import "server-only";
import { OAuth2Client } from "google-auth-library";
import { getGoogleDriveConfig, GoogleDriveConfig } from "./google-drive-config";

export function createGoogleDriveOAuthClient(configOverride?: GoogleDriveConfig): OAuth2Client {
  const config = configOverride || getGoogleDriveConfig();
  return new OAuth2Client({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: config.redirectUri,
  });
}

export interface ExchangedTokens {
  accessToken: string;
  refreshToken: string | null;
  expiryDate: number | null;
}

export async function exchangeAuthorizationCode(
  code: string,
  client?: OAuth2Client
): Promise<ExchangedTokens> {
  if (!code || code.trim() === "") {
    throw new Error("Authorization code is required.");
  }

  const oauthClient = client || createGoogleDriveOAuthClient();
  const { tokens } = await oauthClient.getToken(code);

  if (!tokens.access_token) {
    throw new Error("Access token missing from Google response.");
  }

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || null,
    expiryDate: tokens.expiry_date || null,
  };
}
