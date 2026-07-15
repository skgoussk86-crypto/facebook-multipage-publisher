import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import crypto from "crypto";
import { getSessionUser } from "@/lib/auth";
import { generateGoogleDriveAuthorizationUrl } from "@/lib/google-drive-oauth";

export async function GET(request: NextRequest) {
  try {
    const user = await getSessionUser();
    if (!user) {
      const loginUrl = `${request.nextUrl.origin}/login?callbackUrl=/settings/storage`;
      return NextResponse.redirect(loginUrl);
    }

    // Generate secure state for CSRF validation using at least 32 random bytes
    const state = crypto.randomBytes(32).toString("hex");

    // Save state in HTTP-only cookie
    const cookieStore = await cookies();
    cookieStore.set("google_drive_oauth_state", state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 600, // 10 minutes validation window
    });

    let authUrl: string;
    try {
      authUrl = generateGoogleDriveAuthorizationUrl(state);
    } catch (configError: unknown) {
      const errorMsg = configError instanceof Error ? configError.message : String(configError);
      // Log only a short sanitized server error without credentials
      console.error(`Google OAuth Initiate Error: ${errorMsg}`);
      const redirectUrl = `${request.nextUrl.origin}/settings/storage?error=google_oauth_not_configured`;
      return NextResponse.redirect(redirectUrl);
    }

    return NextResponse.redirect(authUrl);
  } catch (error) {
    console.error("Error in Google Drive OAuth initiate route:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
