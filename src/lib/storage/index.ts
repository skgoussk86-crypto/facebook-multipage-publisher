import { StorageAdapter } from './storage-adapter';
import { CloudflareR2StorageAdapter } from './cloudflare-r2-adapter';
import { InMemoryFakeStorageAdapter } from './in-memory-fake-adapter';
import { getStorageConfig } from './storage-config';

export * from './storage-adapter';
export * from './storage-config';
export * from './cloudflare-r2-adapter';
export * from './in-memory-fake-adapter';
export * from './upload-session-encryption';
export * from './upload-state-service';
export * from './upload-session-service';
export * from './upload-initiation-service';
export * from './upload-api-errors';
export * from './finalization-claim-service';
export * from './upload-finalization-service';




let instance: StorageAdapter | null = null;

export function getStorageAdapter(): StorageAdapter {
  if (instance) {
    return instance;
  }

  const config = getStorageConfig();
  const isProd = process.env.NODE_ENV === 'production';

  if (config.provider === 'R2') {
    instance = new CloudflareR2StorageAdapter(config);
  } else {
    // Fail closed in production: if we are in production, we do not allow the fake adapter!
    if (isProd) {
      throw new Error('Security Error: Local/Fake storage fallback is disabled in production.');
    }
    instance = new InMemoryFakeStorageAdapter();
  }

  return instance;
}

// Reset helper primarily for automated tests to switch configurations dynamically
export function resetStorageAdapterInstance() {
  instance = null;
}
