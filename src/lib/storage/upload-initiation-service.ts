import { UploadStatus } from '@prisma/client';
import { prisma } from '../prisma-client';
import { getStorageConfig } from './storage-config';
import { getStorageAdapter } from './index';
import {
  encryptUploadSecret,
  IdempotencyConflictError,
} from './upload-session-encryption';
import {
  serializeBigInt,
} from './upload-state-service';
import {
  UploadSessionService,
} from './upload-session-service';
import { getSupportedMediaDescriptor } from '../uploads/media-file-types';

export const PART_SIZE_BYTES = 10 * 1024 * 1024; // Fixed 10 MiB part size
export const MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024; // Max 500 MiB size

export function isValidFilename(name: string): boolean {
  if (!name || name.trim().length === 0) return false;
  if (name.length > 255) return false;
  // Reject control characters (0x00 - 0x1F, 0x7F) and path traversal
  if (/[\x00-\x1F\x7F\\/\0]/.test(name)) return false;
  if (name.includes('..')) return false;
  // Allow letters, numbers, spaces, dots, dashes, underscores
  // The storage object key is sanitized separately. Accept normal display filenames
  // such as "ChatGPT Image Jul 30, 2026, 08_50_28 PM (1).png" after
  // rejecting control characters, path separators, and traversal above.
  return true;
}

export function sanitizeFilename(name: string): string {
  const clean = name.replace(/[^a-zA-Z0-9_\-\.]/g, '_').toLowerCase();
  return `${Date.now()}_${clean}`;
}

export class UploadInitiationService {
  static async initiateFlow(
    userId: string,
    data: {
      idempotencyKey: string;
      originalName: string;
      expectedSize: bigint;
      declaredMimeType: string;
    }
  ): Promise<{ asset: unknown; idempotentReplay: boolean }> {
    // 1. Validation Checks
    if (!data.idempotencyKey || data.idempotencyKey.trim().length === 0 || data.idempotencyKey.length > 128) {
      throw new Error('INVALID_IDEMPOTENCY_KEY');
    }

    if (!isValidFilename(data.originalName)) {
      throw new Error('INVALID_FILENAME');
    }

    if (data.expectedSize <= BigInt(0) || data.expectedSize > BigInt(MAX_FILE_SIZE_BYTES)) {
      throw new Error('FILE_TOO_LARGE');
    }

    const mime = data.declaredMimeType.trim().toLowerCase();
    const mediaDescriptor = getSupportedMediaDescriptor(data.originalName, mime);
    if (!mediaDescriptor) {
      const byExtension = getSupportedMediaDescriptor(data.originalName);
      throw new Error(byExtension ? 'MIME_MISMATCH' : 'UNSUPPORTED_MEDIA_TYPE');
    }

    const totalParts = Math.ceil(Number(data.expectedSize) / PART_SIZE_BYTES);
    if (totalParts < 1 || totalParts > 10000) {
      throw new Error('INVALID_PART_COUNT');
    }

    // Generate request fingerprint
    const requestFingerprint = UploadSessionService.generateRequestFingerprint(
      data.originalName,
      data.expectedSize,
      data.declaredMimeType
    );

    // 2. Idempotency Check
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
      await prisma.auditLog.create({
        data: {
          action: 'UPLOAD_INITIATION_REPLAYED',
          details: `Idempotent upload initiation replayed for asset ${existing.id}.`,
          userId,
        },
      });
      return { asset: serializeBigInt(existing), idempotentReplay: true };
    }

    // 3. Setup R2 variables
    const sanitized = sanitizeFilename(data.originalName);
    const objectKey = `uploads/${userId}/${sanitized}`;
    const config = getStorageConfig();
    const bucket = config.r2.bucketName;

    let newAsset;
    try {
      // Create the UploadAsset record in REQUESTED status
      newAsset = await prisma.uploadAsset.create({
        data: {
          userId,
          idempotencyKey: data.idempotencyKey,
          requestFingerprint,
          provider: 'R2',
          bucket,
          objectKey,
          originalName: data.originalName,
          expectedSize: data.expectedSize,
          declaredMimeType: data.declaredMimeType,
          status: UploadStatus.REQUESTED,
          uploadExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours expiry
        },
      });
    } catch (err: unknown) {
      // Handle concurrent inserts race condition safely
      if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'P2002') {
        const raceExisting = await prisma.uploadAsset.findUnique({
          where: {
            userId_idempotencyKey: {
              userId,
              idempotencyKey: data.idempotencyKey,
            },
          },
        });
        if (raceExisting) {
          if (raceExisting.requestFingerprint !== requestFingerprint) {
            throw new IdempotencyConflictError(
              'An upload asset with this idempotency key already exists with different request parameters.'
            );
          }
          await prisma.auditLog.create({
            data: {
              action: 'UPLOAD_INITIATION_REPLAYED',
              details: `Idempotent upload initiation replayed for asset ${raceExisting.id} after concurrent race.`,
              userId,
            },
          });
          return { asset: serializeBigInt(raceExisting), idempotentReplay: true };
        }
      }
      throw err;
    }

    // 4. Initiate multipart upload on provider
    let providerSessionId: string;
    try {
      const adapter = getStorageAdapter();
      providerSessionId = await adapter.createMultipartUpload(bucket, objectKey, data.declaredMimeType);
    } catch (s3Err: unknown) {
      // Transition asset to FAILED safely
      await prisma.uploadAsset.update({
        where: { id: newAsset.id },
        data: {
          status: UploadStatus.FAILED,
          failureCode: 'PROVIDER_INITIATION_FAILED',
          failureMessage: s3Err instanceof Error ? s3Err.message : 'Multipart upload initiation failed on provider.',
        },
      });
      await prisma.auditLog.create({
        data: {
          action: 'UPLOAD_STATUS_CHANGED',
          details: `Transitioned upload asset ${newAsset.id} to FAILED due to provider initiation failure.`,
          userId,
        },
      });
      throw s3Err;
    }

    // 5. Create session secrets and transition to UPLOADING status in a transaction
    const currentVersion = process.env.UPLOAD_SESSION_ENCRYPTION_KEY_VERSION || '1';
    const encryptedProviderId = encryptUploadSecret(providerSessionId);
    const encryptedParts = encryptUploadSecret(JSON.stringify([]));

    const updatedAsset = await prisma.$transaction(async (tx) => {
      await tx.uploadSession.create({
        data: {
          uploadAssetId: newAsset.id,
          encryptionKeyVersion: currentVersion,
          encryptedProviderSessionId: encryptedProviderId,
          encryptedCompletedParts: encryptedParts,
          expiresAt: newAsset.uploadExpiresAt,
          lastActivityAt: new Date(),
        },
      });

      await tx.uploadAsset.update({
        where: { id: newAsset.id },
        data: {
          status: UploadStatus.UPLOADING,
        },
      });

      await tx.auditLog.create({
        data: {
          action: 'UPLOAD_INITIATED',
          details: `Initiated upload asset ${newAsset.id} and session secrets. Status set to UPLOADING.`,
          userId,
        },
      });

      return await tx.uploadAsset.findUnique({
        where: { id: newAsset.id },
      });
    });

    return {
      asset: serializeBigInt(updatedAsset),
      idempotentReplay: false,
    };
  }
}
