import { PrismaClient, UploadStatus, UploadFinalizationOperation } from '@prisma/client';
import { randomUUID } from 'crypto';
import {
  FinalizationClaimService,
  FinalizationOperationConflictError,
  FinalizationInProgressError,
  InitialCompletionClaim,
  InitialAbortClaim,
  CompletionRecoveryClaim,
} from '../src/lib/storage/finalization-claim-service';
import {
  UploadStateService,
  FencingError,
} from '../src/lib/storage/upload-state-service';
import {
  InMemoryFakeStorageAdapter,
} from '../src/lib/storage/in-memory-fake-adapter';
import {
  MultipartUploadNotFoundError,
} from '../src/lib/storage/storage-adapter';
import {
  NotFoundError,
  InvalidStateTransitionError,
} from '../src/lib/storage/upload-session-encryption';

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
  process.exit(1);
}

const prisma = new PrismaClient();

function createExpiredLease(now = new Date()) {
  const lockedAt = new Date(now.getTime() - 120_000);
  const expiresAt = new Date(now.getTime() - 60_000);

  if (!(lockedAt < expiresAt && expiresAt <= now)) {
    throw new Error('Invalid expired lease fixture.');
  }

  return { lockedAt, expiresAt };
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

async function transitionCompletionToValidating(claim: InitialCompletionClaim): Promise<void> {
  await UploadStateService.transitionWithFinalizationClaim(
    claim,
    UploadStatus.UPLOADING,
    UploadStatus.UPLOADED,
    { actualSize: BigInt(500000) }
  );

  await UploadStateService.transitionWithFinalizationClaim(
    claim,
    UploadStatus.UPLOADED,
    UploadStatus.VALIDATING
  );
}

async function runTests() {
  console.log('Starting Step 3C Prerequisite Finalization Claim Integration Tests...');

  // Clean up database tables
  await prisma.uploadSession.deleteMany({});
  await prisma.uploadAttempt.deleteMany({});
  await prisma.uploadAsset.deleteMany({});
  await prisma.auditLog.deleteMany({});
  await prisma.user.deleteMany({
    where: {
      email: {
        contains: 'test-prereq',
      },
    },
  });

  const testUserId1 = randomUUID();
  const testUserId2 = randomUUID();

  // Create mock users
  await prisma.user.createMany({
    data: [
      {
        id: testUserId1,
        email: `test-prereq-u1-${testUserId1.slice(0, 8)}@example.com`,
        passwordHash: 'dummy',
        role: 'USER',
        status: 'ACTIVE',
        approvalStatus: 'APPROVED',
      },
      {
        id: testUserId2,
        email: `test-prereq-u2-${testUserId2.slice(0, 8)}@example.com`,
        passwordHash: 'dummy',
        role: 'USER',
        status: 'ACTIVE',
        approvalStatus: 'APPROVED',
      },
    ],
  });

  try {
    // -------------------------------------------------------------
    // 1. COMPLETE from UPLOADING
    // -------------------------------------------------------------
    console.log('Test: COMPLETE from UPLOADING...');
    const assetIdCompleteUPLOADING = randomUUID();
    await prisma.uploadAsset.create({
      data: {
        id: assetIdCompleteUPLOADING,
        userId: testUserId1,
        provider: 'R2',
        bucket: 'mock-bucket',
        objectKey: 'uploads/vid1.mp4',
        originalName: 'vid1.mp4',
        expectedSize: 10000000,
        declaredMimeType: 'video/mp4',
        status: UploadStatus.UPLOADING,
        idempotencyKey: 'idem-1',
        requestFingerprint: 'fingerprint-1',
        uploadExpiresAt: new Date(Date.now() + 60000),
      },
    });

    const claim1: InitialCompletionClaim = await FinalizationClaimService.acquireInitialCompletionClaim(
      testUserId1,
      assetIdCompleteUPLOADING
    );
    if (claim1.operation !== UploadFinalizationOperation.COMPLETE || claim1.attemptCount !== 1) {
      throw new Error('Claim 1 metadata mismatch.');
    }

    // -------------------------------------------------------------
    // 2. COMPLETE rejects REQUESTED
    // -------------------------------------------------------------
    console.log('Test: COMPLETE rejects REQUESTED...');
    const assetIdCompleteRejectsREQUESTED = randomUUID();
    await prisma.uploadAsset.create({
      data: {
        id: assetIdCompleteRejectsREQUESTED,
        userId: testUserId1,
        provider: 'R2',
        bucket: 'mock-bucket',
        objectKey: 'uploads/vid-req-complete.mp4',
        originalName: 'vid-req-complete.mp4',
        expectedSize: 10000000,
        declaredMimeType: 'video/mp4',
        status: UploadStatus.REQUESTED,
        idempotencyKey: 'idem-req-complete',
        requestFingerprint: 'fingerprint-req-complete',
        uploadExpiresAt: new Date(Date.now() + 60000),
      },
    });

    await assertThrows(
      'COMPLETE claim rejects REQUESTED status',
      () => FinalizationClaimService.acquireInitialCompletionClaim(testUserId1, assetIdCompleteRejectsREQUESTED),
      InvalidStateTransitionError
    );

    // -------------------------------------------------------------
    // 3. COMPLETE rejects UPLOADED
    // -------------------------------------------------------------
    console.log('Test: COMPLETE rejects UPLOADED...');
    const assetIdCompleteRejectsUPLOADED = randomUUID();
    await prisma.uploadAsset.create({
      data: {
        id: assetIdCompleteRejectsUPLOADED,
        userId: testUserId1,
        provider: 'R2',
        bucket: 'mock-bucket',
        objectKey: 'uploads/vid-uploaded-complete.mp4',
        originalName: 'vid-uploaded-complete.mp4',
        expectedSize: 10000000,
        declaredMimeType: 'video/mp4',
        status: UploadStatus.UPLOADED,
        idempotencyKey: 'idem-uploaded-complete',
        requestFingerprint: 'fingerprint-uploaded-complete',
        uploadExpiresAt: new Date(Date.now() + 60000),
      },
    });

    await assertThrows(
      'COMPLETE claim rejects UPLOADED status',
      () => FinalizationClaimService.acquireInitialCompletionClaim(testUserId1, assetIdCompleteRejectsUPLOADED),
      InvalidStateTransitionError
    );

    // -------------------------------------------------------------
    // 4. Completion Recovery
    // -------------------------------------------------------------
    console.log('Test: Completion Recovery...');
    const assetIdRecovery = randomUUID();
    await prisma.uploadAsset.create({
      data: {
        id: assetIdRecovery,
        userId: testUserId1,
        provider: 'R2',
        bucket: 'mock-bucket',
        objectKey: 'uploads/vid-recovery.mp4',
        originalName: 'vid-recovery.mp4',
        expectedSize: 10000000,
        declaredMimeType: 'video/mp4',
        status: UploadStatus.UPLOADED,
        idempotencyKey: 'idem-recovery',
        requestFingerprint: 'fingerprint-recovery',
        uploadExpiresAt: new Date(Date.now() + 60000),
        finalizationOperation: UploadFinalizationOperation.COMPLETE, // sticky COMPLETE intent
      },
    });

    const claim2: CompletionRecoveryClaim = await FinalizationClaimService.acquireCompletionRecoveryClaim(
      testUserId1,
      assetIdRecovery
    );
    if (claim2.operation !== UploadFinalizationOperation.COMPLETE || claim2.providerCallAllowed !== false) {
      throw new Error('Completion recovery claim failed.');
    }

    // Recovery mode rejects null operation
    const assetIdRecoveryNull = randomUUID();
    await prisma.uploadAsset.create({
      data: {
        id: assetIdRecoveryNull,
        userId: testUserId1,
        provider: 'R2',
        bucket: 'mock-bucket',
        objectKey: 'uploads/vid-recovery-null.mp4',
        originalName: 'vid-recovery-null.mp4',
        expectedSize: 10000000,
        declaredMimeType: 'video/mp4',
        status: UploadStatus.UPLOADED,
        idempotencyKey: 'idem-rec-null',
        requestFingerprint: 'fingerprint-rec-null',
        uploadExpiresAt: new Date(Date.now() + 60000),
      },
    });

    await assertThrows(
      'Recovery claim rejects null operation',
      () => FinalizationClaimService.acquireCompletionRecoveryClaim(testUserId1, assetIdRecoveryNull),
      FinalizationOperationConflictError
    );

    // Recovery mode rejects ABORT intent
    const assetIdRecoveryAbort = randomUUID();
    await prisma.uploadAsset.create({
      data: {
        id: assetIdRecoveryAbort,
        userId: testUserId1,
        provider: 'R2',
        bucket: 'mock-bucket',
        objectKey: 'uploads/vid-recovery-abort.mp4',
        originalName: 'vid-recovery-abort.mp4',
        expectedSize: 10000000,
        declaredMimeType: 'video/mp4',
        status: UploadStatus.UPLOADED,
        idempotencyKey: 'idem-rec-abort',
        requestFingerprint: 'fingerprint-rec-abort',
        uploadExpiresAt: new Date(Date.now() + 60000),
        finalizationOperation: UploadFinalizationOperation.ABORT,
      },
    });

    await assertThrows(
      'Recovery claim rejects ABORT intent',
      () => FinalizationClaimService.acquireCompletionRecoveryClaim(testUserId1, assetIdRecoveryAbort),
      FinalizationOperationConflictError
    );

    // Recovery mode rejects UPLOADING
    const assetIdRecoveryUploading = randomUUID();
    await prisma.uploadAsset.create({
      data: {
        id: assetIdRecoveryUploading,
        userId: testUserId1,
        provider: 'R2',
        bucket: 'mock-bucket',
        objectKey: 'uploads/vid-recovery-uploading.mp4',
        originalName: 'vid-recovery-uploading.mp4',
        expectedSize: 10000000,
        declaredMimeType: 'video/mp4',
        status: UploadStatus.UPLOADING,
        idempotencyKey: 'idem-rec-uploading',
        requestFingerprint: 'fingerprint-rec-uploading',
        uploadExpiresAt: new Date(Date.now() + 60000),
        finalizationOperation: UploadFinalizationOperation.COMPLETE,
      },
    });

    await assertThrows(
      'Recovery claim rejects UPLOADING status',
      () => FinalizationClaimService.acquireCompletionRecoveryClaim(testUserId1, assetIdRecoveryUploading),
      InvalidStateTransitionError
    );

    // -------------------------------------------------------------
    // 5. ABORT from REQUESTED
    // -------------------------------------------------------------
    console.log('Test: ABORT from REQUESTED...');
    const assetIdAbortREQUESTED = randomUUID();
    await prisma.uploadAsset.create({
      data: {
        id: assetIdAbortREQUESTED,
        userId: testUserId1,
        provider: 'R2',
        bucket: 'mock-bucket',
        objectKey: 'uploads/vid-abort-req.mp4',
        originalName: 'vid-abort-req.mp4',
        expectedSize: 10000000,
        declaredMimeType: 'video/mp4',
        status: UploadStatus.REQUESTED,
        idempotencyKey: 'idem-abort-req',
        requestFingerprint: 'fingerprint-abort-req',
        uploadExpiresAt: new Date(Date.now() + 60000),
      },
    });

    const claim3: InitialAbortClaim = await FinalizationClaimService.acquireInitialAbortClaim(
      testUserId1,
      assetIdAbortREQUESTED
    );
    if (claim3.operation !== UploadFinalizationOperation.ABORT) {
      throw new Error('ABORT claim from REQUESTED failed.');
    }

    // -------------------------------------------------------------
    // 6. ABORT from UPLOADING
    // -------------------------------------------------------------
    console.log('Test: ABORT from UPLOADING...');
    const assetIdAbortUPLOADING = randomUUID();
    await prisma.uploadAsset.create({
      data: {
        id: assetIdAbortUPLOADING,
        userId: testUserId1,
        provider: 'R2',
        bucket: 'mock-bucket',
        objectKey: 'uploads/vid-abort-upl.mp4',
        originalName: 'vid-abort-upl.mp4',
        expectedSize: 10000000,
        declaredMimeType: 'video/mp4',
        status: UploadStatus.UPLOADING,
        idempotencyKey: 'idem-abort-upl',
        requestFingerprint: 'fingerprint-abort-upl',
        uploadExpiresAt: new Date(Date.now() + 60000),
      },
    });

    const claim4: InitialAbortClaim = await FinalizationClaimService.acquireInitialAbortClaim(
      testUserId1,
      assetIdAbortUPLOADING
    );
    if (claim4.operation !== UploadFinalizationOperation.ABORT) {
      throw new Error('ABORT claim from UPLOADING failed.');
    }

    // -------------------------------------------------------------
    // 7. ABORT rejects UPLOADED
    // -------------------------------------------------------------
    console.log('Test: ABORT rejects UPLOADED...');
    const assetIdAbortRejectsUPLOADED = randomUUID();
    await prisma.uploadAsset.create({
      data: {
        id: assetIdAbortRejectsUPLOADED,
        userId: testUserId1,
        provider: 'R2',
        bucket: 'mock-bucket',
        objectKey: 'uploads/vid-abort-uploaded.mp4',
        originalName: 'vid-abort-uploaded.mp4',
        expectedSize: 10000000,
        declaredMimeType: 'video/mp4',
        status: UploadStatus.UPLOADED,
        idempotencyKey: 'idem-abort-uploaded',
        requestFingerprint: 'fingerprint-abort-uploaded',
        uploadExpiresAt: new Date(Date.now() + 60000),
      },
    });

    await assertThrows(
      'ABORT claim rejects UPLOADED status',
      () => FinalizationClaimService.acquireInitialAbortClaim(testUserId1, assetIdAbortRejectsUPLOADED),
      InvalidStateTransitionError
    );

    // -------------------------------------------------------------
    // 8. Sticky COMPLETE versus ABORT
    // -------------------------------------------------------------
    console.log('Test: Sticky COMPLETE versus ABORT...');
    const assetIdStickyCompleteVersusAbort = randomUUID();
    await prisma.uploadAsset.create({
      data: {
        id: assetIdStickyCompleteVersusAbort,
        userId: testUserId1,
        provider: 'R2',
        bucket: 'mock-bucket',
        objectKey: 'uploads/sticky-complete.mp4',
        originalName: 'sticky-complete.mp4',
        expectedSize: 10000000,
        declaredMimeType: 'video/mp4',
        status: UploadStatus.UPLOADED,
        idempotencyKey: 'idem-sticky-complete',
        requestFingerprint: 'fingerprint-sticky-complete',
        uploadExpiresAt: new Date(Date.now() + 60000),
        finalizationOperation: UploadFinalizationOperation.COMPLETE, // sticky COMPLETE intent
      },
    });

    // Opposite intent must throw FinalizationOperationConflictError (precedence check)
    await assertThrows(
      'Sticky COMPLETE intent blocks ABORT claim',
      () => FinalizationClaimService.acquireInitialAbortClaim(testUserId1, assetIdStickyCompleteVersusAbort),
      FinalizationOperationConflictError
    );

    // -------------------------------------------------------------
    // 9. Sticky ABORT versus COMPLETE
    // -------------------------------------------------------------
    console.log('Test: Sticky ABORT versus COMPLETE...');
    const assetIdStickyAbortVersusComplete = randomUUID();
    await prisma.uploadAsset.create({
      data: {
        id: assetIdStickyAbortVersusComplete,
        userId: testUserId1,
        provider: 'R2',
        bucket: 'mock-bucket',
        objectKey: 'uploads/sticky-abort.mp4',
        originalName: 'sticky-abort.mp4',
        expectedSize: 10000000,
        declaredMimeType: 'video/mp4',
        status: UploadStatus.UPLOADING,
        idempotencyKey: 'idem-sticky-abort',
        requestFingerprint: 'fingerprint-sticky-abort',
        uploadExpiresAt: new Date(Date.now() + 60000),
        finalizationOperation: UploadFinalizationOperation.ABORT, // sticky ABORT intent
      },
    });

    await assertThrows(
      'Sticky ABORT intent blocks COMPLETE claim',
      () => FinalizationClaimService.acquireInitialCompletionClaim(testUserId1, assetIdStickyAbortVersusComplete),
      FinalizationOperationConflictError
    );

    // -------------------------------------------------------------
    // 10. Active Lock Conflict
    // -------------------------------------------------------------
    console.log('Test: Active Lock Conflict...');
    const assetIdActiveLock = randomUUID();
    await prisma.uploadAsset.create({
      data: {
        id: assetIdActiveLock,
        userId: testUserId1,
        provider: 'R2',
        bucket: 'mock-bucket',
        objectKey: 'uploads/active-lock.mp4',
        originalName: 'active-lock.mp4',
        expectedSize: 10000000,
        declaredMimeType: 'video/mp4',
        status: UploadStatus.UPLOADING,
        idempotencyKey: 'idem-active-lock',
        requestFingerprint: 'fingerprint-active-lock',
        uploadExpiresAt: new Date(Date.now() + 60000),
      },
    });

    await FinalizationClaimService.acquireInitialCompletionClaim(testUserId1, assetIdActiveLock);

    await assertThrows(
      'Active lock progress conflict',
      () => FinalizationClaimService.acquireInitialCompletionClaim(testUserId1, assetIdActiveLock),
      FinalizationInProgressError
    );

    // -------------------------------------------------------------
    // 11. Stale Takeover
    // -------------------------------------------------------------
    console.log('Test: Stale Takeover...');
    const assetIdStaleTakeover = randomUUID();
    await prisma.uploadAsset.create({
      data: {
        id: assetIdStaleTakeover,
        userId: testUserId1,
        provider: 'R2',
        bucket: 'mock-bucket',
        objectKey: 'uploads/stale-takeover.mp4',
        originalName: 'stale-takeover.mp4',
        expectedSize: 10000000,
        declaredMimeType: 'video/mp4',
        status: UploadStatus.UPLOADING,
        idempotencyKey: 'idem-stale-takeover',
        requestFingerprint: 'fingerprint-stale-takeover',
        uploadExpiresAt: new Date(Date.now() + 60000),
      },
    });

    const initialStaleLock = await FinalizationClaimService.acquireInitialCompletionClaim(testUserId1, assetIdStaleTakeover);

    // Expire it safely keeping lockedAt < expiresAt <= now
    const expiredLease1 = createExpiredLease();
    await prisma.uploadAsset.update({
      where: { id: assetIdStaleTakeover },
      data: {
        finalizationLockedAt: expiredLease1.lockedAt,
        finalizationLockExpiresAt: expiredLease1.expiresAt,
      },
    });

    const takeoverClaim = await FinalizationClaimService.acquireInitialCompletionClaim(testUserId1, assetIdStaleTakeover);
    if (!takeoverClaim.staleTakeover || takeoverClaim.attemptCount !== 2) {
      throw new Error('Takeover failed to detect stale lock.');
    }
    if (takeoverClaim.lockToken === initialStaleLock.lockToken) {
      throw new Error('Takeover generated identical token.');
    }

    // -------------------------------------------------------------
    // 12. Renewal
    // -------------------------------------------------------------
    console.log('Test: Renewal...');
    const assetIdRenewal = randomUUID();
    await prisma.uploadAsset.create({
      data: {
        id: assetIdRenewal,
        userId: testUserId1,
        provider: 'R2',
        bucket: 'mock-bucket',
        objectKey: 'uploads/renewal.mp4',
        originalName: 'renewal.mp4',
        expectedSize: 10000000,
        declaredMimeType: 'video/mp4',
        status: UploadStatus.UPLOADING,
        idempotencyKey: 'idem-renewal',
        requestFingerprint: 'fingerprint-renewal',
        uploadExpiresAt: new Date(Date.now() + 60000),
      },
    });

    const claimForRenewal = await FinalizationClaimService.acquireInitialCompletionClaim(testUserId1, assetIdRenewal);
    const renewed = await FinalizationClaimService.renewFinalizationClaim(claimForRenewal);
    if (renewed.lockExpiresAt.getTime() <= claimForRenewal.lockExpiresAt.getTime()) {
      throw new Error('Renewal failed to advance expiry.');
    }

    // Expired renewal fails
    const expiredLease2 = createExpiredLease();
    const expiredClaimForRenewal = {
      ...renewed,
      lockExpiresAt: expiredLease2.expiresAt,
    };
    await prisma.uploadAsset.update({
      where: { id: assetIdRenewal },
      data: {
        finalizationLockedAt: expiredLease2.lockedAt,
        finalizationLockExpiresAt: expiredLease2.expiresAt,
      },
    });

    await assertThrows(
      'Expired lease claim renewal fenced',
      () => FinalizationClaimService.renewFinalizationClaim(expiredClaimForRenewal),
      FencingError
    );

    // -------------------------------------------------------------
    // 13. Release
    // -------------------------------------------------------------
    console.log('Test: Release...');
    const assetIdRelease = randomUUID();
    await prisma.uploadAsset.create({
      data: {
        id: assetIdRelease,
        userId: testUserId1,
        provider: 'R2',
        bucket: 'mock-bucket',
        objectKey: 'uploads/release.mp4',
        originalName: 'release.mp4',
        expectedSize: 10000000,
        declaredMimeType: 'video/mp4',
        status: UploadStatus.UPLOADING,
        idempotencyKey: 'idem-release',
        requestFingerprint: 'fingerprint-release',
        uploadExpiresAt: new Date(Date.now() + 60000),
      },
    });

    const claimForRelease = await FinalizationClaimService.acquireInitialCompletionClaim(testUserId1, assetIdRelease);
    await FinalizationClaimService.releaseFinalizationClaim(claimForRelease, 'PRE_PROVIDER_FAILURE');

    // Duplicate release fails
    await assertThrows(
      'Duplicate release fenced',
      () => FinalizationClaimService.releaseFinalizationClaim(claimForRelease, 'PRE_PROVIDER_FAILURE'),
      FencingError
    );

    // -------------------------------------------------------------
    // 14. State Transitions
    // -------------------------------------------------------------
    console.log('Test: State Transitions...');
    const assetIdTransitions = randomUUID();
    await prisma.uploadAsset.create({
      data: {
        id: assetIdTransitions,
        userId: testUserId1,
        provider: 'R2',
        bucket: 'mock-bucket',
        objectKey: 'uploads/transitions.mp4',
        originalName: 'transitions.mp4',
        expectedSize: 10000000,
        declaredMimeType: 'video/mp4',
        status: UploadStatus.UPLOADING,
        idempotencyKey: 'idem-transitions',
        requestFingerprint: 'fingerprint-transitions',
        uploadExpiresAt: new Date(Date.now() + 60000),
      },
    });

    const claimForTransition = await FinalizationClaimService.acquireInitialCompletionClaim(testUserId1, assetIdTransitions);

    // UPLOADING -> UPLOADED
    await UploadStateService.transitionWithFinalizationClaim(
      claimForTransition,
      UploadStatus.UPLOADING,
      UploadStatus.UPLOADED,
      { actualSize: BigInt(500000) }
    );

    // Expired lease state transition fenced
    const expiredLeaseTransition = createExpiredLease();
    await prisma.uploadAsset.update({
      where: { id: assetIdTransitions },
      data: {
        finalizationLockedAt: expiredLeaseTransition.lockedAt,
        finalizationLockExpiresAt: expiredLeaseTransition.expiresAt,
      },
    });

    const expiredClaimForTransition = {
      ...claimForTransition,
      lockExpiresAt: expiredLeaseTransition.expiresAt,
    };

    await assertThrows(
      'Expired lease state transition fenced',
      () => UploadStateService.transitionWithFinalizationClaim(expiredClaimForTransition, UploadStatus.UPLOADED, UploadStatus.VALIDATING),
      FencingError
    );

    // Invalid matrix transition (COMPLETE: UPLOADING -> ABORTED)
    const assetIdTransitionsAbort = randomUUID();
    await prisma.uploadAsset.create({
      data: {
        id: assetIdTransitionsAbort,
        userId: testUserId1,
        provider: 'R2',
        bucket: 'mock-bucket',
        objectKey: 'uploads/transitions-abort.mp4',
        originalName: 'transitions-abort.mp4',
        expectedSize: 10000000,
        declaredMimeType: 'video/mp4',
        status: UploadStatus.UPLOADING,
        idempotencyKey: 'idem-transitions-abort',
        requestFingerprint: 'fingerprint-transitions-abort',
        uploadExpiresAt: new Date(Date.now() + 60000),
      },
    });

    const claimForTransitionAbort = await FinalizationClaimService.acquireInitialCompletionClaim(testUserId1, assetIdTransitionsAbort);
    await assertThrows(
      'COMPLETE claim rejects status transition to ABORTED',
      () => UploadStateService.transitionWithFinalizationClaim(claimForTransitionAbort, UploadStatus.UPLOADING, UploadStatus.ABORTED),
      InvalidStateTransitionError
    );

    // -------------------------------------------------------------
    // 15. COMPLETE Successful Cleanup
    // -------------------------------------------------------------
    console.log('Test: COMPLETE Successful Cleanup...');
    const assetIdCleanupComplete = randomUUID();
    await prisma.uploadAsset.create({
      data: {
        id: assetIdCleanupComplete,
        userId: testUserId1,
        provider: 'R2',
        bucket: 'mock-bucket',
        objectKey: 'uploads/cleanup-complete.mp4',
        originalName: 'cleanup-complete.mp4',
        expectedSize: 10000000,
        declaredMimeType: 'video/mp4',
        status: UploadStatus.UPLOADING,
        idempotencyKey: 'idem-cleanup-complete',
        requestFingerprint: 'fingerprint-cleanup-complete',
        uploadExpiresAt: new Date(Date.now() + 60000),
      },
    });

    const claimForCleanupComplete = await FinalizationClaimService.acquireInitialCompletionClaim(testUserId1, assetIdCleanupComplete);

    // Cleanup before VALIDATING status (status is UPLOADING) throws FencingError
    await assertThrows(
      'COMPLETE cleanup rejects UPLOADING status',
      () => FinalizationClaimService.clearFinalizationClaimAfterSuccess(claimForCleanupComplete),
      FencingError
    );

    // Step 1: Transition UPLOADING -> UPLOADED
    await UploadStateService.transitionWithFinalizationClaim(
      claimForCleanupComplete,
      UploadStatus.UPLOADING,
      UploadStatus.UPLOADED,
      { actualSize: BigInt(500000) }
    );

    // Cleanup before VALIDATING status (status is UPLOADED) still throws FencingError
    await assertThrows(
      'COMPLETE cleanup rejects UPLOADED status',
      () => FinalizationClaimService.clearFinalizationClaimAfterSuccess(claimForCleanupComplete),
      FencingError
    );

    // Step 2: Transition UPLOADED -> VALIDATING
    await UploadStateService.transitionWithFinalizationClaim(
      claimForCleanupComplete,
      UploadStatus.UPLOADED,
      UploadStatus.VALIDATING
    );

    // Successful cleanup resolves cleanly
    const cleanupResComplete: void = await FinalizationClaimService.clearFinalizationClaimAfterSuccess(claimForCleanupComplete);
    if (cleanupResComplete !== undefined) {
      throw new Error('Successful complete cleanup must return void.');
    }

    const cleanedCompleteAsset = await prisma.uploadAsset.findUnique({
      where: { id: assetIdCleanupComplete },
    });
    if (
      cleanedCompleteAsset?.finalizationOperation !== UploadFinalizationOperation.COMPLETE ||
      cleanedCompleteAsset?.finalizationAttemptCount !== claimForCleanupComplete.attemptCount ||
      cleanedCompleteAsset?.finalizationLockToken !== null ||
      cleanedCompleteAsset?.finalizationLockedAt !== null ||
      cleanedCompleteAsset?.finalizationLockExpiresAt !== null
    ) {
      throw new Error('Successful complete cleanup did not nullify lock parameters or preserved sticky data.');
    }

    // -------------------------------------------------------------
    // 16. ABORT Successful Cleanup
    // -------------------------------------------------------------
    console.log('Test: ABORT Successful Cleanup...');
    const assetIdCleanupAbort = randomUUID();
    await prisma.uploadAsset.create({
      data: {
        id: assetIdCleanupAbort,
        userId: testUserId1,
        provider: 'R2',
        bucket: 'mock-bucket',
        objectKey: 'uploads/cleanup-abort.mp4',
        originalName: 'cleanup-abort.mp4',
        expectedSize: 10000000,
        declaredMimeType: 'video/mp4',
        status: UploadStatus.UPLOADING,
        idempotencyKey: 'idem-cleanup-abort',
        requestFingerprint: 'fingerprint-cleanup-abort',
        uploadExpiresAt: new Date(Date.now() + 60000),
      },
    });

    const claimForCleanupAbort = await FinalizationClaimService.acquireInitialAbortClaim(testUserId1, assetIdCleanupAbort);

    // Cleanup before ABORTED status (status is UPLOADING) throws FencingError
    await assertThrows(
      'ABORT cleanup rejects UPLOADING status',
      () => FinalizationClaimService.clearFinalizationClaimAfterSuccess(claimForCleanupAbort),
      FencingError
    );

    // Transition UPLOADING -> ABORTED
    await UploadStateService.transitionWithFinalizationClaim(
      claimForCleanupAbort,
      UploadStatus.UPLOADING,
      UploadStatus.ABORTED
    );

    // Successful cleanup resolves cleanly
    const cleanupResAbort: void = await FinalizationClaimService.clearFinalizationClaimAfterSuccess(claimForCleanupAbort);
    if (cleanupResAbort !== undefined) {
      throw new Error('Successful abort cleanup must return void.');
    }

    const cleanedAbortAsset = await prisma.uploadAsset.findUnique({
      where: { id: assetIdCleanupAbort },
    });
    if (
      cleanedAbortAsset?.finalizationOperation !== UploadFinalizationOperation.ABORT ||
      cleanedAbortAsset?.finalizationAttemptCount !== claimForCleanupAbort.attemptCount ||
      cleanedAbortAsset?.finalizationLockToken !== null ||
      cleanedAbortAsset?.finalizationLockedAt !== null ||
      cleanedAbortAsset?.finalizationLockExpiresAt !== null
    ) {
      throw new Error('Successful abort cleanup did not nullify lock parameters or preserved sticky data.');
    }

    // -------------------------------------------------------------
    // 17. Expired lease successful-cleanup fenced
    // -------------------------------------------------------------
    console.log('Test: Expired lease successful-cleanup fenced...');
    const assetIdExpiredCleanup = randomUUID();
    await prisma.uploadAsset.create({
      data: {
        id: assetIdExpiredCleanup,
        userId: testUserId1,
        provider: 'R2',
        bucket: 'mock-bucket',
        objectKey: 'uploads/expired-cleanup.mp4',
        originalName: 'expired-cleanup.mp4',
        expectedSize: 10000000,
        declaredMimeType: 'video/mp4',
        status: UploadStatus.UPLOADING,
        idempotencyKey: 'idem-expired-cleanup',
        requestFingerprint: 'fingerprint-expired-cleanup',
        uploadExpiresAt: new Date(Date.now() + 60000),
      },
    });

    const claimForExpiredCleanup = await FinalizationClaimService.acquireInitialCompletionClaim(testUserId1, assetIdExpiredCleanup);

    // Transition UPLOADING -> UPLOADED -> VALIDATING
    await transitionCompletionToValidating(claimForExpiredCleanup);

    // Set expired lease
    const expiredLease4 = createExpiredLease();
    await prisma.uploadAsset.update({
      where: { id: assetIdExpiredCleanup },
      data: {
        finalizationLockedAt: expiredLease4.lockedAt,
        finalizationLockExpiresAt: expiredLease4.expiresAt,
      },
    });

    const expiredClaimForCleanup = {
      ...claimForExpiredCleanup,
      lockExpiresAt: expiredLease4.expiresAt,
    };

    await assertThrows(
      'Expired lease successful-cleanup fenced',
      () => FinalizationClaimService.clearFinalizationClaimAfterSuccess(expiredClaimForCleanup),
      FencingError
    );

    // -------------------------------------------------------------
    // 18. Stale-token cleanup fenced
    // -------------------------------------------------------------
    console.log('Test: Stale-token cleanup fenced...');
    const assetIdStaleCleanup = randomUUID();
    await prisma.uploadAsset.create({
      data: {
        id: assetIdStaleCleanup,
        userId: testUserId1,
        provider: 'R2',
        bucket: 'mock-bucket',
        objectKey: 'uploads/stale-cleanup.mp4',
        originalName: 'stale-cleanup.mp4',
        expectedSize: 10000000,
        declaredMimeType: 'video/mp4',
        status: UploadStatus.UPLOADING,
        idempotencyKey: 'idem-stale-cleanup',
        requestFingerprint: 'fingerprint-stale-cleanup',
        uploadExpiresAt: new Date(Date.now() + 60000),
      },
    });

    const claimForStaleCleanup = await FinalizationClaimService.acquireInitialCompletionClaim(testUserId1, assetIdStaleCleanup);

    // Transition UPLOADING -> UPLOADED -> VALIDATING
    await transitionCompletionToValidating(claimForStaleCleanup);

    const claimStale = { ...claimForStaleCleanup, lockToken: randomUUID() };
    await assertThrows(
      'Stale token cleanup throws FencingError',
      () => FinalizationClaimService.clearFinalizationClaimAfterSuccess(claimStale),
      FencingError
    );

    // -------------------------------------------------------------
    // Missing and Foreign Owner Checks (indistinguishable internally)
    // -------------------------------------------------------------
    console.log('Test: Missing and Foreign Owner checks...');
    await assertThrows(
      'Missing asset initial abort claim',
      () => FinalizationClaimService.acquireInitialAbortClaim(testUserId1, randomUUID()),
      NotFoundError
    );

    // -------------------------------------------------------------
    // Provider call permissions and emulated calls checks
    // -------------------------------------------------------------
    console.log('Test: Provider call permissions...');
    // Initial completion claim permits provider Action
    if (claim1.providerAction !== 'COMPLETE_MULTIPART' || claim1.providerCallAllowed !== true) {
      throw new Error('Initial completion claim has invalid provider permissions.');
    }

    // Recovery mode completion claim denies provider Action
    if (claim2.providerAction !== 'NONE' || claim2.providerCallAllowed !== false) {
      throw new Error('Completion recovery claim has invalid provider permissions.');
    }

    const mockS3CompleteCall = (c: InitialCompletionClaim) => {
      return c.lockToken;
    };
    mockS3CompleteCall(claim1); // compiles cleanly

    const mockS3AbortCall = (c: InitialAbortClaim) => {
      return c.lockToken;
    };
    mockS3AbortCall(claim3); // compiles cleanly

    // -------------------------------------------------------------
    // Fake Storage Adapter Mappings
    // -------------------------------------------------------------
    console.log('Test: Fake adapter mappings...');
    const fakeAdapter = new InMemoryFakeStorageAdapter();
    fakeAdapter.simulateMultipartNotFound = true;

    await assertThrows(
      'Fake adapter complete multipart not found mapping',
      () => fakeAdapter.completeMultipartUpload('mock-bucket', 'key', 'session-id', []),
      MultipartUploadNotFoundError
    );

    await assertThrows(
      'Fake adapter abort multipart not found mapping',
      () => fakeAdapter.abortMultipartUpload('mock-bucket', 'key', 'session-id'),
      MultipartUploadNotFoundError
    );

    // Test clearFinalizationClaimAfterSuccessTx works inside an existing Prisma transaction
    const assetIdTx = randomUUID();
    await prisma.uploadAsset.create({
      data: {
        id: assetIdTx,
        userId: testUserId1,
        provider: 'R2',
        bucket: 'mock-bucket',
        objectKey: 'uploads/vidtx.mp4',
        originalName: 'vidtx.mp4',
        expectedSize: 10000000,
        declaredMimeType: 'video/mp4',
        status: UploadStatus.UPLOADING,
        idempotencyKey: 'idem-tx',
        requestFingerprint: 'fingerprint-tx',
        uploadExpiresAt: new Date(Date.now() + 60000),
      },
    });

    const claimTx = await FinalizationClaimService.acquireInitialCompletionClaim(testUserId1, assetIdTx);

    await transitionCompletionToValidating(claimTx);

    await prisma.$transaction(async (tx) => {
      await FinalizationClaimService.clearFinalizationClaimAfterSuccessTx(tx, claimTx);
    });

    const cleanedTxAsset = await prisma.uploadAsset.findUnique({
      where: { id: assetIdTx },
    });
    if (cleanedTxAsset?.finalizationLockToken !== null) {
      throw new Error('Tx cleanup failed to clear lock token.');
    }

    // Verify a failed cleanup rolls back its audit entry
    const auditCountBefore = await prisma.auditLog.count();
    await assertThrows(
      'Duplicate Tx cleanup throws FencingError',
      () => prisma.$transaction(async (tx) => {
        await FinalizationClaimService.clearFinalizationClaimAfterSuccessTx(tx, claimTx);
      }),
      FencingError
    );

    const auditCountAfter = await prisma.auditLog.count();
    if (auditCountBefore !== auditCountAfter) {
      throw new Error('Audit entry was not rolled back after failed Tx cleanup.');
    }

    // -------------------------------------------------------------
    // Audit log confidentiality
    // -------------------------------------------------------------
    console.log('Test: Audit confidentiality...');
    const auditLogs = await prisma.auditLog.findMany();
    for (const log of auditLogs) {
      const text = log.details.toLowerCase();
      if (
        text.includes('token') ||
        text.includes('expires') ||
        text.includes('bucket') ||
        text.includes('key')
      ) {
        throw new Error(`Audit details contains sensitive fields: ${log.details}`);
      }
    }

    console.log('ALL PHASE 4 STEP 3C PREREQUISITE INTEGRATION TESTS PASSED SUCCESSFULLY! 🎉');

  } finally {
    await prisma.$disconnect();
  }
}

runTests().catch((e) => {
  console.error('TEST SUITE FAILED:', e);
  process.exit(1);
});
