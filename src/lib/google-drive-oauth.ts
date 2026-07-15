import "server-only";
import { OAuth2Client } from "google-auth-library";

export interface GoogleDriveOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/**
 * Validates and retrieves the GOOGLE_OAUTH_REDIRECT_URI environment variable.
 * Enforces absolute URL structure, correct pathname, no credentials, no query parameters,
 * no hashes, and HTTPS in production.
 */
export function getGoogleDriveOAuthCallbackUrl(): string {
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  if (!redirectUri) {
    throw new Error("GOOGLE_OAUTH_REDIRECT_URI environment variable is missing.");
  }

  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    throw new Error("GOOGLE_OAUTH_REDIRECT_URI must be a valid absolute URL.");
  }

  if (url.pathname !== "/api/auth/google-drive/callback") {
    throw new Error('GOOGLE_OAUTH_REDIRECT_URI pathname must be exactly "/api/auth/google-drive/callback".');
  }

  if (url.username || url.password) {
    throw new Error("GOOGLE_OAUTH_REDIRECT_URI must not contain username or password credentials.");
  }

  if (url.search) {
    throw new Error("GOOGLE_OAUTH_REDIRECT_URI must not contain query parameters.");
  }

  if (url.hash) {
    throw new Error("GOOGLE_OAUTH_REDIRECT_URI must not contain a URL fragment.");
  }

  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("GOOGLE_OAUTH_REDIRECT_URI must use HTTPS in production.");
  }

  return redirectUri;
}

/**
 * Returns the Google Drive OAuth configuration details if they are complete and valid.
 * Throws an error otherwise.
 */
export function getGoogleDriveOAuthConfig(): GoogleDriveOAuthConfig {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = getGoogleDriveOAuthCallbackUrl();

  if (!clientId || clientId.trim() === "") {
    throw new Error("GOOGLE_OAUTH_CLIENT_ID environment variable is missing or empty.");
  }

  if (!clientSecret || clientSecret.trim() === "") {
    throw new Error("GOOGLE_OAUTH_CLIENT_SECRET environment variable is missing or empty.");
  }

  return {
    clientId,
    clientSecret,
    redirectUri,
  };
}

/**
 * Safe check to verify if the Google Drive OAuth flow is fully configured.
 */
export function isGoogleDriveOAuthConfigured(): boolean {
  try {
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return false;
    }
    getGoogleDriveOAuthCallbackUrl();
    return true;
  } catch {
    return false;
  }
}

/**
 * Instantiates and returns a Google OAuth2Client.
 */
export function createGoogleDriveOAuthClient(): OAuth2Client {
  const config = getGoogleDriveOAuthConfig();
  return new OAuth2Client({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: config.redirectUri,
  });
}

/**
 * Generates the redirect URL for Google OAuth consent screen with offline access.
 */
export function generateGoogleDriveAuthorizationUrl(state: string): string {
  if (!state || state.trim() === "") {
    throw new Error("State parameter is required for Google Drive OAuth authorization.");
  }
  const client = createGoogleDriveOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: true,
    response_type: "code",
    state,
    scope: [
      "openid",
      "email",
      "https://www.googleapis.com/auth/drive.file",
    ],
  });
}

export interface ExchangedGoogleTokens {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  expiryDate: number | null;
}

/**
 * Exchanges a temporary OAuth authorization code for persistent tokens.
 */
export async function exchangeGoogleDriveAuthorizationCode(
  code: string
): Promise<ExchangedGoogleTokens> {
  if (!code || code.trim() === "") {
    throw new Error("Authorization code is required and cannot be empty.");
  }

  const client = createGoogleDriveOAuthClient();
  const { tokens } = await client.getToken(code);

  if (!tokens.access_token) {
    throw new Error("OAuth exchange failed: Access token was not returned by Google.");
  }

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
    idToken: tokens.id_token ?? null,
    expiryDate: tokens.expiry_date ?? null,
  };
}

/**
 * Decodes and verifies a Google ID token, returning the verified and normalized email.
 */
export async function getGoogleAccountEmailFromIdToken(
  idToken: string
): Promise<string> {
  if (!idToken || idToken.trim() === "") {
    throw new Error("ID token is required and cannot be empty.");
  }

  const config = getGoogleDriveOAuthConfig();
  const client = createGoogleDriveOAuthClient();

  try {
    const ticket = await client.verifyIdToken({
      idToken,
      audience: config.clientId,
    });

    const payload = ticket.getPayload();
    if (!payload) {
      throw new Error("Verification failed: ID token payload is empty.");
    }

    const { email, email_verified } = payload;
    if (!email) {
      throw new Error("Verification failed: Email claim is missing in ID token.");
    }

    if (email_verified !== true) {
      throw new Error("Verification failed: Google account email is not verified.");
    }

    return email.trim().toLowerCase();
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    throw new Error(`Google ID token verification failed: ${errorMsg}`);
  }
}

/**
 * Revokes the supplied access or refresh token with Google API.
 * Handles already invalid, expired, or revoked tokens gracefully.
 */
export async function revokeGoogleDriveToken(
  token: string
): Promise<{ revoked: boolean; alreadyInvalid: boolean }> {
  if (!token || token.trim() === "") {
    throw new Error("Token is required for revocation.");
  }

  const client = createGoogleDriveOAuthClient();
  try {
    await client.revokeToken(token);
    return {
      revoked: true,
      alreadyInvalid: false,
    };
  } catch (error: unknown) {
    let status: number | undefined;
    let errorDataStr = "";
    let errorMsg = "";

    if (error && typeof error === "object") {
      const errObj = error as Record<string, unknown>;

      if (errObj.response && typeof errObj.response === "object") {
        const responseObj = errObj.response as Record<string, unknown>;
        if (typeof responseObj.status === "number") {
          status = responseObj.status;
        }
        if (responseObj.data) {
          try {
            errorDataStr = JSON.stringify(responseObj.data);
          } catch {
            // Ignore serialization exceptions
          }
        }
      }

      if (status === undefined && typeof errObj.status === "number") {
        status = errObj.status;
      }

      if (typeof errObj.message === "string") {
        errorMsg = errObj.message;
      }
    }

    if (!errorMsg && error) {
      errorMsg = String(error);
    }

    const isAlreadyInvalid =
      status === 400 ||
      errorMsg.includes("invalid_token") ||
      errorDataStr.includes("invalid_token") ||
      errorMsg.includes("Token expired") ||
      errorMsg.includes("Token revoked");

    if (isAlreadyInvalid) {
      return {
        revoked: true,
        alreadyInvalid: true,
      };
    }

    // Sanitize message: omit raw secret tokens and headers
    throw new Error(`Google token revocation failed: ${errorMsg}`);
  }
}
