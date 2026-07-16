import { NextRequest, NextResponse } from "next/server";
import { User } from "@prisma/client";
import { OAuth2Client } from "google-auth-library";
import { getSessionUser } from "@/lib/auth";
import { getGoogleDriveConfig, GoogleDriveConfig } from "@/lib/google-drive/google-drive-config";
import { getActiveConnectionForOwner, upsertConnection, GoogleDriveConnectionRecord } from "@/lib/google-drive/google-drive-connection-repository";
import { verifyOAuthState } from "@/lib/google-drive/google-drive-oauth-state";
import { createGoogleDriveOAuthClient, exchangeAuthorizationCode } from "@/lib/google-drive/google-drive-oauth-client";
import { encryptRefreshToken } from "@/lib/google-drive/google-drive-token-crypto";

export interface CallbackTokensDto {
  accessToken: string;
  refreshToken: string | null;
  expiryDate: number | null;
}

export interface CallbackDependencies {
  getSessionUser?: () => Promise<User | null>;
  getConfig?: () => GoogleDriveConfig;
  verifyState?: (state: string, cookieNonce: string, expectedUserId: string, ownerUserId: string) => boolean;
  exchangeCode?: (code: string, client?: OAuth2Client) => Promise<CallbackTokensDto>;
  getActiveConnection?: (ownerId: string) => Promise<GoogleDriveConnectionRecord | null>;
  upsertConn?: (userId: string, data: { encryptedRefreshToken: string; refreshTokenKeyVersion: string; googleAccountEmail?: string | null; driveFolderId?: string | null }) => Promise<GoogleDriveConnectionRecord>;
  encryptToken?: (plainText: string, keyHex?: string) => string;
  createOAuthClient?: (config: GoogleDriveConfig) => OAuth2Client;
}

function createCallbackRedirect(
  url: string
): NextResponse {
  const response = NextResponse.redirect(url);

  // Clear cookie using response.cookies
  response.cookies.set("google_drive_oauth_state_nonce", "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/api/auth/google-drive/callback",
    maxAge: 0,
  });

  return response;
}

export async function handleCallback(request: NextRequest, deps?: CallbackDependencies) {
  const getConfig = deps?.getConfig || getGoogleDriveConfig;
  const baseUrl = request.nextUrl.origin;

  let config: GoogleDriveConfig;
  try {
    config = getConfig();
  } catch {
    return createCallbackRedirect(`${baseUrl}/settings/storage?error=google_oauth_not_configured`);
  }

  const getSession = deps?.getSessionUser || getSessionUser;
  const user = await getSession();

  if (!user) {
    return createCallbackRedirect(`${baseUrl}/login?callbackUrl=/settings/storage`);
  }

  if (user.id !== config.ownerUserId) {
    return createCallbackRedirect(`${baseUrl}/settings/storage?error=google_drive_connection_failed`);
  }

  if (user.role !== "ADMIN" || user.status !== "ACTIVE" || user.approvalStatus !== "APPROVED") {
    return createCallbackRedirect(`${baseUrl}/settings/storage?error=google_drive_connection_failed`);
  }

  const searchParams = request.nextUrl.searchParams;
  const state = searchParams.get("state") || "";
  const code = searchParams.get("code") || "";
  const errorParam = searchParams.get("error");

  // Read state nonce cookie
  const cookieNonce = request.cookies.get("google_drive_oauth_state_nonce")?.value;

  // 1. Check for error parameters returned by Google
  if (errorParam) {
    console.error("Google Drive OAuth callback error parameter returned:", errorParam);
    return createCallbackRedirect(`${baseUrl}/settings/storage?error=google_oauth_cancelled`);
  }

  // 2. Validate state and nonce cookie
  const verifyStateFn = deps?.verifyState || verifyOAuthState;
  const isStateValid = verifyStateFn(state, cookieNonce || "", user.id, config.ownerUserId);

  if (!isStateValid || !cookieNonce) {
    console.error("Google Drive OAuth state validation failed.");
    return createCallbackRedirect(`${baseUrl}/settings/storage?error=google_oauth_state_invalid`);
  }

  // 3. Ensure authorization code is present
  if (!code || code.trim() === "") {
    return createCallbackRedirect(`${baseUrl}/settings/storage?error=google_oauth_code_missing`);
  }

  try {
    const createClient = deps?.createOAuthClient || createGoogleDriveOAuthClient;
    const oauthClient = createClient(config);

    // 4. Exchange authorization code
    const exchangeFn = deps?.exchangeCode || exchangeAuthorizationCode;
    let tokens: CallbackTokensDto;
    try {
      tokens = await exchangeFn(code, oauthClient);
    } catch (exchangeErr: unknown) {
      const errorMsg = exchangeErr instanceof Error ? exchangeErr.message : String(exchangeErr);
      console.error("Token exchange failed:", errorMsg);
      return createCallbackRedirect(`${baseUrl}/settings/storage?error=google_token_exchange_failed`);
    }

    const { refreshToken } = tokens;

    // 5. Check for active connection
    const getActiveConn = deps?.getActiveConnection || getActiveConnectionForOwner;
    const activeConnection = await getActiveConn(config.ownerUserId);

    if (!refreshToken && !activeConnection) {
      console.error("Google Drive connection failed: Missing refresh token on first connection or revoked connection.");
      return createCallbackRedirect(`${baseUrl}/settings/storage?error=google_refresh_token_missing`);
    }

    // 6. Persist or update credentials with email null
    const encryptFn = deps?.encryptToken || encryptRefreshToken;
    const upsertConnFn = deps?.upsertConn || upsertConnection;

    let encryptedRefreshToken = activeConnection?.encryptedRefreshToken || "";
    let refreshTokenKeyVersion = activeConnection?.refreshTokenKeyVersion || "1";

    if (refreshToken) {
      encryptedRefreshToken = encryptFn(refreshToken, config.encryptionKey);
      refreshTokenKeyVersion = "1";
    }

    try {
      await upsertConnFn(user.id, {
        encryptedRefreshToken,
        refreshTokenKeyVersion,
        googleAccountEmail: null,
        driveFolderId: activeConnection?.driveFolderId || null,
      });
    } catch (dbErr: unknown) {
      const errorMsg = dbErr instanceof Error ? dbErr.message : String(dbErr);
      console.error("Database upsert failed:", errorMsg);
      return createCallbackRedirect(`${baseUrl}/settings/storage?error=google_drive_connection_failed`);
    }

    return createCallbackRedirect(`${baseUrl}/settings/storage?success=google_drive_connected`);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("Unexpected error in callback:", errorMsg);
    return createCallbackRedirect(`${baseUrl}/settings/storage?error=google_drive_connection_failed`);
  }
}

export async function GET(request: NextRequest) {
  return await handleCallback(request);
}
