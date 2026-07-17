import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { UploadStatus, Prisma } from '@prisma/client';
import { prisma } from '../prisma-client';
import { getStorageConfig } from './index';
import { MediaProbe, MediaMetadata, MediaValidationError } from './media-probe';
import { FfprobeMediaProbe } from './ffprobe-media-probe';
import { prepareValidationSource } from './validation-source-resolver';
import { NotFoundError, InvalidStateTransitionError } from './upload-session-encryption';

export interface ValidationClaim {
  assetId: string;
  userId: string;
  lockToken: string;
  lockedAt: Date;
  lockExpiresAt: Date;
}

export interface ValidationResult {
  assetId: string;
  success: boolean;
  status: UploadStatus;
  failureCode?: string;
  failureMessage?: string;
  durationMs?: number | null;
  width?: number | null;
  height?: number | null;
  frameRate?: number | null;
  videoCodec?: string | null;
  audioCodec?: string | null;
  containerFormat?: string | null;
  detectedMimeType?: string | null;
}

// 5 minutes lease duration for validation worker lock
export const VALIDATION_LEASE_DURATION_MS = 5 * 60 * 1000;

export class VideoValidationService {
  private static activeProbe: MediaProbe = new FfprobeMediaProbe();

  static setProbe(probe: MediaProbe) {
    this.activeProbe = probe;
  }

  static getProbe(): MediaProbe {
    return this.activeProbe;
  }

  /**
   * Scan for and atomically claim one asset in VALIDATING state
   */
  static async claimOneAsset(): Promise<ValidationClaim | null> {
    const now = new Date();

    // Query eligible VALIDATING assets (either lock is null or expired)
    const eligibleAssets = await prisma.uploadAsset.findMany({
      where: {
        status: UploadStatus.VALIDATING,
        OR: [
          { validationLockToken: null },
          { validationLockExpiresAt: { lt: now } }
        ]
      },
      orderBy: { createdAt: 'asc' },
      take: 10
    });

    for (const asset of eligibleAssets) {
      // Check attempt count before locking
      if (asset.validationAttemptCount >= asset.validationMaxAttempts) {
        // If it already exceeded max attempts but status is still VALIDATING (e.g. locked expired),
        // transition it directly to terminal failure.
        await this.handleMaxAttemptsExceeded(asset.userId, asset.id);
        continue;
      }

      const lockToken = randomUUID();
      const lockExpiresAt = new Date(Date.now() + VALIDATION_LEASE_DURATION_MS);

      const updateCount = await prisma.uploadAsset.updateMany({
        where: {
          id: asset.id,
          status: UploadStatus.VALIDATING,
          validationAttemptCount: { lt: asset.validationMaxAttempts },
          OR: [
            { validationLockToken: asset.validationLockToken },
            { validationLockExpiresAt: { lt: now } }
          ]
        },
        data: {
          validationLockToken: lockToken,
          validationLockedAt: now,
          validationLockExpiresAt: lockExpiresAt,
          validationAttemptCount: { increment: 1 },
          validationStartedAt: now
        }
      });

      if (updateCount.count === 1) {
        return {
          assetId: asset.id,
          userId: asset.userId,
          lockToken,
          lockedAt: now,
          lockExpiresAt
        };
      }
    }

    return null;
  }

  /**
   * Run validation orchestrator on a claimed asset
   */
  static async validateAsset(
    claim: ValidationClaim,
    deps?: { prepareValidationSource?: typeof prepareValidationSource }
  ): Promise<ValidationResult> {
    const asset = await prisma.uploadAsset.findUnique({
      where: { id: claim.assetId }
    });

    if (!asset) {
      throw new Error(`Asset ${claim.assetId} not found.`);
    }

    const tempFileName = `val-${randomUUID()}.tmp`;
    const tempFilePath = path.join(os.tmpdir(), tempFileName);

    try {
      // 1. Fetch validation source
      const prepareFn = deps?.prepareValidationSource || prepareValidationSource;
      const source = await prepareFn(asset);
      if (!source) {
        return await this.transitionToFailure(claim, 'OBJECT_MISSING', 'The uploaded file does not exist in persistent storage.');
      }

      const meta = source.metadata;

      // 2. Validate object size
      if (asset.actualSize !== null && meta.size !== Number(asset.actualSize)) {
        return await this.transitionToFailure(claim, 'SIZE_MISMATCH', 'The uploaded file size does not match finalization size.');
      }

      const config = getStorageConfig();
      const maxLimit = config.r2.uploadMaxBytes;

      if (meta.size > maxLimit) {
        return await this.transitionToFailure(claim, 'SIZE_LIMIT_EXCEEDED', `File size exceeds the maximum limit of ${maxLimit} bytes.`);
      }

      // 3. Download the file locally to temp path with byte counter and bounds protection
      const readStream = await source.createReadStream();
      const writeStream = fs.createWriteStream(tempFilePath);

      let downloadedBytes = 0;
      const targetSize = asset.actualSize !== null ? Number(asset.actualSize) : (asset.expectedSize !== null ? Number(asset.expectedSize) : null);

      const downloadPromise = new Promise<void>((resolve, reject) => {
        let isAborted = false;

        readStream.on('data', (chunk: Buffer) => {
          downloadedBytes += chunk.length;

          if (downloadedBytes > maxLimit) {
            isAborted = true;
            readStream.destroy(new Error('DOWNLOAD_MAX_LIMIT_EXCEEDED'));
            writeStream.destroy(new Error('DOWNLOAD_MAX_LIMIT_EXCEEDED'));
            return;
          }

          if (targetSize !== null && downloadedBytes > targetSize) {
            isAborted = true;
            readStream.destroy(new Error('DOWNLOAD_EXPECTED_SIZE_EXCEEDED'));
            writeStream.destroy(new Error('DOWNLOAD_EXPECTED_SIZE_EXCEEDED'));
            return;
          }
        });

        writeStream.on('finish', () => {
          if (!isAborted) {
            resolve();
          }
        });

        readStream.on('error', (err) => {
          reject(err);
        });

        writeStream.on('error', (err) => {
          reject(err);
        });

        readStream.pipe(writeStream);
      });

      try {
        await downloadPromise;
      } catch (err: unknown) {
        const errorObj = err instanceof Error ? err : new Error(String(err));
        if (errorObj.message === 'DOWNLOAD_MAX_LIMIT_EXCEEDED') {
          return await this.transitionToFailure(claim, 'SIZE_LIMIT_EXCEEDED', 'File size exceeds the maximum allowed limit during download.');
        }
        if (errorObj.message === 'DOWNLOAD_EXPECTED_SIZE_EXCEEDED') {
          return await this.transitionToFailure(claim, 'SIZE_MISMATCH', 'Downloaded content size exceeds the expected size of the asset.');
        }
        throw errorObj;
      }

      if (targetSize !== null && downloadedBytes !== targetSize) {
        return await this.transitionToFailure(claim, 'SIZE_MISMATCH', `Downloaded content size (${downloadedBytes} bytes) does not match the expected size (${targetSize} bytes).`);
      }

      // 4. Run probe
      const metadata = await this.activeProbe.probe(tempFilePath);

      // 5. Evaluate validation rules
      const formats = metadata.containerFormat.toLowerCase().split(',');
      const isMp4OrMov = formats.some(f => {
        const trimmed = f.trim();
        return trimmed === 'mp4' || trimmed === 'mov' || trimmed === 'quicktime' || trimmed === 'qt';
      });

      if (!isMp4OrMov) {
        return await this.transitionToFailure(claim, 'INVALID_CONTAINER', 'Container format must be MP4 or MOV.');
      }

      const videoCodecLower = metadata.videoCodec.toLowerCase();
      if (!videoCodecLower.includes('h264') && !videoCodecLower.includes('h.264') && !videoCodecLower.includes('avc')) {
        return await this.transitionToFailure(claim, 'INVALID_VIDEO_CODEC', 'Video codec must be H.264.');
      }

      if (metadata.audioCodec !== null) {
        const audioCodecLower = metadata.audioCodec.toLowerCase();
        if (!audioCodecLower.includes('aac')) {
          return await this.transitionToFailure(claim, 'INVALID_AUDIO_CODEC', 'Audio codec must be AAC.');
        }
      }

      if (metadata.durationMs <= 0) {
        return await this.transitionToFailure(claim, 'INVALID_DURATION', 'Video duration must be greater than zero.');
      }

      if (metadata.durationMs > 10 * 60 * 1000) {
        return await this.transitionToFailure(claim, 'DURATION_EXCEEDED', 'Video duration must not exceed 10 minutes.');
      }

      if (metadata.width <= 0 || metadata.height <= 0) {
        return await this.transitionToFailure(claim, 'INVALID_DIMENSIONS', 'Width and height must be positive.');
      }

      if (metadata.frameRate <= 0) {
        return await this.transitionToFailure(claim, 'INVALID_FRAMERATE', 'Frame rate must be positive.');
      }

      // 6. Transition to success
      return await this.transitionToSuccess(claim, metadata);
    } catch (err: unknown) {
      // Clean up temp file
      await this.safeUnlink(tempFilePath);

      const errorObj = err instanceof Error ? err : new Error(String(err));

      if (errorObj instanceof MediaValidationError) {
        return await this.transitionToFailure(claim, errorObj.code, errorObj.message);
      }

      if (errorObj.message === 'FFPROBE_NOT_FOUND') {
        console.error('Operational Configuration Error: ffprobe executable was not found. Please configure FFPROBE_PATH in your environment.');
      }

      // If it's a known validation failure or transition error, propagate it
      if (errorObj.name === 'ValidationTransitionError') {
        throw errorObj;
      }

      // Ambiguous infrastructure/probing error: handle retry recovery
      return await this.handleTransientFailure(claim);
    } finally {
      // Always cleanup temp file on exit
      await this.safeUnlink(tempFilePath);
    }
  }

  /**
   * Top-level callable worker function
   */
  static async validateOneAsset(): Promise<ValidationResult | null> {
    const claim = await this.claimOneAsset();
    if (!claim) {
      return null;
    }
    return await this.validateAsset(claim);
  }

  /**
   * Run validation on a specific asset by ID, verifying ownership and idempotency
   */
  static async validateAssetById(
    userId: string,
    assetId: string,
    deps?: {
      validateAsset?: typeof VideoValidationService.validateAsset;
      prepareValidationSource?: typeof prepareValidationSource;
    }
  ): Promise<ValidationResult> {
    const now = new Date();
    const asset = await prisma.uploadAsset.findUnique({
      where: { id: assetId }
    });

    if (!asset || asset.userId !== userId) {
      throw new NotFoundError('Upload asset not found.');
    }

    if (asset.status === UploadStatus.VALIDATED) {
      return {
        assetId,
        success: true,
        status: UploadStatus.VALIDATED,
        durationMs: asset.durationMs !== null ? Number(asset.durationMs) : null,
        width: asset.width,
        height: asset.height,
        frameRate: asset.frameRate !== null ? Number(asset.frameRate) : null,
        videoCodec: asset.videoCodec,
        audioCodec: asset.audioCodec,
        containerFormat: asset.containerFormat,
        detectedMimeType: asset.detectedMimeType,
      };
    }

    if (asset.status !== UploadStatus.VALIDATING) {
      throw new InvalidStateTransitionError('Upload is not in VALIDATING state.');
    }

    // Check if it already exceeded max attempts
    if (asset.validationAttemptCount >= asset.validationMaxAttempts) {
      await this.handleMaxAttemptsExceeded(asset.userId, asset.id);
      return {
        assetId,
        success: false,
        status: UploadStatus.FAILED,
        failureCode: 'VALIDATION_MAX_ATTEMPTS_EXCEEDED',
        failureMessage: 'Validation failed: Maximum retry attempts exceeded.'
      };
    }

    if (asset.validationLockToken !== null && asset.validationLockExpiresAt !== null && asset.validationLockExpiresAt >= now) {
      return {
        assetId,
        success: false,
        status: UploadStatus.VALIDATING,
      };
    }

    // Try to atomically claim the validation lock for this specific asset
    const lockToken = randomUUID();
    const lockExpiresAt = new Date(Date.now() + VALIDATION_LEASE_DURATION_MS);

    const updateCount = await prisma.uploadAsset.updateMany({
      where: {
        id: assetId,
        userId,
        status: UploadStatus.VALIDATING,
        validationAttemptCount: { lt: asset.validationMaxAttempts },
        OR: [
          { validationLockToken: null },
          { validationLockExpiresAt: { lt: now } }
        ]
      },
      data: {
        validationLockToken: lockToken,
        validationLockedAt: now,
        validationLockExpiresAt: lockExpiresAt,
        validationAttemptCount: { increment: 1 },
        validationStartedAt: now
      }
    });

    if (updateCount.count === 0) {
      // Lock is currently held by another worker/process. Prevent concurrent duplicate validation.
      return {
        assetId,
        success: false,
        status: UploadStatus.VALIDATING,
      };
    }

    const claim: ValidationClaim = {
      assetId,
      userId,
      lockToken,
      lockedAt: now,
      lockExpiresAt
    };

    if (deps?.validateAsset) {
      return await deps.validateAsset(claim, { prepareValidationSource: deps?.prepareValidationSource });
    }
    return await VideoValidationService.validateAsset(claim, { prepareValidationSource: deps?.prepareValidationSource });
  }

  private static async transitionToSuccess(claim: ValidationClaim, meta: MediaMetadata): Promise<ValidationResult> {
    const now = new Date();
    const retentionUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30-day policy

    await prisma.$transaction(async (tx) => {
      const updateCount = await tx.uploadAsset.updateMany({
        where: {
          id: claim.assetId,
          userId: claim.userId,
          status: UploadStatus.VALIDATING,
          validationLockToken: claim.lockToken,
          validationLockExpiresAt: { gt: now }
        },
        data: {
          status: UploadStatus.VALIDATED,
          validatedAt: now,
          retentionUntil,
          durationMs: meta.durationMs,
          containerFormat: meta.containerFormat,
          videoCodec: meta.videoCodec,
          audioCodec: meta.audioCodec,
          width: meta.width,
          height: meta.height,
          frameRate: meta.frameRate,
          detectedMimeType: meta.detectedMimeType,
          // Clear lease locks on success
          validationLockToken: null,
          validationLockedAt: null,
          validationLockExpiresAt: null
        }
      });

      if (updateCount.count === 0) {
        throw new ValidationTransitionError('Validation success transition failed: Fencing lock mismatch or expired.');
      }

      await tx.auditLog.create({
        data: {
          action: 'UPLOAD_VALIDATION_SUCCESS',
          details: `Successfully validated asset ${claim.assetId}. Format: ${meta.containerFormat}, Video: ${meta.videoCodec}, Audio: ${meta.audioCodec || 'none'}, Duration: ${meta.durationMs}ms, Size: ${meta.width}x${meta.height}.`,
          userId: claim.userId
        }
      });

      return await tx.uploadAsset.findUnique({
        where: { id: claim.assetId }
      });
    });

    return {
      assetId: claim.assetId,
      success: true,
      status: UploadStatus.VALIDATED,
      durationMs: meta.durationMs,
      width: meta.width,
      height: meta.height,
      frameRate: meta.frameRate,
      videoCodec: meta.videoCodec,
      audioCodec: meta.audioCodec,
      containerFormat: meta.containerFormat,
      detectedMimeType: meta.detectedMimeType,
    };
  }

  private static async transitionToFailure(claim: ValidationClaim, failureCode: string, failureMessage: string): Promise<ValidationResult> {
    console.error('[Validation Error]', {
      classification: 'VALIDATION_FAILED',
      assetId: claim.assetId,
      userId: claim.userId,
      failureCode,
    });
    const now = new Date();
    const retentionUntil = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24-hour policy

    await prisma.$transaction(async (tx) => {
      const updateCount = await tx.uploadAsset.updateMany({
        where: {
          id: claim.assetId,
          userId: claim.userId,
          status: UploadStatus.VALIDATING,
          validationLockToken: claim.lockToken,
          validationLockExpiresAt: { gt: now }
        },
        data: {
          status: UploadStatus.FAILED,
          retentionUntil,
          failureCode,
          failureMessage,
          // Clear lease locks on failure
          validationLockToken: null,
          validationLockedAt: null,
          validationLockExpiresAt: null
        }
      });

      if (updateCount.count === 0) {
        throw new ValidationTransitionError('Validation failure transition failed: Fencing lock mismatch or expired.');
      }

      await tx.auditLog.create({
        data: {
          action: 'UPLOAD_VALIDATION_FAILED',
          details: `Validation failed for asset ${claim.assetId} with code: ${failureCode}. Message: ${failureMessage}`,
          userId: claim.userId
        }
      });

      return await tx.uploadAsset.findUnique({
        where: { id: claim.assetId }
      });
    });

    return {
      assetId: claim.assetId,
      success: false,
      status: UploadStatus.FAILED,
      failureCode,
      failureMessage
    };
  }

  static async releaseValidationLeaseForRetryTx(
    tx: Prisma.TransactionClient,
    claim: ValidationClaim
  ): Promise<void> {
    const now = new Date();
    const updateCount = await tx.uploadAsset.updateMany({
      where: {
        id: claim.assetId,
        validationLockToken: claim.lockToken,
        validationLockExpiresAt: { gt: now },
        status: UploadStatus.VALIDATING
      },
      data: {
        validationLockToken: null,
        validationLockedAt: null,
        validationLockExpiresAt: null
      }
    });

    if (updateCount.count === 0) {
      throw new ValidationTransitionError('Failed to release validation lease: Fencing lock mismatch or expired.');
    }
  }

  static async releaseValidationLeaseForRetry(
    claim: ValidationClaim,
    safeMessage: string
  ): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await this.releaseValidationLeaseForRetryTx(tx, claim);

      await tx.auditLog.create({
        data: {
          action: 'UPLOAD_VALIDATION_LEASE_RELEASED',
          details: `Validation lease released for retry on asset ${claim.assetId}. Reason: ${safeMessage}`,
          userId: claim.userId
        }
      });
    });
  }

  private static async handleTransientFailure(claim: ValidationClaim): Promise<ValidationResult> {
    const now = new Date();
    const asset = await prisma.uploadAsset.findUnique({
      where: { id: claim.assetId }
    });

    if (!asset) {
      throw new Error(`Asset ${claim.assetId} not found.`);
    }

    const safeErrorMessage = 'Transient infrastructure failure occurred during validation probing or storage access.';
    console.error('[Validation Error]', {
      classification: 'VALIDATION_TRANSIENT_FAILURE',
      assetId: claim.assetId,
      userId: claim.userId,
    });

    if (asset.validationAttemptCount >= asset.validationMaxAttempts) {
      // Terminal Failure due to max retries
      const failureCode = 'VALIDATION_MAX_ATTEMPTS_EXCEEDED';
      const failureMessage = `Validation failed: Maximum retry attempts exceeded. Last error: ${safeErrorMessage}`;
      const retentionUntil = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

      await prisma.$transaction(async (tx) => {
        const updateCount = await tx.uploadAsset.updateMany({
          where: {
            id: claim.assetId,
            validationLockToken: claim.lockToken,
            validationLockExpiresAt: { gt: now },
            status: UploadStatus.VALIDATING
          },
          data: {
            status: UploadStatus.FAILED,
            failureCode,
            failureMessage,
            retentionUntil,
            validationLockToken: null,
            validationLockedAt: null,
            validationLockExpiresAt: null
          }
        });

        if (updateCount.count === 0) {
          throw new ValidationTransitionError('Transient terminal failure transition failed: Fencing lock mismatch or expired.');
        }

        await tx.auditLog.create({
          data: {
            action: 'UPLOAD_VALIDATION_RETRY_EXHAUSTED',
            details: `Validation retries exhausted for asset ${claim.assetId}. Last error details: ${safeErrorMessage}`,
            userId: claim.userId
          }
        });
      });

      return {
        assetId: claim.assetId,
        success: false,
        status: UploadStatus.FAILED,
        failureCode,
        failureMessage
      };
    } else {
      // Recovery Retry: keep status VALIDATING, release lease for reclaiming
      await this.releaseValidationLeaseForRetry(claim, safeErrorMessage);

      return {
        assetId: claim.assetId,
        success: false,
        status: UploadStatus.VALIDATING,
        failureCode: 'TRANSIENT_INFRASTRUCTURE_FAILURE',
        failureMessage: safeErrorMessage
      };
    }
  }
  private static async handleMaxAttemptsExceeded(userId: string, assetId: string): Promise<void> {
    const retentionUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await prisma.$transaction(async (tx) => {
      await tx.uploadAsset.updateMany({
        where: {
          id: assetId,
          status: UploadStatus.VALIDATING
        },
        data: {
          status: UploadStatus.FAILED,
          failureCode: 'VALIDATION_MAX_ATTEMPTS_EXCEEDED',
          failureMessage: 'Validation failed: Maximum retry attempts exceeded.',
          retentionUntil,
          validationLockToken: null,
          validationLockedAt: null,
          validationLockExpiresAt: null
        }
      });

      await tx.auditLog.create({
        data: {
          action: 'UPLOAD_VALIDATION_RETRY_EXHAUSTED',
          details: `Validated retry attempts exhausted out of lease context for asset ${assetId}.`,
          userId
        }
      });
    });
  }

  private static async safeUnlink(filePath: string): Promise<void> {
    try {
      if (fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
      }
    } catch {
      // Ignore cleanup error
    }
  }
}

export class ValidationTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationTransitionError';
  }
}
