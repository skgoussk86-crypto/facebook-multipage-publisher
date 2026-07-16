import "server-only";
import crypto from "crypto";
import { getGoogleDriveConfig } from "./google-drive-config";

function getValidatedKey(keyHex?: string): Buffer {
  const hex = keyHex || getGoogleDriveConfig().encryptionKey;
  if (!hex || hex.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("Invalid encryption key. Must be a 64-character hex string.");
  }
  return Buffer.from(hex, "hex");
}

export function encryptRefreshToken(plainText: string, keyHexOverride?: string): string {
  if (!plainText) {
    throw new Error("Plaintext token is required.");
  }
  const key = getValidatedKey(keyHexOverride);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  let encrypted = cipher.update(plainText, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");

  return `v1:${iv.toString("hex")}:${tag}:${encrypted}`;
}

export function decryptRefreshToken(envelope: string, keyHexOverride?: string): string {
  const key = getValidatedKey(keyHexOverride);

  if (!envelope || !envelope.startsWith("v1:")) {
    throw new Error("Invalid token envelope format.");
  }

  const parts = envelope.split(":");
  if (parts.length !== 4) {
    throw new Error("Malformed ciphertext envelope.");
  }

  const [, ivHex, tagHex, cipherText] = parts;
  if (!ivHex || !tagHex || !cipherText) {
    throw new Error("Invalid components in ciphertext envelope.");
  }

  try {
    const iv = Buffer.from(ivHex, "hex");
    const tag = Buffer.from(tagHex, "hex");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);

    let decrypted = decipher.update(cipherText, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch {
    throw new Error("Decryption failed: malformed ciphertext or incorrect key/tag.");
  }
}
