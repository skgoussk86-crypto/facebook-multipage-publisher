import "server-only";
import { decryptRefreshToken as defaultDecrypt } from "./google-drive-token-crypto";
import { getAccessTokenFromRefreshToken as defaultGetAccessToken } from "./google-drive-oauth-client";
import { findOrCreateGoogleDriveMediaFolder as defaultFindOrCreate } from "./google-drive-folder-client";
import { saveDriveFolderIdForOwner as defaultSaveFolderId } from "./google-drive-connection-repository";

export interface GoogleDriveFolderProvisioningInput {
  readonly ownerUserId: string;
  readonly encryptedRefreshToken: string;
  readonly folderName?: string;
}

export interface GoogleDriveFolderProvisioningResult {
  readonly folderId: string;
  readonly folderName: string;
}

export interface GoogleDriveFolderProvisioningDependencies {
  readonly decryptRefreshToken: (
    encryptedRefreshToken: string
  ) => string;

  readonly getAccessToken: (
    refreshToken: string
  ) => Promise<string>;

  readonly findOrCreateFolder: (
    accessToken: string,
    folderName?: string
  ) => Promise<{
    readonly id: string;
    readonly name: string;
  }>;

  readonly saveFolderId: (
    ownerUserId: string,
    driveFolderId: string
  ) => Promise<boolean>;
}

const defaultDependencies: GoogleDriveFolderProvisioningDependencies = {
  decryptRefreshToken: defaultDecrypt,
  getAccessToken: (token) => defaultGetAccessToken(token),
  findOrCreateFolder: (token, name) => defaultFindOrCreate(token, name),
  saveFolderId: (uid, fid) => defaultSaveFolderId(uid, fid),
};

export async function provisionGoogleDriveMediaFolderForOwner(
  input: GoogleDriveFolderProvisioningInput,
  dependencies?: GoogleDriveFolderProvisioningDependencies
): Promise<GoogleDriveFolderProvisioningResult> {
  if (!input.ownerUserId || input.ownerUserId.trim() === "") {
    throw new Error("Owner User ID is required.");
  }
  if (!input.encryptedRefreshToken || input.encryptedRefreshToken.trim() === "") {
    throw new Error("Encrypted refresh token is required.");
  }
  if (input.folderName !== undefined) {
    if (input.folderName.trim() === "") {
      throw new Error("Google Drive folder name is required.");
    }
  }

  const trimmedOwnerUserId = input.ownerUserId.trim();
  const trimmedEncryptedRefreshToken = input.encryptedRefreshToken.trim();
  const trimmedFolderName = input.folderName !== undefined ? input.folderName.trim() : undefined;

  const activeDeps = dependencies || defaultDependencies;

  let decryptedToken = "";
  try {
    decryptedToken = activeDeps.decryptRefreshToken(trimmedEncryptedRefreshToken);
  } catch {
    throw new Error("Google Drive refresh token decryption failed.");
  }

  let accessToken = "";
  try {
    accessToken = await activeDeps.getAccessToken(decryptedToken);
  } catch {
    throw new Error("Google Drive access token refresh failed.");
  }

  let folder: { readonly id: string; readonly name: string };
  try {
    folder = await activeDeps.findOrCreateFolder(accessToken, trimmedFolderName);
  } catch {
    throw new Error("Google Drive media folder provisioning failed.");
  }

  if (!folder.id || folder.id.trim() === "" || !folder.name || folder.name.trim() === "") {
    throw new Error("Google Drive folder provisioning returned an invalid folder.");
  }

  const trimmedFolderId = folder.id.trim();
  const trimmedFolderNameResult = folder.name.trim();

  let saved = false;
  try {
    saved = await activeDeps.saveFolderId(trimmedOwnerUserId, trimmedFolderId);
  } catch {
    throw new Error("Google Drive folder ID persistence failed.");
  }

  if (!saved) {
    throw new Error("Active Google Drive connection was not found while saving the folder ID.");
  }

  return {
    folderId: trimmedFolderId,
    folderName: trimmedFolderNameResult,
  };
}
