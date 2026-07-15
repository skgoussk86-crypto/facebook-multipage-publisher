import { UploadStatus, UploadFinalizationOperation } from '@prisma/client';
import { prisma } from '../prisma-client';
import { getStorageAdapter } from './index';
import { FinalizationClaimService, FinalizationOperationConflictError } from './finalization-claim-service';
import { UploadStateService, serializeBigInt } from './upload-state-service';
import { UploadSessionService } from './upload-session-service';
import {
  NotFoundError,
  ForbiddenOwnershipError,
  InvalidStateTransitionError,
  InvalidMultipartMetadataError,
} from './upload-session-encryption';
import { PART_SIZE_BYTES } from './upload-initiation-service';
import { CompletedPart } from './storage-adapter';

export class UploadFinalizationService {
  /**
   * Safe, durable orchestration to complete a multipart upload
   */
  static async completeUpload(
    userId: string,
    assetId: string,
    body: unknown
  ): Promise<unknown> {
    // 1. Validate request body layout before acquiring claim
    if (!body || typeof body !== 'object' || !('parts' in body)) {
      throw new InvalidMultipartMetadataError('Malformed payload: parts list must be an array.');
    }
    const rawParts = (body as Record<string, unknown>).parts;
    if (!Array.isArray(rawParts)) {
      throw new InvalidMultipartMetadataError('Malformed payload: parts list must be an array.');
    }
    if (rawParts.length === 0) {
      throw new InvalidMultipartMetadataError('Malformed payload: parts list cannot be empty.');
    }

    const partNumbers = new Set<number>();
    const parts: CompletedPart[] = [];
    for (const p of rawParts as unknown[]) {
      if (!p || typeof p !== 'object') {
        throw new InvalidMultipartMetadataError('Malformed payload: part item must be an object.');
      }
      const partObj = p as Record<string, unknown>;
      const { partNumber, etag } = partObj;
      if (partNumber === undefined || typeof partNumber !== 'number' || !Number.isInteger(partNumber)) {
        throw new InvalidMultipartMetadataError('Invalid partNumber: must be an integer.');
      }
      if (partNumber < 1 || partNumber > 10000) {
        throw new InvalidMultipartMetadataError(`Invalid partNumber: ${partNumber}. Must be between 1 and 10000.`);
      }
      if (typeof etag !== 'string' || !etag.trim()) {
        throw new InvalidMultipartMetadataError('ETag must be a non-empty string.');
      }
      if (partNumbers.has(partNumber)) {
        throw new InvalidMultipartMetadataError(`Duplicate part number detected: ${partNumber}.`);
      }
      partNumbers.add(partNumber);
      parts.push({ partNumber, etag: etag.trim() });
    }

    // Normalize: sort ascending by part number
    parts.sort((a, b) => a.partNumber - b.partNumber);

    // 2. Retrieve asset & check ownership
    const asset = await prisma.uploadAsset.findUnique({
      where: { id: assetId },
    });

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

    // 3. Status-specific flows
    if (asset.status === UploadStatus.UPLOADED) {
      // Recovery path
      const claim = await FinalizationClaimService.acquireCompletionRecoveryClaim(userId, assetId);
      const result = await prisma.$transaction(async (tx) => {
        // Transition UPLOADED -> VALIDATING
        await UploadStateService.transitionWithFinalizationClaimTx(
          tx,
          claim,
          UploadStatus.UPLOADED,
          UploadStatus.VALIDATING
        );

        // Invalidate upload session secrets
        await tx.uploadSession.deleteMany({
          where: { uploadAssetId: assetId },
        });

        // Clear finalization claim lock
        await FinalizationClaimService.clearFinalizationClaimAfterSuccessTx(tx, claim);

        return await tx.uploadAsset.findUnique({
          where: { id: assetId },
        });
      });

      return serializeBigInt(result);
    }

    // status is UPLOADING
    // Verify client-provided parts sequence matches expected total parts count
    const expectedTotalParts = Math.ceil(Number(asset.expectedSize) / PART_SIZE_BYTES);
    if (parts.length !== expectedTotalParts) {
      throw new InvalidMultipartMetadataError(
        `Upload is incomplete: expected ${expectedTotalParts} parts, but only ${parts.length} parts were provided.`
      );
    }
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].partNumber !== i + 1) {
        throw new InvalidMultipartMetadataError(
          `Missing part: expected part number ${i + 1}, but got ${parts[i].partNumber}.`
        );
      }
    }

    // Acquire initial claim
    const claim = await FinalizationClaimService.acquireInitialCompletionClaim(userId, assetId);

    // Retrieve session and verify details
    let session;
    try {
      session = await UploadSessionService.getDecryptedSession(userId, assetId);

      // Verify request parts list matches database session parts list
      if (session.completedParts.length !== parts.length) {
        throw new InvalidMultipartMetadataError(
          'Parts list mismatch: count of completed parts does not match the recorded session.'
        );
      }
      for (let i = 0; i < parts.length; i++) {
        if (parts[i].partNumber !== session.completedParts[i].partNumber) {
          throw new InvalidMultipartMetadataError(
            `Parts list mismatch: expected part number ${session.completedParts[i].partNumber} at index ${i}, got ${parts[i].partNumber}.`
          );
        }
        if (parts[i].etag !== session.completedParts[i].etag) {
          throw new InvalidMultipartMetadataError(
            `Parts list mismatch: ETag mismatch for part number ${parts[i].partNumber}.`
          );
        }
      }
    } catch (err) {
      // Safe release on pre-provider failure
      await FinalizationClaimService.releaseFinalizationClaim(claim, 'PRE_PROVIDER_FAILURE');
      throw err;
    }

    // Call provider complete multipart upload
    try {
      if (!claim.providerCallAllowed) {
        throw new Error('Claim does not authorize provider completion call.');
      }

      const adapter = getStorageAdapter();
      const metadata = await adapter.completeMultipartUpload(
        asset.bucket,
        asset.objectKey,
        session.providerSessionId,
        parts
      );

      // Complete transitions and cleanup
      const result = await prisma.$transaction(async (tx) => {
        // Transition UPLOADING -> UPLOADED
        await UploadStateService.transitionWithFinalizationClaimTx(
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
        await UploadStateService.transitionWithFinalizationClaimTx(
          tx,
          claim,
          UploadStatus.UPLOADED,
          UploadStatus.VALIDATING
        );

        // Invalidate session secrets
        await tx.uploadSession.deleteMany({
          where: { uploadAssetId: assetId },
        });

        // Clear lease
        await FinalizationClaimService.clearFinalizationClaimAfterSuccessTx(tx, claim);

        return await tx.uploadAsset.findUnique({
          where: { id: assetId },
        });
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
    assetId: string
  ): Promise<unknown> {
    // 1. Retrieve asset & check ownership
    const asset = await prisma.uploadAsset.findUnique({
      where: { id: assetId },
    });

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
    const claim = await FinalizationClaimService.acquireInitialAbortClaim(userId, assetId);

    // Find session if any
    const sessionRecord = await prisma.uploadSession.findUnique({
      where: { uploadAssetId: assetId },
    });

    if (asset.status === UploadStatus.UPLOADING && !sessionRecord) {
      // Safe release on pre-provider failure
      await FinalizationClaimService.releaseFinalizationClaim(claim, 'PRE_PROVIDER_FAILURE');
      throw new NotFoundError('Upload session not found for asset in UPLOADING status.');
    }

    if (sessionRecord) {
      let session;
      try {
        session = await UploadSessionService.getDecryptedSession(userId, assetId);
      } catch (err) {
        // Safe release on pre-provider failure
        await FinalizationClaimService.releaseFinalizationClaim(claim, 'PRE_PROVIDER_FAILURE');
        throw err;
      }

      try {
        if (!claim.providerCallAllowed) {
          throw new Error('Claim does not authorize provider abort call.');
        }

        const adapter = getStorageAdapter();
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
    const result = await prisma.$transaction(async (tx) => {
      // Transition from current state (REQUESTED or UPLOADING) to ABORTED
      await UploadStateService.transitionWithFinalizationClaimTx(
        tx,
        claim,
        asset.status,
        UploadStatus.ABORTED
      );

      // Invalidate session secrets
      await tx.uploadSession.deleteMany({
        where: { uploadAssetId: assetId },
      });

      // Clear lease
      await FinalizationClaimService.clearFinalizationClaimAfterSuccessTx(tx, claim);

      return await tx.uploadAsset.findUnique({
        where: { id: assetId },
      });
    });

    return serializeBigInt(result);
  }
}
