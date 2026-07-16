import "server-only";
import { User, GoogleDriveConnection, UploadAsset, UploadSession, AuditLog, UploadStatus } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma-client";
import { getGoogleDriveConfig, GoogleDriveConfig } from "./google-drive-config";
import { getActiveConnectionForOwner, GoogleDriveConnectionRecord } from "./google-drive-connection-repository";
import { decryptRefreshToken } from "./google-drive-token-crypto";
import { getAccessTokenFromRefreshToken } from "./google-drive-oauth-client";
import { getGoogleDriveFileMetadata, deleteGoogleDriveFile, GOOGLE_DRIVE_ASSET_ID_APP_PROPERTY } from "./google-drive-media-client";
import { NotFoundError, ForbiddenOwnershipError, InvalidStateTransitionError, ExpiredSessionError } from "../storage/upload-session-encryption";

export interface DbClient {
  readonly user: {
    readonly findUnique: (args: { where: { id: string } }) => Promise<User | null>;
  };
  readonly googleDriveConnection: {
    readonly findUnique: (args: { where: { userId: string } }) => Promise<GoogleDriveConnection | null>;
  };
  readonly uploadAsset: {
    readonly findUnique: (args: { where: { id: string } }) => Promise<UploadAsset | null>;
    readonly update: (args: { where: { id: string }; data: { status: UploadStatus; objectKey?: string; actualSize?: bigint | null; failureCode?: string | null; failureMessage?: string | null; uploadedAt?: Date } }) => Promise<UploadAsset>;
  };
  readonly uploadSession: {
    readonly findUnique: (args: { where: { uploadAssetId: string } }) => Promise<UploadSession | null>;
    readonly deleteMany: (args: { where: { uploadAssetId: string } }) => Promise<{ count: number }>;
  };
  readonly auditLog: {
    readonly create: (args: { data: { action: string; details: string; userId: string; ipAddress?: string | null } }) => Promise<AuditLog>;
  };
  readonly $transaction: <T>(fn: (tx: DbClient) => Promise<T>) => Promise<T>;
}

export interface GDCompletionDependencies {
  readonly db?: DbClient;
  readonly getActiveConnection?: (userId: string) => Promise<GoogleDriveConnectionRecord | null>;
  readonly getGoogleDriveConfig?: () => GoogleDriveConfig;
  readonly decryptRefreshToken?: (envelope: string, key?: string) => string;
  readonly getAccessToken?: (refreshToken: string) => Promise<string>;
  readonly getFileMetadata?: typeof getGoogleDriveFileMetadata;
  readonly deleteFile?: typeof deleteGoogleDriveFile;
}

class PrismaDbAdapter implements DbClient {
  constructor(private prismaClient: typeof defaultPrisma) {}

  get user() {
    return {
      findUnique: async (args: { where: { id: string } }) => {
        return this.prismaClient.user.findUnique(args);
      }
    };
  }

  get googleDriveConnection() {
    return {
      findUnique: async (args: { where: { userId: string } }) => {
        return this.prismaClient.googleDriveConnection.findUnique(args);
      }
    };
  }

  get uploadAsset() {
    return {
      findUnique: async (args: { where: { id: string } }) => {
        return this.prismaClient.uploadAsset.findUnique(args);
      },
      update: async (args: { where: { id: string }; data: { status: UploadStatus; objectKey?: string; actualSize?: bigint | null; failureCode?: string | null; failureMessage?: string | null; uploadedAt?: Date } }) => {
        return this.prismaClient.uploadAsset.update(args);
      }
    };
  }

  get uploadSession() {
    return {
      findUnique: async (args: { where: { uploadAssetId: string } }) => {
        return this.prismaClient.uploadSession.findUnique(args);
      },
      deleteMany: async (args: { where: { uploadAssetId: string } }) => {
        return this.prismaClient.uploadSession.deleteMany(args);
      }
    };
  }

  get auditLog() {
    return {
      create: async (args: { data: { action: string; details: string; userId: string; ipAddress?: string | null } }) => {
        return this.prismaClient.auditLog.create(args);
      }
    };
  }

  async $transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    return this.prismaClient.$transaction(async (tx) => {
      const adapter = new PrismaDbAdapter(tx as typeof defaultPrisma);
      return fn(adapter);
    });
  }
}

function isCompleteRequestBody(body: unknown): body is { driveFileId: string } {
  if (!body || typeof body !== "object") {
    return false;
  }
  if (!("driveFileId" in body)) {
    return false;
  }
  const driveFileId = (body as { driveFileId: unknown }).driveFileId;
  return typeof driveFileId === "string";
}

function isDriveFileId(id: string | null): id is string {
  if (!id) return false;
  const trimmed = id.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return false;
  if (trimmed.startsWith("uploads/")) return false;
  const regex = /^[a-zA-Z0-9_\-]+$/;
  return regex.test(trimmed);
}

export class GoogleDriveUploadCompletionService {
  static async completeUpload(
    userId: string,
    assetId: string,
    body: unknown,
    deps?: GDCompletionDependencies
  ): Promise<{
    assetId: string;
    provider: "GOOGLE_DRIVE";
    filename: string;
    expectedSize: string;
    actualSize: string;
    status: UploadStatus;
  }> {
    const activeDb: DbClient = deps?.db || new PrismaDbAdapter(defaultPrisma);

    // 1. Retrieve asset & check ownership
    const asset = await activeDb.uploadAsset.findUnique({ where: { id: assetId } });
    if (!asset) {
      throw new NotFoundError("Upload asset not found.");
    }
    if (asset.userId !== userId) {
      throw new ForbiddenOwnershipError("Access denied: You do not own this upload asset.");
    }

    if (asset.provider !== "GOOGLE_DRIVE") {
      throw new Error("INVALID_PROVIDER");
    }

    // 2. Validate request body and file ID format before idempotent check
    if (!isCompleteRequestBody(body)) {
      throw new Error("INVALID_REQUEST");
    }

    const driveFileId = body.driveFileId.trim();
    if (driveFileId.length === 0 || driveFileId.length > 128) {
      throw new Error("INVALID_FILE_ID");
    }

    const driveFileIdRegex = /^[a-zA-Z0-9_\-]+$/;
    if (!driveFileIdRegex.test(driveFileId)) {
      throw new Error("INVALID_FILE_ID");
    }

    // Idempotent success response if already validating or validated
    if (asset.status === UploadStatus.VALIDATING || asset.status === UploadStatus.VALIDATED) {
      const replayActualSize = asset.actualSize;
      if (asset.objectKey === null || asset.objectKey.trim() === "") {
        throw new Error("COMPLETION_FILE_ID_MISMATCH");
      }
      if (asset.objectKey.startsWith("uploads/")) {
        throw new Error("COMPLETION_FILE_ID_MISMATCH");
      }
      if (asset.objectKey !== driveFileId) {
        throw new Error("COMPLETION_FILE_ID_MISMATCH");
      }
      if (replayActualSize === null) {
        throw new Error("COMPLETION_FILE_ID_MISMATCH");
      }

      return {
        assetId: asset.id,
        provider: "GOOGLE_DRIVE",
        filename: asset.originalName,
        expectedSize: asset.expectedSize.toString(),
        actualSize: replayActualSize.toString(),
        status: asset.status,
      };
    }

    // Validate transition feasibility
    if (asset.status !== UploadStatus.UPLOADING && asset.status !== UploadStatus.UPLOADED) {
      throw new InvalidStateTransitionError(
        `Cannot perform completion finalization on asset in status ${asset.status}.`
      );
    }

    // 3. User connection verification
    const connHelper = deps?.getActiveConnection || getActiveConnectionForOwner;
    const connection = await connHelper(userId);
    if (!connection || connection.revokedAt !== null) {
      throw new Error("GOOGLE_DRIVE_NOT_CONNECTED");
    }
    if (!connection.driveFolderId || connection.driveFolderId.trim() === "") {
      throw new Error("GOOGLE_DRIVE_FOLDER_MISSING");
    }

    // 4. Session verification
    const session = await activeDb.uploadSession.findUnique({
      where: { uploadAssetId: asset.id },
    });
    if (!session) {
      throw new Error("UPLOAD_SESSION_NOT_FOUND");
    }
    if (session.expiresAt.getTime() < Date.now()) {
      throw new ExpiredSessionError("Upload session has expired.");
    }

    // 5. Fetch and verify Google Drive metadata
    const config = deps?.getGoogleDriveConfig ? deps.getGoogleDriveConfig() : getGoogleDriveConfig();
    const decryptFn = deps?.decryptRefreshToken || decryptRefreshToken;
    const refreshToken = decryptFn(connection.encryptedRefreshToken, config.encryptionKey);

    const tokenHelper = deps?.getAccessToken || getAccessTokenFromRefreshToken;
    const accessToken = await tokenHelper(refreshToken);

    const getMetadataFn = deps?.getFileMetadata || getGoogleDriveFileMetadata;
    let metadata;
    try {
      metadata = await getMetadataFn(accessToken, driveFileId);
    } catch {
      throw new Error("GOOGLE_DRIVE_FILE_MISSING");
    }

    if (!metadata || metadata.trashed) {
      throw new Error("GOOGLE_DRIVE_FILE_MISSING_OR_TRASHED");
    }

    // Enforce metadata matching
    if (!metadata.appProperties || metadata.appProperties[GOOGLE_DRIVE_ASSET_ID_APP_PROPERTY] !== asset.id) {
      throw new Error("METADATA_MISMATCH");
    }
    if (!asset.bucket || asset.bucket.trim() === "") {
      throw new Error("METADATA_MISMATCH");
    }
    if (connection.driveFolderId !== asset.bucket) {
      throw new Error("METADATA_MISMATCH");
    }
    if (!metadata.parents || !metadata.parents.includes(asset.bucket)) {
      throw new Error("METADATA_MISMATCH");
    }
    if (metadata.size !== Number(asset.expectedSize)) {
      throw new Error("METADATA_MISMATCH");
    }
    if (metadata.name !== asset.originalName || metadata.mimeType !== asset.declaredMimeType) {
      throw new Error("METADATA_MISMATCH");
    }

    const verifiedSize = BigInt(metadata.size);

    // Atomically transition status and clean up session
    await activeDb.$transaction(async (tx) => {
      await tx.uploadAsset.update({
        where: { id: asset.id },
        data: {
          status: UploadStatus.VALIDATING,
          objectKey: driveFileId,
          actualSize: verifiedSize,
          uploadedAt: new Date(),
        },
      });

      await tx.uploadSession.deleteMany({
        where: { uploadAssetId: asset.id },
      });

      await tx.auditLog.create({
        data: {
          action: "UPLOAD_COMPLETED",
          details: `Completed Google Drive upload for asset ${asset.id}. Status transitioned to VALIDATING.`,
          userId,
          ipAddress: null,
        },
      });
    });

    return {
      assetId: asset.id,
      provider: "GOOGLE_DRIVE",
      filename: asset.originalName,
      expectedSize: asset.expectedSize.toString(),
      actualSize: verifiedSize.toString(),
      status: UploadStatus.VALIDATING,
    };
  }

  static async abortUpload(
    userId: string,
    assetId: string,
    deps?: GDCompletionDependencies
  ): Promise<{
    assetId: string;
    provider: "GOOGLE_DRIVE";
    status: UploadStatus;
  }> {
    const activeDb: DbClient = deps?.db || new PrismaDbAdapter(defaultPrisma);

    // 1. Retrieve asset & check ownership
    const asset = await activeDb.uploadAsset.findUnique({ where: { id: assetId } });
    if (!asset) {
      throw new NotFoundError("Upload asset not found.");
    }
    if (asset.userId !== userId) {
      throw new ForbiddenOwnershipError("Access denied: You do not own this upload asset.");
    }

    if (asset.provider !== "GOOGLE_DRIVE") {
      throw new Error("INVALID_PROVIDER");
    }

    // Idempotent success response if already aborted
    if (asset.status === UploadStatus.ABORTED) {
      return {
        assetId: asset.id,
        provider: "GOOGLE_DRIVE",
        status: UploadStatus.ABORTED,
      };
    }

    // Validate transition feasibility
    if (
      asset.status !== UploadStatus.REQUESTED &&
      asset.status !== UploadStatus.UPLOADING &&
      asset.status !== UploadStatus.VALIDATING &&
      asset.status !== UploadStatus.VALIDATED
    ) {
      throw new InvalidStateTransitionError(
        `Cannot perform abort finalization on asset in status ${asset.status}.`
      );
    }

    const hasFinalizedFileId = isDriveFileId(asset.objectKey);

    if (hasFinalizedFileId && asset.objectKey) {
      const connHelper = deps?.getActiveConnection || getActiveConnectionForOwner;
      const connection = await connHelper(userId);
      if (!connection || connection.revokedAt !== null) {
        throw new Error("GOOGLE_DRIVE_NOT_CONNECTED");
      }

      const config = deps?.getGoogleDriveConfig ? deps.getGoogleDriveConfig() : getGoogleDriveConfig();
      const decryptFn = deps?.decryptRefreshToken || decryptRefreshToken;
      const refreshToken = decryptFn(connection.encryptedRefreshToken, config.encryptionKey);

      const tokenHelper = deps?.getAccessToken || getAccessTokenFromRefreshToken;
      const accessToken = await tokenHelper(refreshToken);

      const deleteFileFn = deps?.deleteFile || deleteGoogleDriveFile;
      try {
        await deleteFileFn(accessToken, asset.objectKey);
      } catch (err: unknown) {
        void err;
        throw new Error("GOOGLE_DRIVE_DELETE_FAILED");
      }
    }

    await activeDb.$transaction(async (tx) => {
      await tx.uploadAsset.update({
        where: { id: asset.id },
        data: {
          status: UploadStatus.ABORTED,
        },
      });

      await tx.uploadSession.deleteMany({
        where: { uploadAssetId: asset.id },
      });

      await tx.auditLog.create({
        data: {
          action: "UPLOAD_ABORTED",
          details: `Aborted Google Drive upload for asset ${asset.id}. Status set to ABORTED.`,
          userId,
          ipAddress: null,
        },
      });
    });

    return {
      assetId: asset.id,
      provider: "GOOGLE_DRIVE",
      status: UploadStatus.ABORTED,
    };
  }
}
