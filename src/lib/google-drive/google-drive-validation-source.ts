import "server-only";
import type { ObjectMetadata } from "../storage/storage-adapter";
import type { ValidationSourceAssetInput, PreparedValidationSource } from "../storage/validation-source-resolver";
import { getActiveConnectionForOwner } from "./google-drive-connection-repository";
import type { GoogleDriveConnectionRecord } from "./google-drive-connection-repository";
import { getGoogleDriveConfig } from "./google-drive-config";
import type { GoogleDriveConfig } from "./google-drive-config";
import { decryptRefreshToken } from "./google-drive-token-crypto";
import { getAccessTokenFromRefreshToken } from "./google-drive-oauth-client";
import { getGoogleDriveFileMetadata, createGoogleDriveFileReadStream, GOOGLE_DRIVE_ASSET_ID_APP_PROPERTY } from "./google-drive-media-client";
import { MediaValidationError } from "../storage/media-probe";

export interface GDValidationSourceDependencies {
  readonly getActiveConnection?: (userId: string) => Promise<GoogleDriveConnectionRecord | null>;
  readonly getGoogleDriveConfig?: () => GoogleDriveConfig;
  readonly decryptRefreshToken?: (envelope: string, key?: string) => string;
  readonly getAccessToken?: (refreshToken: string) => Promise<string>;
  readonly getFileMetadata?: typeof getGoogleDriveFileMetadata;
  readonly createReadStream?: typeof createGoogleDriveFileReadStream;
}

export async function prepareGoogleDriveSource(
  asset: ValidationSourceAssetInput,
  dependencies?: GDValidationSourceDependencies
): Promise<PreparedValidationSource | null> {
  // Before any Google request, validate inputs
  if (!asset.bucket || asset.bucket.trim() === "") {
    throw new Error("GOOGLE_DRIVE_VALIDATION_ACCESS_FAILED");
  }

  const fileId = asset.objectKey;
  if (!fileId || fileId.trim() === "" || fileId.startsWith("uploads/") || fileId.length > 128) {
    throw new Error("GOOGLE_DRIVE_VALIDATION_ACCESS_FAILED");
  }

  const fileIdRegex = /^[a-zA-Z0-9_-]+$/;
  if (!fileIdRegex.test(fileId)) {
    throw new Error("GOOGLE_DRIVE_VALIDATION_ACCESS_FAILED");
  }

  // 1. Connection check
  let connection: GoogleDriveConnectionRecord | null = null;
  try {
    const connFn = dependencies?.getActiveConnection || getActiveConnectionForOwner;
    connection = await connFn(asset.userId);
  } catch {
    throw new Error("GOOGLE_DRIVE_VALIDATION_ACCESS_FAILED");
  }

  if (!connection || connection.revokedAt !== null) {
    throw new Error("GOOGLE_DRIVE_VALIDATION_ACCESS_FAILED");
  }

  if (!connection.driveFolderId || connection.driveFolderId.trim() === "") {
    throw new Error("GOOGLE_DRIVE_VALIDATION_ACCESS_FAILED");
  }

  if (connection.driveFolderId !== asset.bucket) {
    throw new Error("GOOGLE_DRIVE_VALIDATION_ACCESS_FAILED");
  }

  // 2. Fetch credentials
  let accessToken: string;
  try {
    const configFn = dependencies?.getGoogleDriveConfig || getGoogleDriveConfig;
    const config = configFn();
    const decryptFn = dependencies?.decryptRefreshToken || decryptRefreshToken;
    const refreshToken = decryptFn(connection.encryptedRefreshToken, config.encryptionKey);

    const tokenFn = dependencies?.getAccessToken || getAccessTokenFromRefreshToken;
    accessToken = await tokenFn(refreshToken);
  } catch {
    throw new Error("GOOGLE_DRIVE_VALIDATION_ACCESS_FAILED");
  }

  // 3. Fetch metadata
  const getMetadataFn = dependencies?.getFileMetadata || getGoogleDriveFileMetadata;
  let metadata;
  try {
    metadata = await getMetadataFn(accessToken, fileId);
  } catch {
    throw new Error("GOOGLE_DRIVE_VALIDATION_ACCESS_FAILED");
  }

  if (!metadata || metadata.trashed) {
    return null;
  }

  // 4. Verify binding
  const bindingMismatch =
    metadata.id !== fileId ||
    !metadata.appProperties ||
    metadata.appProperties[GOOGLE_DRIVE_ASSET_ID_APP_PROPERTY] !== asset.id ||
    !metadata.parents ||
    !metadata.parents.includes(asset.bucket) ||
    metadata.name !== asset.originalName ||
    metadata.mimeType !== asset.declaredMimeType;

  if (bindingMismatch) {
    throw new MediaValidationError(
      "STORAGE_BINDING_MISMATCH",
      "The uploaded file does not match its recorded storage binding."
    );
  }

  // 5. Map ObjectMetadata
  const objectMetadata: ObjectMetadata = {
    bucket: asset.bucket,
    objectKey: fileId,
    size: metadata.size,
    etag: metadata.md5Checksum || "",
    contentType: metadata.mimeType,
    lastModified: metadata.modifiedTime || undefined,
  };

  // 6. Return prepared validation source
  return {
    metadata: objectMetadata,
    createReadStream: async () => {
      const readStreamFn = dependencies?.createReadStream || createGoogleDriveFileReadStream;
      try {
        return await readStreamFn(accessToken, fileId);
      } catch {
        throw new Error("GOOGLE_DRIVE_VALIDATION_DOWNLOAD_FAILED");
      }
    },
  };
}
