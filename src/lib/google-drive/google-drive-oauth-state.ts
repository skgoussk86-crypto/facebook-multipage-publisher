import "server-only";
import crypto from "crypto";
import { encryptRefreshToken, decryptRefreshToken } from "./google-drive-token-crypto";

export interface OAuthStatePayload {
  version: "v1";
  userId: string;
  purpose: "GOOGLE_DRIVE";
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}

export function generateOAuthState(userId: string): { state: string; nonce: string } {
  if (!userId || userId.trim() === "") {
    throw new Error("User ID is required to generate OAuth state.");
  }

  const nonce = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  const payload: OAuthStatePayload = {
    version: "v1",
    userId,
    purpose: "GOOGLE_DRIVE",
    nonce,
    issuedAt: now,
    expiresAt: now + 10 * 60 * 1000, // 10 minutes lifespan
  };

  const state = encryptRefreshToken(JSON.stringify(payload));
  return { state, nonce };
}

export function verifyOAuthState(
  state: string,
  cookieNonce: string,
  expectedUserId: string,
  ownerUserId: string
): boolean {
  if (!state || !cookieNonce || !expectedUserId || !ownerUserId) {
    return false;
  }

  try {
    const decrypted = decryptRefreshToken(state);
    const payload = JSON.parse(decrypted) as OAuthStatePayload;

    if (
      !payload ||
      payload.version !== "v1" ||
      payload.purpose !== "GOOGLE_DRIVE" ||
      payload.userId !== expectedUserId ||
      expectedUserId !== ownerUserId ||
      typeof payload.issuedAt !== "number" ||
      typeof payload.expiresAt !== "number" ||
      payload.expiresAt < Date.now() ||
      payload.issuedAt > Date.now()
    ) {
      return false;
    }

    if (payload.nonce.length !== cookieNonce.length) {
      return false;
    }

    const nonceBuf = Buffer.from(payload.nonce);
    const cookieBuf = Buffer.from(cookieNonce);

    return crypto.timingSafeEqual(nonceBuf, cookieBuf);
  } catch {
    return false;
  }
}
