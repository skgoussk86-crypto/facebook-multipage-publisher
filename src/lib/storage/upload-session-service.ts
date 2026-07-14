import crypto from 'crypto';
import { UploadStatus } from '@prisma/client';
import { prisma } from '../prisma-client';
import { CompletedPart } from './storage-adapter';
import {
  encryptUploadSecret,
  decryptUploadSecret,
  NotFoundError,
  ForbiddenOwnershipError,
  ExpiredSessionError,
  IdempotencyConflictError,
  InvalidMultipartMetadataError,
} from './upload-session-encryption';
import { serializeBigInt } from './upload-state-service';

export interface DecryptedUploadSession {
  uploadAssetId: string;
  providerSessionId: string;
  completedParts: CompletedPart[];
  expiresAt: Date;
  lastActivityAt: Date;
}

export class UploadSessionService {
  /**
   * Helper to canonicalize metadata and generate lowercase SHA-256 fingerprint for idempotency
   */
  static generateRequestFingerprint(originalName: string, expectedSize: bigint, declaredMimeType: string): string {
    const canonical = `${originalName.trim().toLowerCase()}:${expectedSize.toString()}:${declaredMimeType.trim().toLowerCase()}`;
    return crypto.createHash('sha256').update(canonical).digest('hex').toLowerCase();
  }

  /**
   * Safe, idempotent initiation of an UploadAsset & UploadSession
   */
  static async initiateUpload(
    userId: string,
    data: {
      idempotencyKey: string;
      originalName: string;
      expectedSize: bigint;
      declaredMimeType: string;
      bucket: string;
      objectKey: string;
      providerSessionId: string;
      uploadExpiresAt: Date;
    }
  ): Promise<unknown> {
    const requestFingerprint = this.generateRequestFingerprint(
      data.originalName,
      data.expectedSize,
      data.declaredMimeType
    );

    try {
      const result = await prisma.$transaction(async (tx) => {
        // 1. Check existing asset with same idempotency key
        const existing = await tx.uploadAsset.findUnique({
          where: {
            userId_idempotencyKey: {
              userId,
              idempotencyKey: data.idempotencyKey,
            },
          },
        });

        if (existing) {
          // Compare fingerprint
          if (existing.requestFingerprint !== requestFingerprint) {
            throw new IdempotencyConflictError(
              'An upload asset with this idempotency key already exists with different request parameters.'
            );
          }
          return { asset: existing, idempotentReplay: true };
        }

        // 2. Create the asset in REQUESTED status
        const newAsset = await tx.uploadAsset.create({
          data: {
            userId,
            idempotencyKey: data.idempotencyKey,
            requestFingerprint,
            provider: 'R2',
            bucket: data.bucket,
            objectKey: data.objectKey,
            originalName: data.originalName,
            expectedSize: data.expectedSize,
            declaredMimeType: data.declaredMimeType,
            status: UploadStatus.REQUESTED,
            uploadExpiresAt: data.uploadExpiresAt,
          },
        });

        // 3. Create the encrypted session secrets
        const currentVersion = process.env.UPLOAD_SESSION_ENCRYPTION_KEY_VERSION || '1';
        const encryptedProviderId = encryptUploadSecret(data.providerSessionId);
        const encryptedParts = encryptUploadSecret(JSON.stringify([]));

        await tx.uploadSession.create({
          data: {
            uploadAssetId: newAsset.id,
            encryptionKeyVersion: currentVersion,
            encryptedProviderSessionId: encryptedProviderId,
            encryptedCompletedParts: encryptedParts,
            expiresAt: data.uploadExpiresAt, // Align session expiry with asset upload expiry
            lastActivityAt: new Date(),
          },
        });

        // 4. Log session creation in audits
        await tx.auditLog.create({
          data: {
            action: 'UPLOAD_SESSION_CREATED',
            details: `Created upload session for asset ${newAsset.id} (key: ${data.idempotencyKey}).`,
            userId,
          },
        });

        return { asset: newAsset, idempotentReplay: false };
      });

      return {
        asset: serializeBigInt(result.asset),
        idempotentReplay: result.idempotentReplay,
      };
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'P2002') {
        const existing = await prisma.uploadAsset.findUnique({
          where: {
            userId_idempotencyKey: {
              userId,
              idempotencyKey: data.idempotencyKey,
            },
          },
        });
        if (existing) {
          if (existing.requestFingerprint !== requestFingerprint) {
            throw new IdempotencyConflictError(
              'An upload asset with this idempotency key already exists with different request parameters.'
            );
          }
          return {
            asset: serializeBigInt(existing),
            idempotentReplay: true,
          };
        }
      }
      throw err;
    }
  }

  /**
   * Retrieves and decrypts the session details, verifying ownership and active status
   */
  static async getDecryptedSession(userId: string, assetId: string): Promise<DecryptedUploadSession> {
    const asset = await prisma.uploadAsset.findUnique({
      where: { id: assetId },
    });

    if (!asset) {
      throw new NotFoundError('Upload asset not found.');
    }
    if (asset.userId !== userId) {
      throw new ForbiddenOwnershipError('Access denied: You do not own this upload asset.');
    }

    const session = await prisma.uploadSession.findUnique({
      where: { uploadAssetId: assetId },
    });

    if (!session) {
      throw new NotFoundError('Active upload session secrets not found for this asset.');
    }

    if (session.expiresAt < new Date()) {
      throw new ExpiredSessionError('Upload session has expired.');
    }

    const decryptedSessionId = decryptUploadSecret(session.encryptedProviderSessionId);
    const decryptedPartsText = decryptUploadSecret(session.encryptedCompletedParts);
    let completedParts: CompletedPart[] = [];

    try {
      completedParts = JSON.parse(decryptedPartsText);
    } catch {
      throw new Error('Malformed JSON session completed-parts metadata.');
    }

    return {
      uploadAssetId: session.uploadAssetId,
      providerSessionId: decryptedSessionId,
      completedParts,
      expiresAt: session.expiresAt,
      lastActivityAt: session.lastActivityAt,
    };
  }

  /**
   * Atomically merges, validates, and updates completed-parts metadata
   */
  static async updateCompletedParts(
    userId: string,
    assetId: string,
    partsToUpdate: CompletedPart[]
  ): Promise<DecryptedUploadSession> {
    // 1. Validate input parts to ensure strict correctness
    for (const part of partsToUpdate) {
      if (!Number.isInteger(part.partNumber) || part.partNumber < 1 || part.partNumber > 10000) {
        throw new InvalidMultipartMetadataError(`Invalid partNumber: ${part.partNumber}. Must be between 1 and 10000.`);
      }
      if (typeof part.etag !== 'string' || !part.etag.trim()) {
        throw new InvalidMultipartMetadataError('ETag must be a non-empty string.');
      }
    }

    // 2. Fetch and decrypt current session
    const decrypted = await this.getDecryptedSession(userId, assetId);

    // 3. Merge parts with duplicate replacement behavior
    const partMap = new Map<number, CompletedPart>();
    for (const p of decrypted.completedParts) {
      partMap.set(p.partNumber, p);
    }

    for (const p of partsToUpdate) {
      partMap.set(p.partNumber, {
        partNumber: p.partNumber,
        etag: p.etag.trim(),
        size: p.size,
      });
    }

    // Sort deterministically by part number in ascending order
    const mergedParts = Array.from(partMap.values()).sort((a, b) => a.partNumber - b.partNumber);

    // 4. Encrypt updated secrets
    const encryptedParts = encryptUploadSecret(JSON.stringify(mergedParts));

    // 5. Update database and log audit
    const updatedSession = await prisma.$transaction(async (tx) => {
      const session = await tx.uploadSession.update({
        where: { uploadAssetId: assetId },
        data: {
          encryptedCompletedParts: encryptedParts,
          lastActivityAt: new Date(),
        },
      });

      await tx.auditLog.create({
        data: {
          action: 'UPLOAD_SESSION_UPDATED',
          details: `Updated completed parts list for upload session ${assetId}. Merged ${partsToUpdate.length} parts.`,
          userId,
        },
      });

      return session;
    });

    return {
      uploadAssetId: updatedSession.uploadAssetId,
      providerSessionId: decrypted.providerSessionId,
      completedParts: mergedParts,
      expiresAt: updatedSession.expiresAt,
      lastActivityAt: updatedSession.lastActivityAt,
    };
  }

  /**
   * Explicitly invalidates and deletes the temporary session secrets
   */
  static async invalidateUploadSession(userId: string, assetId: string): Promise<void> {
    const asset = await prisma.uploadAsset.findUnique({
      where: { id: assetId },
    });

    if (!asset) {
      throw new NotFoundError('Upload asset not found.');
    }
    if (asset.userId !== userId) {
      throw new ForbiddenOwnershipError('Access denied: You do not own this upload asset.');
    }

    await prisma.$transaction(async (tx) => {
      await tx.uploadSession.deleteMany({
        where: { uploadAssetId: assetId },
      });

      await tx.auditLog.create({
        data: {
          action: 'UPLOAD_SESSION_INVALIDATED',
          details: `Invalidated and deleted secrets for upload session ${assetId}.`,
          userId,
        },
      });
    });
  }

  /**
   * Expires stale sessions atomically, transitioning their statuses to EXPIRED
   */
  static async expireStaleSessions(): Promise<number> {
    const now = new Date();

    const staleSessions = await prisma.uploadSession.findMany({
      where: {
        expiresAt: { lt: now },
      },
    });

    let expiredCount = 0;

    for (const session of staleSessions) {
      try {
        await prisma.$transaction(async (tx) => {
          // Atomically update corresponding assets if status is REQUESTED or UPLOADING
          const updateCount = await tx.uploadAsset.updateMany({
            where: {
              id: session.uploadAssetId,
              status: {
                in: [UploadStatus.REQUESTED, UploadStatus.UPLOADING],
              },
            },
            data: {
              status: UploadStatus.EXPIRED,
            },
          });

          // Delete session secrets
          await tx.uploadSession.delete({
            where: { uploadAssetId: session.uploadAssetId },
          });

          if (updateCount.count > 0) {
            expiredCount++;
            await tx.auditLog.create({
              data: {
                action: 'UPLOAD_SESSION_EXPIRED',
                details: `Upload session ${session.uploadAssetId} expired. Asset status set to EXPIRED. Secrets deleted.`,
              },
            });
          }
        });
      } catch (err) {
        console.error(`Failed to process expiry for session ${session.uploadAssetId}:`, err);
      }
    }

    return expiredCount;
  }
}
