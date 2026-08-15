export interface StorageConfig {
  provider: 'R2' | 'FAKE';
  r2: {
    accountId: string;
    bucketName: string;
    accessKeyId: string;
    secretAccessKey: string;
    endpoint: string;
    region: string;
    presignedUrlTtlSeconds: number;
    uploadMaxBytes: number;
    uploadPartSizeBytes: number;
  };
  uploadSessionEncryptionKey?: string;
  uploadSessionEncryptionKeyVersion?: string;
}

export function getStorageConfig(): StorageConfig {
  const providerEnv = process.env.STORAGE_PROVIDER || 'FAKE';
  const provider = (providerEnv.toUpperCase() === 'R2') ? 'R2' : 'FAKE';

  // TTL: positive, default 900
  let presignedUrlTtlSeconds = 900;
  if (process.env.R2_PRESIGNED_URL_TTL_SECONDS) {
    const parsed = parseInt(process.env.R2_PRESIGNED_URL_TTL_SECONDS, 10);
    if (!isNaN(parsed) && parsed > 0) {
      presignedUrlTtlSeconds = parsed;
    }
  }

  // Max Bytes: positive, max 2 GiB (2,147,483,648 bytes)
  let uploadMaxBytes = 2147483648;
  if (process.env.UPLOAD_MAX_BYTES) {
    const parsed = parseInt(process.env.UPLOAD_MAX_BYTES, 10);
    if (!isNaN(parsed) && parsed > 0) {
      uploadMaxBytes = Math.min(parsed, 2147483648);
    }
  }

  // Part Size: at least 5 MiB (5,242,880 bytes), default 10 MiB
  let uploadPartSizeBytes = 10485760;
  if (process.env.UPLOAD_PART_SIZE_BYTES) {
    const parsed = parseInt(process.env.UPLOAD_PART_SIZE_BYTES, 10);
    if (!isNaN(parsed) && parsed >= 5242880) {
      uploadPartSizeBytes = parsed;
    }
  }

  return {
    provider,
    r2: {
      accountId: process.env.R2_ACCOUNT_ID || '',
      bucketName: process.env.R2_BUCKET_NAME || '',
      accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
      endpoint: process.env.R2_ENDPOINT || '',
      region: process.env.R2_REGION || 'auto',
      presignedUrlTtlSeconds,
      uploadMaxBytes,
      uploadPartSizeBytes,
    },
    uploadSessionEncryptionKey: process.env.UPLOAD_SESSION_ENCRYPTION_KEY,
    uploadSessionEncryptionKeyVersion: process.env.UPLOAD_SESSION_ENCRYPTION_KEY_VERSION || '1',
  };
}

export function validateR2Config(config: StorageConfig) {
  // Never log access keys, secret keys, or encryption keys.
  // Fail closed in production.
  const isProd = process.env.NODE_ENV === 'production';
  if (isProd && config.provider === 'FAKE') {
    throw new Error('Storage configuration error: InMemoryFakeStorageAdapter cannot be activated in production.');
  }

  const missing: string[] = [];
  if (!config.r2.accountId) missing.push('R2_ACCOUNT_ID');
  if (!config.r2.bucketName) missing.push('R2_BUCKET_NAME');
  if (!config.r2.accessKeyId) missing.push('R2_ACCESS_KEY_ID');
  if (!config.r2.secretAccessKey) missing.push('R2_SECRET_ACCESS_KEY');
  if (!config.r2.endpoint) missing.push('R2_ENDPOINT');

  if (missing.length > 0) {
    throw new Error(`Cloudflare R2 Storage Configuration is missing required variables: ${missing.join(', ')}`);
  }
}
