import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

/**
 * Encrypts a text token using AES-256-GCM
 * Output format: ivHex:authTagHex:encryptedTextHex
 */
export function encryptToken(text: string): string {
  const secretKeyHex = process.env.TOKEN_ENCRYPTION_KEY;
  if (!secretKeyHex || secretKeyHex.length !== 64) {
    throw new Error('TOKEN_ENCRYPTION_KEY must be a 64-character hex string (256 bits) in environment variables.');
  }

  const key = Buffer.from(secretKeyHex, 'hex');
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag().toString('hex');

  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypts a text token encrypted via encryptToken
 */
export function decryptToken(encryptedText: string): string {
  const secretKeyHex = process.env.TOKEN_ENCRYPTION_KEY;
  if (!secretKeyHex || secretKeyHex.length !== 64) {
    throw new Error('TOKEN_ENCRYPTION_KEY must be a 64-character hex string (256 bits) in environment variables.');
  }

  const key = Buffer.from(secretKeyHex, 'hex');
  const parts = encryptedText.split(':');

  if (parts.length !== 3) {
    throw new Error('Invalid encrypted token format. Expected iv:authTag:ciphertext');
  }

  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const encrypted = parts[2];

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}
