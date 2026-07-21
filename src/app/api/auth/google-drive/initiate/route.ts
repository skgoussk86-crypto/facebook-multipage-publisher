import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { User } from "@prisma/client";
import { OAuth2Client } from "google-auth-library";
import { getSessionUser } from "@/lib/auth";
import { getGoogleDriveConfig, GoogleDriveConfig } from "@/lib/google-drive/google-drive-config";
import { getActiveConnectionForOwner } from "@/lib/google-drive/google-drive-connection-repository";
import { generateOAuthState } from "@/lib/google-drive/google-drive-oauth-state";
import { createGoogleDriveOAuthClient } from "@/lib/google-drive/google-drive-oauth-client";

export interface InitiateDependencies {
  getSessionUser?: () => Promise<User | null>;
  getConfig?: () => GoogleDriveConfig;
  getActiveConnection?: (ownerId: string) => Promise<unknown>;
  generateState?: (userId: string) => { state: string; nonce: string };
  createOAuthClient?: (config: GoogleDriveConfig) => OAuth2Client;
  setCookie?: (name: string, value: string, options: unknown) => Promise<void> | void;
}

export async function handleInitiate(request: NextRequest, deps?: InitiateDependencies) {
  try {
    const getSession = deps?.getSessionUser || getSessionUser;
    const getConfig = deps?.getConfig || getGoogleDriveConfig;
    const getActiveConn = deps?.getActiveConnection || getActiveConnectionForOwner;
    const genState = deps?.generateState || generateOAuthState;
    const createClient = deps?.createOAuthClient || createGoogleDriveOAuthClient;

    const user = await getSession();
    if (!user) {
      return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
    }

    let config: GoogleDriveConfig;
    try {
      config = getConfig();
    } catch (configErr: unknown) {
      const errorMsg = configErr instanceof Error ? configErr.message : String(configErr);
      return NextResponse.json({ error: "GOOGLE_DRIVE_NOT_CONFIGURED", details: errorMsg }, { status: 500 });
    }

    if (user.status !== "ACTIVE" || user.approvalStatus !== "APPROVED") {
      return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
    }

    const activeConnection = await getActiveConn(user.id);
    const hasActiveToken = !!activeConnection;

    const searchParams = request.nextUrl.searchParams;
    const explicitReconnect = searchParams.get("reconnect") === "true";

    const prompt = (!hasActiveToken || explicitReconnect) ? "consent" : undefined;

    const { state, nonce } = genState(user.id);

    const isHttps = request.nextUrl.protocol === "https:" || process.env.NODE_ENV === "production";
    const cookieOptions = {
      httpOnly: true,
      secure: isHttps,
      sameSite: "lax" as const,
      path: "/api/auth/google-drive/callback",
      maxAge: 600, // 10 minutes
    };

    if (deps?.setCookie) {
      await deps.setCookie("google_drive_oauth_state_nonce", nonce, cookieOptions);
    } else {
      const cookieStore = await cookies();
      cookieStore.set("google_drive_oauth_state_nonce", nonce, cookieOptions);
    }

    const oauthClient = createClient(config);
    const authUrl = oauthClient.generateAuthUrl({
      access_type: "offline",
      prompt,
      include_granted_scopes: true,
      response_type: "code",
      state,
      redirect_uri: config.redirectUri,
      scope: ["https://www.googleapis.com/auth/drive.file"],
    });

    return NextResponse.redirect(authUrl);
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error("Error in Google Drive initiate route:", errorMsg);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  return await handleInitiate(request);
}
