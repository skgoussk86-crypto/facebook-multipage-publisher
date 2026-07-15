import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import crypto from "crypto";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma-client";
import {
  exchangeGoogleDriveAuthorizationCode,
  getGoogleAccountEmailFromIdToken,
} from "@/lib/google-drive-oauth";
import { findOrCreateGoogleDriveMediaFolder } from "@/lib/google-drive-folder";
import {
  saveGoogleDriveConnectionForUser,
  saveGoogleDriveConnectionWithoutNewRefreshToken,
} from "@/lib/google-drive-connection";

export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) {
    const loginUrl = `${request.nextUrl.origin}/login?callbackUrl=/settings/storage`;
    return NextResponse.redirect(loginUrl);
  }

  const cookieStore = await cookies();
  const savedState = cookieStore.get("google_drive_oauth_state")?.value;

  // Immediately clear the state cookie on every callback attempt
  cookieStore.set("google_drive_oauth_state", "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });

  const searchParams = request.nextUrl.searchParams;
  const state = searchParams.get("state");
  const code = searchParams.get("code");
  const error = searchParams.get("error");

  // 1. CSRF Verification
  if (!state || !savedState || state.length !== savedState.length) {
    return NextResponse.redirect(`${request.nextUrl.origin}/settings/storage?error=google_oauth_state_invalid`);
  }

  const stateBuffer = Buffer.from(state);
  const savedStateBuffer = Buffer.from(savedState);

  if (!crypto.timingSafeEqual(stateBuffer, savedStateBuffer)) {
    return NextResponse.redirect(`${request.nextUrl.origin}/settings/storage?error=google_oauth_state_invalid`);
  }

  // 2. Handle Google errors/cancellations
  if (error) {
    return NextResponse.redirect(`${request.nextUrl.origin}/settings/storage?error=google_oauth_cancelled`);
  }

  // 3. Ensure authorization code is present
  if (!code || code.trim() === "") {
    return NextResponse.redirect(`${request.nextUrl.origin}/settings/storage?error=google_oauth_code_missing`);
  }

  try {
    // 4. Exchange authorization code for tokens
    let tokens;
    try {
      tokens = await exchangeGoogleDriveAuthorizationCode(code);
    } catch (exchangeError: unknown) {
      const errorMsg = exchangeError instanceof Error ? exchangeError.message : String(exchangeError);
      console.error(`Google Drive OAuth code exchange failed: ${errorMsg}`);
      return NextResponse.redirect(`${request.nextUrl.origin}/settings/storage?error=google_token_exchange_failed`);
    }

    const { accessToken, idToken, refreshToken } = tokens;
    if (!accessToken || !idToken) {
      console.error("Google Drive OAuth failed: Missing required accessToken or idToken in response.");
      return NextResponse.redirect(`${request.nextUrl.origin}/settings/storage?error=google_token_exchange_failed`);
    }

    // 5. Get verified Google account email
    let email: string;
    try {
      email = await getGoogleAccountEmailFromIdToken(idToken);
    } catch (emailError: unknown) {
      const errorMsg = emailError instanceof Error ? emailError.message : String(emailError);
      console.error(`Google Drive Account verification failed: ${errorMsg}`);
      return NextResponse.redirect(`${request.nextUrl.origin}/settings/storage?error=google_account_invalid`);
    }

    // 6. Find or create the dedicated storage folder
    let folder;
    try {
      folder = await findOrCreateGoogleDriveMediaFolder(accessToken);
    } catch (folderError: unknown) {
      const errorMsg = folderError instanceof Error ? folderError.message : String(folderError);
      console.error(`Google Drive Folder initialization failed: ${errorMsg}`);
      return NextResponse.redirect(`${request.nextUrl.origin}/settings/storage?error=google_drive_folder_failed`);
    }

    // 7. Save or update Connection settings
    try {
      if (refreshToken) {
        await saveGoogleDriveConnectionForUser({
          userId: user.id,
          googleAccountEmail: email,
          refreshToken,
          driveFolderId: folder.id,
        });
      } else {
        try {
          await saveGoogleDriveConnectionWithoutNewRefreshToken({
            userId: user.id,
            googleAccountEmail: email,
            driveFolderId: folder.id,
          });
        } catch (saveError: unknown) {
          const saveMsg = saveError instanceof Error ? saveError.message : String(saveError);
          if (saveMsg.includes("No existing credentials found")) {
            return NextResponse.redirect(`${request.nextUrl.origin}/settings/storage?error=google_refresh_token_missing`);
          }
          throw saveError;
        }
      }
    } catch (saveError: unknown) {
      const errorMsg = saveError instanceof Error ? saveError.message : String(saveError);
      console.error(`Google Drive connection save failed: ${errorMsg}`);
      return NextResponse.redirect(`${request.nextUrl.origin}/settings/storage?error=google_drive_connection_failed`);
    }

    // 8. Create audit log of success connection
    await prisma.auditLog.create({
      data: {
        action: "GOOGLE_DRIVE_CONNECT",
        details: `Connected Google Drive account ${email} with folder ID ${folder.id}. New refresh token returned: ${refreshToken ? "yes" : "no"}.`,
        userId: user.id,
      },
    });

    return NextResponse.redirect(`${request.nextUrl.origin}/settings/storage?success=google_drive_connected`);
  } catch (error) {
    console.error("Unexpected error in Google Drive OAuth callback route:", error);
    return NextResponse.redirect(`${request.nextUrl.origin}/settings/storage?error=google_drive_connection_failed`);
  }
}
