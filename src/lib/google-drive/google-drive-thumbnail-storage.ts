import "server-only";
import {
  getActiveConnectionForOwner,
  GoogleDriveConnectionRecord,
} from "./google-drive-connection-repository";
import {
  getGoogleDriveConfig,
  GoogleDriveConfig,
} from "./google-drive-config";
import {
  decryptRefreshToken,
} from "./google-drive-token-crypto";
import {
  getAccessTokenFromRefreshToken,
} from "./google-drive-oauth-client";
import {
  GoogleDriveThumbnailFile,
  GoogleDriveThumbnailSource,
  GoogleDriveThumbnailUploadInput,
  uploadGoogleDriveThumbnail,
} from "./google-drive-thumbnail-client";

export interface StoreGoogleDriveThumbnailInput {
  readonly sourceVideoAssetId: string;
  readonly jpegBytes: Buffer;
  readonly source: GoogleDriveThumbnailSource;
  readonly timestampMs?: number | null;
}

export interface StoredGoogleDriveThumbnail {
  readonly fileId: string;
  readonly storageUri: string;
  readonly folderId: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly md5Checksum: string | null;
  readonly source: GoogleDriveThumbnailSource;
  readonly timestampMs: number | null;
}

export interface GoogleDriveThumbnailStorageDependencies {
  readonly getActiveConnection?: (
    userId: string,
  ) => Promise<GoogleDriveConnectionRecord | null>;
  readonly getGoogleDriveConfig?: () => GoogleDriveConfig;
  readonly decryptRefreshToken?: (
    envelope: string,
    encryptionKey?: string,
  ) => string;
  readonly getAccessToken?: (
    refreshToken: string,
  ) => Promise<string>;
  readonly uploadThumbnail?: (
    input: GoogleDriveThumbnailUploadInput,
  ) => Promise<GoogleDriveThumbnailFile>;
}

function buildThumbnailFileName(
  sourceVideoAssetId: string,
  timestampMs: number | null,
): string {
  const safeAssetId =
    sourceVideoAssetId
      .trim()
      .replace(/[^a-zA-Z0-9_-]/g, "")
      .slice(0, 64);

  if (!safeAssetId) {
    throw new Error(
      "INVALID_SOURCE_VIDEO_ASSET_ID",
    );
  }

  const timePart =
    timestampMs === null
      ? "custom"
      : timestampMs.toString();

  return `thumbnail-${safeAssetId}-${timePart}.jpg`;
}

export class GoogleDriveThumbnailStorage {
  static async store(
    userId: string,
    input: StoreGoogleDriveThumbnailInput,
    dependencies?: GoogleDriveThumbnailStorageDependencies,
  ): Promise<StoredGoogleDriveThumbnail> {
    const trimmedUserId =
      userId.trim();

    if (!trimmedUserId) {
      throw new Error("USER_ID_REQUIRED");
    }

    const sourceVideoAssetId =
      input.sourceVideoAssetId.trim();

    if (!sourceVideoAssetId) {
      throw new Error(
        "SOURCE_VIDEO_ASSET_ID_REQUIRED",
      );
    }

    if (
      !Buffer.isBuffer(input.jpegBytes) ||
      input.jpegBytes.length <= 0
    ) {
      throw new Error(
        "THUMBNAIL_BYTES_REQUIRED",
      );
    }

    const timestampMs =
      input.timestampMs === undefined ||
      input.timestampMs === null
        ? null
        : input.timestampMs;

    if (
      timestampMs !== null &&
      (
        !Number.isSafeInteger(timestampMs) ||
        timestampMs < 0
      )
    ) {
      throw new Error(
        "INVALID_THUMBNAIL_TIMESTAMP",
      );
    }

    const getConnection =
      dependencies?.getActiveConnection ||
      getActiveConnectionForOwner;

    const connection =
      await getConnection(trimmedUserId);

    if (
      !connection ||
      connection.revokedAt !== null
    ) {
      throw new Error(
        "GOOGLE_DRIVE_CONNECTION_REVOKED",
      );
    }

    const folderId =
      connection.driveFolderId?.trim();

    if (!folderId) {
      throw new Error(
        "GOOGLE_DRIVE_FOLDER_MISSING",
      );
    }

    const getConfig =
      dependencies?.getGoogleDriveConfig ||
      getGoogleDriveConfig;

    const config =
      getConfig();

    const decrypt =
      dependencies?.decryptRefreshToken ||
      decryptRefreshToken;

    let refreshToken: string;

    try {
      refreshToken = decrypt(
        connection.encryptedRefreshToken,
        config.encryptionKey,
      );
    } catch {
      throw new Error(
        "GOOGLE_DRIVE_DECRYPTION_FAILED",
      );
    }

    const getAccessToken =
      dependencies?.getAccessToken ||
      getAccessTokenFromRefreshToken;

    let accessToken: string;

    try {
      accessToken =
        await getAccessToken(refreshToken);
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);

      if (
        message.includes("invalid_grant") ||
        message.includes("revoked")
      ) {
        throw new Error(
          "GOOGLE_DRIVE_CONNECTION_REVOKED",
        );
      }

      throw error;
    }

    const fileName =
      buildThumbnailFileName(
        sourceVideoAssetId,
        timestampMs,
      );

    const upload =
      dependencies?.uploadThumbnail ||
      uploadGoogleDriveThumbnail;

    const file =
      await upload({
        accessToken,
        folderId,
        sourceVideoAssetId,
        fileName,
        mimeType: "image/jpeg",
        bytes: input.jpegBytes,
        source: input.source,
        timestampMs,
      });

    return {
      fileId: file.id,
      storageUri:
        `gdrive://${file.id}`,
      folderId,
      fileName: file.name,
      mimeType: file.mimeType,
      sizeBytes: file.size,
      md5Checksum: file.md5Checksum,
      source: input.source,
      timestampMs,
    };
  }
}
