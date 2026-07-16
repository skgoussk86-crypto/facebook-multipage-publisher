import "server-only";
import crypto from "crypto";
import { prisma as defaultPrisma } from "@/lib/prisma-client";
import { encryptRefreshToken } from "./google-drive-token-crypto";

export interface GoogleDriveConnectionRecord {
  id: string;
  userId: string;
  encryptedRefreshToken: string;
  refreshTokenKeyVersion: string;
  googleAccountEmail: string | null;
  driveFolderId: string | null;
  connectedAt: Date;
  updatedAt: Date;
  revokedAt: Date | null;
}

export async function getActiveConnectionForOwner(
  ownerUserId: string,
  prisma = defaultPrisma
): Promise<GoogleDriveConnectionRecord | null> {
  if (!ownerUserId || ownerUserId.trim() === "") {
    throw new Error("Owner User ID is required.");
  }
  const conn = await prisma.googleDriveConnection.findUnique({
    where: { userId: ownerUserId },
  });
  if (!conn || conn.revokedAt !== null) {
    return null;
  }
  return conn as GoogleDriveConnectionRecord;
}

export async function upsertConnection(
  userId: string,
  data: {
    encryptedRefreshToken: string;
    refreshTokenKeyVersion: string;
    googleAccountEmail?: string | null;
    driveFolderId?: string | null;
  },
  prisma = defaultPrisma
): Promise<GoogleDriveConnectionRecord> {
  if (!userId || userId.trim() === "") {
    throw new Error("User ID is required.");
  }

  const existing = await prisma.googleDriveConnection.findUnique({
    where: { userId },
  });

  const now = new Date();
  const connectedAt = existing && existing.revokedAt === null ? existing.connectedAt : now;

  const result = await prisma.googleDriveConnection.upsert({
    where: { userId },
    update: {
      encryptedRefreshToken: data.encryptedRefreshToken,
      refreshTokenKeyVersion: data.refreshTokenKeyVersion,
      googleAccountEmail: data.googleAccountEmail ?? null,
      driveFolderId: data.driveFolderId ?? null,
      connectedAt,
      revokedAt: null,
      updatedAt: now,
    },
    create: {
      userId,
      encryptedRefreshToken: data.encryptedRefreshToken,
      refreshTokenKeyVersion: data.refreshTokenKeyVersion,
      googleAccountEmail: data.googleAccountEmail ?? null,
      driveFolderId: data.driveFolderId ?? null,
      connectedAt,
      revokedAt: null,
    },
  });

  return result as GoogleDriveConnectionRecord;
}

export async function markRevoked(
  userId: string,
  prisma = defaultPrisma
): Promise<GoogleDriveConnectionRecord | null> {
  if (!userId || userId.trim() === "") {
    throw new Error("User ID is required.");
  }
  const existing = await prisma.googleDriveConnection.findUnique({
    where: { userId },
  });
  if (!existing) {
    return null;
  }
  const result = await prisma.googleDriveConnection.update({
    where: { userId },
    data: {
      revokedAt: new Date(),
    },
  });
  return result as GoogleDriveConnectionRecord;
}

export async function disconnectConnection(
  userId: string,
  prisma = defaultPrisma
): Promise<GoogleDriveConnectionRecord | null> {
  if (!userId || userId.trim() === "") {
    throw new Error("User ID is required.");
  }
  const existing = await prisma.googleDriveConnection.findUnique({
    where: { userId },
  });

  const tombstonePlain = crypto.randomBytes(32).toString("hex");
  const encryptedTombstone = encryptRefreshToken(tombstonePlain);

  if (!existing) {
    return null;
  }

  const result = await prisma.googleDriveConnection.update({
    where: { userId },
    data: {
      encryptedRefreshToken: encryptedTombstone,
      revokedAt: new Date(),
    },
  });
  return result as GoogleDriveConnectionRecord;
}

export interface GoogleDriveFolderIdPersistenceInput {
  readonly ownerUserId: string;
  readonly driveFolderId: string;
}

export interface GoogleDriveFolderIdPersistence {
  readonly updateActiveOwnerFolderId: (
    input: GoogleDriveFolderIdPersistenceInput
  ) => Promise<number>;
}

export async function saveDriveFolderIdForOwner(
  ownerUserId: string,
  driveFolderId: string,
  persistence?: GoogleDriveFolderIdPersistence
): Promise<boolean> {
  if (!ownerUserId || ownerUserId.trim() === "") {
    throw new Error("Owner User ID is required.");
  }
  if (!driveFolderId || driveFolderId.trim() === "") {
    throw new Error("Drive folder ID is required.");
  }

  const trimmedOwnerUserId = ownerUserId.trim();
  const trimmedDriveFolderId = driveFolderId.trim();

  const activePersistence = persistence || {
    updateActiveOwnerFolderId: async (input) => {
      const result = await defaultPrisma.googleDriveConnection.updateMany({
        where: {
          userId: input.ownerUserId,
          revokedAt: null,
        },
        data: {
          driveFolderId: input.driveFolderId,
        },
      });
      return result.count;
    },
  };

  const count = await activePersistence.updateActiveOwnerFolderId({
    ownerUserId: trimmedOwnerUserId,
    driveFolderId: trimmedDriveFolderId,
  });

  if (count === 1) {
    return true;
  }
  if (count === 0) {
    return false;
  }
  throw new Error("Unexpected Google Drive connection update count.");
}
