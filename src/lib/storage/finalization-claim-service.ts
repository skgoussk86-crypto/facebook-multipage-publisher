import crypto from 'crypto';
import { UploadFinalizationOperation, UploadStatus, Prisma } from '@prisma/client';
import { prisma } from '../prisma-client';
import { FencingError } from './upload-state-service';
import {
  NotFoundError,
  ForbiddenOwnershipError,
  InvalidStateTransitionError,
} from './upload-session-encryption';

export interface InitialCompletionClaim {
  mode: 'INITIAL';
  operation: typeof UploadFinalizationOperation.COMPLETE;
  providerAction: 'COMPLETE_MULTIPART';
  providerCallAllowed: true;
  userId: string;
  assetId: string;
  lockToken: string;
  lockedAt: Date;
  lockExpiresAt: Date;
  attemptCount: number;
  staleTakeover: boolean;
}

export interface InitialAbortClaim {
  mode: 'INITIAL';
  operation: typeof UploadFinalizationOperation.ABORT;
  providerAction: 'ABORT_MULTIPART';
  providerCallAllowed: true;
  userId: string;
  assetId: string;
  lockToken: string;
  lockedAt: Date;
  lockExpiresAt: Date;
  attemptCount: number;
  staleTakeover: boolean;
}

export interface CompletionRecoveryClaim {
  mode: 'COMPLETION_RECOVERY';
  operation: typeof UploadFinalizationOperation.COMPLETE;
  providerAction: 'NONE';
  providerCallAllowed: false;
  userId: string;
  assetId: string;
  lockToken: string;
  lockedAt: Date;
  lockExpiresAt: Date;
  attemptCount: number;
  staleTakeover: boolean;
}

export type InitialFinalizationClaim =
  | InitialCompletionClaim
  | InitialAbortClaim;

export type FinalizationClaim =
  | InitialCompletionClaim
  | InitialAbortClaim
  | CompletionRecoveryClaim;

export class FinalizationOperationConflictError extends Error {
  constructor(message: string = 'Finalization operation conflict: requested operation cannot overwrite sticky intent.') {
    super(message);
    this.name = 'FinalizationOperationConflictError';
  }
}

export class FinalizationInProgressError extends Error {
  constructor(message: string = 'Finalization operation in progress: active lock lease holds this asset.') {
    super(message);
    this.name = 'FinalizationInProgressError';
  }
}

export const LEASE_DURATION_MS = 5 * 60 * 1000; // 5 minutes

export class FinalizationClaimService {
  /**
   * Internal shared implementation for initial claims
   */
  private static async acquireInitialClaim(
    userId: string,
    assetId: string,
    operation: UploadFinalizationOperation
  ): Promise<InitialCompletionClaim | InitialAbortClaim> {
    const now = new Date();
    const isComplete = operation === UploadFinalizationOperation.COMPLETE;
    const legalStatuses: UploadStatus[] = isComplete
      ? [UploadStatus.UPLOADING]
      : [UploadStatus.REQUESTED, UploadStatus.UPLOADING];

    const newLockToken = crypto.randomUUID();
    const lockExpiresAt = new Date(now.getTime() + LEASE_DURATION_MS);

    return await prisma.$transaction(async (tx) => {
      // Find lock target to inspect if there is already a stale lock we are taking over
      const target = await tx.uploadAsset.findUnique({
        where: { id: assetId },
      });

      const staleTakeover = !!(
        target &&
        target.finalizationLockToken &&
        target.finalizationLockExpiresAt &&
        target.finalizationLockExpiresAt.getTime() <= now.getTime()
      );

      // Perform compare-and-set conditional update
      const updateCount = await tx.uploadAsset.updateMany({
        where: {
          id: assetId,
          userId: userId,
          status: { in: legalStatuses },
          OR: [
            { finalizationOperation: null },
            { finalizationOperation: operation },
          ],
          AND: {
            OR: [
              { finalizationLockToken: null },
              { finalizationLockExpiresAt: { lte: now } },
            ],
          },
        },
        data: {
          finalizationOperation: operation,
          finalizationLockToken: newLockToken,
          finalizationLockedAt: now,
          finalizationLockExpiresAt: lockExpiresAt,
          finalizationAttemptCount: { increment: 1 },
        },
      });

      if (updateCount.count === 0) {
        // Failed claim. Perform diagnosis.
        const asset = await tx.uploadAsset.findUnique({
          where: { id: assetId },
        });

        if (!asset) {
          throw new NotFoundError('Upload asset not found.');
        }
        if (asset.userId !== userId) {
          throw new ForbiddenOwnershipError('Access denied: You do not own this upload asset.');
        }
        if (asset.finalizationOperation && asset.finalizationOperation !== operation) {
          throw new FinalizationOperationConflictError();
        }
        if (!legalStatuses.includes(asset.status)) {
          throw new InvalidStateTransitionError(
            `Cannot perform initial ${operation} finalization on asset in status ${asset.status}.`
          );
        }

        const hasActiveLock =
          asset.finalizationLockToken &&
          asset.finalizationLockExpiresAt &&
          asset.finalizationLockExpiresAt.getTime() > now.getTime();

        if (hasActiveLock) {
          throw new FinalizationInProgressError();
        }

        throw new InvalidStateTransitionError(
          `Cannot perform initial ${operation} finalization on asset in status ${asset.status}.`
        );
      }

      // Claim succeeded. Read the updated record to obtain current attemptCount
      const updatedAsset = await tx.uploadAsset.findUnique({
        where: { id: assetId },
      });

      const attemptCount = updatedAsset?.finalizationAttemptCount || 1;

      // Write claim audit entry atomically
      await tx.auditLog.create({
        data: {
          action: staleTakeover ? 'FINALIZATION_STALE_CLAIM_TAKEN_OVER' : 'FINALIZATION_CLAIM_ACQUIRED',
          details: `Acquired initial claim for asset ${assetId} with operation ${operation}. Attempt count: ${attemptCount}.`,
          userId,
        },
      });

      if (isComplete) {
        return {
          mode: 'INITIAL',
          operation: UploadFinalizationOperation.COMPLETE,
          providerAction: 'COMPLETE_MULTIPART',
          providerCallAllowed: true,
          userId,
          assetId,
          lockToken: newLockToken,
          lockedAt: now,
          lockExpiresAt,
          attemptCount,
          staleTakeover,
        };
      } else {
        return {
          mode: 'INITIAL',
          operation: UploadFinalizationOperation.ABORT,
          providerAction: 'ABORT_MULTIPART',
          providerCallAllowed: true,
          userId,
          assetId,
          lockToken: newLockToken,
          lockedAt: now,
          lockExpiresAt,
          attemptCount,
          staleTakeover,
        };
      }
    });
  }

  /**
   * Atomically acquires an initial completion claim on an asset inside a short database transaction.
   * Only allows status UPLOADING.
   */
  static async acquireInitialCompletionClaim(
    userId: string,
    assetId: string
  ): Promise<InitialCompletionClaim> {
    return (await this.acquireInitialClaim(
      userId,
      assetId,
      UploadFinalizationOperation.COMPLETE
    )) as InitialCompletionClaim;
  }

  /**
   * Atomically acquires an initial abort claim on an asset inside a short database transaction.
   * Allows status REQUESTED or UPLOADING.
   */
  static async acquireInitialAbortClaim(
    userId: string,
    assetId: string
  ): Promise<InitialAbortClaim> {
    return (await this.acquireInitialClaim(
      userId,
      assetId,
      UploadFinalizationOperation.ABORT
    )) as InitialAbortClaim;
  }

  /**
   * Atomically acquires a recovery claim on an asset that is already in UPLOADED status.
   * Authorized only for status UPLOADED, matching user owner, sticky COMPLETE operation,
   * and expired or absent claim.
   */
  static async acquireCompletionRecoveryClaim(
    userId: string,
    assetId: string
  ): Promise<CompletionRecoveryClaim> {
    const now = new Date();
    const newLockToken = crypto.randomUUID();
    const lockExpiresAt = new Date(now.getTime() + LEASE_DURATION_MS);

    return await prisma.$transaction(async (tx) => {
      // Find lock target to inspect if there is already a stale lock we are taking over
      const target = await tx.uploadAsset.findUnique({
        where: { id: assetId },
      });

      const staleTakeover = !!(
        target &&
        target.finalizationLockToken &&
        target.finalizationLockExpiresAt &&
        target.finalizationLockExpiresAt.getTime() <= now.getTime()
      );

      // Perform compare-and-set conditional update
      const updateCount = await tx.uploadAsset.updateMany({
        where: {
          id: assetId,
          userId: userId,
          status: UploadStatus.UPLOADED,
          finalizationOperation: UploadFinalizationOperation.COMPLETE,
          AND: {
            OR: [
              { finalizationLockToken: null },
              { finalizationLockExpiresAt: { lte: now } },
            ],
          },
        },
        data: {
          finalizationLockToken: newLockToken,
          finalizationLockedAt: now,
          finalizationLockExpiresAt: lockExpiresAt,
          finalizationAttemptCount: { increment: 1 },
        },
      });

      if (updateCount.count === 0) {
        // Failed claim. Perform diagnosis.
        const asset = await tx.uploadAsset.findUnique({
          where: { id: assetId },
        });

        if (!asset) {
          throw new NotFoundError('Upload asset not found.');
        }
        if (asset.userId !== userId) {
          throw new ForbiddenOwnershipError('Access denied: You do not own this upload asset.');
        }
        if (asset.finalizationOperation !== UploadFinalizationOperation.COMPLETE) {
          throw new FinalizationOperationConflictError(
            'Cannot perform completion recovery: asset has no existing COMPLETE finalization intent.'
          );
        }
        if (asset.status !== UploadStatus.UPLOADED) {
          throw new InvalidStateTransitionError(
            `Cannot perform completion recovery on asset in status ${asset.status}. Only UPLOADED status is allowed.`
          );
        }

        const hasActiveLock =
          asset.finalizationLockToken &&
          asset.finalizationLockExpiresAt &&
          asset.finalizationLockExpiresAt.getTime() > now.getTime();

        if (hasActiveLock) {
          throw new FinalizationInProgressError();
        }

        throw new InvalidStateTransitionError(
          `Cannot perform completion recovery on asset in status ${asset.status}. Only UPLOADED status is allowed.`
        );
      }

      // Claim succeeded. Read the updated record to obtain current attemptCount
      const updatedAsset = await tx.uploadAsset.findUnique({
        where: { id: assetId },
      });

      const attemptCount = updatedAsset?.finalizationAttemptCount || 1;

      // Write claim audit entry atomically
      await tx.auditLog.create({
        data: {
          action: staleTakeover ? 'FINALIZATION_STALE_CLAIM_TAKEN_OVER' : 'FINALIZATION_CLAIM_ACQUIRED',
          details: `Acquired completion recovery claim for asset ${assetId}. Attempt count: ${attemptCount}.`,
          userId,
        },
      });

      return {
        mode: 'COMPLETION_RECOVERY',
        operation: UploadFinalizationOperation.COMPLETE,
        providerAction: 'NONE',
        providerCallAllowed: false,
        userId,
        assetId,
        lockToken: newLockToken,
        lockedAt: now,
        lockExpiresAt,
        attemptCount,
        staleTakeover,
      };
    });
  }

  /**
   * Renews an active finalization claim before provider calls.
   * Throws FencingError when no matching row or unexpired lease is found.
   */
  static async renewFinalizationClaim<T extends FinalizationClaim>(
    claim: T
  ): Promise<T> {
    const now = new Date();
    const lockExpiresAt = new Date(now.getTime() + LEASE_DURATION_MS);

    return await prisma.$transaction(async (tx) => {
      // Atomically renew in updateMany
      const updateCount = await tx.uploadAsset.updateMany({
        where: {
          id: claim.assetId,
          userId: claim.userId,
          finalizationOperation: claim.operation,
          finalizationLockToken: claim.lockToken,
          finalizationLockExpiresAt: { gt: now }, // current lease must still be unexpired
        },
        data: {
          finalizationLockedAt: now,
          finalizationLockExpiresAt: lockExpiresAt,
        },
      });

      if (updateCount.count === 0) {
        throw new FencingError('Claim has expired or was replaced by a newer claimant.');
      }

      await tx.auditLog.create({
        data: {
          action: 'FINALIZATION_CLAIM_RENEWED',
          details: `Renewed finalization claim for asset ${claim.assetId} with operation ${claim.operation}.`,
          userId: claim.userId,
        },
      });

      return {
        ...claim,
        lockedAt: now,
        lockExpiresAt,
      } as unknown as T;
    });
  }

  /**
   * Asserts that the finalization claim is currently active and unexpired.
   */
  static async assertFinalizationClaim(
    claim: FinalizationClaim
  ): Promise<void> {
    const now = new Date();
    const asset = await prisma.uploadAsset.findUnique({
      where: { id: claim.assetId },
    });

    const isUnexpired =
      asset &&
      asset.finalizationLockExpiresAt &&
      asset.finalizationLockExpiresAt.getTime() > now.getTime();

    if (
      !asset ||
      asset.userId !== claim.userId ||
      asset.finalizationOperation !== claim.operation ||
      asset.finalizationLockToken !== claim.lockToken ||
      !isUnexpired
    ) {
      throw new FencingError('Claim has expired or was replaced by a newer claimant.');
    }
  }

  /**
   * Releases a temporary claim lock on provider failure using token-fenced update.
   * Requires a typed reason to prevent accidental release on ambiguous provider timeout/failure.
   */
  static async releaseFinalizationClaim(
    claim: FinalizationClaim,
    reason: 'PRE_PROVIDER_FAILURE' | 'PROVEN_REQUEST_NOT_SENT'
  ): Promise<boolean> {
    return await prisma.$transaction(async (tx) => {
      const updateCount = await tx.uploadAsset.updateMany({
        where: {
          id: claim.assetId,
          userId: claim.userId,
          finalizationOperation: claim.operation,
          finalizationLockToken: claim.lockToken,
        },
        data: {
          finalizationLockToken: null,
          finalizationLockedAt: null,
          finalizationLockExpiresAt: null,
        },
      });

      if (updateCount.count === 0) {
        throw new FencingError('Fencing collision: claim was already released or overtaken.');
      }

      await tx.auditLog.create({
        data: {
          action: 'FINALIZATION_CLAIM_RELEASED',
          details: `Released finalization claim for asset ${claim.assetId} with operation ${claim.operation}. Reason: ${reason}.`,
          userId: claim.userId,
        },
      });
      return true;
    });
  }

  /**
   * Clears a temporary claim lock after provider success using token-fenced update.
   * Only allows successful cleanup when the asset is transitioned to correct final status:
   * - COMPLETE operation requires VALIDATING status.
   * - ABORT operation requires ABORTED status.
   */
  static async clearFinalizationClaimAfterSuccess(
    claim: FinalizationClaim
  ): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await this.clearFinalizationClaimAfterSuccessTx(tx, claim);
    });
  }

  /**
   * Transaction-composable implementation of successful cleanup.
   */
  static async clearFinalizationClaimAfterSuccessTx(
    tx: Prisma.TransactionClient,
    claim: FinalizationClaim
  ): Promise<void> {
    const now = new Date();
    const requiredStatus = claim.operation === UploadFinalizationOperation.COMPLETE
      ? UploadStatus.VALIDATING
      : UploadStatus.ABORTED;

    const updateCount = await tx.uploadAsset.updateMany({
      where: {
        id: claim.assetId,
        userId: claim.userId,
        finalizationOperation: claim.operation,
        finalizationLockToken: claim.lockToken,
        status: requiredStatus,
        finalizationLockExpiresAt: { gt: now },
      },
      data: {
        finalizationLockToken: null,
        finalizationLockedAt: null,
        finalizationLockExpiresAt: null,
      },
    });

    if (updateCount.count === 0) {
      throw new FencingError(
        `Fencing collision: claim has expired, was cleared/overtaken, or asset is not in expected status ${requiredStatus}.`
      );
    }

    await tx.auditLog.create({
      data: {
        action: 'FINALIZATION_CLAIM_CLEARED_AFTER_SUCCESS',
        details: `Successfully cleared finalization claim lock for asset ${claim.assetId} with operation ${claim.operation} at status ${requiredStatus}.`,
        userId: claim.userId,
      },
    });
  }
}
