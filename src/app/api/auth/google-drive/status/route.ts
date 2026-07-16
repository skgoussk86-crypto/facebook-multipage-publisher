import { NextRequest, NextResponse } from "next/server";
import { User } from "@prisma/client";
import { getSessionUser } from "@/lib/auth";
import { getGoogleDriveConfig, GoogleDriveConfig } from "@/lib/google-drive/google-drive-config";
import { GoogleDriveConnectionRecord } from "@/lib/google-drive/google-drive-connection-repository";
import { prisma } from "@/lib/prisma-client";

export interface StatusDependencies {
  getSessionUser?: () => Promise<User | null>;
  getConfig?: () => GoogleDriveConfig;
  getConnection?: (ownerId: string) => Promise<GoogleDriveConnectionRecord | null>;
}

export async function handleStatus(request: NextRequest, deps?: StatusDependencies) {
  try {
    const getSession = deps?.getSessionUser || getSessionUser;
    const getConfig = deps?.getConfig || getGoogleDriveConfig;

    const user = await getSession();
    if (!user) {
      return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
    }

    let config: GoogleDriveConfig;
    try {
      config = getConfig();
    } catch {
      return NextResponse.json({ error: "GOOGLE_DRIVE_NOT_CONFIGURED" }, { status: 500 });
    }

    if (user.id !== config.ownerUserId) {
      return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
    }

    if (user.role !== "ADMIN" || user.status !== "ACTIVE" || user.approvalStatus !== "APPROVED") {
      return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
    }

    let connection: GoogleDriveConnectionRecord | null;
    if (deps?.getConnection) {
      connection = await deps.getConnection(config.ownerUserId);
    } else {
      connection = (await prisma.googleDriveConnection.findUnique({
        where: { userId: config.ownerUserId },
      })) as GoogleDriveConnectionRecord | null;
    }

    if (!connection) {
      return NextResponse.json({
        connected: false,
        revoked: false,
        connectedAt: null,
        updatedAt: null,
        googleAccountEmail: null,
        driveFolderConfigured: false,
      });
    }

    const connected = connection.revokedAt === null && connection.encryptedRefreshToken !== "REVOKED" && connection.encryptedRefreshToken !== "";
    const revoked = connection.revokedAt !== null;
    const driveFolderConfigured = !!connection.driveFolderId;

    return NextResponse.json({
      connected,
      revoked,
      connectedAt: connection.connectedAt ? connection.connectedAt.toISOString() : null,
      updatedAt: connection.updatedAt ? connection.updatedAt.toISOString() : null,
      googleAccountEmail: connection.googleAccountEmail,
      driveFolderConfigured,
    });
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error("Error in Google Drive status route:", errorMsg);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  return await handleStatus(request);
}
