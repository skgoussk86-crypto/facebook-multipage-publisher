import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, verifyAdminSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma-client";
import {
  getGoogleDriveConnectionForUser,
  getGoogleDriveRefreshTokenForUser,
  markGoogleDriveConnectionRevoked,
} from "@/lib/google-drive-connection";
import {
  isGoogleDriveOAuthConfigured,
  getGoogleDriveOAuthCallbackUrl,
  revokeGoogleDriveToken,
} from "@/lib/google-drive-oauth";

export async function GET() {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
    }

    const connection = await getGoogleDriveConnectionForUser(user.id);
    const oauthConfigured = isGoogleDriveOAuthConfigured();
    let callbackUrl: string | null = null;

    if (oauthConfigured) {
      try {
        callbackUrl = getGoogleDriveOAuthCallbackUrl();
      } catch {
        // Leave callbackUrl as null if validation failed
      }
    }

    if (!connection) {
      return NextResponse.json(
        {
          connected: false,
          googleAccountEmail: null,
          driveFolderId: null,
          connectedAt: null,
          updatedAt: null,
          revokedAt: null,
          oauthConfigured,
          callbackUrl,
        },
        { status: 200 }
      );
    }

    const connected = connection.revokedAt === null;

    return NextResponse.json(
      {
        connected,
        googleAccountEmail: connection.googleAccountEmail,
        driveFolderId: connection.driveFolderId,
        connectedAt: connection.connectedAt.toISOString(),
        updatedAt: connection.updatedAt.toISOString(),
        revokedAt: connection.revokedAt ? connection.revokedAt.toISOString() : null,
        oauthConfigured,
        callbackUrl,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("Error in Google Drive connection check route:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const user = await verifyAdminSession(request);
    if (!user) {
      return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
    }

    const connection = await getGoogleDriveConnectionForUser(user.id);
    if (!connection || connection.revokedAt !== null) {
      return NextResponse.json(
        {
          disconnected: true,
          alreadyDisconnected: true,
          remoteRevoked: false,
          remoteAlreadyInvalid: false,
          remoteRevocationFailed: false,
        },
        { status: 200 }
      );
    }

    let refreshToken: string | null = null;
    try {
      refreshToken = await getGoogleDriveRefreshTokenForUser(user.id);
    } catch (tokenError) {
      console.warn("Failed to retrieve or decrypt refresh token during disconnect:", tokenError);
    }

    let remoteRevoked = false;
    let remoteAlreadyInvalid = false;
    let remoteRevocationFailed = false;

    if (refreshToken) {
      try {
        const revResult = await revokeGoogleDriveToken(refreshToken);
        remoteRevoked = revResult.revoked;
        remoteAlreadyInvalid = revResult.alreadyInvalid;
      } catch (revError) {
        console.warn("Remote Google token revocation failed during disconnect:", revError);
        remoteRevocationFailed = true;
      }
    } else {
      remoteRevocationFailed = true;
    }

    // Perform local database revocation
    try {
      await markGoogleDriveConnectionRevoked(user.id);
    } catch (dbError) {
      console.error("Database save failed during Google Drive connection disconnect:", dbError);
      return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }

    // Save audit log
    await prisma.auditLog.create({
      data: {
        action: "GOOGLE_DRIVE_DISCONNECT",
        details: `Disconnected Google Drive connection for user ${user.id}. existed: true, alreadyDisconnected: false, remoteRevoked: ${remoteRevoked}, remoteAlreadyInvalid: ${remoteAlreadyInvalid}, remoteRevocationFailed: ${remoteRevocationFailed}`,
        userId: user.id,
      },
    });

    return NextResponse.json(
      {
        disconnected: true,
        alreadyDisconnected: false,
        remoteRevoked,
        remoteAlreadyInvalid,
        remoteRevocationFailed,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("Error in Google Drive disconnect route:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
