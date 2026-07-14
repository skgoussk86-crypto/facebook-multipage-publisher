import { PrismaClient, UploadStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import {
  injectTestEncryptionKey,
  clearTestEncryptionKey,
  encryptUploadSecret,
  decryptUploadSecret,
  ConfigurationError,
  EncryptionAuthenticationError,
  MalformedEncryptedDataError,
  IdempotencyConflictError,
  InvalidStateTransitionError,
  NotFoundError,
  ForbiddenOwnershipError,
  ExpiredSessionError,
  InvalidMultipartMetadataError,
} from '../src/lib/storage/upload-session-encryption';
import {
  UploadStateService,
} from '../src/lib/storage/upload-state-service';
import {
  UploadSessionService
} from '../src/lib/storage/upload-session-service';

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

interface TestAsset {
  id: string;
  status: string;
  uploadedAt: Date | null;
  actualSize: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  validationStartedAt: Date | null;
}

async function runTests() {
  console.log('Starting Phase 4 Step 3A Upload Service & Encryption Tests...');

  // Clean up existing test data from previous runs
  await prisma.uploadSession.deleteMany({});
  await prisma.uploadAttempt.deleteMany({});
  await prisma.uploadAsset.deleteMany({});
  await prisma.user.deleteMany({
    where: {
      email: {
        contains: 'test-u',
      },
    },
  });

  // Setup mock users
  const testUserId1 = randomUUID();
  const testUserId2 = randomUUID();

  // Create users in test database
  await prisma.user.createMany({
    data: [
      {
        id: testUserId1,
        email: `test-u1-${testUserId1.slice(0, 8)}@example.com`,
        passwordHash: 'dummy',
        role: 'USER',
        status: 'ACTIVE',
        approvalStatus: 'APPROVED',
      },
      {
        id: testUserId2,
        email: `test-u2-${testUserId2.slice(0, 8)}@example.com`,
        passwordHash: 'dummy',
        role: 'USER',
        status: 'ACTIVE',
        approvalStatus: 'APPROVED',
      },
    ],
  });

  // Inject a 32-byte test key
  const testKey = Buffer.alloc(32, 'x');
  const testKeyVersion = 'v-test';
  injectTestEncryptionKey(testKey, testKeyVersion);

  try {
    // -------------------------------------------------------------
    // Encryption Tests
    // -------------------------------------------------------------
    console.log('Test: Encryption round trip...');
    const plaintext = 'my-secret-provider-session-id';
    const envelope = encryptUploadSecret(plaintext);
    if (!envelope.startsWith(`${testKeyVersion}:`)) {
      throw new Error('Assertion failed: Envelope version mismatch.');
    }
    const decrypted = decryptUploadSecret(envelope);
    if (decrypted !== plaintext) {
      throw new Error('Assertion failed: Decryption round trip failed.');
    }

    console.log('Test: Unique nonce generation...');
    const envelope2 = encryptUploadSecret(plaintext);
    if (envelope === envelope2) {
      throw new Error('Assertion failed: Nonce must be unique.');
    }

    console.log('Test: Tampered ciphertext rejection...');
    const tampered = envelope.slice(0, -5) + 'abcde';
    try {
      decryptUploadSecret(tampered);
      throw new Error('Assertion failed: Tampered ciphertext was not rejected.');
    } catch (e: unknown) {
      if (!(e instanceof EncryptionAuthenticationError)) throw e;
    }

    console.log('Test: Malformed envelope rejection...');
    try {
      decryptUploadSecret('invalid-envelope-format');
      throw new Error('Assertion failed: Malformed envelope was not rejected.');
    } catch (e: unknown) {
      if (!(e instanceof MalformedEncryptedDataError)) throw e;
    }

    console.log('Test: Unknown key-version rejection...');
    const badEnvelope = `v-other:iv:tag:cipher`;
    try {
      decryptUploadSecret(badEnvelope);
      throw new Error('Assertion failed: Unknown version was not rejected.');
    } catch (e: unknown) {
      if (!(e instanceof ConfigurationError)) throw e;
    }

    console.log('Test: Missing configuration fail-closed behavior...');
    clearTestEncryptionKey();
    const originalEnvKey = process.env.UPLOAD_SESSION_ENCRYPTION_KEY;
    const originalEnvVersion = process.env.UPLOAD_SESSION_ENCRYPTION_KEY_VERSION;
    delete process.env.UPLOAD_SESSION_ENCRYPTION_KEY;
    delete process.env.UPLOAD_SESSION_ENCRYPTION_KEY_VERSION;
    try {
      encryptUploadSecret(plaintext);
      throw new Error('Assertion failed: Should fail when environment keys are missing.');
    } catch (e: unknown) {
      if (!(e instanceof ConfigurationError)) throw e;
    }
    // Restore
    process.env.UPLOAD_SESSION_ENCRYPTION_KEY = originalEnvKey;
    process.env.UPLOAD_SESSION_ENCRYPTION_KEY_VERSION = originalEnvVersion;
    injectTestEncryptionKey(testKey, testKeyVersion);

    // -------------------------------------------------------------
    // Request Fingerprint & Idempotency Tests
    // -------------------------------------------------------------
    console.log('Test: Deterministic request fingerprint...');
    const fp1 = UploadSessionService.generateRequestFingerprint('video.mp4', BigInt(100), 'video/mp4');
    const fp2 = UploadSessionService.generateRequestFingerprint('video.mp4', BigInt(100), 'video/mp4');
    const fp3 = UploadSessionService.generateRequestFingerprint('  VIDEO.MP4  ', BigInt(100), '  video/mp4  ');
    if (fp1 !== fp2 || fp1 !== fp3) {
      throw new Error('Assertion failed: Fingerprint calculation must be deterministic.');
    }

    console.log('Test: Same idempotency key and same fingerprint behavior...');
    const idempotencyKey = randomUUID();
    const initData = {
      idempotencyKey,
      originalName: 'my-video.mov',
      expectedSize: BigInt(5000000),
      declaredMimeType: 'video/quicktime',
      bucket: 'test-bucket',
      objectKey: 'uploads/vid-1.mov',
      providerSessionId: 'provider-sess-123',
      uploadExpiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 mins expiry
    };

    const asset1 = (await UploadSessionService.initiateUpload(testUserId1, initData)) as TestAsset;
    const asset2 = (await UploadSessionService.initiateUpload(testUserId1, initData)) as TestAsset;
    if (asset1.id !== asset2.id) {
      throw new Error('Assertion failed: Reinitiating with same parameters should return the same asset ID.');
    }

    console.log('Test: Same idempotency key and different fingerprint conflict...');
    try {
      await UploadSessionService.initiateUpload(testUserId1, {
        ...initData,
        originalName: 'different-video.mp4', // Changes fingerprint
      });
      throw new Error('Assertion failed: Should throw conflict error when fingerprint differs.');
    } catch (e: unknown) {
      if (!(e instanceof IdempotencyConflictError)) throw e;
    }

    // -------------------------------------------------------------
    // Owner Isolation Tests
    // -------------------------------------------------------------
    console.log('Test: Owner isolation checks...');
    try {
      await UploadSessionService.getDecryptedSession(testUserId2, asset1.id);
      throw new Error('Assertion failed: Should reject session retrieval by non-owner user.');
    } catch (e: unknown) {
      if (!(e instanceof ForbiddenOwnershipError)) throw e;
    }

    try {
      await UploadStateService.transitionUploadStatus(testUserId2, asset1.id, UploadStatus.UPLOADING);
      throw new Error('Assertion failed: Should reject state transition by non-owner user.');
    } catch (e: unknown) {
      if (!(e instanceof ForbiddenOwnershipError)) throw e;
    }

    // -------------------------------------------------------------
    // Upload Session Decryption Verification
    // -------------------------------------------------------------
    console.log('Test: Read and decrypt active session...');
    const decryptedSession = await UploadSessionService.getDecryptedSession(testUserId1, asset1.id);
    if (decryptedSession.providerSessionId !== 'provider-sess-123') {
      throw new Error('Assertion failed: Decrypted provider session ID mismatch.');
    }
    if (decryptedSession.completedParts.length !== 0) {
      throw new Error('Assertion failed: Fresh completed parts list should be empty.');
    }

    // Verify no plaintext is stored in the database
    const dbSession = await prisma.uploadSession.findUnique({
      where: { uploadAssetId: asset1.id },
    });
    if (!dbSession) throw new Error('Assertion failed: Session not found in DB.');
    if (
      dbSession.encryptedProviderSessionId.includes('provider-sess-123') ||
      dbSession.encryptedCompletedParts.includes('[]')
    ) {
      throw new Error('Assertion failed: Plaintext secrets were stored in database!');
    }

    // -------------------------------------------------------------
    // Completed Part Metadata Tests
    // -------------------------------------------------------------
    console.log('Test: Add completed parts metadata...');
    const partsToUpdate = [
      { partNumber: 2, etag: 'etag-2', size: 100 },
      { partNumber: 1, etag: 'etag-1', size: 200 },
    ];
    const sessionWithParts = await UploadSessionService.updateCompletedParts(testUserId1, asset1.id, partsToUpdate);

    // Check sorting order (ascending by partNumber)
    if (sessionWithParts.completedParts[0].partNumber !== 1 || sessionWithParts.completedParts[1].partNumber !== 2) {
      throw new Error('Assertion failed: Completed parts must be ordered in ascending order.');
    }

    console.log('Test: Duplicate part replacement behavior...');
    const replacementPart = [{ partNumber: 2, etag: 'new-etag-2', size: 150 }];
    const sessionUpdated = await UploadSessionService.updateCompletedParts(testUserId1, asset1.id, replacementPart);
    if (sessionUpdated.completedParts.length !== 2) {
      throw new Error('Assertion failed: Merging should not duplicate part records.');
    }
    if (sessionUpdated.completedParts[1].etag !== 'new-etag-2' || sessionUpdated.completedParts[1].size !== 150) {
      throw new Error('Assertion failed: Duplicate part number did not replace the existing metadata.');
    }

    console.log('Test: Invalid part number rejection...');
    try {
      await UploadSessionService.updateCompletedParts(testUserId1, asset1.id, [
        { partNumber: 0, etag: 'etag-0' },
      ]);
      throw new Error('Assertion failed: Part number 0 should be rejected.');
    } catch (e: unknown) {
      if (!(e instanceof InvalidMultipartMetadataError)) throw e;
    }

    try {
      await UploadSessionService.updateCompletedParts(testUserId1, asset1.id, [
        { partNumber: 10001, etag: 'etag-10001' },
      ]);
      throw new Error('Assertion failed: Part number 10001 should be rejected.');
    } catch (e: unknown) {
      if (!(e instanceof InvalidMultipartMetadataError)) throw e;
    }

    console.log('Test: Empty/Malformed ETag rejection...');
    try {
      await UploadSessionService.updateCompletedParts(testUserId1, asset1.id, [
        { partNumber: 3, etag: '' },
      ]);
      throw new Error('Assertion failed: Empty ETag should be rejected.');
    } catch (e: unknown) {
      if (!(e instanceof InvalidMultipartMetadataError)) throw e;
    }

    // -------------------------------------------------------------
    // Upload Status Transition Tests
    // -------------------------------------------------------------
    console.log('Test: Legal upload status transitions...');
    // REQUESTED -> UPLOADING
    let updatedAsset = (await UploadStateService.transitionUploadStatus(testUserId1, asset1.id, UploadStatus.UPLOADING)) as TestAsset;
    if (updatedAsset.status !== 'UPLOADING') throw new Error('Assertion failed: Status should be UPLOADING.');

    // UPLOADING -> UPLOADED
    updatedAsset = (await UploadStateService.transitionUploadStatus(testUserId1, asset1.id, UploadStatus.UPLOADED, {
      actualSize: BigInt(8000000),
    })) as TestAsset;
    if (updatedAsset.status !== 'UPLOADED') throw new Error('Assertion failed: Status should be UPLOADED.');
    if (updatedAsset.uploadedAt === null || updatedAsset.actualSize !== '8000000') {
      throw new Error('Assertion failed: uploadedAt and actualSize metadata mismatch.');
    }

    // UPLOADED -> VALIDATING
    updatedAsset = (await UploadStateService.transitionUploadStatus(testUserId1, asset1.id, UploadStatus.VALIDATING)) as TestAsset;
    if (updatedAsset.status !== 'VALIDATING') throw new Error('Assertion failed: Status should be VALIDATING.');
    if (updatedAsset.validationStartedAt === null) throw new Error('Assertion failed: validationStartedAt should be set.');

    // VALIDATING -> FAILED
    updatedAsset = (await UploadStateService.transitionUploadStatus(testUserId1, asset1.id, UploadStatus.FAILED, {
      failureCode: 'TEST_ERR',
      failureMessage: 'Test failure msg',
    })) as TestAsset;
    if (updatedAsset.status !== 'FAILED') throw new Error('Assertion failed: Status should be FAILED.');
    if (updatedAsset.failureCode !== 'TEST_ERR' || updatedAsset.failureMessage !== 'Test failure msg') {
      throw new Error('Assertion failed: failureCode or failureMessage mismatch.');
    }

    // FAILED -> REQUESTED (via Retry)
    updatedAsset = (await UploadStateService.prepareUploadRetry(testUserId1, asset1.id)) as TestAsset;
    if (updatedAsset.status !== 'REQUESTED') throw new Error('Assertion failed: Status should be REQUESTED post retry.');
    if (updatedAsset.failureCode !== null || updatedAsset.uploadedAt !== null) {
      throw new Error('Assertion failed: Retry should reset fields.');
    }

    // Verify session was deleted on retry
    try {
      await UploadSessionService.getDecryptedSession(testUserId1, asset1.id);
      throw new Error('Assertion failed: Session secrets should be deleted on retry.');
    } catch (e: unknown) {
      if (!(e instanceof NotFoundError)) throw e;
    }

    console.log('Test: Illegal status transitions...');
    // REQUESTED -> VALIDATED is illegal
    try {
      await UploadStateService.transitionUploadStatus(testUserId1, asset1.id, UploadStatus.VALIDATED);
      throw new Error('Assertion failed: REQUESTED -> VALIDATED must be blocked.');
    } catch (e: unknown) {
      if (!(e instanceof InvalidStateTransitionError)) throw e;
    }

    // -------------------------------------------------------------
    // Session Invalidation & Expiry
    // -------------------------------------------------------------
    console.log('Test: Invalidate session...');
    // Setup new session
    const idempotencyKey2 = randomUUID();
    const asset3 = (await UploadSessionService.initiateUpload(testUserId1, {
      ...initData,
      idempotencyKey: idempotencyKey2,
      objectKey: 'uploads/vid-3.mov',
    })) as TestAsset;
    await UploadSessionService.invalidateUploadSession(testUserId1, asset3.id);
    try {
      await UploadSessionService.getDecryptedSession(testUserId1, asset3.id);
      throw new Error('Assertion failed: Session secrets should not exist after invalidation.');
    } catch (e: unknown) {
      if (!(e instanceof NotFoundError)) throw e;
    }

    console.log('Test: Session expiry...');
    const idempotencyKey3 = randomUUID();
    // Create an asset whose session is already expired
    const expiredDate = new Date(Date.now() - 5000);
    const asset4 = (await UploadSessionService.initiateUpload(testUserId1, {
      ...initData,
      idempotencyKey: idempotencyKey3,
      objectKey: 'uploads/vid-4.mov',
      uploadExpiresAt: expiredDate,
    })) as TestAsset;

    // Check that reading it throws expired error
    try {
      await UploadSessionService.getDecryptedSession(testUserId1, asset4.id);
      throw new Error('Assertion failed: Expired session read should fail.');
    } catch (e: unknown) {
      if (!(e instanceof ExpiredSessionError)) throw e;
    }

    // Process expiration cron service
    const expiredCount = await UploadSessionService.expireStaleSessions();
    if (expiredCount !== 1) {
      throw new Error(`Assertion failed: Should expire 1 stale session. Got ${expiredCount}.`);
    }

    // Verify asset4 status transitioned to EXPIRED
    const expiredAsset = await prisma.uploadAsset.findUnique({
      where: { id: asset4.id },
    });
    if (expiredAsset?.status !== UploadStatus.EXPIRED) {
      throw new Error('Assertion failed: Expired asset status should be EXPIRED.');
    }

    console.log('ALL PERSISTENT UPLOAD SERVICE TESTS PASSED SUCCESSFULLY! 🎉');
  } finally {
    clearTestEncryptionKey();
    await prisma.$disconnect();
  }
}

runTests().catch((e: unknown) => {
  console.error('TEST SUITE FAILED:', e);
  process.exit(1);
});
