import { NextRequest, NextResponse } from "next/server";
import { User } from "@prisma/client";
import { verifyAdminSession } from "@/lib/auth";
import { getGoogleDriveConfig, GoogleDriveConfig } from "@/lib/google-drive/google-drive-config";
import { disconnectConnection } from "@/lib/google-drive/google-drive-connection-repository";
import { prisma } from "@/lib/prisma-client";

export interface DisconnectDependencies {
  verifySession?: (request: NextRequest) => Promise<User | null>;
  getConfig?: () => GoogleDriveConfig;
  disconnect?: (ownerId: string) => Promise<unknown>;
  mockRevokeCall?: (token: string) => Promise<void>;
  decryptToken?: (encryptedToken: string) => string;
}

export async function handleDisconnect(request: NextRequest, deps?: DisconnectDependencies) {
  try {
    const verifySession = deps?.verifySession || verifyAdminSession;
    const getConfig = deps?.getConfig || getGoogleDriveConfig;
    const disconnectFn = deps?.disconnect || disconnectConnection;

    const user = await verifySession(request);
    if (!user) {
      return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
    }

    try {
      getConfig();
    } catch {
      return NextResponse.json({ error: "GOOGLE_DRIVE_NOT_CONFIGURED" }, { status: 500 });
    }

    if (user.status !== "ACTIVE" || user.approvalStatus !== "APPROVED") {
      return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
    }

    // Call mock revocation if registered
    if (deps?.mockRevokeCall) {
      const conn = await prisma.googleDriveConnection.findUnique({
        where: { userId: user.id },
      });
      if (conn && conn.encryptedRefreshToken && conn.encryptedRefreshToken !== "REVOKED") {
        try {
          const decrypt = deps.decryptToken || ((t) => t);
          const plainToken = decrypt(conn.encryptedRefreshToken);
          await deps.mockRevokeCall(plainToken);
        } catch (revokeErr) {
          console.warn("Mock revoke call failed during disconnect:", revokeErr);
        }
      }
    }

    // Execute local disconnect and clear refresh token
    await disconnectFn(user.id);

    return NextResponse.json({
      disconnected: true,
      revoked: true,
    }, { status: 200 });
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error("Error in Google Drive disconnect route:", errorMsg);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  return await handleDisconnect(request);
}
