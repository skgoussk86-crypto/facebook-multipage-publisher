import "server-only";
import { UploadAsset, UploadStatus } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma-client";
import { UploadSessionService } from "../storage/upload-session-service";
import { GoogleDriveUploadCompletionService } from "./google-drive-upload-completion-service";
import { NotFoundError, ForbiddenOwnershipError, InvalidStateTransitionError, ExpiredSessionError } from "../storage/upload-session-encryption";

export interface DbClient {
  readonly uploadAsset: {
    readonly findUnique: (args: { where: { id: string } }) => Promise<UploadAsset | null>;
  };
}

class PrismaDbAdapter implements DbClient {
  constructor(private prismaClient: typeof defaultPrisma) {}

  get uploadAsset() {
    return {
      findUnique: async (args: { where: { id: string } }) => {
        return this.prismaClient.uploadAsset.findUnique(args);
      }
    };
  }
}

export interface GDReconciliationDependencies {
  readonly db?: DbClient;
  readonly getDecryptedSession?: (userId: string, assetId: string) => Promise<{ providerSessionId: string }>;
  readonly fetchImpl?: typeof fetch;
  readonly completeUpload?: (
    userId: string,
    assetId: string,
    body: { driveFileId: string }
  ) => Promise<{ status: string }>;
}

export interface ReconciliationResult {
  reconciled: boolean;
  status: "UPLOADING" | "VALIDATING" | "VALIDATED";
  confirmedBytes?: number;
}

export class GoogleDriveUploadReconciliationService {
  static async reconcileUpload(
    userId: string,
    assetId: string,
    deps?: GDReconciliationDependencies
  ): Promise<ReconciliationResult> {
    const activeDb: DbClient = deps?.db || new PrismaDbAdapter(defaultPrisma);

    // 1. Retrieve asset and check ownership/provider
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

    // 2. Idempotent success response if already validating or validated
    if (asset.status === UploadStatus.VALIDATING || asset.status === UploadStatus.VALIDATED) {
      return {
        reconciled: true,
        status: asset.status as "VALIDATING" | "VALIDATED",
      };
    }

    // 3. Enforce valid upload states
    if (asset.status !== UploadStatus.UPLOADING && asset.status !== UploadStatus.UPLOADED) {
      throw new InvalidStateTransitionError(
        `Cannot perform upload reconciliation on asset in status ${asset.status}.`
      );
    }

    // 4. Retrieve decrypted session URI
    const getDecryptedSessionFn = deps?.getDecryptedSession || UploadSessionService.getDecryptedSession;
    const session = await getDecryptedSessionFn(userId, assetId);
    const sessionUri = session.providerSessionId;

    // Validate resumable-session URI as an HTTPS Google APIs URL
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(sessionUri);
    } catch {
      throw new Error("Invalid resumable session URI: Not a valid absolute URL.");
    }

    if (parsedUrl.protocol !== "https:") {
      throw new Error("Invalid resumable session URI: Protocol must be HTTPS.");
    }
    if (parsedUrl.username !== "" || parsedUrl.password !== "") {
      throw new Error("Invalid resumable session URI: Credentials must be absent.");
    }
    if (parsedUrl.hash !== "") {
      throw new Error("Invalid resumable session URI: Fragment must be absent.");
    }
    const hostname = parsedUrl.hostname;
    if (hostname !== "www.googleapis.com" && !hostname.endsWith(".googleapis.com")) {
      throw new Error("Invalid resumable session URI: Hostname must end with .googleapis.com.");
    }

    // 5. Send server-side request
    const expectedSize = asset.expectedSize;
    const activeFetch = deps?.fetchImpl || fetch;

    let response: Response;
    try {
      response = await activeFetch(sessionUri, {
        method: "PUT",
        headers: {
          "Content-Length": "0",
          "Content-Range": `bytes */${expectedSize.toString()}`,
        },
      });
    } catch {
      throw new Error("GOOGLE_DRIVE_UPLOAD_FAILED");
    }

    if (response.status === 200 || response.status === 201) {
      let bodyText = "";
      try {
        bodyText = await response.text();
      } catch {
        throw new Error("GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE");
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        throw new Error("GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE");
      }

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE");
      }

      const driveFileId = (parsed as { id?: unknown }).id;
      if (typeof driveFileId !== "string" || driveFileId.trim() === "") {
        throw new Error("GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE");
      }

      const trimmedId = driveFileId.trim();
      if (trimmedId.length > 128 || !/^[a-zA-Z0-9_\-]+$/.test(trimmedId)) {
        throw new Error("GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE");
      }

      let result;
      if (deps?.completeUpload) {
        result = await deps.completeUpload(userId, assetId, { driveFileId: trimmedId });
      } else {
        result = await GoogleDriveUploadCompletionService.completeUpload(userId, assetId, { driveFileId: trimmedId });
      }

      return {
        reconciled: true,
        status: result.status as "VALIDATING" | "VALIDATED",
      };
    }

    if (response.status === 308) {
      const rangeHeader = response.headers.get("Range");
      let confirmedBytes = 0;
      if (rangeHeader !== null && rangeHeader !== undefined) {
        confirmedBytes = parseStrictRangeHeader(rangeHeader, expectedSize);
      }
      return {
        reconciled: false,
        status: UploadStatus.UPLOADING as "UPLOADING",
        confirmedBytes,
      };
    }

    if (response.status === 404 || response.status === 410) {
      throw new ExpiredSessionError("Upload session has expired.");
    }

    if (response.status >= 400 && response.status < 500) {
      throw new Error("UPLOAD_SESSION_RESTART_REQUIRED");
    }

    throw new Error("GOOGLE_DRIVE_UPLOAD_FAILED");
  }
}

function parseStrictRangeHeader(rangeHeader: string, expectedSize: bigint): number {
  if (expectedSize <= BigInt(0)) {
    throw new Error("GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE");
  }
  const trimmed = rangeHeader.trim();
  const match = trimmed.match(/^bytes=0-(\d+)$/);
  if (!match) {
    throw new Error("GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE");
  }
  const endStr = match[1];

  if (endStr.length > 1 && endStr.startsWith("0")) {
    throw new Error("GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE");
  }

  let endBig: bigint;
  try {
    endBig = BigInt(endStr);
  } catch {
    throw new Error("GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE");
  }

  if (endBig < BigInt(0)) {
    throw new Error("GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE");
  }

  if (endBig >= expectedSize) {
    throw new Error("GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE");
  }

  const confirmedBig = endBig + BigInt(1);
  if (confirmedBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE");
  }

  return Number(confirmedBig);
}
