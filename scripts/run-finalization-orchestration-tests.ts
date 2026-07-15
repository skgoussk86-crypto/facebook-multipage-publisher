import { PrismaClient, UploadStatus, UploadFinalizationOperation } from '@prisma/client';
import { randomUUID } from 'crypto';
import {
  injectTestEncryptionKey,
  clearTestEncryptionKey,
  encryptUploadSecret,
  InvalidMultipartMetadataError,
  ForbiddenOwnershipError,
  NotFoundError,
} from '../src/lib/storage/upload-session-encryption';
import { UploadFinalizationService } from '../src/lib/storage/upload-finalization-service';
import {
  FinalizationOperationConflictError,
  FinalizationInProgressError,
  LEASE_DURATION_MS,
} from '../src/lib/storage/finalization-claim-service';
import { UploadStateService, FencingError } from '../src/lib/storage/upload-state-service';
import { MultipartUploadNotFoundError } from '../src/lib/storage/storage-adapter';
import { getStorageAdapter, resetStorageAdapterInstance } from '../src/lib/storage';
import { InMemoryFakeStorageAdapter } from '../src/lib/storage/in-memory-fake-adapter';
import { handleCompleteUpload } from '../src/app/api/uploads/[id]/complete/route';
import { handleAbortUpload } from '../src/app/api/uploads/[id]/abort/route';

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

interface CompletedPartInput {
  partNumber: number;
  etag: string;
  size?: number;
}

async function createProviderFailureFixture(
  userId: string,
  options: {
    expectedSize?: number;
    status?: UploadStatus;
    completedParts?: CompletedPartInput[];
  } = {}
) {
  const assetId = randomUUID();
  const suffix = randomUUID().slice(0, 8);
  const objectKey = `uploads/${userId}/fail-${suffix}.mp4`;
  const idempotencyKey = `idem-fail-${suffix}`;
  const requestFingerprint = `fp-fail-${suffix}`;
  const expectedSize = options.expectedSize || 10 * 1024 * 1024;
  const status = options.status || UploadStatus.UPLOADING;

  await prisma.uploadAsset.create({
    data: {
      id: assetId,
      userId,
      provider: 'R2',
      bucket: 'mock-bucket',
      objectKey,
      originalName: `fail-${suffix}.mp4`,
      expectedSize,
      declaredMimeType: 'video/mp4',
      status,
      idempotencyKey,
      requestFingerprint,
      uploadExpiresAt: new Date(Date.now() + 60000),
    },
  });

  const adapter = getStorageAdapter() as InMemoryFakeStorageAdapter;
  const providerSessionId = await adapter.createMultipartUpload('mock-bucket', objectKey, 'video/mp4');

  const parts = options.completedParts || [
    { partNumber: 1, etag: `etag-${suffix}`, size: expectedSize },
  ];

  for (const part of parts) {
    const partSize = part.size || expectedSize;
    adapter.simulateUploadPart(providerSessionId, part.partNumber, Buffer.alloc(partSize, 'x'), part.etag);
  }

  if (status !== UploadStatus.REQUESTED) {
    await prisma.uploadSession.create({
      data: {
        uploadAssetId: assetId,
        encryptionKeyVersion: 'v-test-orch',
        encryptedProviderSessionId: encryptUploadSecret(providerSessionId),
        encryptedCompletedParts: encryptUploadSecret(JSON.stringify(parts)),
        expiresAt: new Date(Date.now() + 60000),
        lastActivityAt: new Date(),
      },
    });
  }

  return {
    assetId,
    providerSessionId,
    parts,
  };
}

async function runTests() {
  console.log('Starting Phase 4 Step 3D finalization orchestration tests...');

  // Configure storage environment
  process.env.STORAGE_PROVIDER = 'FAKE';
  resetStorageAdapterInstance();
  const adapter = getStorageAdapter() as InMemoryFakeStorageAdapter;

  // Inject a 32-byte test key
  const testKey = Buffer.alloc(32, 'y');
  const testKeyVersion = 'v-test-orch';
  injectTestEncryptionKey(testKey, testKeyVersion);

  // Setup mock user
  const userId = randomUUID();
  await prisma.uploadSession.deleteMany({});
  await prisma.uploadAttempt.deleteMany({});
  await prisma.uploadAsset.deleteMany({});
  await prisma.auditLog.deleteMany({});
  await prisma.user.deleteMany({
    where: {
      email: {
        contains: 'test-orch',
      },
    },
  });

  await prisma.user.create({
    data: {
      id: userId,
      email: `test-orch-${userId.slice(0, 8)}@example.com`,
      passwordHash: 'dummy',
      role: 'USER',
      status: 'ACTIVE',
      approvalStatus: 'APPROVED',
    },
  });

  try {
    // -------------------------------------------------------------
    // 1. Successful COMPLETE and legal status progression
    // -------------------------------------------------------------
    console.log('Test: Successful COMPLETE flow & legal status progression...');
    adapter.completeCallsCount = 0;
    adapter.simulateGenericFailure = false;
    adapter.simulateMultipartNotFound = false;

    const assetId1 = randomUUID();
    const objectKey1 = `uploads/${userId}/video1.mp4`;
    await prisma.uploadAsset.create({
      data: {
        id: assetId1,
        userId,
        provider: 'R2',
        bucket: 'mock-bucket',
        objectKey: objectKey1,
        originalName: 'video1.mp4',
        expectedSize: 15 * 1024 * 1024, // 15 MiB -> 2 parts (10 MB, 5 MB)
        declaredMimeType: 'video/mp4',
        status: UploadStatus.UPLOADING,
        idempotencyKey: 'idem-1',
        requestFingerprint: 'fp-1',
        uploadExpiresAt: new Date(Date.now() + 60000),
      },
    });

    const providerSessionId1 = await adapter.createMultipartUpload('mock-bucket', objectKey1, 'video/mp4');
    const partData1 = Buffer.alloc(10 * 1024 * 1024, 'a');
    const partData2 = Buffer.alloc(5 * 1024 * 1024, 'b');
    adapter.simulateUploadPart(providerSessionId1, 1, partData1, 'etag-1');
    adapter.simulateUploadPart(providerSessionId1, 2, partData2, 'etag-2');

    const completedParts1 = [
      { partNumber: 1, etag: 'etag-1', size: 10 * 1024 * 1024 },
      { partNumber: 2, etag: 'etag-2', size: 5 * 1024 * 1024 },
    ];

    await prisma.uploadSession.create({
      data: {
        uploadAssetId: assetId1,
        encryptionKeyVersion: testKeyVersion,
        encryptedProviderSessionId: encryptUploadSecret(providerSessionId1),
        encryptedCompletedParts: encryptUploadSecret(JSON.stringify(completedParts1)),
        expiresAt: new Date(Date.now() + 60000),
        lastActivityAt: new Date(),
      },
    });

    const result1 = (await UploadFinalizationService.completeUpload(userId, assetId1, {
      parts: [
        { partNumber: 1, etag: 'etag-1' },
        { partNumber: 2, etag: 'etag-2' },
      ],
    })) as Record<string, unknown>;

    if (result1.status !== UploadStatus.VALIDATING) {
      throw new Error(`Expected status VALIDATING, got ${result1.status}`);
    }
    if (typeof result1.expectedSize !== 'string' || typeof result1.actualSize !== 'string') {
      throw new Error('BigInt values were not returned as strings.');
    }
    if (adapter.completeCallsCount !== 1) {
      throw new Error(`Expected complete calls count to be 1, got ${adapter.completeCallsCount}`);
    }

    // Verify session secrets are deleted
    const session1 = await prisma.uploadSession.findUnique({
      where: { uploadAssetId: assetId1 },
    });
    if (session1) {
      throw new Error('Expected upload session to be deleted after success.');
    }

    // Verify claim lock is cleared but preserves sticky operation
    const assetRecord1 = await prisma.uploadAsset.findUnique({
      where: { id: assetId1 },
    });
    if (assetRecord1?.finalizationLockToken !== null) {
      throw new Error('Expected finalization lock token to be cleared.');
    }
    if (assetRecord1?.finalizationOperation !== UploadFinalizationOperation.COMPLETE) {
      throw new Error(`Expected sticky finalization operation COMPLETE, got ${assetRecord1?.finalizationOperation}`);
    }

    // Verify transitions occurred UPLOADING -> UPLOADED -> VALIDATING in audit log
    const auditLogs1 = await prisma.auditLog.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
    const transitionLogs = auditLogs1.filter(log => log.action === 'FINALIZATION_STATE_TRANSITIONED');
    if (transitionLogs.length < 2) {
      throw new Error('Expected at least two transition logs.');
    }
    if (!transitionLogs[0].details.includes('from UPLOADING to UPLOADED') ||
        !transitionLogs[1].details.includes('from UPLOADED to VALIDATING')) {
      throw new Error(`Incorrect transition details logged: ${JSON.stringify(transitionLogs)}`);
    }

    // Check audit details do not contain secrets
    for (const log of auditLogs1) {
      if (log.details.includes('etag') || log.details.includes(providerSessionId1) || log.details.includes('http')) {
        throw new Error(`Secrets or IDs leaked in audit details: ${log.details}`);
      }
    }

    // -------------------------------------------------------------
    // 2. Successful ABORT from REQUESTED
    // -------------------------------------------------------------
    console.log('Test: Successful ABORT from REQUESTED...');
    adapter.abortCallsCount = 0;
    const assetId2 = randomUUID();
    await prisma.uploadAsset.create({
      data: {
        id: assetId2,
        userId,
        provider: 'R2',
        bucket: 'mock-bucket',
        objectKey: `uploads/${userId}/video2.mp4`,
        originalName: 'video2.mp4',
        expectedSize: 1000000,
        declaredMimeType: 'video/mp4',
        status: UploadStatus.REQUESTED,
        idempotencyKey: 'idem-2',
        requestFingerprint: 'fp-2',
        uploadExpiresAt: new Date(Date.now() + 60000),
      },
    });

    const result2 = (await UploadFinalizationService.abortUpload(userId, assetId2)) as Record<string, unknown>;
    if (result2.status !== UploadStatus.ABORTED) {
      throw new Error(`Expected status ABORTED, got ${result2.status}`);
    }
    if (adapter.abortCallsCount !== 0) {
      throw new Error('Abort calls count should be 0 because there was no session record.');
    }

    // -------------------------------------------------------------
    // 3. Successful ABORT from UPLOADING
    // -------------------------------------------------------------
    console.log('Test: Successful ABORT from UPLOADING...');
    adapter.abortCallsCount = 0;
    const assetId3 = randomUUID();
    const objectKey3 = `uploads/${userId}/video3.mp4`;
    await prisma.uploadAsset.create({
      data: {
        id: assetId3,
        userId,
        provider: 'R2',
        bucket: 'mock-bucket',
        objectKey: objectKey3,
        originalName: 'video3.mp4',
        expectedSize: 1000000,
        declaredMimeType: 'video/mp4',
        status: UploadStatus.UPLOADING,
        idempotencyKey: 'idem-3',
        requestFingerprint: 'fp-3',
        uploadExpiresAt: new Date(Date.now() + 60000),
      },
    });

    const providerSessionId3 = await adapter.createMultipartUpload('mock-bucket', objectKey3, 'video/mp4');
    await prisma.uploadSession.create({
      data: {
        uploadAssetId: assetId3,
        encryptionKeyVersion: testKeyVersion,
        encryptedProviderSessionId: encryptUploadSecret(providerSessionId3),
        encryptedCompletedParts: encryptUploadSecret(JSON.stringify([])),
        expiresAt: new Date(Date.now() + 60000),
        lastActivityAt: new Date(),
      },
    });

    const result3 = (await UploadFinalizationService.abortUpload(userId, assetId3)) as Record<string, unknown>;
    if (result3.status !== UploadStatus.ABORTED) {
      throw new Error(`Expected status ABORTED, got ${result3.status}`);
    }
    if (adapter.abortCallsCount !== 1) {
      throw new Error(`Expected abort calls count to be 1, got ${adapter.abortCallsCount}`);
    }

    // Verify session is deleted
    const session3 = await prisma.uploadSession.findUnique({
      where: { uploadAssetId: assetId3 },
    });
    if (session3) {
      throw new Error('Expected session secrets to be deleted after abort.');
    }

    // -------------------------------------------------------------
    // 4. Input Validation & duplicate part numbers
    // -------------------------------------------------------------
    console.log('Test: Input Validation & duplicate parts...');
    const assetIdVal = randomUUID();
    await prisma.uploadAsset.create({
      data: {
        id: assetIdVal,
        userId,
        provider: 'R2',
        bucket: 'mock-bucket',
        objectKey: `uploads/${userId}/val.mp4`,
        originalName: 'val.mp4',
        expectedSize: 15 * 1024 * 1024,
        declaredMimeType: 'video/mp4',
        status: UploadStatus.UPLOADING,
        idempotencyKey: 'idem-val',
        requestFingerprint: 'fp-val',
        uploadExpiresAt: new Date(Date.now() + 60000),
      },
    });

    // Malformed body: no parts
    await assertThrows(
      'Malformed payload missing parts list',
      () => UploadFinalizationService.completeUpload(userId, assetIdVal, {}),
      InvalidMultipartMetadataError
    );

    // Malformed body: empty parts list
    await assertThrows(
      'Malformed payload empty parts list',
      () => UploadFinalizationService.completeUpload(userId, assetIdVal, { parts: [] }),
      InvalidMultipartMetadataError
    );

    // Duplicate parts
    await assertThrows(
      'Duplicate parts list check',
      () => UploadFinalizationService.completeUpload(userId, assetIdVal, {
        parts: [
          { partNumber: 1, etag: 'etag-1' },
          { partNumber: 1, etag: 'etag-2' },
        ],
      }),
      InvalidMultipartMetadataError
    );

    // Out of bounds part number
    await assertThrows(
      'Out of bounds part check',
      () => UploadFinalizationService.completeUpload(userId, assetIdVal, {
        parts: [
          { partNumber: 0, etag: 'etag-1' },
        ],
      }),
      InvalidMultipartMetadataError
    );

    // -------------------------------------------------------------
    // 5. Ownership, Missing Asset, same-operation lock, opposite sticky
    // -------------------------------------------------------------
    console.log('Test: Ownership, missing asset, locks and conflicts...');
    const otherUser = randomUUID();
    await prisma.user.create({
      data: {
        id: otherUser,
        email: `test-orch-other@example.com`,
        passwordHash: 'dummy',
        role: 'USER',
        status: 'ACTIVE',
        approvalStatus: 'APPROVED',
      },
    });

    // Foreign ownership complete rejection
    await assertThrows(
      'Foreign owner rejection on complete',
      () => UploadFinalizationService.completeUpload(otherUser, assetIdVal, {
        parts: [{ partNumber: 1, etag: 'etag-1' }],
      }),
      ForbiddenOwnershipError
    );

    // Missing asset check
    await assertThrows(
      'Missing asset on complete',
      () => UploadFinalizationService.completeUpload(userId, randomUUID(), {
        parts: [{ partNumber: 1, etag: 'etag-1' }],
      }),
      NotFoundError
    );

    // Active same-operation lock check
    const assetIdLock = randomUUID();
    await prisma.uploadAsset.create({
      data: {
        id: assetIdLock,
        userId,
        provider: 'R2',
        bucket: 'mock-bucket',
        objectKey: `uploads/${userId}/lock.mp4`,
        originalName: 'lock.mp4',
        expectedSize: 10 * 1024 * 1024,
        declaredMimeType: 'video/mp4',
        status: UploadStatus.UPLOADING,
        finalizationOperation: UploadFinalizationOperation.COMPLETE,
        finalizationLockToken: randomUUID(),
        finalizationLockedAt: new Date(),
        finalizationLockExpiresAt: new Date(Date.now() + LEASE_DURATION_MS),
        idempotencyKey: 'idem-lock',
        requestFingerprint: 'fp-lock',
        uploadExpiresAt: new Date(Date.now() + 60000),
      },
    });

    await assertThrows(
      'Active same-operation lock blocks',
      () => UploadFinalizationService.completeUpload(userId, assetIdLock, {
        parts: [{ partNumber: 1, etag: 'etag-1' }],
      }),
      FinalizationInProgressError
    );

    // Opposite sticky operation conflict
    const assetIdOpp = randomUUID();
    await prisma.uploadAsset.create({
      data: {
        id: assetIdOpp,
        userId,
        provider: 'R2',
        bucket: 'mock-bucket',
        objectKey: `uploads/${userId}/opp.mp4`,
        originalName: 'opp.mp4',
        expectedSize: 10 * 1024 * 1024,
        declaredMimeType: 'video/mp4',
        status: UploadStatus.UPLOADING,
        finalizationOperation: UploadFinalizationOperation.ABORT,
        idempotencyKey: 'idem-opp',
        requestFingerprint: 'fp-opp',
        uploadExpiresAt: new Date(Date.now() + 60000),
      },
    });

    await assertThrows(
      'Opposite sticky operation conflict complete vs abort',
      () => UploadFinalizationService.completeUpload(userId, assetIdOpp, {
        parts: [{ partNumber: 1, etag: 'etag-1' }],
      }),
      FinalizationOperationConflictError
    );

    // -------------------------------------------------------------
    // 6. Expired claim reacquisition
    // -------------------------------------------------------------
    console.log('Test: Expired claim reacquisition...');
    const assetIdExp = randomUUID();
    const objectKeyExp = `uploads/${userId}/exp.mp4`;
    await prisma.uploadAsset.create({
      data: {
        id: assetIdExp,
        userId,
        provider: 'R2',
        bucket: 'mock-bucket',
        objectKey: objectKeyExp,
        originalName: 'exp.mp4',
        expectedSize: 10 * 1024 * 1024, // 10 MiB -> 1 part
        declaredMimeType: 'video/mp4',
        status: UploadStatus.UPLOADING,
        finalizationOperation: UploadFinalizationOperation.COMPLETE,
        finalizationLockToken: randomUUID(),
        finalizationLockedAt: new Date(Date.now() - 10000),
        finalizationLockExpiresAt: new Date(Date.now() - 5000), // Expired claim
        idempotencyKey: 'idem-exp',
        requestFingerprint: 'fp-exp',
        uploadExpiresAt: new Date(Date.now() + 60000),
      },
    });

    const providerSessionIdExp = await adapter.createMultipartUpload('mock-bucket', objectKeyExp, 'video/mp4');
    const completedPartsExp = [{ partNumber: 1, etag: 'etag-exp', size: 10 * 1024 * 1024 }];
    adapter.simulateUploadPart(providerSessionIdExp, 1, Buffer.alloc(10 * 1024 * 1024, 'x'), 'etag-exp');

    await prisma.uploadSession.create({
      data: {
        uploadAssetId: assetIdExp,
        encryptionKeyVersion: testKeyVersion,
        encryptedProviderSessionId: encryptUploadSecret(providerSessionIdExp),
        encryptedCompletedParts: encryptUploadSecret(JSON.stringify(completedPartsExp)),
        expiresAt: new Date(Date.now() + 60000),
        lastActivityAt: new Date(),
      },
    });

    const resultExp = (await UploadFinalizationService.completeUpload(userId, assetIdExp, {
      parts: [{ partNumber: 1, etag: 'etag-exp' }],
    })) as Record<string, unknown>;
    if (resultExp.status !== UploadStatus.VALIDATING) {
      throw new Error(`Expected reacquired claim to complete. Got ${resultExp.status}`);
    }

    // -------------------------------------------------------------
    // 7. Stale-token fencing
    // -------------------------------------------------------------
    console.log('Test: Stale-token fencing...');
    // We test this by trying a transition using a mock claim that has an expired token/mismatched token
    const fakeClaim = {
      mode: 'INITIAL' as const,
      operation: UploadFinalizationOperation.COMPLETE,
      providerAction: 'COMPLETE_MULTIPART' as const,
      providerCallAllowed: true as const,
      userId,
      assetId: assetIdVal,
      lockToken: randomUUID(), // Mismatched UUID
      lockedAt: new Date(),
      lockExpiresAt: new Date(Date.now() + LEASE_DURATION_MS),
      attemptCount: 1,
      staleTakeover: false,
    };

    await assertThrows(
      'Mismatched lock token fails transition',
      () => UploadStateService.transitionWithFinalizationClaim(
        fakeClaim,
        UploadStatus.UPLOADING,
        UploadStatus.UPLOADED
      ),
      FencingError
    );

    // -------------------------------------------------------------
    // 8. Provider failure claims retention
    // -------------------------------------------------------------
    console.log('Test: Provider failures retain claims...');
    
    // Case A: Generic provider error during COMPLETE (ambiguous COMPLETE failure)
    console.log('  Sub-test: ambiguous COMPLETE failure...');
    const fixtureA = await createProviderFailureFixture(userId);
    adapter.simulateGenericFailure = true;
    adapter.simulateMultipartNotFound = false;
    adapter.completeCallsCount = 0;

    await assertThrows(
      'Generic provider complete failure',
      () => UploadFinalizationService.completeUpload(userId, fixtureA.assetId, {
        parts: [{ partNumber: 1, etag: fixtureA.parts[0].etag }],
      }),
      Error
    );

    // Verify claim and session are retained
    const assetRecordA = await prisma.uploadAsset.findUnique({
      where: { id: fixtureA.assetId },
    });
    if (!assetRecordA?.finalizationLockToken) {
      throw new Error('Claim lock token should be retained after generic complete failure.');
    }
    if (assetRecordA.finalizationOperation !== UploadFinalizationOperation.COMPLETE) {
      throw new Error('Claim operation COMPLETE should be retained.');
    }
    const sessionRecordA = await prisma.uploadSession.findUnique({
      where: { uploadAssetId: fixtureA.assetId },
    });
    if (!sessionRecordA) {
      throw new Error('Upload session should remain present.');
    }

    // Case B: MultipartUploadNotFoundError during COMPLETE
    console.log('  Sub-test: MultipartUploadNotFoundError during COMPLETE...');
    const fixtureB = await createProviderFailureFixture(userId);
    adapter.simulateGenericFailure = false;
    adapter.simulateMultipartNotFound = true;
    adapter.completeCallsCount = 0;

    await assertThrows(
      'MultipartUploadNotFoundError completes',
      () => UploadFinalizationService.completeUpload(userId, fixtureB.assetId, {
        parts: [{ partNumber: 1, etag: fixtureB.parts[0].etag }],
      }),
      MultipartUploadNotFoundError
    );

    if (adapter.completeCallsCount !== 1) {
      throw new Error(`Expected complete provider calls to be exactly 1, got ${adapter.completeCallsCount}`);
    }

    // Verify claim, status, and session are retained
    const assetRecordB = await prisma.uploadAsset.findUnique({
      where: { id: fixtureB.assetId },
    });
    if (assetRecordB?.status !== UploadStatus.UPLOADING) {
      throw new Error(`Expected status to remain UPLOADING, got ${assetRecordB?.status}`);
    }
    if (assetRecordB?.finalizationOperation !== UploadFinalizationOperation.COMPLETE) {
      throw new Error(`Expected finalizationOperation COMPLETE, got ${assetRecordB?.finalizationOperation}`);
    }
    if (!assetRecordB?.finalizationLockToken) {
      throw new Error('Expected finalizationLockToken to remain non-null.');
    }
    if (!assetRecordB?.finalizationLockExpiresAt || assetRecordB.finalizationLockExpiresAt <= new Date()) {
      throw new Error('Expected finalizationLockExpiresAt to remain in the future.');
    }
    const sessionRecordB = await prisma.uploadSession.findUnique({
      where: { uploadAssetId: fixtureB.assetId },
    });
    if (!sessionRecordB) {
      throw new Error('Expected UploadSession to remain present.');
    }

    // Case C: ambiguous ABORT failure (generic provider error during ABORT)
    console.log('  Sub-test: ambiguous ABORT failure...');
    const fixtureC = await createProviderFailureFixture(userId);
    adapter.simulateGenericFailure = true;
    adapter.simulateMultipartNotFound = false;
    adapter.abortCallsCount = 0;

    await assertThrows(
      'Generic provider abort failure',
      () => UploadFinalizationService.abortUpload(userId, fixtureC.assetId),
      Error
    );

    // Verify claim, status, and session are retained
    const assetRecordC = await prisma.uploadAsset.findUnique({
      where: { id: fixtureC.assetId },
    });
    if (assetRecordC?.status !== UploadStatus.UPLOADING) {
      throw new Error(`Expected status to remain UPLOADING, got ${assetRecordC?.status}`);
    }
    if (assetRecordC?.finalizationOperation !== UploadFinalizationOperation.ABORT) {
      throw new Error(`Expected sticky finalizationOperation ABORT, got ${assetRecordC?.finalizationOperation}`);
    }
    if (!assetRecordC?.finalizationLockToken) {
      throw new Error('Claim lock token should remain active.');
    }
    const sessionRecordC = await prisma.uploadSession.findUnique({
      where: { uploadAssetId: fixtureC.assetId },
    });
    if (!sessionRecordC) {
      throw new Error('UploadSession should remain present.');
    }

    // Case D: MultipartUploadNotFoundError during ABORT
    console.log('  Sub-test: MultipartUploadNotFoundError during ABORT...');
    const fixtureD = await createProviderFailureFixture(userId);
    adapter.simulateGenericFailure = false;
    adapter.simulateMultipartNotFound = true;
    adapter.abortCallsCount = 0;

    await assertThrows(
      'MultipartUploadNotFoundError during ABORT',
      () => UploadFinalizationService.abortUpload(userId, fixtureD.assetId),
      MultipartUploadNotFoundError
    );

    if (adapter.abortCallsCount !== 1) {
      throw new Error(`Expected abort provider calls to be exactly 1, got ${adapter.abortCallsCount}`);
    }

    // Verify claim, status, and session are retained
    const assetRecordD = await prisma.uploadAsset.findUnique({
      where: { id: fixtureD.assetId },
    });
    if (assetRecordD?.status !== UploadStatus.UPLOADING) {
      throw new Error(`Expected status to remain UPLOADING, got ${assetRecordD?.status}`);
    }
    if (assetRecordD?.finalizationOperation !== UploadFinalizationOperation.ABORT) {
      throw new Error(`Expected finalizationOperation ABORT, got ${assetRecordD?.finalizationOperation}`);
    }
    if (!assetRecordD?.finalizationLockToken) {
      throw new Error('Expected finalizationLockToken to remain non-null.');
    }
    if (!assetRecordD?.finalizationLockExpiresAt || assetRecordD.finalizationLockExpiresAt <= new Date()) {
      throw new Error('Expected finalizationLockExpiresAt to remain in the future.');
    }
    const sessionRecordD = await prisma.uploadSession.findUnique({
      where: { uploadAssetId: fixtureD.assetId },
    });
    if (!sessionRecordD) {
      throw new Error('Expected UploadSession to remain present.');
    }

    // Reset adapter failure flags
    adapter.simulateGenericFailure = false;
    adapter.simulateMultipartNotFound = false;

    // -------------------------------------------------------------
    // 9. Proven pre-provider failure safely releases claim
    // -------------------------------------------------------------
    console.log('Test: Proven pre-provider failures release claim...');
    const assetIdPre = randomUUID();
    const objectKeyPre = `uploads/${userId}/pre.mp4`;
    await prisma.uploadAsset.create({
      data: {
        id: assetIdPre,
        userId,
        provider: 'R2',
        bucket: 'mock-bucket',
        objectKey: objectKeyPre,
        originalName: 'pre.mp4',
        expectedSize: 10 * 1024 * 1024,
        declaredMimeType: 'video/mp4',
        status: UploadStatus.UPLOADING,
        idempotencyKey: 'idem-pre',
        requestFingerprint: 'fp-pre',
        uploadExpiresAt: new Date(Date.now() + 60000),
      },
    });

    const providerSessionIdPre = await adapter.createMultipartUpload('mock-bucket', objectKeyPre, 'video/mp4');
    // Session parts will mismatch client parts to trigger pre-provider check
    const completedPartsPre = [{ partNumber: 1, etag: 'etag-pre-recorded', size: 10 * 1024 * 1024 }];
    adapter.simulateUploadPart(providerSessionIdPre, 1, Buffer.alloc(10 * 1024 * 1024, 'z'), 'etag-pre-recorded');

    await prisma.uploadSession.create({
      data: {
        uploadAssetId: assetIdPre,
        encryptionKeyVersion: testKeyVersion,
        encryptedProviderSessionId: encryptUploadSecret(providerSessionIdPre),
        encryptedCompletedParts: encryptUploadSecret(JSON.stringify(completedPartsPre)),
        expiresAt: new Date(Date.now() + 60000),
        lastActivityAt: new Date(),
      },
    });

    // Call complete with mismatched ETag (etag-pre-sent !== etag-pre-recorded)
    await assertThrows(
      'Mismatched parts pre-provider failure',
      () => UploadFinalizationService.completeUpload(userId, assetIdPre, {
        parts: [{ partNumber: 1, etag: 'etag-pre-sent' }],
      }),
      InvalidMultipartMetadataError
    );

    // Verify claim lock token is released (set to null) but finalizationOperation remains complete
    const assetPreRecord = await prisma.uploadAsset.findUnique({
      where: { id: assetIdPre },
    });
    if (assetPreRecord?.finalizationLockToken !== null) {
      throw new Error('Claim lock token should be released.');
    }
    if (assetPreRecord?.finalizationOperation !== UploadFinalizationOperation.COMPLETE) {
      throw new Error('Sticky operation should remain COMPLETE.');
    }

    // -------------------------------------------------------------
    // 10. Concurrency protections
    // -------------------------------------------------------------
    console.log('Test: Concurrency protections...');
    adapter.completeCallsCount = 0;
    adapter.abortCallsCount = 0;
    adapter.simulateGenericFailure = false;
    adapter.simulateMultipartNotFound = false;

    // A. Simultaneous COMPLETE requests
    const assetIdConcComplete = randomUUID();
    const objectKeyConcComplete = `uploads/${userId}/conc-complete.mp4`;
    await prisma.uploadAsset.create({
      data: {
        id: assetIdConcComplete,
        userId,
        provider: 'R2',
        bucket: 'mock-bucket',
        objectKey: objectKeyConcComplete,
        originalName: 'conc-complete.mp4',
        expectedSize: 10 * 1024 * 1024,
        declaredMimeType: 'video/mp4',
        status: UploadStatus.UPLOADING,
        idempotencyKey: 'idem-conc-comp',
        requestFingerprint: 'fp-conc-comp',
        uploadExpiresAt: new Date(Date.now() + 60000),
      },
    });

    const providerSessionIdConc = await adapter.createMultipartUpload('mock-bucket', objectKeyConcComplete, 'video/mp4');
    const completedPartsConc = [{ partNumber: 1, etag: 'etag-conc', size: 10 * 1024 * 1024 }];
    adapter.simulateUploadPart(providerSessionIdConc, 1, Buffer.alloc(10 * 1024 * 1024, 'x'), 'etag-conc');

    await prisma.uploadSession.create({
      data: {
        uploadAssetId: assetIdConcComplete,
        encryptionKeyVersion: testKeyVersion,
        encryptedProviderSessionId: encryptUploadSecret(providerSessionIdConc),
        encryptedCompletedParts: encryptUploadSecret(JSON.stringify(completedPartsConc)),
        expiresAt: new Date(Date.now() + 60000),
        lastActivityAt: new Date(),
      },
    });

    // Run simultaneously
    const completeBody = { parts: [{ partNumber: 1, etag: 'etag-conc' }] };
    const completePromises = Promise.allSettled([
      UploadFinalizationService.completeUpload(userId, assetIdConcComplete, completeBody),
      UploadFinalizationService.completeUpload(userId, assetIdConcComplete, completeBody),
    ]);

    const completeOutcomes = await completePromises;
    const fulfilledComplete = completeOutcomes.filter(o => o.status === 'fulfilled');
    const rejectedComplete = completeOutcomes.filter(o => o.status === 'rejected');

    if (fulfilledComplete.length !== 1 || rejectedComplete.length !== 1) {
      throw new Error(`Concurrency assertion failed: expected 1 success and 1 rejection. Fulfilled: ${fulfilledComplete.length}, Rejected: ${rejectedComplete.length}`);
    }
    if (adapter.completeCallsCount !== 1) {
      throw new Error(`Expected provider complete call count to be exactly 1, got ${adapter.completeCallsCount}`);
    }

    // B. Simultaneous ABORT requests
    const assetIdConcAbort = randomUUID();
    const objectKeyConcAbort = `uploads/${userId}/conc-abort.mp4`;
    await prisma.uploadAsset.create({
      data: {
        id: assetIdConcAbort,
        userId,
        provider: 'R2',
        bucket: 'mock-bucket',
        objectKey: objectKeyConcAbort,
        originalName: 'conc-abort.mp4',
        expectedSize: 1000000,
        declaredMimeType: 'video/mp4',
        status: UploadStatus.UPLOADING,
        idempotencyKey: 'idem-conc-abort',
        requestFingerprint: 'fp-conc-abort',
        uploadExpiresAt: new Date(Date.now() + 60000),
      },
    });

    const providerSessionIdConcAbort = await adapter.createMultipartUpload('mock-bucket', objectKeyConcAbort, 'video/mp4');
    await prisma.uploadSession.create({
      data: {
        uploadAssetId: assetIdConcAbort,
        encryptionKeyVersion: testKeyVersion,
        encryptedProviderSessionId: encryptUploadSecret(providerSessionIdConcAbort),
        encryptedCompletedParts: encryptUploadSecret(JSON.stringify([])),
        expiresAt: new Date(Date.now() + 60000),
        lastActivityAt: new Date(),
      },
    });

    const abortPromises = Promise.allSettled([
      UploadFinalizationService.abortUpload(userId, assetIdConcAbort),
      UploadFinalizationService.abortUpload(userId, assetIdConcAbort),
    ]);

    const abortOutcomes = await abortPromises;
    const fulfilledAbort = abortOutcomes.filter(o => o.status === 'fulfilled');
    const rejectedAbort = abortOutcomes.filter(o => o.status === 'rejected');

    if (fulfilledAbort.length !== 1 || rejectedAbort.length !== 1) {
      throw new Error(`Concurrency assertion failed: expected 1 success and 1 rejection for abort. Fulfilled: ${fulfilledAbort.length}, Rejected: ${rejectedAbort.length}`);
    }
    if (adapter.abortCallsCount !== 1) {
      throw new Error(`Expected provider abort call count to be exactly 1, got ${adapter.abortCallsCount}`);
    }

    // C. Simultaneous COMPLETE vs ABORT
    const assetIdConcMixed = randomUUID();
    const objectKeyConcMixed = `uploads/${userId}/conc-mixed.mp4`;
    await prisma.uploadAsset.create({
      data: {
        id: assetIdConcMixed,
        userId,
        provider: 'R2',
        bucket: 'mock-bucket',
        objectKey: objectKeyConcMixed,
        originalName: 'conc-mixed.mp4',
        expectedSize: 10 * 1024 * 1024,
        declaredMimeType: 'video/mp4',
        status: UploadStatus.UPLOADING,
        idempotencyKey: 'idem-conc-mixed',
        requestFingerprint: 'fp-conc-mixed',
        uploadExpiresAt: new Date(Date.now() + 60000),
      },
    });

    const providerSessionIdConcMixed = await adapter.createMultipartUpload('mock-bucket', objectKeyConcMixed, 'video/mp4');
    const completedPartsConcMixed = [{ partNumber: 1, etag: 'etag-mixed', size: 10 * 1024 * 1024 }];
    adapter.simulateUploadPart(providerSessionIdConcMixed, 1, Buffer.alloc(10 * 1024 * 1024, 'a'), 'etag-mixed');

    await prisma.uploadSession.create({
      data: {
        uploadAssetId: assetIdConcMixed,
        encryptionKeyVersion: testKeyVersion,
        encryptedProviderSessionId: encryptUploadSecret(providerSessionIdConcMixed),
        encryptedCompletedParts: encryptUploadSecret(JSON.stringify(completedPartsConcMixed)),
        expiresAt: new Date(Date.now() + 60000),
        lastActivityAt: new Date(),
      },
    });

    const mixedPromises = Promise.allSettled([
      UploadFinalizationService.completeUpload(userId, assetIdConcMixed, { parts: [{ partNumber: 1, etag: 'etag-mixed' }] }),
      UploadFinalizationService.abortUpload(userId, assetIdConcMixed),
    ]);

    const mixedOutcomes = await mixedPromises;
    const fulfilledMixed = mixedOutcomes.filter(o => o.status === 'fulfilled');
    const rejectedMixed = mixedOutcomes.filter(o => o.status === 'rejected');

    if (fulfilledMixed.length !== 1 || rejectedMixed.length !== 1) {
      throw new Error(`Concurrency mixed assertion failed. Fulfilled: ${fulfilledMixed.length}, Rejected: ${rejectedMixed.length}`);
    }

    // -------------------------------------------------------------
    // 11. API route integrations (handleCompleteUpload / handleAbortUpload)
    // -------------------------------------------------------------
    console.log('Test: Route handlers handleCompleteUpload and handleAbortUpload...');
    const assetIdRouteComplete = randomUUID();
    const objectKeyRouteComp = `uploads/${userId}/route-comp.mp4`;
    await prisma.uploadAsset.create({
      data: {
        id: assetIdRouteComplete,
        userId,
        provider: 'R2',
        bucket: 'mock-bucket',
        objectKey: objectKeyRouteComp,
        originalName: 'route-comp.mp4',
        expectedSize: 10 * 1024 * 1024,
        declaredMimeType: 'video/mp4',
        status: UploadStatus.UPLOADING,
        idempotencyKey: 'idem-route-comp',
        requestFingerprint: 'fp-route-comp',
        uploadExpiresAt: new Date(Date.now() + 60000),
      },
    });

    const providerSessionIdRouteComp = await adapter.createMultipartUpload('mock-bucket', objectKeyRouteComp, 'video/mp4');
    const completedPartsRouteComp = [{ partNumber: 1, etag: 'etag-route-comp', size: 10 * 1024 * 1024 }];
    adapter.simulateUploadPart(providerSessionIdRouteComp, 1, Buffer.alloc(10 * 1024 * 1024, 'x'), 'etag-route-comp');

    await prisma.uploadSession.create({
      data: {
        uploadAssetId: assetIdRouteComplete,
        encryptionKeyVersion: testKeyVersion,
        encryptedProviderSessionId: encryptUploadSecret(providerSessionIdRouteComp),
        encryptedCompletedParts: encryptUploadSecret(JSON.stringify(completedPartsRouteComp)),
        expiresAt: new Date(Date.now() + 60000),
        lastActivityAt: new Date(),
      },
    });

    const resRouteComp = await handleCompleteUpload(userId, assetIdRouteComplete, {
      parts: [{ partNumber: 1, etag: 'etag-route-comp' }],
    });
    if (resRouteComp.status !== 202) {
      throw new Error(`Expected HTTP 202 on route completion, got ${resRouteComp.status}`);
    }
    const dataRouteComp = await resRouteComp.json();
    if (dataRouteComp.status !== UploadStatus.VALIDATING) {
      throw new Error(`Expected status to be VALIDATING in JSON, got ${dataRouteComp.status}`);
    }

    // Route Abort
    const assetIdRouteAbort = randomUUID();
    await prisma.uploadAsset.create({
      data: {
        id: assetIdRouteAbort,
        userId,
        provider: 'R2',
        bucket: 'mock-bucket',
        objectKey: `uploads/${userId}/route-abort.mp4`,
        originalName: 'route-abort.mp4',
        expectedSize: 1000000,
        declaredMimeType: 'video/mp4',
        status: UploadStatus.REQUESTED,
        idempotencyKey: 'idem-route-abort',
        requestFingerprint: 'fp-route-abort',
        uploadExpiresAt: new Date(Date.now() + 60000),
      },
    });

    const resRouteAbort = await handleAbortUpload(userId, assetIdRouteAbort);
    if (resRouteAbort.status !== 200) {
      throw new Error(`Expected HTTP 200 on route abort, got ${resRouteAbort.status}`);
    }
    const dataRouteAbort = await resRouteAbort.json();
    if (dataRouteAbort.status !== UploadStatus.ABORTED) {
      throw new Error(`Expected status to be ABORTED in JSON, got ${dataRouteAbort.status}`);
    }

    // 12. UPLOADING with no session
    console.log('Test: UPLOADING with no session...');
    adapter.abortCallsCount = 0;
    const assetIdUploadingNoSession = randomUUID();
    await prisma.uploadAsset.create({
      data: {
        id: assetIdUploadingNoSession,
        userId,
        provider: 'R2',
        bucket: 'mock-bucket',
        objectKey: `uploads/${userId}/upload-no-session.mp4`,
        originalName: 'upload-no-session.mp4',
        expectedSize: 1000000,
        declaredMimeType: 'video/mp4',
        status: UploadStatus.UPLOADING,
        idempotencyKey: 'idem-upload-no-session',
        requestFingerprint: 'fp-upload-no-session',
        uploadExpiresAt: new Date(Date.now() + 60000),
      },
    });

    await assertThrows(
      'UPLOADING with no session throws NotFoundError',
      () => UploadFinalizationService.abortUpload(userId, assetIdUploadingNoSession),
      NotFoundError
    );

    // Verify claim is released
    const assetUploadingNoSessionRecord = await prisma.uploadAsset.findUnique({
      where: { id: assetIdUploadingNoSession },
    });
    if (assetUploadingNoSessionRecord?.finalizationLockToken !== null) {
      throw new Error('Expected finalization lock token to be released.');
    }
    if (assetUploadingNoSessionRecord?.finalizationOperation !== UploadFinalizationOperation.ABORT) {
      throw new Error(`Expected sticky finalization operation ABORT, got ${assetUploadingNoSessionRecord?.finalizationOperation}`);
    }
    if (assetUploadingNoSessionRecord?.status !== UploadStatus.UPLOADING) {
      throw new Error(`Expected status to remain UPLOADING, got ${assetUploadingNoSessionRecord?.status}`);
    }
    if (adapter.abortCallsCount !== 0) {
      throw new Error(`Expected abort calls count to be 0, got ${adapter.abortCallsCount}`);
    }

    // 13. Idempotency conflicts (inconsistent states)
    console.log('Test: Idempotency conflict tests...');
    const assetIdInconsistentAbort = randomUUID();
    await prisma.uploadAsset.create({
      data: {
        id: assetIdInconsistentAbort,
        userId,
        provider: 'R2',
        bucket: 'mock-bucket',
        objectKey: `uploads/${userId}/inconsistent-abort.mp4`,
        originalName: 'inconsistent-abort.mp4',
        expectedSize: 1000000,
        declaredMimeType: 'video/mp4',
        status: UploadStatus.ABORTED,
        finalizationOperation: UploadFinalizationOperation.COMPLETE, // Inconsistent!
        idempotencyKey: 'idem-inconsistent-abort',
        requestFingerprint: 'fp-inconsistent-abort',
        uploadExpiresAt: new Date(Date.now() + 60000),
      },
    });

    await assertThrows(
      'Inconsistent ABORTED asset with sticky COMPLETE throws FinalizationOperationConflictError',
      () => UploadFinalizationService.abortUpload(userId, assetIdInconsistentAbort),
      FinalizationOperationConflictError
    );

    console.log('ALL PHASE 4 STEP 3D ORCHESTRATION INTEGRATION TESTS PRE-CHECK CLEAN! 🎉');
  } finally {
    clearTestEncryptionKey();
    await prisma.$disconnect();
  }
}

runTests().catch((e: unknown) => {
  console.error('TEST SUITE FAILED:', e);
  process.exit(1);
});
