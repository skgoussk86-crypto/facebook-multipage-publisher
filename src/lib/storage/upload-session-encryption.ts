import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

// Custom safe service error classes
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ForbiddenOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenOwnershipError';
  }
}

export class InvalidStateTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidStateTransitionError';
  }
}

export class IdempotencyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdempotencyConflictError';
  }
}

export class ExpiredSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExpiredSessionError';
  }
}

export class MalformedEncryptedDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedEncryptedDataError';
  }
}

export class EncryptionAuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionAuthenticationError';
  }
}

export class InvalidMultipartMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMultipartMetadataError';
  }
}

let testKey: Buffer | null = null;
let testVersion: string | null = null;

/**
 * Dependency injection helper for automated tests
 */
export function injectTestEncryptionKey(key: Buffer, version: string) {
  if (key.length !== 32) {
    throw new Error('Test key must be exactly 32 bytes.');
  }
  testKey = key;
  testVersion = version;
}

/**
 * Clear dependency injected test keys
 */
export function clearTestEncryptionKey() {
  testKey = null;
  testVersion = null;
}

function getEncryptionConfig(): { key: Buffer; version: string } {
  if (testKey && testVersion) {
    return { key: testKey, version: testVersion };
  }

  const keyBase64 = process.env.UPLOAD_SESSION_ENCRYPTION_KEY;
  const version = process.env.UPLOAD_SESSION_ENCRYPTION_KEY_VERSION;

  if (!keyBase64 || !version) {
    throw new ConfigurationError('Upload session encryption configuration is missing or incomplete.');
  }

  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== 32) {
    throw new ConfigurationError('Decoded UPLOAD_SESSION_ENCRYPTION_KEY must be exactly 32 bytes.');
  }

  return { key, version };
}

export function encryptUploadSecret(plaintext: string): string {
  const { key, version } = getEncryptionConfig();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let ciphertext = cipher.update(plaintext, 'utf8', 'hex');
  ciphertext += cipher.final('hex');

  const tag = cipher.getAuthTag().toString('hex');
  const ivHex = iv.toString('hex');

  return `${version}:${ivHex}:${tag}:${ciphertext}`;
}

export function decryptUploadSecret(envelope: string): string {
  const parts = envelope.split(':');
  if (parts.length !== 4) {
    throw new MalformedEncryptedDataError('Malformed encrypted session envelope.');
  }

  const [version, ivHex, tagHex, ciphertext] = parts;
  const { key, version: currentVersion } = getEncryptionConfig();

  // Support future key-version rotation: reject unknown versions
  if (version !== currentVersion) {
    throw new ConfigurationError(`Unknown or unsupported encryption key version: ${version}`);
  }

  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  try {
    let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    throw new EncryptionAuthenticationError('Decryption authentication failure.');
  }
}
