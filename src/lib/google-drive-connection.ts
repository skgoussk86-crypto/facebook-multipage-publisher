import "server-only";
import { prisma } from "@/lib/prisma-client";
import { encryptToken, decryptToken } from "@/lib/crypto";

export interface SaveGoogleDriveConnectionInput {
  userId: string;
  googleAccountEmail: string;
  refreshToken: string;
  driveFolderId: string;
}

export interface SaveGoogleDriveConnectionWithoutTokenInput {
  userId: string;
  googleAccountEmail: string;
  driveFolderId: string;
}

/**
 * Retrieves the Google Drive Connection record for a specific user.
 */
export async function getGoogleDriveConnectionForUser(userId: string) {
  if (!userId || userId.trim() === "") {
    throw new Error("User ID is required.");
  }
  return await prisma.googleDriveConnection.findUnique({
    where: { userId },
  });
}

/**
 * Creates or updates a Google Drive connection with a new refresh token.
 */
export async function saveGoogleDriveConnectionForUser(
  input: SaveGoogleDriveConnectionInput
) {
  const { userId, googleAccountEmail, refreshToken, driveFolderId } = input;

  if (!userId || userId.trim() === "") {
    throw new Error("User ID is required.");
  }
  if (!googleAccountEmail || googleAccountEmail.trim() === "") {
    throw new Error("Google account email is required.");
  }
  if (!refreshToken || refreshToken.trim() === "") {
    throw new Error("Refresh token is required.");
  }
  if (!driveFolderId || driveFolderId.trim() === "") {
    throw new Error("Drive folder ID is required.");
  }

  const normalizedEmail = googleAccountEmail.trim().toLowerCase();
  const encryptedRefreshToken = encryptToken(refreshToken);
  const refreshTokenKeyVersion = process.env.GOOGLE_DRIVE_TOKEN_KEY_VERSION || "1";

  const existing = await prisma.googleDriveConnection.findUnique({
    where: { userId },
  });

  const now = new Date();
  let connectedAt = now;

  if (existing) {
    connectedAt = existing.revokedAt === null ? existing.connectedAt : now;
  }

  return await prisma.googleDriveConnection.upsert({
    where: { userId },
    update: {
      googleAccountEmail: normalizedEmail,
      encryptedRefreshToken,
      refreshTokenKeyVersion,
      driveFolderId,
      connectedAt,
      revokedAt: null,
    },
    create: {
      userId,
      googleAccountEmail: normalizedEmail,
      encryptedRefreshToken,
      refreshTokenKeyVersion,
      driveFolderId,
      connectedAt,
      revokedAt: null,
    },
  });
}

/**
 * Updates an existing Google Drive connection metadata without modifying the refresh token.
 */
export async function saveGoogleDriveConnectionWithoutNewRefreshToken(
  input: SaveGoogleDriveConnectionWithoutTokenInput
) {
  const { userId, googleAccountEmail, driveFolderId } = input;

  if (!userId || userId.trim() === "") {
    throw new Error("User ID is required.");
  }
  if (!googleAccountEmail || googleAccountEmail.trim() === "") {
    throw new Error("Google account email is required.");
  }
  if (!driveFolderId || driveFolderId.trim() === "") {
    throw new Error("Drive folder ID is required.");
  }

  const existing = await prisma.googleDriveConnection.findUnique({
    where: { userId },
  });

  if (!existing || !existing.encryptedRefreshToken) {
    throw new Error("Google Drive connection update failed: No existing credentials found for this user.");
  }

  const normalizedEmail = googleAccountEmail.trim().toLowerCase();
  const now = new Date();
  const connectedAt = existing.revokedAt !== null ? now : existing.connectedAt;

  return await prisma.googleDriveConnection.update({
    where: { userId },
    data: {
      googleAccountEmail: normalizedEmail,
      driveFolderId,
      connectedAt,
      revokedAt: null,
    },
  });
}

/**
 * Marks a specific user's Google Drive connection as revoked.
 */
export async function markGoogleDriveConnectionRevoked(userId: string): Promise<boolean> {
  if (!userId || userId.trim() === "") {
    throw new Error("User ID is required.");
  }

  const existing = await prisma.googleDriveConnection.findUnique({
    where: { userId },
  });

  if (!existing) {
    return false;
  }

  await prisma.googleDriveConnection.update({
    where: { userId },
    data: {
      revokedAt: new Date(),
    },
  });

  return true;
}

/**
 * Retrieves and decrypts the Google Drive refresh token for a specific user.
 * Returns null if connection is missing or revoked.
 */
export async function getGoogleDriveRefreshTokenForUser(
  userId: string
): Promise<string | null> {
  if (!userId || userId.trim() === "") {
    throw new Error("User ID is required.");
  }

  const connection = await getGoogleDriveConnectionForUser(userId);
  if (!connection) {
    return null;
  }

  if (connection.revokedAt !== null) {
    return null;
  }

  const encryptedToken = connection.encryptedRefreshToken;
  if (!encryptedToken) {
    return null;
  }

  let decryptedToken: string;
  try {
    decryptedToken = decryptToken(encryptedToken);
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to decrypt refresh token: ${errorMsg}`);
  }

  if (!decryptedToken || decryptedToken.trim() === "") {
    throw new Error("Decrypted refresh token is empty or invalid.");
  }

  return decryptedToken;
}
