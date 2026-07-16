import "server-only";

export interface GoogleDriveConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  encryptionKey: string;
  ownerUserId: string;
}

export function validateRedirectUri(redirectUri: string): string {
  if (!redirectUri) {
    throw new Error("GOOGLE_DRIVE_REDIRECT_URI is missing.");
  }

  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    throw new Error("GOOGLE_DRIVE_REDIRECT_URI must be a valid absolute URL.");
  }

  if (url.pathname !== "/api/auth/google-drive/callback") {
    throw new Error('GOOGLE_DRIVE_REDIRECT_URI pathname must be exactly "/api/auth/google-drive/callback".');
  }

  if (url.username || url.password) {
    throw new Error("GOOGLE_DRIVE_REDIRECT_URI must not contain credentials.");
  }

  if (url.search) {
    throw new Error("GOOGLE_DRIVE_REDIRECT_URI must not contain query parameters.");
  }

  if (url.hash) {
    throw new Error("GOOGLE_DRIVE_REDIRECT_URI must not contain a URL fragment.");
  }

  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("GOOGLE_DRIVE_REDIRECT_URI must use HTTPS in production.");
  }

  return redirectUri;
}

export function getGoogleDriveConfig(): GoogleDriveConfig {
  const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_DRIVE_REDIRECT_URI;
  const encryptionKey = process.env.GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY;
  const ownerUserId = process.env.GOOGLE_DRIVE_STORAGE_OWNER_USER_ID;

  if (!clientId || clientId.trim() === "") {
    throw new Error("GOOGLE_DRIVE_CLIENT_ID is missing or empty.");
  }
  if (!clientSecret || clientSecret.trim() === "") {
    throw new Error("GOOGLE_DRIVE_CLIENT_SECRET is missing or empty.");
  }
  if (!ownerUserId || ownerUserId.trim() === "") {
    throw new Error("GOOGLE_DRIVE_STORAGE_OWNER_USER_ID is missing or empty.");
  }

  const validatedUri = validateRedirectUri(redirectUri || "");

  if (!encryptionKey || encryptionKey.length !== 64) {
    throw new Error("GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY must be a 64-character hex string.");
  }

  // Validate hex string format
  if (!/^[0-9a-fA-F]{64}$/.test(encryptionKey)) {
    throw new Error("GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY must be a valid hex string.");
  }

  return {
    clientId,
    clientSecret,
    redirectUri: validatedUri,
    encryptionKey,
    ownerUserId,
  };
}
