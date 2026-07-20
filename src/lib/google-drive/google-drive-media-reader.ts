import "server-only";
import { Readable } from "stream";
export interface GoogleDriveReadableAsset {
  readonly userId: string;
  readonly provider: string;
  readonly objectKey: string;
}
import { getActiveConnectionForOwner } from "./google-drive-connection-repository";
import { getGoogleDriveConfig } from "./google-drive-config";
import { decryptRefreshToken } from "./google-drive-token-crypto";
import { getAccessTokenFromRefreshToken } from "./google-drive-oauth-client";
import { createGoogleDriveFileReadStream, GoogleDriveFileNotFoundError } from "./google-drive-media-client";

export class GoogleDriveMediaReader {
  static async getDownloadStream(
    userId: string,
    asset: GoogleDriveReadableAsset,
    dependencies?: {
      getActiveConnection?: typeof getActiveConnectionForOwner;
      getGoogleDriveConfig?: typeof getGoogleDriveConfig;
      decryptRefreshToken?: typeof decryptRefreshToken;
      getAccessToken?: typeof getAccessTokenFromRefreshToken;
      createReadStream?: typeof createGoogleDriveFileReadStream;
    }
  ): Promise<Readable> {
    // 1. Check asset ownership
    if (asset.userId !== userId) {
      throw new Error("OWNERSHIP_MISMATCH");
    }

    // 2. Parse canonical storage URI
    if (asset.provider !== 'GOOGLE_DRIVE') {
      throw new Error("UNSUPPORTED_STORAGE_PROVIDER");
    }

    const fileId = asset.objectKey;
    if (!fileId || fileId.trim() === "" || fileId.startsWith("uploads/")) {
      throw new Error("INVALID_STORAGE_URI");
    }

    // 3. Load active connection
    const getActiveConn = dependencies?.getActiveConnection || getActiveConnectionForOwner;
    const connection = await getActiveConn(userId);
    if (!connection || connection.revokedAt) {
      throw new Error("GOOGLE_DRIVE_CONNECTION_REVOKED");
    }

    // 4. Decrypt refresh token
    const configFn = dependencies?.getGoogleDriveConfig || getGoogleDriveConfig;
    const config = configFn();
    const decryptFn = dependencies?.decryptRefreshToken || decryptRefreshToken;
    let refreshToken: string;
    try {
      refreshToken = decryptFn(connection.encryptedRefreshToken, config.encryptionKey);
    } catch {
      throw new Error("GOOGLE_DRIVE_DECRYPTION_FAILED");
    }

    // 5. Get access token
    const getAccessTokenFn = dependencies?.getAccessToken || getAccessTokenFromRefreshToken;
    let accessToken: string;
    try {
      accessToken = await getAccessTokenFn(refreshToken);
    } catch (err: unknown) {
      const error = err as Error;
      if (error?.message?.includes("invalid_grant") || error?.message?.includes("revoked")) {
        throw new Error("GOOGLE_DRIVE_CONNECTION_REVOKED");
      }
      throw err;
    }

    // 6. Create read stream
    const readStreamFn = dependencies?.createReadStream || createGoogleDriveFileReadStream;
    try {
      return await readStreamFn(accessToken, fileId);
    } catch (err: unknown) {
      const error = err as Error;
      if (error instanceof GoogleDriveFileNotFoundError || error?.message?.includes("404")) {
        throw new Error("GOOGLE_DRIVE_FILE_NOT_FOUND");
      }
      if (error?.message?.includes("403")) {
        throw new Error("GOOGLE_DRIVE_PERMISSION_DENIED");
      }
      throw err;
    }
  }
}
