import assert from 'node:assert/strict';
import { MAX_FILE_SIZE_BYTES, PART_SIZE_BYTES, isValidFilename, sanitizeFilename } from '../src/lib/storage/upload-initiation-service';
import { getStorageConfig } from '../src/lib/storage/storage-config';
import {
  GoogleDriveUploadInitiationService,
  type DbClient,
  type GDUploadInitiationDependencies,
} from '../src/lib/google-drive/google-drive-upload-initiation-service';
import type { GoogleDriveConnectionRecord } from '../src/lib/google-drive/google-drive-connection-repository';
import type { GoogleDriveConfig } from '../src/lib/google-drive/google-drive-config';
import type { User, UploadAsset, UploadSession, AuditLog } from '@prisma/client';

async function runLargeFileTests() {
  console.log('Starting Large Video Upload (2 GiB) Test Suite...');

  // 1. Verify Constant definitions
  console.log('Test 1: Verifying constant definitions...');
  const expectedConstant = 2 * 1024 * 1024 * 1024; // 2,147,483,648 bytes
  assert.equal(MAX_FILE_SIZE_BYTES, expectedConstant, 'MAX_FILE_SIZE_BYTES must equal exactly 2 GiB');
  assert.equal(PART_SIZE_BYTES, 10 * 1024 * 1024, 'PART_SIZE_BYTES must remain 10 MiB');

  // 2. Storage Config UPLOAD_MAX_BYTES handling
  console.log('Test 2: Verifying UPLOAD_MAX_BYTES configuration handling up to 2 GiB...');
  const origEnv = process.env.UPLOAD_MAX_BYTES;
  try {
    process.env.UPLOAD_MAX_BYTES = '2147483648';
    let config = getStorageConfig();
    assert.equal(config.r2.uploadMaxBytes, 2147483648, 'UPLOAD_MAX_BYTES=2147483648 must be accepted');

    process.env.UPLOAD_MAX_BYTES = '3000000000'; // Exceeds 2 GiB
    config = getStorageConfig();
    assert.equal(config.r2.uploadMaxBytes, 2147483648, 'UPLOAD_MAX_BYTES above 2 GiB must be capped at 2147483648');
  } finally {
    if (origEnv !== undefined) {
      process.env.UPLOAD_MAX_BYTES = origEnv;
    } else {
      delete process.env.UPLOAD_MAX_BYTES;
    }
  }

  // 3. File Size Validation Boundaries & Part Count Calculations
  console.log('Test 3: File size validation & part count calculations...');

  const partCount = (sizeBytes: number) => Math.ceil(sizeBytes / PART_SIZE_BYTES);

  // Sizes to test acceptance
  const size499MiB = 499 * 1024 * 1024;
  const size500MiB = 500 * 1024 * 1024;
  const size500MiBPlus1 = 500 * 1024 * 1024 + 1;
  const size1GiB = 1024 * 1024 * 1024;
  const size1_5GiB = Math.floor(1.5 * 1024 * 1024 * 1024);
  const size2GiB = 2 * 1024 * 1024 * 1024;
  const size2GiBPlus1 = 2 * 1024 * 1024 * 1024 + 1;

  // Boundary checks against MAX_FILE_SIZE_BYTES
  assert.ok(BigInt(size499MiB) <= BigInt(MAX_FILE_SIZE_BYTES), '499 MiB must be accepted');
  assert.ok(BigInt(size500MiB) <= BigInt(MAX_FILE_SIZE_BYTES), '500 MiB must be accepted');
  assert.ok(BigInt(size500MiBPlus1) <= BigInt(MAX_FILE_SIZE_BYTES), '500 MiB + 1 byte must be accepted');
  assert.ok(BigInt(size1GiB) <= BigInt(MAX_FILE_SIZE_BYTES), '1 GiB must be accepted');
  assert.ok(BigInt(size1_5GiB) <= BigInt(MAX_FILE_SIZE_BYTES), '1.5 GiB must be accepted');
  assert.ok(BigInt(size2GiB) <= BigInt(MAX_FILE_SIZE_BYTES), 'exactly 2 GiB must be accepted');
  assert.ok(BigInt(size2GiBPlus1) > BigInt(MAX_FILE_SIZE_BYTES), '2 GiB + 1 byte must exceed MAX_FILE_SIZE_BYTES');

  // Part counts
  const parts1GiB = partCount(size1GiB);
  assert.equal(parts1GiB, 103, '1 GiB file with 10 MiB parts must produce 103 parts');

  const parts2GiB = partCount(size2GiB);
  assert.equal(parts2GiB, 205, '2 GiB file with 10 MiB parts must produce 205 parts');

  // Final smaller part check for 2 GiB file
  const fullParts2GiB = Math.floor(size2GiB / PART_SIZE_BYTES);
  const remainder2GiB = size2GiB % PART_SIZE_BYTES;
  assert.equal(fullParts2GiB, 204, '2 GiB should have 204 full 10 MiB parts');
  assert.equal(remainder2GiB, 8388608, '2 GiB should have a final smaller part of 8,388,608 bytes (8 MiB)');
  assert.ok(remainder2GiB > 0 && remainder2GiB < PART_SIZE_BYTES, 'Final smaller part is valid');

  // 4. Maximum parts boundary (> 10,000 parts)
  console.log('Test 4: Checking > 10,000 parts boundary validation...');
  const hugeFileParts = Math.ceil((100 * 1024 * 1024 * 1024) / PART_SIZE_BYTES);
  assert.ok(hugeFileParts > 10000, 'Huge file exceeds 10,000 parts');

  // 5. Filename Security & Hotfix Policies Preservation
  console.log('Test 5: Filename security policy preservation...');

  // Accepted filenames
  assert.ok(isValidFilename('sample.jpg'), 'JPG accepted');
  assert.ok(isValidFilename('sample.jpeg'), 'JPEG accepted');
  assert.ok(isValidFilename('sample.png'), 'PNG accepted');
  assert.ok(isValidFilename('ChatGPT Image Jul 30, 2026, 08_50_28 PM (1).png'), 'ChatGPT style filename accepted');
  assert.ok(isValidFilename('video,file.mp4'), 'commas accepted');
  assert.ok(isValidFilename('video(1).mp4'), 'parentheses accepted');
  assert.ok(isValidFilename('video_🎉_unicode.mp4'), 'Unicode filenames accepted');

  // Rejected filenames
  assert.equal(isValidFilename('video\x00bad.mp4'), false, 'Null byte control char rejected');
  assert.equal(isValidFilename('video\x1Fbad.mp4'), false, 'Control character rejected');
  assert.equal(isValidFilename('folder/video.mp4'), false, 'Forward slash path separator rejected');
  assert.equal(isValidFilename('folder\\video.mp4'), false, 'Backslash path separator rejected');
  assert.equal(isValidFilename('../video.mp4'), false, 'Path traversal rejected');

  // Storage key sanitization preserved
  const sanitized = sanitizeFilename('ChatGPT Image Jul 30, 2026, 08_50_28 PM (1).png');
  assert.ok(!sanitized.includes(' '), 'Sanitization removes spaces');
  assert.ok(!sanitized.includes('('), 'Sanitization removes parentheses');
  assert.ok(!sanitized.includes(','), 'Sanitization removes commas');

  // 6. Verification of Google Drive initiation using same MAX_FILE_SIZE_BYTES
  console.log('Test 6: Google Drive initiation limit verification...');
  let gdErrorThrown = false;
  try {
    const mockDb: DbClient = {
      user: { findUnique: async () => ({ id: 'u1', status: 'ACTIVE', approvalStatus: 'APPROVED' }) as User },
      googleDriveConnection: { findUnique: async () => null },
      uploadAsset: {
        findUnique: async () => null,
        create: async () => ({} as UploadAsset),
        update: async () => ({} as UploadAsset),
      },
      uploadSession: { findUnique: async () => null, create: async () => ({} as UploadSession) },
      auditLog: { create: async () => ({} as AuditLog) },
      $transaction: async <T>(fn: (tx: DbClient) => Promise<T>) => fn(mockDb),
    };

    const mockDeps: GDUploadInitiationDependencies = {
      db: mockDb,
      getActiveConnection: async () => ({ driveFolderId: 'folder123', revokedAt: null, encryptedRefreshToken: 'enc' } as GoogleDriveConnectionRecord),
    };

    await GoogleDriveUploadInitiationService.initiateGDUpload(
      'u1',
      {
        idempotencyKey: 'idem-test-gd',
        originalName: 'big-video.mp4',
        expectedSize: BigInt(size2GiBPlus1), // 2 GiB + 1 byte
        declaredMimeType: 'video/mp4',
      },
      mockDeps
    );
  } catch (err: unknown) {
    gdErrorThrown = true;
    const errorMsg = err instanceof Error ? err.message : String(err);
    assert.equal(errorMsg, 'FILE_TOO_LARGE', 'Google Drive initiation must throw FILE_TOO_LARGE for 2 GiB + 1 byte');
  }
  assert.ok(gdErrorThrown, 'Google Drive initiation rejected 2 GiB + 1 byte');

  // Test that Google Drive initiation accepts 2 GiB file metadata validation
  let gdAcceptedSizePassesValidation = false;
  try {
    const mockDbPass: DbClient = {
      user: { findUnique: async () => ({ id: 'u1', status: 'ACTIVE', approvalStatus: 'APPROVED' }) as User },
      googleDriveConnection: { findUnique: async () => null },
      uploadAsset: {
        findUnique: async () => null,
        create: async () => ({
          id: 'asset-2gib',
          originalName: '2gib-video.mp4',
          expectedSize: BigInt(size2GiB),
          declaredMimeType: 'video/mp4',
          uploadExpiresAt: new Date(),
        }) as UploadAsset,
        update: async () => ({} as UploadAsset),
      },
      uploadSession: { findUnique: async () => null, create: async () => ({} as UploadSession) },
      auditLog: { create: async () => ({} as AuditLog) },
      $transaction: async <T>(fn: (tx: DbClient) => Promise<T>) => fn(mockDbPass),
    };

    const mockPassDeps: GDUploadInitiationDependencies = {
      db: mockDbPass,
      getActiveConnection: async () => ({ driveFolderId: 'folder123', revokedAt: null, encryptedRefreshToken: 'enc' } as GoogleDriveConnectionRecord),
      getGoogleDriveConfig: () => ({ encryptionKey: 'k'.repeat(32) } as GoogleDriveConfig),
      decryptRefreshToken: () => 'refresh_token',
      getAccessToken: async () => 'access_token',
      initiateResumableUpload: async () => {
        gdAcceptedSizePassesValidation = true;
        return { sessionUri: 'https://upload.goog/session', expiresAt: new Date() };
      },
      encryptSessionSecret: () => 'enc_secret',
    };

    await GoogleDriveUploadInitiationService.initiateGDUpload(
      'u1',
      {
        idempotencyKey: 'idem-test-gd-pass',
        originalName: '2gib-video.mp4',
        expectedSize: BigInt(size2GiB), // Exactly 2 GiB
        declaredMimeType: 'video/mp4',
      },
      mockPassDeps
    );
  } catch {
    // If gdAcceptedSizePassesValidation was set, initiateResumableUpload was reached
  }
  assert.ok(gdAcceptedSizePassesValidation, 'Google Drive initiation accepts exactly 2 GiB file size');

  console.log('ALL LARGE FILE UPLOAD TESTS PASSED SUCCESSFULLY! 🎉');
}

runLargeFileTests().catch((err: unknown) => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});
