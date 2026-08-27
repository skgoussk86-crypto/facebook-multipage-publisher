import { PrismaClient, UploadStatus, User } from '@prisma/client';
import { randomUUID } from 'crypto';
import { VideoValidationService, VALIDATION_LEASE_DURATION_MS, ValidationClaim } from '../src/lib/storage/video-validation-service';
import { MediaProbe, MediaMetadata, MediaValidationError } from '../src/lib/storage/media-probe';
import { FfprobeMediaProbe } from '../src/lib/storage/ffprobe-media-probe';
import { getStorageAdapter, resetStorageAdapterInstance } from '../src/lib/storage';
import { InMemoryFakeStorageAdapter } from '../src/lib/storage/in-memory-fake-adapter';
import * as fs from 'fs';
import { NextRequest } from 'next/server';
import { handleWorkerPost, WorkerRouteDependencies } from '../src/app/api/admin/worker/route';

const dbUrl = process.env.DATABASE_URL || '';

if (!dbUrl) {
  console.error('REFUSED: DATABASE_URL env variable is missing.');
  process.exit(1);
}

let dbName = '';
try {
  const parsedUrl = new URL(dbUrl);
  dbName = decodeURIComponent(parsedUrl.pathname.slice(1));
} catch {
  console.error('REFUSED: Invalid DATABASE_URL format.');
  process.exit(1);
}

if (dbName !== 'fb_publisher_test') {
  console.error(`REFUSED: Refusing to run tests against database "${dbName}".`);
  console.error('Database name must equal exactly "fb_publisher_test".');
  process.exit(1);
}

const prisma = new PrismaClient();

class FakeMediaProbe implements MediaProbe {
  public mockMetadata: MediaMetadata | null = null;
  public mockError: Error | null = null;
  public probeCount = 0;

  async probe(filePath: string): Promise<MediaMetadata> {
    this.probeCount++;

    // Assert that the file actually exists on the filesystem during probe call
    if (!fs.existsSync(filePath)) {
      throw new Error('Test Error: Probed file does not exist on filesystem.');
    }

    if (this.mockError) {
      throw this.mockError;
    }
    if (this.mockMetadata) {
      return this.mockMetadata;
    }
    throw new Error('FakeMediaProbe is not configured.');
  }
}

async function assertThrows(
  testName: string,
  fn: () => Promise<unknown>,
  expectedErrorClass: new (...args: never[]) => Error
): Promise<void> {
  try {
    await fn();
    throw new Error(`[${testName}] Failed: Expected error class ${expectedErrorClass.name} but function resolved successfully.`);
  } catch (actualError: unknown) {
    if (actualError instanceof Error && actualError.message.startsWith(`[${testName}] Failed:`)) {
      throw actualError;
    }
    if (!(actualError instanceof expectedErrorClass)) {
      const actualName = actualError instanceof Error ? actualError.constructor.name : typeof actualError;
      const actualMsg = actualError instanceof Error ? actualError.message : String(actualError);
      throw new Error(
        `[${testName}] Failed: Expected ${expectedErrorClass.name} but got ${actualName} (Message: ${actualMsg})`
      );
    }
  }
}

async function runTests() {
  console.log('Starting Phase 4 Step 4A video validation tests...');

  // Configure storage environment
  const originalVideoMaxDurationMinutes = process.env.VIDEO_MAX_DURATION_MINUTES;
  process.env.STORAGE_PROVIDER = 'FAKE';
  process.env.VIDEO_MAX_DURATION_MINUTES = '240';
  resetStorageAdapterInstance();
  const adapter = getStorageAdapter() as InMemoryFakeStorageAdapter;

  const fakeProbe = new FakeMediaProbe();
  VideoValidationService.setProbe(fakeProbe);

  // Setup mock user
  const userId = randomUUID();
  await prisma.uploadSession.deleteMany({});
  await prisma.uploadAttempt.deleteMany({});
  await prisma.uploadAsset.deleteMany({});
  await prisma.auditLog.deleteMany({});
  await prisma.user.deleteMany({
    where: {
      email: {
        contains: 'test-val',
      },
    },
  });

  await prisma.user.create({
    data: {
      id: userId,
      email: `test-val-${userId.slice(0, 8)}@example.com`,
      passwordHash: 'dummy',
      role: 'USER',
      status: 'ACTIVE',
      approvalStatus: 'APPROVED',
    },
  });

  // Helper to create basic validation fixture
  async function createValidationFixture(
    expectedSize: number = 1024,
    status: UploadStatus = UploadStatus.VALIDATING,
    validationAttemptCount: number = 0,
    validationMaxAttempts: number = 3,
    originalName: string = 'video.mp4',
    declaredMimeType: string = 'video/mp4'
  ) {
    const assetId = randomUUID();
    const objectKey = `uploads/${userId}/video-${assetId.slice(0, 8)}.mp4`;
    await prisma.uploadAsset.create({
      data: {
        id: assetId,
        userId,
        provider: 'R2',
        bucket: 'mock-bucket',
        objectKey,
        originalName,
        expectedSize,
        actualSize: expectedSize,
        declaredMimeType,
        status,
        idempotencyKey: `idem-${assetId.slice(0, 8)}`,
        requestFingerprint: `fp-${assetId.slice(0, 8)}`,
        uploadExpiresAt: new Date(Date.now() + 60000),
        validationAttemptCount,
        validationMaxAttempts
      }
    });

    // Populate fake storage object
    const path = `mock-bucket/${objectKey}`;
    (adapter as unknown as { storedObjects: Map<string, unknown> }).storedObjects.set(path, {
      size: expectedSize,
      etag: '"etag-mock"',
      contentType: 'video/mp4',
      content: Buffer.alloc(expectedSize, 'v'),
      lastModified: new Date()
    });

    return { assetId, objectKey };
  }

  async function parkRetryableAsset(assetId: string): Promise<void> {
    await prisma.uploadAsset.update({
      where: { id: assetId },
      data: {
        validationLockToken: randomUUID(),
        validationLockedAt: new Date(),
        validationLockExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
      }
    });
  }

  try {
    // -------------------------------------------------------------
    // 1. Successful MP4 H.264 AAC video
    // -------------------------------------------------------------
    console.log('Test: successful MP4 H.264 AAC video...');
    const f1 = await createValidationFixture();
    fakeProbe.mockError = null;
    fakeProbe.mockMetadata = {
      containerFormat: 'mov,mp4,m4a,3gp,3g2,mj2',
      durationMs: 15000,
      videoCodec: 'h264',
      audioCodec: 'aac',
      width: 1920,
      height: 1080,
      frameRate: 30.0,
      detectedMimeType: 'video/mp4'
    };

    const claim1 = await VideoValidationService.claimOneAsset();
    if (!claim1) throw new Error('Failed to claim asset.');
    if (claim1.assetId !== f1.assetId) throw new Error('Claimed incorrect asset.');

    const res1 = await VideoValidationService.validateAsset(claim1);
    if (!res1.success || res1.status !== UploadStatus.VALIDATED) {
      throw new Error(`Expected success validation, got ${res1.status}`);
    }

    // Verify metadata saved, retention set to 30 days
    const asset1 = await prisma.uploadAsset.findUnique({ where: { id: f1.assetId } });
    if (asset1?.status !== UploadStatus.VALIDATED) throw new Error('Expected status VALIDATED.');
    if (asset1.durationMs !== 15000 || asset1.videoCodec !== 'h264' || asset1.audioCodec !== 'aac') {
      throw new Error('Probed metadata was not saved.');
    }
    if (asset1.width !== 1920 || asset1.height !== 1080 || asset1.frameRate !== 30.0) {
      throw new Error('Dimensions/frameRate not saved.');
    }
    if (asset1.validationLockToken !== null) throw new Error('Lock token was not cleared.');
    if (!asset1.validatedAt) throw new Error('validatedAt not set.');
    const thirtyDaysLimit = Date.now() + 29 * 24 * 60 * 60 * 1000;
    if (!asset1.retentionUntil || asset1.retentionUntil.getTime() < thirtyDaysLimit) {
      throw new Error('retentionUntil must be at least 30 days in the future.');
    }

    // Check audit logs for no credential/key leaks
    const logs1 = await prisma.auditLog.findMany({ where: { userId } });
    const auditSuccess = logs1.find(l => l.action === 'UPLOAD_VALIDATION_SUCCESS');
    if (!auditSuccess) throw new Error('Audit log for validation success was not created.');
    if (auditSuccess.details.includes(f1.objectKey) || auditSuccess.details.includes('http')) {
      throw new Error('Object key or URLs leaked in audit log.');
    }

    // -------------------------------------------------------------
    // 2. Successful MOV H.264 AAC video
    // -------------------------------------------------------------
    console.log('Test: successful MOV H.264 AAC video...');
    await createValidationFixture(1024, UploadStatus.VALIDATING, 0, 3, 'video.mov', 'video/quicktime');
    fakeProbe.mockMetadata = {
      containerFormat: 'mov,quicktime',
      durationMs: 45000,
      videoCodec: 'h264',
      audioCodec: 'aac',
      width: 1280,
      height: 720,
      frameRate: 24.0,
      detectedMimeType: 'video/quicktime'
    };

    const claim2 = await VideoValidationService.claimOneAsset();
    if (!claim2) throw new Error('Failed to claim asset.');
    const res2 = await VideoValidationService.validateAsset(claim2);
    if (!res2.success || res2.status !== UploadStatus.VALIDATED) {
      throw new Error('Expected success validation for MOV video.');
    }

    // -------------------------------------------------------------
    // 3. Valid video with no audio stream
    // -------------------------------------------------------------
    console.log('Test: valid video with no audio stream...');
    await createValidationFixture();
    fakeProbe.mockMetadata = {
      containerFormat: 'mp4',
      durationMs: 5000,
      videoCodec: 'h264',
      audioCodec: null,
      width: 640,
      height: 480,
      frameRate: 29.97,
      detectedMimeType: 'video/mp4'
    };

    const claim3 = await VideoValidationService.claimOneAsset();
    if (!claim3) throw new Error('Failed to claim asset.');
    const res3 = await VideoValidationService.validateAsset(claim3);
    if (!res3.success || res3.status !== UploadStatus.VALIDATED) {
      throw new Error('Expected success validation with no audio stream.');
    }

    // -------------------------------------------------------------
    // 4. Object missing in persistent storage
    // -------------------------------------------------------------
    console.log('Test: object missing...');
    const f4 = await createValidationFixture();
    // Delete object from fake storage
    (adapter as unknown as { storedObjects: Map<string, unknown> }).storedObjects.delete(`mock-bucket/${f4.objectKey}`);

    const claim4 = await VideoValidationService.claimOneAsset();
    if (!claim4) throw new Error('Failed to claim asset.');
    const res4 = await VideoValidationService.validateAsset(claim4);
    if (res4.success || res4.status !== UploadStatus.FAILED || res4.failureCode !== 'OBJECT_MISSING') {
      throw new Error(`Expected OBJECT_MISSING failure, got status ${res4.status}, code ${res4.failureCode}`);
    }

    // Verify lease locks cleared and retention is 24 hours
    const asset4 = await prisma.uploadAsset.findUnique({ where: { id: f4.assetId } });
    if (asset4?.validationLockToken !== null) throw new Error('Expected validation lock token to be cleared.');
    const oneDayLimit = Date.now() + 23 * 60 * 60 * 1000;
    if (!asset4.retentionUntil || asset4.retentionUntil.getTime() < oneDayLimit || asset4.retentionUntil.getTime() > Date.now() + 25 * 60 * 60 * 1000) {
      throw new Error('retentionUntil must be exactly 24 hours in the future.');
    }

    // -------------------------------------------------------------
    // 5. Object size mismatch
    // -------------------------------------------------------------
    console.log('Test: object size mismatch...');
    const f5 = await createValidationFixture(5000); // Expects 5000
    // Change fake storage size to 1024
    (adapter as unknown as { storedObjects: Map<string, unknown> }).storedObjects.set(`mock-bucket/${f5.objectKey}`, {
      size: 1024,
      etag: '"etag-mock"',
      contentType: 'video/mp4',
      content: Buffer.alloc(1024, 'v'),
      lastModified: new Date()
    });

    const claim5 = await VideoValidationService.claimOneAsset();
    if (!claim5) throw new Error('Failed to claim asset.');
    const res5 = await VideoValidationService.validateAsset(claim5);
    if (res5.success || res5.status !== UploadStatus.FAILED || res5.failureCode !== 'SIZE_MISMATCH') {
      throw new Error(`Expected SIZE_MISMATCH failure, got status ${res5.status}, code ${res5.failureCode}`);
    }

    // -------------------------------------------------------------
    // 6. Unsupported container
    // -------------------------------------------------------------
    console.log('Test: unsupported container...');
    await createValidationFixture();
    fakeProbe.mockMetadata = {
      containerFormat: 'avi',
      durationMs: 10000,
      videoCodec: 'h264',
      audioCodec: 'aac',
      width: 1920,
      height: 1080,
      frameRate: 30.0,
      detectedMimeType: null
    };

    const claim6 = await VideoValidationService.claimOneAsset();
    if (!claim6) throw new Error('Failed to claim asset.');
    const res6 = await VideoValidationService.validateAsset(claim6);
    if (res6.success || res6.status !== UploadStatus.FAILED || res6.failureCode !== 'INVALID_CONTAINER') {
      throw new Error(`Expected INVALID_CONTAINER failure, got status ${res6.status}, code ${res6.failureCode}`);
    }

    // -------------------------------------------------------------
    // 7. Unsupported video codec
    // -------------------------------------------------------------
    console.log('Test: unsupported video codec...');
    await createValidationFixture();
    fakeProbe.mockMetadata = {
      containerFormat: 'mp4',
      durationMs: 10000,
      videoCodec: 'hevc',
      audioCodec: 'aac',
      width: 1920,
      height: 1080,
      frameRate: 30.0,
      detectedMimeType: 'video/mp4'
    };

    const claim7 = await VideoValidationService.claimOneAsset();
    if (!claim7) throw new Error('Failed to claim asset.');
    const res7 = await VideoValidationService.validateAsset(claim7);
    if (res7.success || res7.status !== UploadStatus.FAILED || res7.failureCode !== 'INVALID_VIDEO_CODEC') {
      throw new Error(`Expected INVALID_VIDEO_CODEC failure, got status ${res7.status}, code ${res7.failureCode}`);
    }

    // -------------------------------------------------------------
    // 8. Unsupported audio codec
    // -------------------------------------------------------------
    console.log('Test: unsupported audio codec...');
    await createValidationFixture();
    fakeProbe.mockMetadata = {
      containerFormat: 'mp4',
      durationMs: 10000,
      videoCodec: 'h264',
      audioCodec: 'mp3',
      width: 1920,
      height: 1080,
      frameRate: 30.0,
      detectedMimeType: 'video/mp4'
    };

    const claim8 = await VideoValidationService.claimOneAsset();
    if (!claim8) throw new Error('Failed to claim asset.');
    const res8 = await VideoValidationService.validateAsset(claim8);
    if (res8.success || res8.status !== UploadStatus.FAILED || res8.failureCode !== 'INVALID_AUDIO_CODEC') {
      throw new Error(`Expected INVALID_AUDIO_CODEC failure, got status ${res8.status}, code ${res8.failureCode}`);
    }

    // -------------------------------------------------------------
    // 9. Missing video stream
    // -------------------------------------------------------------
    console.log('Test: missing video stream...');
    const f9 = await createValidationFixture();
    fakeProbe.mockMetadata = null;
    fakeProbe.mockError = new MediaValidationError('MISSING_VIDEO_STREAM', 'No video stream found in media.');

    const claim9 = await VideoValidationService.claimOneAsset();
    if (!claim9) throw new Error('Failed to claim asset.');

    const probeCountBefore9 = fakeProbe.probeCount;
    const res9 = await VideoValidationService.validateAsset(claim9);

    if (res9.success || res9.status !== UploadStatus.FAILED || res9.failureCode !== 'MISSING_VIDEO_STREAM') {
      throw new Error(`Expected FAILED with MISSING_VIDEO_STREAM, got status ${res9.status}, code ${res9.failureCode}`);
    }

    // Verify claim lock cleared and attempt count remains recorded
    const asset9 = await prisma.uploadAsset.findUnique({ where: { id: f9.assetId } });
    if (asset9?.validationLockToken !== null) throw new Error('Expected validation lock token to be cleared.');
    if (asset9?.validationAttemptCount !== 1) throw new Error(`Expected attempt count 1, got ${asset9?.validationAttemptCount}`);

    // Verify lease is cleared after terminal failure and retention is 24 hours
    const oneDayLimit9 = Date.now() + 23 * 60 * 60 * 1000;
    if (!asset9.retentionUntil || asset9.retentionUntil.getTime() < oneDayLimit9 || asset9.retentionUntil.getTime() > Date.now() + 25 * 60 * 60 * 1000) {
      throw new Error('retentionUntil must be exactly 24 hours in the future.');
    }
    if (fakeProbe.probeCount - probeCountBefore9 !== 1) {
      throw new Error(`Expected probe to be called exactly once, got ${fakeProbe.probeCount - probeCountBefore9}`);
    }

    // -------------------------------------------------------------
    // 10. Zero duration
    // -------------------------------------------------------------
    console.log('Test: zero duration...');
    await createValidationFixture();
    fakeProbe.mockError = null;
    fakeProbe.mockMetadata = {
      containerFormat: 'mp4',
      durationMs: 0,
      videoCodec: 'h264',
      audioCodec: 'aac',
      width: 1920,
      height: 1080,
      frameRate: 30.0,
      detectedMimeType: 'video/mp4'
    };

    const claim10 = await VideoValidationService.claimOneAsset();
    if (!claim10) throw new Error('Failed to claim asset.');
    const res10 = await VideoValidationService.validateAsset(claim10);
    if (res10.success || res10.status !== UploadStatus.FAILED || res10.failureCode !== 'INVALID_DURATION') {
      throw new Error(`Expected INVALID_DURATION failure, got status ${res10.status}, code ${res10.failureCode}`);
    }

    // -------------------------------------------------------------
    // 11. Long-form 30-minute video is accepted
    // -------------------------------------------------------------
    console.log('Test: 30-minute long-form video...');
    await createValidationFixture();
    fakeProbe.mockMetadata = {
      containerFormat: 'mp4',
      durationMs: 30 * 60 * 1000,
      videoCodec: 'h264',
      audioCodec: 'aac',
      width: 1920,
      height: 1080,
      frameRate: 30.0,
      detectedMimeType: 'video/mp4'
    };

    const claim11 = await VideoValidationService.claimOneAsset();
    if (!claim11) throw new Error('Failed to claim asset.');
    const res11 = await VideoValidationService.validateAsset(claim11);
    if (!res11.success || res11.status !== UploadStatus.VALIDATED) {
      throw new Error(`Expected 30-minute video to validate, got status ${res11.status}, code ${res11.failureCode}`);
    }

    // -------------------------------------------------------------
    // 11b. Duration over the configured four-hour limit
    // -------------------------------------------------------------
    console.log('Test: duration over configured long-form limit...');
    await createValidationFixture();
    fakeProbe.mockMetadata = {
      containerFormat: 'mp4',
      durationMs: 240 * 60 * 1000 + 1,
      videoCodec: 'h264',
      audioCodec: 'aac',
      width: 1920,
      height: 1080,
      frameRate: 30.0,
      detectedMimeType: 'video/mp4'
    };

    const claim11b = await VideoValidationService.claimOneAsset();
    if (!claim11b) throw new Error('Failed to claim asset.');
    const res11b = await VideoValidationService.validateAsset(claim11b);
    if (res11b.success || res11b.status !== UploadStatus.FAILED || res11b.failureCode !== 'DURATION_EXCEEDED') {
      throw new Error(`Expected DURATION_EXCEEDED failure, got status ${res11b.status}, code ${res11b.failureCode}`);
    }

    // -------------------------------------------------------------
    // 12. Invalid width or height
    // -------------------------------------------------------------
    console.log('Test: invalid width or height...');
    await createValidationFixture();
    fakeProbe.mockMetadata = {
      containerFormat: 'mp4',
      durationMs: 10000,
      videoCodec: 'h264',
      audioCodec: 'aac',
      width: 0,
      height: 1080,
      frameRate: 30.0,
      detectedMimeType: 'video/mp4'
    };

    const claim12 = await VideoValidationService.claimOneAsset();
    if (!claim12) throw new Error('Failed to claim asset.');
    const res12 = await VideoValidationService.validateAsset(claim12);
    if (res12.success || res12.status !== UploadStatus.FAILED || res12.failureCode !== 'INVALID_DIMENSIONS') {
      throw new Error(`Expected INVALID_DIMENSIONS failure, got status ${res12.status}, code ${res12.failureCode}`);
    }

    // -------------------------------------------------------------
    // 13. Invalid frame rate
    // -------------------------------------------------------------
    console.log('Test: invalid frame rate...');
    await createValidationFixture();
    fakeProbe.mockMetadata = {
      containerFormat: 'mp4',
      durationMs: 10000,
      videoCodec: 'h264',
      audioCodec: 'aac',
      width: 1920,
      height: 1080,
      frameRate: -1.0,
      detectedMimeType: 'video/mp4'
    };

    const claim13 = await VideoValidationService.claimOneAsset();
    if (!claim13) throw new Error('Failed to claim asset.');
    const res13 = await VideoValidationService.validateAsset(claim13);
    if (res13.success || res13.status !== UploadStatus.FAILED || res13.failureCode !== 'INVALID_FRAMERATE') {
      throw new Error(`Expected INVALID_FRAMERATE failure, got status ${res13.status}, code ${res13.failureCode}`);
    }

    // -------------------------------------------------------------
    // 14. Corrupt probe output / parse errors
    // -------------------------------------------------------------
    console.log('Test: corrupt probe output...');
    const f14 = await createValidationFixture();
    fakeProbe.mockMetadata = null;
    fakeProbe.mockError = new Error('Failed to parse ffprobe output: Invalid JSON format.');

    const claim14 = await VideoValidationService.claimOneAsset();
    if (!claim14) throw new Error('Failed to claim asset.');
    const res14 = await VideoValidationService.validateAsset(claim14);
    if (res14.success || res14.status !== UploadStatus.VALIDATING || res14.failureCode !== 'TRANSIENT_INFRASTRUCTURE_FAILURE') {
      throw new Error(`Expected VALIDATING retry on corrupt probe, got status ${res14.status}, code ${res14.failureCode}`);
    }

    const asset14 = await prisma.uploadAsset.findUnique({ where: { id: f14.assetId } });
    if (asset14?.validationLockToken !== null) throw new Error('Expected validation lock token to be cleared.');
    if (asset14?.validationAttemptCount !== 1) throw new Error(`Expected attempt count 1, got ${asset14?.validationAttemptCount}`);
    await parkRetryableAsset(f14.assetId);

    // -------------------------------------------------------------
    // 15. Probe timeout
    // -------------------------------------------------------------
    console.log('Test: probe timeout...');
    const f15 = await createValidationFixture();
    fakeProbe.mockError = new Error('ffprobe process timed out.');

    const claim15 = await VideoValidationService.claimOneAsset();
    if (!claim15) throw new Error('Failed to claim asset.');
    const res15 = await VideoValidationService.validateAsset(claim15);
    if (res15.success || res15.status !== UploadStatus.VALIDATING || res15.failureCode !== 'TRANSIENT_INFRASTRUCTURE_FAILURE') {
      throw new Error(`Expected VALIDATING retry on timeout, got status ${res15.status}, code ${res15.failureCode}`);
    }

    const asset15 = await prisma.uploadAsset.findUnique({ where: { id: f15.assetId } });
    if (asset15?.validationLockToken !== null) throw new Error('Expected validation lock token to be cleared.');
    if (asset15?.validationAttemptCount !== 1) throw new Error(`Expected attempt count 1, got ${asset15?.validationAttemptCount}`);
    await parkRetryableAsset(f15.assetId);

    // -------------------------------------------------------------
    // 16. Temporary storage failure
    // -------------------------------------------------------------
    console.log('Test: temporary storage failure...');
    const f16 = await createValidationFixture();
    // Make storage stream fail
    const mockStorage = getStorageAdapter();
    const originalCreateReadStream = mockStorage.createReadStream;
    mockStorage.createReadStream = async () => {
      throw new Error('Connection refused by GCS.');
    };

    try {
      const claim16 = await VideoValidationService.claimOneAsset();
      if (!claim16) throw new Error('Failed to claim asset.');
      const res16 = await VideoValidationService.validateAsset(claim16);
      if (res16.success || res16.status !== UploadStatus.VALIDATING || res16.failureCode !== 'TRANSIENT_INFRASTRUCTURE_FAILURE') {
        throw new Error(`Expected VALIDATING retry on storage failure, got status ${res16.status}, code ${res16.failureCode}`);
      }

      const asset16 = await prisma.uploadAsset.findUnique({ where: { id: f16.assetId } });
      if (asset16?.validationLockToken !== null) throw new Error('Expected validation lock token to be cleared.');
      if (asset16?.validationAttemptCount !== 1) throw new Error(`Expected attempt count 1, got ${asset16?.validationAttemptCount}`);
      await parkRetryableAsset(f16.assetId);
    } finally {
      mockStorage.createReadStream = originalCreateReadStream;
    }

    // -------------------------------------------------------------
    // 17. Active validation claim conflict
    // -------------------------------------------------------------
    console.log('Test: active validation claim conflict...');
    // Create an asset in VALIDATING with active lock token
    const assetIdConflict = randomUUID();
    await prisma.uploadAsset.create({
      data: {
        id: assetIdConflict,
        userId,
        provider: 'R2',
        bucket: 'mock-bucket',
        objectKey: `uploads/${userId}/conflict.mp4`,
        originalName: 'conflict.mp4',
        expectedSize: 1024,
        declaredMimeType: 'video/mp4',
        status: UploadStatus.VALIDATING,
        idempotencyKey: `idem-conflict`,
        requestFingerprint: `fp-conflict`,
        uploadExpiresAt: new Date(Date.now() + 60000),
        validationLockToken: randomUUID(),
        validationLockedAt: new Date(),
        validationLockExpiresAt: new Date(Date.now() + VALIDATION_LEASE_DURATION_MS)
      }
    });

    const activeClaim = await VideoValidationService.claimOneAsset();
    // Should skip active claimed asset and return null because no other VALIDATING assets are free
    if (activeClaim !== null) {
      throw new Error('Expected claimOneAsset to return null due to lock conflict.');
    }

    // -------------------------------------------------------------
    // 18. Expired validation lease reacquisition
    // -------------------------------------------------------------
    console.log('Test: expired validation lease reacquisition...');
    // Create an asset in VALIDATING with expired lock token
    const assetIdExpired = randomUUID();
    await prisma.uploadAsset.create({
      data: {
        id: assetIdExpired,
        userId,
        provider: 'R2',
        bucket: 'mock-bucket',
        objectKey: `uploads/${userId}/expired.mp4`,
        originalName: 'expired.mp4',
        expectedSize: 1024,
        declaredMimeType: 'video/mp4',
        status: UploadStatus.VALIDATING,
        idempotencyKey: `idem-expired`,
        requestFingerprint: `fp-expired`,
        uploadExpiresAt: new Date(Date.now() + 60000),
        validationLockToken: randomUUID(),
        validationLockedAt: new Date(Date.now() - 10000),
        validationLockExpiresAt: new Date(Date.now() - 5000) // Expired!
      }
    });

    const expiredClaim = await VideoValidationService.claimOneAsset();
    if (!expiredClaim || expiredClaim.assetId !== assetIdExpired) {
      throw new Error('Expected to reacquire expired validation lock.');
    }

    // -------------------------------------------------------------
    // 19. Simultaneous workers allow only one validator
    // -------------------------------------------------------------
    console.log('Test: simultaneous workers allow only one validator...');
    await createValidationFixture();

    const claimPromises = Promise.all([
      VideoValidationService.claimOneAsset(),
      VideoValidationService.claimOneAsset()
    ]);
    const claimOutcomes = await claimPromises;
    const successfulClaims = claimOutcomes.filter(c => c !== null) as ValidationClaim[];
    if (successfulClaims.length !== 1) {
      throw new Error(`Expected exactly 1 claim success, got ${successfulClaims.length}`);
    }

    // -------------------------------------------------------------
    // 20. Stale-token fencing
    // -------------------------------------------------------------
    console.log('Test: stale-token fencing...');
    const fStale = await createValidationFixture();
    const staleClaim = await VideoValidationService.claimOneAsset();
    if (!staleClaim) throw new Error('Claim failed.');

    // Manually break the lease in database to simulate expiration/takeover
    await prisma.uploadAsset.update({
      where: { id: fStale.assetId },
      data: {
        validationLockToken: randomUUID() // Change the token in database
      }
    });

    fakeProbe.mockMetadata = {
      containerFormat: 'mp4',
      durationMs: 5000,
      videoCodec: 'h264',
      audioCodec: 'aac',
      width: 1920,
      height: 1080,
      frameRate: 30.0,
      detectedMimeType: 'video/mp4'
    };

    await assertThrows(
      'Stale token fencing fails transitionToSuccess',
      () => VideoValidationService.validateAsset(staleClaim),
      Error
    );

    // -------------------------------------------------------------
    // 21. Maximum-attempt terminal behavior
    // -------------------------------------------------------------
    console.log('Test: maximum-attempt terminal behavior...');
    // Create asset with 2 attempts, validationMaxAttempts = 3 (this next try will be attempt 3 - the maximum)
    const fMax = await createValidationFixture(1024, UploadStatus.VALIDATING, 2, 3);
    fakeProbe.mockMetadata = null;
    fakeProbe.mockError = new Error('Process interrupted.');

    const claimMax = await VideoValidationService.claimOneAsset();
    if (!claimMax) throw new Error('Claim failed.');
    const resMax = await VideoValidationService.validateAsset(claimMax);

    // Attempt 3 fails, should transition to FAILED status
    if (resMax.success || resMax.status !== UploadStatus.FAILED || resMax.failureCode !== 'VALIDATION_MAX_ATTEMPTS_EXCEEDED') {
      throw new Error(`Expected FAILED with VALIDATION_MAX_ATTEMPTS_EXCEEDED, got status ${resMax.status}, code ${resMax.failureCode}`);
    }

    // Verify claim lock cleared and retention is 24 hours
    const assetMax = await prisma.uploadAsset.findUnique({ where: { id: fMax.assetId } });
    if (assetMax?.validationLockToken !== null) throw new Error('Expected validation lock token to be cleared.');
    if (assetMax?.validationAttemptCount !== 3) throw new Error(`Expected attempt count 3, got ${assetMax?.validationAttemptCount}`);

    // -------------------------------------------------------------
    // 22. Transient retry keeps VALIDATING status and releases lease
    // -------------------------------------------------------------
    console.log('Test: transient retry keeps status VALIDATING...');
    const fTransient = await createValidationFixture(1024, UploadStatus.VALIDATING, 0, 3);
    fakeProbe.mockError = new Error('Probe timeout occurred.');
    fakeProbe.mockMetadata = null;

    const claimTransient = await VideoValidationService.claimOneAsset();
    if (!claimTransient) throw new Error('Claim failed.');
    const resTransient = await VideoValidationService.validateAsset(claimTransient);

    if (resTransient.status !== UploadStatus.VALIDATING) {
      throw new Error(`Expected status to remain VALIDATING, got ${resTransient.status}`);
    }
    const assetTransient = await prisma.uploadAsset.findUnique({ where: { id: fTransient.assetId } });
    if (assetTransient?.validationLockToken !== null) {
      throw new Error('Expected validationLockToken to be cleared for retry.');
    }
    if (assetTransient?.validationAttemptCount !== 1) {
      throw new Error(`Expected attempt count to be 1, got ${assetTransient?.validationAttemptCount}`);
    }

    // Verify reclamation by another worker
    const claimReclaimed = await VideoValidationService.claimOneAsset();
    if (!claimReclaimed || claimReclaimed.assetId !== fTransient.assetId) {
      throw new Error('Expected asset to be reclaimable by next worker.');
    }

    // Second attempt on the same asset
    const resTransient2 = await VideoValidationService.validateAsset(claimReclaimed);
    if (resTransient2.status !== UploadStatus.VALIDATING) {
      throw new Error(`Expected status to remain VALIDATING on second attempt, got ${resTransient2.status}`);
    }
    const assetTransient2 = await prisma.uploadAsset.findUnique({ where: { id: fTransient.assetId } });
    if (assetTransient2?.validationAttemptCount !== 2) {
      throw new Error(`Expected attempt count to be 2, got ${assetTransient2?.validationAttemptCount}`);
    }
    await parkRetryableAsset(fTransient.assetId);

    // -------------------------------------------------------------
    // 23. Stale token cannot release lease
    // -------------------------------------------------------------
    console.log('Test: stale token cannot release lease...');
    const staleClaimRelease: ValidationClaim = {
      ...claimReclaimed,
      lockToken: randomUUID() // stale token!
    };
    await assertThrows(
      'Stale token release lease fails',
      () => VideoValidationService.releaseValidationLeaseForRetry(staleClaimRelease, 'safe message'),
      Error
    );

    // -------------------------------------------------------------
    // 24. stream larger than configured maximum
    // -------------------------------------------------------------
    console.log('Test: stream larger than configured maximum...');
    await createValidationFixture(1024, UploadStatus.VALIDATING, 0, 3);
    // Artificially change the stored objects size in fake adapter to exceed UPLOAD_MAX_BYTES limit
    const originalMax = process.env.UPLOAD_MAX_BYTES;
    process.env.UPLOAD_MAX_BYTES = '500'; // Make max limit 500 bytes

    try {
      const claimOver = await VideoValidationService.claimOneAsset();
      if (!claimOver) throw new Error('Claim failed.');
      const resOver = await VideoValidationService.validateAsset(claimOver);
      if (resOver.success || resOver.status !== UploadStatus.FAILED || resOver.failureCode !== 'SIZE_LIMIT_EXCEEDED') {
        throw new Error(`Expected SIZE_LIMIT_EXCEEDED, got status ${resOver.status}, code ${resOver.failureCode}`);
      }
    } finally {
      if (originalMax) process.env.UPLOAD_MAX_BYTES = originalMax;
      else delete process.env.UPLOAD_MAX_BYTES;
    }

    // -------------------------------------------------------------
    // 25. stream larger than expected size
    // -------------------------------------------------------------
    console.log('Test: stream larger than expected size...');
    const fOverExpect = await createValidationFixture(500, UploadStatus.VALIDATING, 0, 3);
    // Write 1000 bytes content in fake adapter
    (adapter as unknown as { storedObjects: Map<string, unknown> }).storedObjects.set(`mock-bucket/${fOverExpect.objectKey}`, {
      size: 1000,
      etag: '"etag-mock"',
      contentType: 'video/mp4',
      content: Buffer.alloc(1000, 'v'),
      lastModified: new Date()
    });

    const claimExpect = await VideoValidationService.claimOneAsset();
    if (!claimExpect) throw new Error('Claim failed.');
    const resExpect = await VideoValidationService.validateAsset(claimExpect);
    if (resExpect.success || resExpect.status !== UploadStatus.FAILED || resExpect.failureCode !== 'SIZE_MISMATCH') {
      throw new Error(`Expected SIZE_MISMATCH failure, got status ${resExpect.status}, code ${resExpect.failureCode}`);
    }

    // -------------------------------------------------------------
    // 26. executable-not-found returns TRANSIENT_INFRASTRUCTURE_FAILURE
    // -------------------------------------------------------------
    console.log('Test: executable-not-found transient behavior...');
    await createValidationFixture(1024, UploadStatus.VALIDATING, 0, 3);
    fakeProbe.mockError = new Error('FFPROBE_NOT_FOUND');
    fakeProbe.mockMetadata = null;

    const claimExe = await VideoValidationService.claimOneAsset();
    if (!claimExe) throw new Error('Claim failed.');
    const resExe = await VideoValidationService.validateAsset(claimExe);
    if (resExe.status !== UploadStatus.VALIDATING || resExe.failureCode !== 'TRANSIENT_INFRASTRUCTURE_FAILURE') {
      throw new Error(`Expected VALIDATING with TRANSIENT_INFRASTRUCTURE_FAILURE, got status ${resExe.status}, code ${resExe.failureCode}`);
    }
    await parkRetryableAsset(claimExe.assetId);

    // -------------------------------------------------------------
    // 27. container format M4A-only & 3GP rejection
    // -------------------------------------------------------------
    console.log('Test: container format M4A-only & 3GP rejection...');
    await createValidationFixture();
    fakeProbe.mockError = null;
    fakeProbe.mockMetadata = {
      containerFormat: 'm4a', // M4A-only!
      durationMs: 10000,
      videoCodec: 'h264',
      audioCodec: 'aac',
      width: 1920,
      height: 1080,
      frameRate: 30.0,
      detectedMimeType: null
    };

    const claimM4A = await VideoValidationService.claimOneAsset();
    if (!claimM4A) throw new Error('Claim failed.');
    const resM4A = await VideoValidationService.validateAsset(claimM4A);
    if (resM4A.success || resM4A.status !== UploadStatus.FAILED || resM4A.failureCode !== 'INVALID_CONTAINER') {
      throw new Error(`Expected INVALID_CONTAINER failure, got status ${resM4A.status}, code ${resM4A.failureCode}`);
    }

    // -------------------------------------------------------------
    // 28. FfprobeMediaProbe Real Implementation Unit Tests (Monkey-patched child_process)
    // -------------------------------------------------------------
    console.log('Test: FfprobeMediaProbe missing executable -> FFPROBE_NOT_FOUND...');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cp = require('child_process');
    const originalExecFile = cp.execFile;
    const realProbe = new FfprobeMediaProbe();

    // Mock ENOENT error
    (cp as unknown as { execFile: unknown }).execFile = (
      _file: string,
      _args: ReadonlyArray<string> | null | undefined,
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void
    ) => {
      const err = new Error('spawn ffprobe ENOENT');
      (err as unknown as Record<string, unknown>).code = 'ENOENT';
      callback(err, '', '');
    };

    await assertThrows(
      'FfprobeMediaProbe throws FFPROBE_NOT_FOUND on ENOENT',
      () => realProbe.probe('some-path.mp4'),
      Error
    );

    console.log('Test: FfprobeMediaProbe malformed stdout JSON output...');
    // Mock malformed JSON
    (cp as unknown as { execFile: unknown }).execFile = (
      _file: string,
      _args: ReadonlyArray<string> | null | undefined,
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void
    ) => {
      callback(null, 'invalid json', '');
    };

    await assertThrows(
      'FfprobeMediaProbe throws on malformed JSON',
      () => realProbe.probe('some-path.mp4'),
      Error
    );

    console.log('Test: FfprobeMediaProbe oversized JSON output...');
    // Mock oversized JSON
    (cp as unknown as { execFile: unknown }).execFile = (
      _file: string,
      _args: ReadonlyArray<string> | null | undefined,
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void
    ) => {
      callback(null, 'a'.repeat(600 * 1024), ''); // 600 KB
    };

    await assertThrows(
      'FfprobeMediaProbe throws on oversized JSON',
      () => realProbe.probe('some-path.mp4'),
      Error
    );

    console.log('Test: FfprobeMediaProbe process timeout terminates child...');
    // Mock timeout error
    (cp as unknown as { execFile: unknown }).execFile = (
      _file: string,
      _args: ReadonlyArray<string> | null | undefined,
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void
    ) => {
      const err = new Error('timeout');
      (err as unknown as Record<string, unknown>).killed = true;
      callback(err, '', '');
    };

    await assertThrows(
      'FfprobeMediaProbe throws on timeout',
      () => realProbe.probe('some-path.mp4'),
      Error
    );

    console.log('Test: FfprobeMediaProbe arguments and shell safety...');
    // Mock successful probe format check
    let passedShell = true;
    let passedArgs = false;
    (cp as unknown as { execFile: unknown }).execFile = (
      _file: string,
      args: ReadonlyArray<string> | null | undefined,
      options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void
    ) => {
      const typedOptions = options as Record<string, unknown>;
      if (typedOptions.shell !== false) passedShell = false;
      if (Array.isArray(args) && args.includes('some-media-path.mp4')) passedArgs = true;

      const mockStdout = JSON.stringify({
        streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, r_frame_rate: '30/1', duration: '15.000000' }],
        format: { format_name: 'mp4', duration: '15.000000' }
      });
      callback(null, mockStdout, '');
    };

    const parsedMeta = await realProbe.probe('some-media-path.mp4');
    if (!passedShell) throw new Error('Expected options.shell to be false');
    if (!passedArgs) throw new Error('Expected arguments array to contain the media path without shell nesting');
    if (parsedMeta.containerFormat !== 'mp4' || parsedMeta.width !== 1920) {
      throw new Error('FfprobeMediaProbe did not parse stdout correctly');
    }

    // Restore original execFile
    (cp as unknown as { execFile: unknown }).execFile = originalExecFile;

    // -------------------------------------------------------------
    // 29. Missing video stream terminal failure
    // -------------------------------------------------------------
    console.log('Test: missing video stream terminal failure...');
    const fNoVideo = await createValidationFixture();
    fakeProbe.mockError = new MediaValidationError('MISSING_VIDEO_STREAM', 'No video stream found in media.');
    fakeProbe.mockMetadata = null;

    const claimNoVideo = await VideoValidationService.claimOneAsset();
    if (!claimNoVideo) throw new Error('Claim failed.');
    const resNoVideo = await VideoValidationService.validateAsset(claimNoVideo);

    if (resNoVideo.success || resNoVideo.status !== UploadStatus.FAILED || resNoVideo.failureCode !== 'MISSING_VIDEO_STREAM') {
      throw new Error(`Expected FAILED with MISSING_VIDEO_STREAM, got status ${resNoVideo.status}, code ${resNoVideo.failureCode}`);
    }

    // Verify attempt is not released for retry
    const assetNoVideo = await prisma.uploadAsset.findUnique({ where: { id: fNoVideo.assetId } });
    if (assetNoVideo?.validationLockToken !== null) {
      throw new Error('Expected validation lease lock token to be cleared after terminal failure');
    }

    // Restore fakeProbe mock defaults
    fakeProbe.mockError = null;

    // -------------------------------------------------------------
    // 30. Worker route fault isolation tests
    // -------------------------------------------------------------
    console.log('Test: worker route unauthorized request...');

    // 1. Unauthorized
    const unauthorizedDeps: WorkerRouteDependencies = {
      verifyAdminSession: async () => null,
      verifyAdminRole: () => false,
      runQueueWorker: async () => [],
      validateOneAsset: async () => null
    };

    const mockHeaders = new Map<string, string>();
    mockHeaders.set('host', 'localhost:3000');
    mockHeaders.set('origin', 'http://localhost:3000');

    const mockRequest = ({
      method: 'POST',
      headers: {
        get: (name: string) => mockHeaders.get(name.toLowerCase()) || null
      }
    } as unknown) as NextRequest;

    const resAuth = await handleWorkerPost(mockRequest, unauthorizedDeps);
    if (resAuth.status !== 401) {
      throw new Error(`Expected status 401, got ${resAuth.status}`);
    }

    // 2. Authorized but no assets
    let mockPublishingCalled = false;
    const noAssetsDeps: WorkerRouteDependencies = {
      verifyAdminSession: async () => ({
        id: 'admin-id',
        email: 'admin@example.com',
        passwordHash: 'dummy',
        role: 'ADMIN',
        status: 'ACTIVE',
        approvalStatus: 'APPROVED',
        createdAt: new Date(),
        updatedAt: new Date()
      } as unknown as User),
      verifyAdminRole: () => true,
      runQueueWorker: async () => {
        mockPublishingCalled = true;
        return ['Publishing worker mock logs.'];
      },
      validateOneAsset: async () => null
    };

    // Clean up any remaining validating assets
    await prisma.uploadAsset.updateMany({
      where: { status: UploadStatus.VALIDATING },
      data: { status: UploadStatus.FAILED }
    });

    const resNoWork = await handleWorkerPost(mockRequest, noAssetsDeps);
    if (resNoWork.status !== 200) {
      throw new Error(`Expected status 200, got ${resNoWork.status}`);
    }
    const noWorkBody = await resNoWork.json() as Record<string, unknown>;
    const logsArray = noWorkBody.logs as string[];
    if (!mockPublishingCalled) {
      throw new Error('Expected publishing worker to run');
    }
    if (!logsArray.some((l: string) => l.includes('No assets in VALIDATING state require validation.'))) {
      throw new Error('Expected logs to indicate no validation assets');
    }

    // 3. Validation success plus normal publishing execution
    mockPublishingCalled = false;
    await createValidationFixture();
    fakeProbe.mockError = null;
    fakeProbe.mockMetadata = {
      containerFormat: 'mp4',
      durationMs: 5000,
      videoCodec: 'h264',
      audioCodec: 'aac',
      width: 1920,
      height: 1080,
      frameRate: 30.0,
      detectedMimeType: 'video/mp4'
    };

    const successDeps: WorkerRouteDependencies = {
      verifyAdminSession: async () => ({
        id: 'admin-id',
        email: 'admin@example.com',
        passwordHash: 'dummy',
        role: 'ADMIN',
        status: 'ACTIVE',
        approvalStatus: 'APPROVED',
        createdAt: new Date(),
        updatedAt: new Date()
      } as unknown as User),
      verifyAdminRole: () => true,
      runQueueWorker: async () => {
        mockPublishingCalled = true;
        return ['Publishing worker mock logs.'];
      },
      validateOneAsset: async () => VideoValidationService.validateOneAsset()
    };

    const resSuccess = await handleWorkerPost(mockRequest, successDeps);
    if (resSuccess.status !== 200) {
      throw new Error(`Expected status 200, got ${resSuccess.status}`);
    }
    const successBody = await resSuccess.json() as Record<string, unknown>;
    const logsSuccess = successBody.logs as string[];
    if (!mockPublishingCalled) {
      throw new Error('Expected publishing worker to run');
    }
    if (!logsSuccess.some((l: string) => l.includes('Success: true, Status: VALIDATED'))) {
      throw new Error('Expected logs to contain success validation message');
    }

    // 4. Validation failure plus publishing still executes
    mockPublishingCalled = false;
    await createValidationFixture();
    fakeProbe.mockError = null;
    fakeProbe.mockMetadata = {
      containerFormat: 'avi', // Invalid container format -> Validation failure!
      durationMs: 5000,
      videoCodec: 'h264',
      audioCodec: 'aac',
      width: 1920,
      height: 1080,
      frameRate: 30.0,
      detectedMimeType: 'video/mp4'
    };

    const failDeps: WorkerRouteDependencies = {
      verifyAdminSession: async () => ({
        id: 'admin-id',
        email: 'admin@example.com',
        passwordHash: 'dummy',
        role: 'ADMIN',
        status: 'ACTIVE',
        approvalStatus: 'APPROVED',
        createdAt: new Date(),
        updatedAt: new Date()
      } as unknown as User),
      verifyAdminRole: () => true,
      runQueueWorker: async () => {
        mockPublishingCalled = true;
        return ['Publishing worker mock logs.'];
      },
      validateOneAsset: async () => VideoValidationService.validateOneAsset()
    };

    const resFail = await handleWorkerPost(mockRequest, failDeps);
    if (resFail.status !== 200) {
      throw new Error(`Expected status 200, got ${resFail.status}`);
    }
    const failBody = await resFail.json() as Record<string, unknown>;
    const logsFail = failBody.logs as string[];
    if (!mockPublishingCalled) {
      throw new Error('Expected publishing worker to run');
    }
    if (!logsFail.some((l: string) => l.includes('Success: false, Status: FAILED'))) {
      throw new Error('Expected logs to contain failure validation message');
    }

    // 5. Publishing failure does not run validation
    mockPublishingCalled = false;
    const publishingFailDeps: WorkerRouteDependencies = {
      verifyAdminSession: async () => ({
        id: 'admin-id',
        email: 'admin@example.com',
        passwordHash: 'dummy',
        role: 'ADMIN',
        status: 'ACTIVE',
        approvalStatus: 'APPROVED',
        createdAt: new Date(),
        updatedAt: new Date()
      } as unknown as User),
      verifyAdminRole: () => true,
      runQueueWorker: async () => {
        throw new Error('Publishing DB error.');
      },
      validateOneAsset: async () => {
        throw new Error('Should not be called since publishing failed first.');
      }
    };

    const resPublishFail = await handleWorkerPost(mockRequest, publishingFailDeps);
    if (resPublishFail.status !== 500) {
      throw new Error(`Expected status 500 on publishing failure, got ${resPublishFail.status}`);
    }

    // -------------------------------------------------------------
    // 31. Bounded actualSize checks (smaller, larger, matched)
    // -------------------------------------------------------------
    console.log('Test: stream bytes smaller than actualSize -> SIZE_MISMATCH...');
    const fSmaller = await createValidationFixture(1000, UploadStatus.VALIDATING, 0, 3);
    // Write 500 bytes content in fake adapter
    (adapter as unknown as { storedObjects: Map<string, unknown> }).storedObjects.set(`mock-bucket/${fSmaller.objectKey}`, {
      size: 500,
      etag: '"etag-mock"',
      contentType: 'video/mp4',
      content: Buffer.alloc(500, 'v'),
      lastModified: new Date()
    });

    const claimSmaller = await VideoValidationService.claimOneAsset();
    if (!claimSmaller) throw new Error('Claim failed.');
    const resSmaller = await VideoValidationService.validateAsset(claimSmaller);
    if (resSmaller.success || resSmaller.status !== UploadStatus.FAILED || resSmaller.failureCode !== 'SIZE_MISMATCH') {
      throw new Error(`Expected FAILED with SIZE_MISMATCH, got status ${resSmaller.status}, code ${resSmaller.failureCode}`);
    }

    console.log('Test: stream bytes larger than actualSize -> SIZE_MISMATCH...');
    const fLarger = await createValidationFixture(1000, UploadStatus.VALIDATING, 0, 3);
    // Write 1500 bytes content in fake adapter
    (adapter as unknown as { storedObjects: Map<string, unknown> }).storedObjects.set(`mock-bucket/${fLarger.objectKey}`, {
      size: 1500,
      etag: '"etag-mock"',
      contentType: 'video/mp4',
      content: Buffer.alloc(1500, 'v'),
      lastModified: new Date()
    });

    const claimLarger = await VideoValidationService.claimOneAsset();
    if (!claimLarger) throw new Error('Claim failed.');
    const resLarger = await VideoValidationService.validateAsset(claimLarger);
    if (resLarger.success || resLarger.status !== UploadStatus.FAILED || resLarger.failureCode !== 'SIZE_MISMATCH') {
      throw new Error(`Expected FAILED with SIZE_MISMATCH, got status ${resLarger.status}, code ${resLarger.failureCode}`);
    }

    console.log('Test: actualSize differs from expectedSize but matches actualSize...');
    await prisma.uploadAsset.create({
      data: {
        userId,
        bucket: 'mock-bucket',
        objectKey: 'diff-size-key',
        originalName: 'video.mp4',
        expectedSize: 5000, // expected is 5000
        actualSize: 1000,   // actual is 1000
        declaredMimeType: 'video/mp4',
        status: UploadStatus.VALIDATING,
        idempotencyKey: 'idem-diff-size',
        requestFingerprint: 'a'.repeat(64),
        uploadExpiresAt: new Date(Date.now() + 60000),
        validationAttemptCount: 0,
        validationMaxAttempts: 3
      }
    });

    (adapter as unknown as { storedObjects: Map<string, unknown> }).storedObjects.set(`mock-bucket/diff-size-key`, {
      size: 1000, // Matches actualSize exactly!
      etag: '"etag-mock"',
      contentType: 'video/mp4',
      content: Buffer.alloc(1000, 'v'),
      lastModified: new Date()
    });

    fakeProbe.mockError = null;
    fakeProbe.mockMetadata = {
      containerFormat: 'mp4',
      durationMs: 5000,
      videoCodec: 'h264',
      audioCodec: 'aac',
      width: 1920,
      height: 1080,
      frameRate: 30.0,
      detectedMimeType: 'video/mp4'
    };

    const claimDiff = await VideoValidationService.claimOneAsset();
    if (!claimDiff) throw new Error('Claim failed.');
    const resDiff = await VideoValidationService.validateAsset(claimDiff);
    if (!resDiff.success || resDiff.status !== UploadStatus.VALIDATED) {
      throw new Error(`Expected successful validation because actualSize matches download size, got status ${resDiff.status}, code ${resDiff.failureCode}`);
    }

    console.log('ALL PHASE 4 STEP 4A VIDEO VALIDATION INTEGRATION TESTS CLEAN! 🎉');
  } finally {
    if (originalVideoMaxDurationMinutes === undefined) {
      delete process.env.VIDEO_MAX_DURATION_MINUTES;
    } else {
      process.env.VIDEO_MAX_DURATION_MINUTES = originalVideoMaxDurationMinutes;
    }
    await prisma.$disconnect();
  }
}

runTests().catch((e: unknown) => {
  console.error('TEST SUITE FAILED:', e);
  process.exit(1);
});
