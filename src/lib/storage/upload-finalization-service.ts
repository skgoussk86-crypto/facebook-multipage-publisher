import { UploadStatus, UploadFinalizationOperation, UploadSession, Prisma } from '@prisma/client';
import { prisma } from '../prisma-client';
import { getStorageAdapter } from './index';
import {
  FinalizationClaimService,
  FinalizationOperationConflictError,
  FinalizationClaim,
} from './finalization-claim-service';
import { UploadStateService, serializeBigInt } from './upload-state-service';
import { UploadSessionService } from './upload-session-service';
import {
  NotFoundError,
  ForbiddenOwnershipError,
  InvalidStateTransitionError,
  InvalidMultipartMetadataError,
} from './upload-session-encryption';
import { PART_SIZE_BYTES } from './upload-initiation-service';

export interface FinalizationTransitionTx {
  uploadAsset: {
    updateMany(args: {
      where: Prisma.UploadAssetWhereInput;
      data: Prisma.UploadAssetUpdateManyMutationInput;
    }): Promise<{ count: number }>;
  };
  uploadSession: {
    deleteMany(args: {
      where: Prisma.UploadSessionWhereInput;
    }): Promise<{ count: number }>;
  };
  auditLog: {
    create(args: {
      data: {
        action: string;
        details: string;
        userId: string;
      };
    }): Promise<{ id: string }>;
  };
}

export interface FinalizationDependencies {
  findUploadAsset: (id: string) => Promise<{
    id: string;
    userId: string;
    status: UploadStatus;
    expectedSize: bigint | string;
    bucket: string;
    objectKey: string;
    finalizationOperation: UploadFinalizationOperation | null;
  } | null>;
  findUploadSessionRecord: (assetId: string) => Promise<UploadSession | null>;
  acquireCompletionRecoveryClaim: typeof FinalizationClaimService.acquireCompletionRecoveryClaim;
  acquireInitialCompletionClaim: typeof FinalizationClaimService.acquireInitialCompletionClaim;
  acquireInitialAbortClaim: typeof FinalizationClaimService.acquireInitialAbortClaim;
  releaseFinalizationClaim: typeof FinalizationClaimService.releaseFinalizationClaim;
  clearFinalizationClaimAfterSuccessTx: (tx: FinalizationTransitionTx, claim: FinalizationClaim) => Promise<void>;
  getDecryptedSession: typeof UploadSessionService.getDecryptedSession;
  transitionStateTx: (
    tx: FinalizationTransitionTx,
    claim: FinalizationClaim,
    fromStatus: UploadStatus,
    toStatus: UploadStatus,
    metadata?: { actualSize?: bigint; objectETag?: string; uploadedAt?: Date }
  ) => Promise<void>;
  deleteUploadSessionTx: (tx: FinalizationTransitionTx, assetId: string) => Promise<void>;
  getStorageAdapter: () => {
    completeMultipartUpload: (
      bucket: string,
      key: string,
      uploadId: string,
      parts: Array<{ partNumber: number; etag: string; size?: number }>
    ) => Promise<{ size: number; etag: string; lastModified?: Date }>;
    abortMultipartUpload: (
      bucket: string,
      key: string,
      uploadId: string
    ) => Promise<void>;
  };
  transaction: <T>(cb: (tx: FinalizationTransitionTx) => Promise<T>) => Promise<T>;
}

export const defaultFinalizationDependencies: FinalizationDependencies = {
  findUploadAsset: async (id) => {
    return await prisma.uploadAsset.findUnique({ where: { id } });
  },
  findUploadSessionRecord: async (assetId) => {
    return await prisma.uploadSession.findUnique({ where: { uploadAssetId: assetId } });
  },
  acquireCompletionRecoveryClaim: (userId, assetId) => {
    return FinalizationClaimService.acquireCompletionRecoveryClaim(userId, assetId);
  },
  acquireInitialCompletionClaim: (userId, assetId) => {
    return FinalizationClaimService.acquireInitialCompletionClaim(userId, assetId);
  },
  acquireInitialAbortClaim: (userId, assetId) => {
    return FinalizationClaimService.acquireInitialAbortClaim(userId, assetId);
  },
  releaseFinalizationClaim: (claim, reason) => {
    return FinalizationClaimService.releaseFinalizationClaim(claim, reason);
  },
  clearFinalizationClaimAfterSuccessTx: (tx, claim) => {
    return FinalizationClaimService.clearFinalizationClaimAfterSuccessTx(
      tx as unknown as Prisma.TransactionClient,
      claim
    );
  },
  getDecryptedSession: (userId, assetId) => {
    return UploadSessionService.getDecryptedSession(userId, assetId);
  },
  transitionStateTx: (tx, claim, fromStatus, toStatus, metadata) => {
    return UploadStateService.transitionWithFinalizationClaimTx(
      tx as unknown as Prisma.TransactionClient,
      claim,
      fromStatus,
      toStatus,
      metadata
    );
  },
  deleteUploadSessionTx: async (tx, assetId) => {
    await (tx as unknown as Prisma.TransactionClient).uploadSession.deleteMany({
      where: { uploadAssetId: assetId },
    });
  },
  getStorageAdapter: () => {
    return getStorageAdapter() as {
      completeMultipartUpload: (
        bucket: string,
        key: string,
        uploadId: string,
        parts: Array<{ partNumber: number; etag: string; size?: number }>
      ) => Promise<{ size: number; etag: string; lastModified?: Date }>;
      abortMultipartUpload: (
        bucket: string,
        key: string,
        uploadId: string
      ) => Promise<void>;
    };
  },
  transaction: async <T>(cb: (tx: FinalizationTransitionTx) => Promise<T>): Promise<T> => {
    return await prisma.$transaction(async (realTx) => {
      return await cb(realTx as unknown as FinalizationTransitionTx);
    });
  }
};

export class UploadFinalizationService {
  /**
   * Safe, durable orchestration to complete a multipart upload
   */
  static async completeUpload(
    userId: string,
    assetId: string,
    _body?: unknown,
    dependencies: FinalizationDependencies = defaultFinalizationDependencies
  ): Promise<unknown> {
    // 1. Retrieve asset & check ownership
    const asset = await dependencies.findUploadAsset(assetId);

    if (!asset) {
      throw new NotFoundError('Upload asset not found.');
    }
    if (asset.userId !== userId) {
      throw new ForbiddenOwnershipError('Access denied: You do not own this upload asset.');
    }

    // Idempotent success response if already validating or validated
    if (asset.status === UploadStatus.VALIDATING || asset.status === UploadStatus.VALIDATED) {
      return serializeBigInt(asset);
    }

    // Sticky operation check
    if (asset.finalizationOperation === UploadFinalizationOperation.ABORT) {
      throw new FinalizationOperationConflictError();
    }

    // Validate transition feasibility
    if (asset.status !== UploadStatus.UPLOADING && asset.status !== UploadStatus.UPLOADED) {
      throw new InvalidStateTransitionError(
        `Cannot perform completion finalization on asset in status ${asset.status}.`
      );
    }

    // 2. Status-specific flows
    if (asset.status === UploadStatus.UPLOADED) {
      // Recovery path
      const claim = await dependencies.acquireCompletionRecoveryClaim(userId, assetId);
      const result = await dependencies.transaction(async (tx) => {
        // Transition UPLOADED -> VALIDATING
        await dependencies.transitionStateTx(
          tx,
          claim,
          UploadStatus.UPLOADED,
          UploadStatus.VALIDATING
        );

        // Invalidate upload session secrets
        await dependencies.deleteUploadSessionTx(tx, assetId);

        // Clear finalization claim lock
        await dependencies.clearFinalizationClaimAfterSuccessTx(tx, claim);

        return await dependencies.findUploadAsset(assetId);
      });

      return serializeBigInt(result);
    }

    // status is UPLOADING
    // Acquire initial claim
    const claim = await dependencies.acquireInitialCompletionClaim(userId, assetId);

    // Retrieve session and verify details
    let session;
    try {
      session = await dependencies.getDecryptedSession(userId, assetId);

      // 1. at least one confirmed part exists
      if (!session.completedParts || session.completedParts.length === 0) {
        throw new InvalidMultipartMetadataError('Upload is incomplete: no completed parts recorded.');
      }

      // 2. part numbers are unique
      const partNumbers = session.completedParts.map((p) => p.partNumber);
      const uniqueParts = new Set(partNumbers);
      if (uniqueParts.size !== partNumbers.length) {
        throw new InvalidMultipartMetadataError('Duplicate part numbers detected.');
      }

      // 3. part numbers are sequential and complete (sorted ascending)
      session.completedParts.sort((a, b) => a.partNumber - b.partNumber);
      for (let i = 0; i < session.completedParts.length; i++) {
        if (session.completedParts[i].partNumber !== i + 1) {
          throw new InvalidMultipartMetadataError(
            `Missing part: expected part number ${i + 1}, but got ${session.completedParts[i].partNumber}.`
          );
        }
      }

      // 4. expected total part count matches
      const expectedTotalParts = Math.ceil(Number(asset.expectedSize) / PART_SIZE_BYTES);
      if (session.completedParts.length !== expectedTotalParts) {
        throw new InvalidMultipartMetadataError(
          `Upload is incomplete: expected ${expectedTotalParts} parts, but only ${session.completedParts.length} parts were completed.`
        );
      }

      // 5. required ETags exist in durable server records
      for (const p of session.completedParts) {
        if (!p.etag || !p.etag.trim()) {
          throw new InvalidMultipartMetadataError(`Missing ETag for part number ${p.partNumber}.`);
        }
      }

      // 6. final non-last multipart part-size constraints remain valid
      for (const p of session.completedParts) {
        if (p.partNumber !== expectedTotalParts) {
          if (p.size !== undefined && p.size !== PART_SIZE_BYTES) {
            throw new InvalidMultipartMetadataError(
              `Invalid part size: part number ${p.partNumber} size is ${p.size} bytes, but must be exactly ${PART_SIZE_BYTES} bytes.`
            );
          }
        }
      }

    } catch (err) {
      // Safe release on pre-provider failure
      await dependencies.releaseFinalizationClaim(claim, 'PRE_PROVIDER_FAILURE');
      throw err;
    }

    // Call provider complete multipart upload
    try {
      if (!claim.providerCallAllowed) {
        throw new Error('Claim does not authorize provider completion call.');
      }

      const adapter = dependencies.getStorageAdapter();
      const metadata = await adapter.completeMultipartUpload(
        asset.bucket,
        asset.objectKey,
        session.providerSessionId,
        session.completedParts // Complete using securely decrypted server session parts
      );

      // Complete transitions and cleanup
      const result = await dependencies.transaction(async (tx) => {
        // Transition UPLOADING -> UPLOADED
        await dependencies.transitionStateTx(
          tx,
          claim,
          UploadStatus.UPLOADING,
          UploadStatus.UPLOADED,
          {
            actualSize: BigInt(metadata.size),
            objectETag: metadata.etag,
            uploadedAt: metadata.lastModified || new Date(),
          }
        );

        // Transition UPLOADED -> VALIDATING
        await dependencies.transitionStateTx(
          tx,
          claim,
          UploadStatus.UPLOADED,
          UploadStatus.VALIDATING
        );

        // Invalidate session secrets
        await dependencies.deleteUploadSessionTx(tx, assetId);

        // Clear lease
        await dependencies.clearFinalizationClaimAfterSuccessTx(tx, claim);

        return await dependencies.findUploadAsset(assetId);
      });

      return serializeBigInt(result);
    } catch (err) {
      // Provider failures retain the claim
      throw err;
    }
  }

  /**
   * Safe, durable orchestration to abort a multipart upload
   */
  static async abortUpload(
    userId: string,
    assetId: string,
    dependencies: FinalizationDependencies = defaultFinalizationDependencies
  ): Promise<unknown> {
    // 1. Retrieve asset & check ownership
    const asset = await dependencies.findUploadAsset(assetId);

    if (!asset) {
      throw new NotFoundError('Upload asset not found.');
    }
    if (asset.userId !== userId) {
      throw new ForbiddenOwnershipError('Access denied: You do not own this upload asset.');
    }

    // Sticky operation check (must run before idempotent aborted check)
    if (asset.finalizationOperation === UploadFinalizationOperation.COMPLETE) {
      throw new FinalizationOperationConflictError();
    }

    // Idempotent success response if already aborted
    if (asset.status === UploadStatus.ABORTED) {
      return serializeBigInt(asset);
    }

    // Validate transition feasibility
    if (asset.status !== UploadStatus.REQUESTED && asset.status !== UploadStatus.UPLOADING) {
      throw new InvalidStateTransitionError(
        `Cannot perform abort finalization on asset in status ${asset.status}.`
      );
    }

    // Acquire claim
    const claim = await dependencies.acquireInitialAbortClaim(userId, assetId);

    // Find session if any
    const sessionRecord = await dependencies.findUploadSessionRecord(assetId);

    if (asset.status === UploadStatus.UPLOADING && !sessionRecord) {
      // Safe release on pre-provider failure
      await dependencies.releaseFinalizationClaim(claim, 'PRE_PROVIDER_FAILURE');
      throw new NotFoundError('Upload session not found for asset in UPLOADING status.');
    }

    if (sessionRecord) {
      let session;
      try {
        session = await dependencies.getDecryptedSession(userId, assetId);
      } catch (err) {
        // Safe release on pre-provider failure
        await dependencies.releaseFinalizationClaim(claim, 'PRE_PROVIDER_FAILURE');
        throw err;
      }

      try {
        if (!claim.providerCallAllowed) {
          throw new Error('Claim does not authorize provider abort call.');
        }

        const adapter = dependencies.getStorageAdapter();
        await adapter.abortMultipartUpload(
          asset.bucket,
          asset.objectKey,
          session.providerSessionId
        );
      } catch (err) {
        // Provider failures retain the claim
        throw err;
      }
    }

    // Complete transitions and cleanup
    const result = await dependencies.transaction(async (tx) => {
      // Transition from current state (REQUESTED or UPLOADING) to ABORTED
      await dependencies.transitionStateTx(
        tx,
        claim,
        asset.status,
        UploadStatus.ABORTED
      );

      // Invalidate session secrets
      await dependencies.deleteUploadSessionTx(tx, assetId);

      // Clear lease
      await dependencies.clearFinalizationClaimAfterSuccessTx(tx, claim);

      return await dependencies.findUploadAsset(assetId);
    });

    return serializeBigInt(result);
  }
}
