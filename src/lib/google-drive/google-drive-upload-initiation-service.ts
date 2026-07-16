import "server-only";
import { User, GoogleDriveConnection, UploadAsset, UploadSession, AuditLog, UploadStatus } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma-client";
import { getGoogleDriveConfig, GoogleDriveConfig } from "./google-drive-config";
import { getActiveConnectionForOwner, GoogleDriveConnectionRecord } from "./google-drive-connection-repository";
import { decryptRefreshToken } from "./google-drive-token-crypto";
import { getAccessTokenFromRefreshToken } from "./google-drive-oauth-client";
import { initiateGoogleDriveResumableUpload, GoogleDriveResumableUploadInput, GoogleDriveResumableUploadSession } from "./google-drive-media-client";
import { encryptUploadSecret, decryptUploadSecret, IdempotencyConflictError, ExpiredSessionError } from "../storage/upload-session-encryption";
import { UploadSessionService } from "../storage/upload-session-service";
import { isValidFilename, sanitizeFilename, MAX_FILE_SIZE_BYTES } from "../storage/upload-initiation-service";

export interface DbClient {
  readonly user: {
    readonly findUnique: (args: { where: { id: string } }) => Promise<User | null>;
  };
  readonly googleDriveConnection: {
    readonly findUnique: (args: { where: { userId: string } }) => Promise<GoogleDriveConnection | null>;
  };
  readonly uploadAsset: {
    readonly findUnique: (args: { where: { userId_idempotencyKey: { userId: string; idempotencyKey: string } } }) => Promise<UploadAsset | null>;
    readonly create: (args: { data: { userId: string; idempotencyKey: string; requestFingerprint: string; provider: "GOOGLE_DRIVE" | "R2"; bucket: string; objectKey: string; originalName: string; expectedSize: bigint; declaredMimeType: string; status: "REQUESTED" | "UPLOADING"; uploadExpiresAt: Date } }) => Promise<UploadAsset>;
    readonly update: (args: { where: { id: string }; data: { status: "FAILED" | "UPLOADING"; failureCode?: string; failureMessage?: string } }) => Promise<UploadAsset>;
  };
  readonly uploadSession: {
    readonly findUnique: (args: { where: { uploadAssetId: string } }) => Promise<UploadSession | null>;
    readonly create: (args: { data: { uploadAssetId: string; encryptionKeyVersion: string; encryptedProviderSessionId: string; encryptedCompletedParts: string; expiresAt: Date; lastActivityAt: Date } }) => Promise<UploadSession>;
  };
  readonly auditLog: {
    readonly create: (args: { data: { action: string; details: string; userId: string } }) => Promise<AuditLog>;
  };
  readonly $transaction: <T>(fn: (tx: DbClient) => Promise<T>) => Promise<T>;
}

export interface GDUploadInitiationDependencies {
  readonly db?: DbClient;
  readonly getActiveConnection?: (userId: string) => Promise<GoogleDriveConnectionRecord | null>;
  readonly getGoogleDriveConfig?: () => GoogleDriveConfig;
  readonly decryptRefreshToken?: (envelope: string, key?: string) => string;
  readonly getAccessToken?: (refreshToken: string) => Promise<string>;
  readonly initiateResumableUpload?: (input: GoogleDriveResumableUploadInput) => Promise<GoogleDriveResumableUploadSession>;
  readonly encryptSessionSecret?: typeof encryptUploadSecret;
  readonly decryptSessionSecret?: typeof decryptUploadSecret;
}

export class GoogleDriveUploadInitiationService {
  static async initiateGDUpload(
    userId: string,
    data: {
      idempotencyKey: string;
      originalName: string;
      expectedSize: bigint;
      declaredMimeType: string;
    },
    deps?: GDUploadInitiationDependencies
  ): Promise<{
    assetId: string;
    provider: "GOOGLE_DRIVE";
    sessionUri: string;
    filename: string;
    mimeType: string;
    totalBytes: number;
    idempotentReplay: boolean;
  }> {
    const activeDb: DbClient = (deps?.db || defaultPrisma) as DbClient;
    const encryptSecret = deps?.encryptSessionSecret ?? encryptUploadSecret;
    const decryptSecret = deps?.decryptSessionSecret ?? decryptUploadSecret;

    // 1. Authenticated approved active user verification
    const dbUser = await activeDb.user.findUnique({ where: { id: userId } });
    if (!dbUser || dbUser.status !== "ACTIVE" || dbUser.approvalStatus !== "APPROVED") {
      throw new Error("UNAUTHORIZED_USER");
    }

    // 2. Read only that user's GoogleDriveConnection
    const connection = deps?.getActiveConnection
      ? await deps.getActiveConnection(userId)
      : await getActiveConnectionForOwner(userId);

    if (!connection || connection.revokedAt !== null) {
      throw new Error("GOOGLE_DRIVE_NOT_CONNECTED");
    }

    // 3. Require nonempty persisted mediaFolderId
    if (!connection.driveFolderId || connection.driveFolderId.trim() === "") {
      throw new Error("GOOGLE_DRIVE_FOLDER_MISSING");
    }

    // 4. Validate metadata parameters
    if (!data.idempotencyKey || data.idempotencyKey.trim().length === 0 || data.idempotencyKey.length > 128) {
      throw new Error("INVALID_IDEMPOTENCY_KEY");
    }

    if (!isValidFilename(data.originalName)) {
      throw new Error("INVALID_FILENAME");
    }

    if (data.expectedSize <= BigInt(0) || data.expectedSize > BigInt(MAX_FILE_SIZE_BYTES)) {
      throw new Error("FILE_TOO_LARGE");
    }

    const mime = data.declaredMimeType.trim().toLowerCase();
    if (mime !== "video/mp4" && mime !== "video/quicktime") {
      throw new Error("UNSUPPORTED_MEDIA_TYPE");
    }

    const ext = data.originalName.slice(data.originalName.lastIndexOf(".")).toLowerCase();
    if (ext === ".mp4" && mime !== "video/mp4") {
      throw new Error("MIME_MISMATCH");
    }
    if (ext === ".mov" && mime !== "video/quicktime") {
      throw new Error("MIME_MISMATCH");
    }
    if (ext !== ".mp4" && ext !== ".mov") {
      throw new Error("UNSUPPORTED_MEDIA_TYPE");
    }

    const requestFingerprint = UploadSessionService.generateRequestFingerprint(
      data.originalName,
      data.expectedSize,
      data.declaredMimeType
    );

    // 5. Idempotency Check
    const existing = await activeDb.uploadAsset.findUnique({
      where: {
        userId_idempotencyKey: {
          userId,
          idempotencyKey: data.idempotencyKey,
        },
      },
    });

    if (existing) {
      if (existing.provider !== "GOOGLE_DRIVE") {
        throw new IdempotencyConflictError(
          "An upload asset with this idempotency key already exists with a different storage provider."
        );
      }

      if (existing.requestFingerprint !== requestFingerprint) {
        throw new IdempotencyConflictError(
          "An upload asset with this idempotency key already exists with different request parameters."
        );
      }

      const session = await activeDb.uploadSession.findUnique({
        where: { uploadAssetId: existing.id },
      });

      if (!session) {
        throw new Error("Upload session not found for existing asset.");
      }

      if (session.expiresAt.getTime() < Date.now()) {
        throw new ExpiredSessionError("Upload session has expired.");
      }

      const sessionUri = decryptSecret(session.encryptedProviderSessionId);

      await activeDb.auditLog.create({
        data: {
          action: "UPLOAD_INITIATION_REPLAYED",
          details: `Idempotent Google Drive upload initiation replayed for asset ${existing.id}.`,
          userId,
        },
      });

      return {
        assetId: existing.id,
        provider: "GOOGLE_DRIVE",
        sessionUri,
        filename: existing.originalName,
        mimeType: existing.declaredMimeType,
        totalBytes: Number(existing.expectedSize),
        idempotentReplay: true,
      };
    }

    // 6. Decrypt stored refresh token
    const config = deps?.getGoogleDriveConfig ? deps.getGoogleDriveConfig() : getGoogleDriveConfig();
    const decryptFn = deps?.decryptRefreshToken || decryptRefreshToken;
    const refreshToken = decryptFn(connection.encryptedRefreshToken, config.encryptionKey);

    // 7. Obtain access token
    const tokenHelper = deps?.getAccessToken || getAccessTokenFromRefreshToken;
    const accessToken = await tokenHelper(refreshToken);

    // 8. Create UploadAsset in REQUESTED status
    const sanitized = sanitizeFilename(data.originalName);
    const objectKey = `uploads/${userId}/${sanitized}`;

    let newAsset: UploadAsset;
    try {
      newAsset = await activeDb.uploadAsset.create({
        data: {
          userId,
          idempotencyKey: data.idempotencyKey,
          requestFingerprint,
          provider: "GOOGLE_DRIVE",
          bucket: connection.driveFolderId,
          objectKey,
          originalName: data.originalName,
          expectedSize: data.expectedSize,
          declaredMimeType: data.declaredMimeType,
          status: UploadStatus.REQUESTED,
          uploadExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });
    } catch (err: unknown) {
      if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "P2002") {
        const raceExisting = await activeDb.uploadAsset.findUnique({
          where: {
            userId_idempotencyKey: {
              userId,
              idempotencyKey: data.idempotencyKey,
            },
          },
        });
        if (raceExisting) {
          if (raceExisting.provider !== "GOOGLE_DRIVE") {
            throw new IdempotencyConflictError(
              "An upload asset with this idempotency key already exists with a different storage provider."
            );
          }

          if (raceExisting.requestFingerprint !== requestFingerprint) {
            throw new IdempotencyConflictError(
              "An upload asset with this idempotency key already exists with different request parameters."
            );
          }
          const session = await activeDb.uploadSession.findUnique({
            where: { uploadAssetId: raceExisting.id },
          });
          if (!session) {
            throw new Error("Upload session not found for existing asset.");
          }
          if (session.expiresAt.getTime() < Date.now()) {
            throw new ExpiredSessionError("Upload session has expired.");
          }
          const sessionUri = decryptSecret(session.encryptedProviderSessionId);
          await activeDb.auditLog.create({
            data: {
              action: "UPLOAD_INITIATION_REPLAYED",
              details: `Idempotent Google Drive upload initiation replayed for asset ${raceExisting.id} after concurrent race.`,
              userId,
            },
          });
          return {
            assetId: raceExisting.id,
            provider: "GOOGLE_DRIVE",
            sessionUri,
            filename: raceExisting.originalName,
            mimeType: raceExisting.declaredMimeType,
            totalBytes: Number(raceExisting.expectedSize),
            idempotentReplay: true,
          };
        }
      }
      throw err;
    }

    // 9. Call initiateGoogleDriveResumableUpload
    const initiateFn = deps?.initiateResumableUpload || initiateGoogleDriveResumableUpload;
    let sessionUri: string;
    try {
      const uploadSessionResult = await initiateFn({
        accessToken,
        folderId: connection.driveFolderId,
        assetId: newAsset.id,
        fileName: data.originalName,
        mimeType: data.declaredMimeType,
        totalBytes: Number(data.expectedSize),
      });
      sessionUri = uploadSessionResult.sessionUri;
    } catch (initErr: unknown) {
      void initErr;
      // Clean up or safely mark the asset failed when resumable initiation fails.
      await activeDb.uploadAsset.update({
        where: { id: newAsset.id },
        data: {
          status: UploadStatus.FAILED,
          failureCode: "PROVIDER_INITIATION_FAILED",
          failureMessage: "Google Drive resumable upload initiation failed.",
        },
      });
      await activeDb.auditLog.create({
        data: {
          action: "UPLOAD_STATUS_CHANGED",
          details: `Transitioned Google Drive upload asset ${newAsset.id} to FAILED due to initiation failure.`,
          userId,
        },
      });
      throw new Error("GOOGLE_DRIVE_INITIATION_FAILED");
    }

    // 10. Create Session Secrets & Transition Status to UPLOADING
    const currentVersion = process.env.UPLOAD_SESSION_ENCRYPTION_KEY_VERSION || "1";
    const encryptedProviderId = encryptSecret(sessionUri);
    const encryptedParts = encryptSecret(JSON.stringify([]));

    await activeDb.$transaction(async (tx) => {
      await tx.uploadSession.create({
        data: {
          uploadAssetId: newAsset.id,
          encryptionKeyVersion: currentVersion,
          encryptedProviderSessionId: encryptedProviderId,
          encryptedCompletedParts: encryptedParts,
          expiresAt: newAsset.uploadExpiresAt,
          lastActivityAt: new Date(),
        },
      });

      await tx.uploadAsset.update({
        where: { id: newAsset.id },
        data: {
          status: UploadStatus.UPLOADING,
        },
      });

      await tx.auditLog.create({
        data: {
          action: "UPLOAD_INITIATED",
          details: `Initiated Google Drive upload asset ${newAsset.id} and session secrets. Status set to UPLOADING.`,
          userId,
        },
      });
    });

    return {
      assetId: newAsset.id,
      provider: "GOOGLE_DRIVE",
      sessionUri,
      filename: newAsset.originalName,
      mimeType: newAsset.declaredMimeType,
      totalBytes: Number(newAsset.expectedSize),
      idempotentReplay: false,
    };
  }
}
