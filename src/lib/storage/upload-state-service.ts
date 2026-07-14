import { UploadStatus, Prisma, UploadFinalizationOperation } from '@prisma/client';
import { prisma } from '../prisma-client';
import {
  NotFoundError,
  ForbiddenOwnershipError,
  InvalidStateTransitionError,
} from './upload-session-encryption';
import { FinalizationClaim } from './finalization-claim-service';

const LEGAL_TRANSITIONS: Record<UploadStatus, Set<UploadStatus>> = {
  [UploadStatus.REQUESTED]: new Set([
    UploadStatus.UPLOADING,
    UploadStatus.ABORTED,
    UploadStatus.EXPIRED,
    UploadStatus.FAILED,
  ]),
  [UploadStatus.UPLOADING]: new Set([
    UploadStatus.UPLOADED,
    UploadStatus.ABORTED,
    UploadStatus.EXPIRED,
    UploadStatus.FAILED,
  ]),
  [UploadStatus.UPLOADED]: new Set([
    UploadStatus.VALIDATING,
    UploadStatus.FAILED,
  ]),
  [UploadStatus.VALIDATING]: new Set([
    UploadStatus.VALIDATED,
    UploadStatus.FAILED,
    UploadStatus.UPLOADED, // Retryable validation recovery
  ]),
  [UploadStatus.FAILED]: new Set([
    UploadStatus.REQUESTED, // Through retry
    UploadStatus.OBJECT_DELETED, // Guarded cleanup
  ]),
  [UploadStatus.ABORTED]: new Set([
    UploadStatus.REQUESTED, // Through retry
    UploadStatus.OBJECT_DELETED, // Guarded cleanup
  ]),
  [UploadStatus.EXPIRED]: new Set([
    UploadStatus.REQUESTED, // Through retry
    UploadStatus.OBJECT_DELETED, // Guarded cleanup
  ]),
  [UploadStatus.VALIDATED]: new Set([
    UploadStatus.OBJECT_DELETED, // Guarded cleanup
  ]),
  [UploadStatus.OBJECT_DELETED]: new Set(), // Terminal
};

export function canTransitionUpload(from: UploadStatus, to: UploadStatus): boolean {
  return LEGAL_TRANSITIONS[from]?.has(to) || false;
}

/**
 * Utility to safely serialize BigInt fields to strings before returning data
 */
export function serializeBigInt(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'bigint') return obj.toString();
  if (Array.isArray(obj)) return obj.map(serializeBigInt);
  if (typeof obj === 'object') {
    const res: Record<string, unknown> = {};
    const typedObj = obj as Record<string, unknown>;
    for (const k of Object.keys(typedObj)) {
      res[k] = serializeBigInt(typedObj[k]);
    }
    return res;
  }
  return obj;
}

export class UploadStateService {
  /**
   * Transitions the upload status of an asset atomically and transactionally
   */
  static async transitionUploadStatus(
    userId: string,
    assetId: string,
    targetStatus: UploadStatus,
    metadataUpdates?: {
      failureCode?: string;
      failureMessage?: string;
      actualSize?: bigint;
    }
  ): Promise<unknown> {
    // 1. Fetch current asset
    const asset = await prisma.uploadAsset.findUnique({
      where: { id: assetId },
    });

    if (!asset) {
      throw new NotFoundError('Upload asset not found.');
    }
    if (asset.userId !== userId) {
      throw new ForbiddenOwnershipError('Access denied: You do not own this upload asset.');
    }

    // 2. Validate transition legality
    if (!canTransitionUpload(asset.status, targetStatus)) {
      throw new InvalidStateTransitionError(
        `Cannot transition upload asset from status ${asset.status} to ${targetStatus}.`
      );
    }

    // 3. Prepare consistent updates based on new status
    const now = new Date();
    const dataUpdate: Record<string, unknown> = {
      status: targetStatus,
    };

    if (targetStatus === UploadStatus.UPLOADING) {
      // Transitioning into uploading
    } else if (targetStatus === UploadStatus.UPLOADED) {
      dataUpdate.uploadedAt = now;
      if (metadataUpdates?.actualSize !== undefined) {
        dataUpdate.actualSize = metadataUpdates.actualSize;
      }
    } else if (targetStatus === UploadStatus.VALIDATING) {
      dataUpdate.validationStartedAt = now;
    } else if (targetStatus === UploadStatus.VALIDATED) {
      dataUpdate.validatedAt = now;
      // Clear validation locks on success
      dataUpdate.validationLockToken = null;
      dataUpdate.validationLockedAt = null;
      dataUpdate.validationLockExpiresAt = null;
    } else if (targetStatus === UploadStatus.FAILED) {
      dataUpdate.failureCode = metadataUpdates?.failureCode || 'VALIDATION_FAILED';
      dataUpdate.failureMessage = metadataUpdates?.failureMessage || 'Asset validation failed.';
      // Clear validation locks on failure
      dataUpdate.validationLockToken = null;
      dataUpdate.validationLockedAt = null;
      dataUpdate.validationLockExpiresAt = null;
    } else if (targetStatus === UploadStatus.OBJECT_DELETED) {
      dataUpdate.objectDeletedAt = now;
    }

    // 4. Atomic transaction update
    const result = await prisma.$transaction(async (tx) => {
      // Atomic status check in updateMany
      const updateCount = await tx.uploadAsset.updateMany({
        where: {
          id: assetId,
          userId,
          status: asset.status,
        },
        data: dataUpdate,
      });

      if (updateCount.count === 0) {
        throw new InvalidStateTransitionError(
          'Atomic status check failed: Status changed concurrently.'
        );
      }

      // Log audit trail
      await tx.auditLog.create({
        data: {
          action: 'UPLOAD_STATUS_CHANGED',
          details: `Changed upload asset ${assetId} status from ${asset.status} to ${targetStatus}.`,
          userId,
        },
      });

      // Query and return the updated asset
      return await tx.uploadAsset.findUnique({
        where: { id: assetId },
      });
    });

    return serializeBigInt(result);
  }

  /**
   * Special atomic retry operation transitioning FAILED, ABORTED, or EXPIRED assets back to REQUESTED
   */
  static async prepareUploadRetry(userId: string, assetId: string): Promise<unknown> {
    const asset = await prisma.uploadAsset.findUnique({
      where: { id: assetId },
    });

    if (!asset) {
      throw new NotFoundError('Upload asset not found.');
    }
    if (asset.userId !== userId) {
      throw new ForbiddenOwnershipError('Access denied: You do not own this upload asset.');
    }

    const current = asset.status;
    if (
      current !== UploadStatus.FAILED &&
      current !== UploadStatus.ABORTED &&
      current !== UploadStatus.EXPIRED
    ) {
      throw new InvalidStateTransitionError(
        `Cannot prepare retry for asset in status ${current}. Only FAILED, ABORTED, and EXPIRED statuses can be retried.`
      );
    }

    const result = await prisma.$transaction(async (tx) => {
      // Atomic status check in updateMany
      const updateCount = await tx.uploadAsset.updateMany({
        where: {
          id: assetId,
          userId,
          status: current,
        },
        data: {
          status: UploadStatus.REQUESTED,
          uploadedAt: null,
          validatedAt: null,
          validationStartedAt: null,
          objectDeletedAt: null,
          actualSize: null,
          failureCode: null,
          failureMessage: null,
          validationAttemptCount: 0,
          validationLockToken: null,
          validationLockedAt: null,
          validationLockExpiresAt: null,
        },
      });

      if (updateCount.count === 0) {
        throw new InvalidStateTransitionError(
          'Atomic status check failed: Status changed concurrently.'
        );
      }

      // Clean up any existing UploadSession associated with the asset
      await tx.uploadSession.deleteMany({
        where: { uploadAssetId: assetId },
      });

      // Log retry audit log
      await tx.auditLog.create({
        data: {
          action: 'UPLOAD_RETRY_PREPARED',
          details: `Prepared upload retry for asset ${assetId}. Reset status from ${current} to REQUESTED. Deleted stale session.`,
          userId,
        },
      });

      return await tx.uploadAsset.findUnique({
        where: { id: assetId },
      });
    });

    return serializeBigInt(result);
  }

  static async transitionWithFinalizationClaim(
    claim: FinalizationClaim,
    expectedStatus: UploadStatus,
    targetStatus: UploadStatus,
    metadataUpdates?: {
      actualSize?: bigint;
      objectETag?: string;
      uploadedAt?: Date;
    }
  ): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await this.transitionWithFinalizationClaimTx(
        tx,
        claim,
        expectedStatus,
        targetStatus,
        metadataUpdates
      );
    });
  }

  static async transitionWithFinalizationClaimTx(
    tx: Prisma.TransactionClient,
    claim: FinalizationClaim,
    expectedStatus: UploadStatus,
    targetStatus: UploadStatus,
    metadataUpdates?: {
      actualSize?: bigint;
      objectETag?: string;
      uploadedAt?: Date;
    }
  ): Promise<void> {
    // Verify transition validity
    if (!canTransitionUpload(expectedStatus, targetStatus)) {
      throw new InvalidStateTransitionError(
        `Cannot transition upload asset from status ${expectedStatus} to ${targetStatus}.`
      );
    }

    // Validate the exact operation-transition matrix
    const isComplete = claim.operation === UploadFinalizationOperation.COMPLETE;
    const isRecovery = claim.mode === 'COMPLETION_RECOVERY';

    if (isRecovery) {
      if (expectedStatus !== UploadStatus.UPLOADED || targetStatus !== UploadStatus.VALIDATING) {
        throw new InvalidStateTransitionError(
          `Completion recovery claim does not authorize transition from ${expectedStatus} to ${targetStatus}. Only UPLOADED -> VALIDATING is allowed.`
        );
      }
    } else if (isComplete) {
      const isAllowed =
        (expectedStatus === UploadStatus.UPLOADING && targetStatus === UploadStatus.UPLOADED) ||
        (expectedStatus === UploadStatus.UPLOADED && targetStatus === UploadStatus.VALIDATING);
      if (!isAllowed) {
        throw new InvalidStateTransitionError(
          `COMPLETE claim does not authorize transition from ${expectedStatus} to ${targetStatus}.`
        );
      }
    } else {
      // ABORT
      const isAllowed =
        (expectedStatus === UploadStatus.REQUESTED && targetStatus === UploadStatus.ABORTED) ||
        (expectedStatus === UploadStatus.UPLOADING && targetStatus === UploadStatus.ABORTED);
      if (!isAllowed) {
        throw new InvalidStateTransitionError(
          `ABORT claim does not authorize transition from ${expectedStatus} to ${targetStatus}.`
        );
      }
    }

    const dataUpdate: Record<string, unknown> = {
      status: targetStatus,
    };

    if (metadataUpdates) {
      if (metadataUpdates.actualSize !== undefined) {
        dataUpdate.actualSize = metadataUpdates.actualSize;
      }
      if (metadataUpdates.objectETag !== undefined) {
        dataUpdate.objectETag = metadataUpdates.objectETag;
      }
      if (metadataUpdates.uploadedAt !== undefined) {
        dataUpdate.uploadedAt = metadataUpdates.uploadedAt;
      }
    }

    // Fenced conditional update
    const updateCount = await tx.uploadAsset.updateMany({
      where: {
        id: claim.assetId,
        userId: claim.userId,
        finalizationOperation: claim.operation,
        finalizationLockToken: claim.lockToken,
        finalizationLockExpiresAt: { gt: new Date() },
        status: expectedStatus,
      },
      data: dataUpdate,
    });

    if (updateCount.count === 0) {
      throw new FencingError();
    }

    // Write state-transition audit log inside the same transaction
    await tx.auditLog.create({
      data: {
        action: 'FINALIZATION_STATE_TRANSITIONED',
        details: `Transitioned asset ${claim.assetId} status from ${expectedStatus} to ${targetStatus}.`,
        userId: claim.userId,
      },
    });
  }
}

export class FencingError extends Error {
  constructor(message: string = 'Fencing assertion failed: lock token mismatch or lease expired.') {
    super(message);
    this.name = 'FencingError';
  }
}
