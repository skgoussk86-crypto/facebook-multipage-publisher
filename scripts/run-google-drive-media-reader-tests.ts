import { GoogleDriveMediaReader } from '../src/lib/google-drive/google-drive-media-reader';
import { UploadAsset, GoogleDriveConnection, StorageProvider } from '@prisma/client';
import { Readable } from 'stream';

function assert(cond: boolean, msg: string) {
  if (!cond) {
    throw new Error('Assertion Failed: ' + msg);
  }
}

async function runTests() {
  console.log('Running Google Drive Media Reader Unit Tests...');

  const userId = 'user-123';
  const validAsset: UploadAsset = {
    id: 'asset-123',
    userId,
    provider: 'GOOGLE_DRIVE',
    bucket: 'drive-bucket',
    objectKey: 'file-xyz',
    originalName: 'video.mp4',
    expectedSize: BigInt(1000000),
    actualSize: BigInt(1000000),
    declaredMimeType: 'video/mp4',
    detectedMimeType: 'video/mp4',
    checksum: 'abc',
    objectETag: 'tag',
    status: 'VALIDATED',
    failureCode: null,
    failureMessage: null,
    idempotencyKey: 'idem',
    requestFingerprint: 'finger',
    validationLockToken: null,
    validationLockedAt: null,
    validationLockExpiresAt: null,
    validationAttemptCount: 0,
    validationMaxAttempts: 3,
    validationStartedAt: null,
    finalizationOperation: null,
    finalizationLockToken: null,
    finalizationLockedAt: null,
    finalizationLockExpiresAt: null,
    finalizationAttemptCount: 0,
    durationMs: null,
    containerFormat: null,
    videoCodec: null,
    audioCodec: null,
    width: null,
    height: null,
    frameRate: null,
    uploadExpiresAt: new Date(),
    uploadedAt: new Date(),
    validatedAt: new Date(),
    retentionUntil: null,
    objectDeletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date()
  };

  // Test 1: Ownership verification check
  try {
    const wrongUserAsset = { ...validAsset, userId: 'other-user' };
    await GoogleDriveMediaReader.getDownloadStream(userId, wrongUserAsset);
    assert(false, 'Should throw OWNERSHIP_MISMATCH');
  } catch (err: unknown) {
    const error = err as Error;
    assert(error.message === 'OWNERSHIP_MISMATCH', 'Expected OWNERSHIP_MISMATCH');
  }
  console.log('✓ Test 1: wrong owner rejected');

  // Test 2: Unsupported provider rejected
  try {
    const r2Asset = { ...validAsset, provider: 'R2' as StorageProvider };
    await GoogleDriveMediaReader.getDownloadStream(userId, r2Asset);
    assert(false, 'Should throw UNSUPPORTED_STORAGE_PROVIDER');
  } catch (err: unknown) {
    const error = err as Error;
    assert(error.message === 'UNSUPPORTED_STORAGE_PROVIDER', 'Expected UNSUPPORTED_STORAGE_PROVIDER');
  }
  console.log('✓ Test 2: unsupported provider rejected');

  // Test 3: Malformed URIs rejected (empty key)
  try {
    const emptyKeyAsset = { ...validAsset, objectKey: '' };
    await GoogleDriveMediaReader.getDownloadStream(userId, emptyKeyAsset);
    assert(false, 'Should throw INVALID_STORAGE_URI');
  } catch (err: unknown) {
    const error = err as Error;
    assert(error.message === 'INVALID_STORAGE_URI', 'Expected INVALID_STORAGE_URI');
  }
  console.log('✓ Test 3: empty key rejected');

  // Test 4: Malformed URIs rejected (starts with uploads/)
  try {
    const localAsset = { ...validAsset, objectKey: 'uploads/file-123' };
    await GoogleDriveMediaReader.getDownloadStream(userId, localAsset);
    assert(false, 'Should throw INVALID_STORAGE_URI');
  } catch (err: unknown) {
    const error = err as Error;
    assert(error.message === 'INVALID_STORAGE_URI', 'Expected INVALID_STORAGE_URI');
  }
  console.log('✓ Test 4: local uploads prefix key rejected');

  // Test 5: Revoked Drive connection check
  try {
    const deps = {
      getActiveConnection: async () => null,
    };
    await GoogleDriveMediaReader.getDownloadStream(userId, validAsset, deps);
    assert(false, 'Should throw GOOGLE_DRIVE_CONNECTION_REVOKED');
  } catch (err: unknown) {
    const error = err as Error;
    assert(error.message === 'GOOGLE_DRIVE_CONNECTION_REVOKED', 'Expected GOOGLE_DRIVE_CONNECTION_REVOKED');
  }
  console.log('✓ Test 5: revoked/missing connection rejected');

  // Test 6: Decryption failure check
  try {
    const mockConn: GoogleDriveConnection = {
      id: 'conn-1',
      userId,
      encryptedRefreshToken: 'enc-refresh',
      refreshTokenKeyVersion: '1',
      googleAccountEmail: 'email@example.com',
      driveFolderId: 'folder-123',
      connectedAt: new Date(),
      updatedAt: new Date(),
      revokedAt: null
    };
    const deps = {
      getActiveConnection: async () => mockConn,
      getGoogleDriveConfig: () => ({
        clientId: 'id',
        clientSecret: 'secret',
        redirectUri: 'http://localhost',
        encryptionKey: 'key',
        ownerUserId: userId
      }),
      decryptRefreshToken: () => { throw new Error('Decryption failed'); },
    };
    await GoogleDriveMediaReader.getDownloadStream(userId, validAsset, deps);
    assert(false, 'Should throw GOOGLE_DRIVE_DECRYPTION_FAILED');
  } catch (err: unknown) {
    const error = err as Error;
    assert(error.message === 'GOOGLE_DRIVE_DECRYPTION_FAILED', 'Expected GOOGLE_DRIVE_DECRYPTION_FAILED');
  }
  console.log('✓ Test 6: decryption failure handled safely');

  // Test 7: OAuth token invalid grant / revoke mapping
  try {
    const mockConn: GoogleDriveConnection = {
      id: 'conn-1',
      userId,
      encryptedRefreshToken: 'enc-refresh',
      refreshTokenKeyVersion: '1',
      googleAccountEmail: 'email@example.com',
      driveFolderId: 'folder-123',
      connectedAt: new Date(),
      updatedAt: new Date(),
      revokedAt: null
    };
    const deps = {
      getActiveConnection: async () => mockConn,
      getGoogleDriveConfig: () => ({
        clientId: 'id',
        clientSecret: 'secret',
        redirectUri: 'http://localhost',
        encryptionKey: 'key',
        ownerUserId: userId
      }),
      decryptRefreshToken: () => 'decrypted-refresh-token',
      getAccessToken: async () => { throw new Error('invalid_grant: token is revoked'); },
    };
    await GoogleDriveMediaReader.getDownloadStream(userId, validAsset, deps);
    assert(false, 'Should throw GOOGLE_DRIVE_CONNECTION_REVOKED');
  } catch (err: unknown) {
    const error = err as Error;
    assert(error.message === 'GOOGLE_DRIVE_CONNECTION_REVOKED', 'Expected GOOGLE_DRIVE_CONNECTION_REVOKED');
  }
  console.log('✓ Test 7: invalid grant maps to GOOGLE_DRIVE_CONNECTION_REVOKED');

  // Test 8: Drive HTTP 404 maps to file not found
  try {
    const mockConn: GoogleDriveConnection = {
      id: 'conn-1',
      userId,
      encryptedRefreshToken: 'enc-refresh',
      refreshTokenKeyVersion: '1',
      googleAccountEmail: 'email@example.com',
      driveFolderId: 'folder-123',
      connectedAt: new Date(),
      updatedAt: new Date(),
      revokedAt: null
    };
    const deps = {
      getActiveConnection: async () => mockConn,
      getGoogleDriveConfig: () => ({
        clientId: 'id',
        clientSecret: 'secret',
        redirectUri: 'http://localhost',
        encryptionKey: 'key',
        ownerUserId: userId
      }),
      decryptRefreshToken: () => 'decrypted-refresh-token',
      getAccessToken: async () => 'access-123',
      createReadStream: async () => { throw new Error('Google file not found (404)'); }
    };
    await GoogleDriveMediaReader.getDownloadStream(userId, validAsset, deps);
    assert(false, 'Should throw GOOGLE_DRIVE_FILE_NOT_FOUND');
  } catch (err: unknown) {
    const error = err as Error;
    assert(error.message === 'GOOGLE_DRIVE_FILE_NOT_FOUND', 'Expected GOOGLE_DRIVE_FILE_NOT_FOUND');
  }
  console.log('✓ Test 8: HTTP 404 maps to GOOGLE_DRIVE_FILE_NOT_FOUND');

  // Test 9: Valid media stream retrieval propagation
  {
    const expectedStream = Readable.from([Buffer.from('hello')]);
    const mockConn: GoogleDriveConnection = {
      id: 'conn-1',
      userId,
      encryptedRefreshToken: 'enc-refresh',
      refreshTokenKeyVersion: '1',
      googleAccountEmail: 'email@example.com',
      driveFolderId: 'folder-123',
      connectedAt: new Date(),
      updatedAt: new Date(),
      revokedAt: null
    };
    const deps = {
      getActiveConnection: async () => mockConn,
      getGoogleDriveConfig: () => ({
        clientId: 'id',
        clientSecret: 'secret',
        redirectUri: 'http://localhost',
        encryptionKey: 'key',
        ownerUserId: userId
      }),
      decryptRefreshToken: () => 'decrypted-refresh-token',
      getAccessToken: async () => 'access-123',
      createReadStream: async () => expectedStream
    };
    const stream = await GoogleDriveMediaReader.getDownloadStream(userId, validAsset, deps);
    assert(stream === expectedStream, 'Should return the expected media stream');
  }
  console.log('✓ Test 9: valid stream successfully returned');

  console.log('ALL GOOGLE DRIVE MEDIA READER TESTS PASSED! 🎉');
}

runTests().catch((err: unknown) => {
  const error = err as Error;
  console.error('Test execution failed:', error.message);
  process.exit(1);
});
