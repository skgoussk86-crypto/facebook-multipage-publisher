import { prisma } from './prisma-client';
import {
  JobStatus,
  FailureClassification,
  MockScenario,
  VideoJob
} from '@prisma/client';
import {
  claimScheduledJob,
  claimMetaProcessingJob,
  transitionJobState,
  recoverExpiredLease
} from './job-state-machine';
import { randomUUID } from 'crypto';
import { Readable } from 'stream';

// Generates a unique UUID token for the worker execution run
export function generateWorkerToken(): string {
  return randomUUID();
}

class StreamAccumulator {
  private stream: Readable;
  private buffer: Buffer = Buffer.alloc(0);
  private done: boolean = false;
  private iterator: AsyncIterator<unknown>;

  constructor(stream: Readable) {
    this.stream = stream;
    this.iterator = stream[Symbol.asyncIterator]();
  }

  async readBytes(bytesNeeded: number): Promise<Buffer | null> {
    if (this.buffer.length >= bytesNeeded) {
      const chunk = this.buffer.subarray(0, bytesNeeded);
      this.buffer = this.buffer.subarray(bytesNeeded);
      return chunk;
    }

    while (!this.done && this.buffer.length < bytesNeeded) {
      try {
        const { value, done } = await this.iterator.next();
        if (done) {
          this.done = true;
          break;
        }
        if (value) {
          const chunkBuf = typeof value === 'string' ? Buffer.from(value) : (value as Buffer);
          this.buffer = Buffer.concat([this.buffer, chunkBuf]);
        }
      } catch (err) {
        this.done = true;
        throw err;
      }
    }

    if (this.buffer.length === 0) {
      return null;
    }

    const actualBytes = Math.min(this.buffer.length, bytesNeeded);
    const chunk = this.buffer.subarray(0, actualBytes);
    this.buffer = this.buffer.subarray(actualBytes);
    return chunk;
  }
}

function classifyFailure(checkResult: {
  status: 'ready' | 'processing' | 'error';
  errorMsg?: string;
  errorDetails?: {
    code?: number;
    subcode?: number;
    message?: string;
    phase?: 'uploading' | 'processing' | 'publishing' | 'unknown';
  };
}): {
  classification: FailureClassification;
  code: string;
} {
  let classification: FailureClassification = FailureClassification.UNKNOWN_ERROR;
  let code = 'META_TRANSCODE_FAILED';

  if (checkResult.errorDetails) {
    const { phase, code: errCode, message } = checkResult.errorDetails;
    if (phase === 'processing') {
      classification = FailureClassification.INVALID_MEDIA;
      code = 'META_TRANSCODE_FAILED';
    } else if (phase === 'publishing') {
      classification = FailureClassification.UNKNOWN_ERROR;
      code = 'META_PUBLISH_FAILED';
    } else if (phase === 'uploading') {
      classification = FailureClassification.NETWORK_ERROR;
      code = 'META_UPLOAD_FAILED';
    }

    const msgUpper = (message || '').toUpperCase();
    if (msgUpper.includes('OAUTH') || msgUpper.includes('TOKEN') || msgUpper.includes('AUTHENTICAT') || errCode === 190) {
      classification = FailureClassification.REVOKED_TOKEN;
      code = 'REVOKED_TOKEN';
    } else if (msgUpper.includes('PERMISSION') || errCode === 10 || errCode === 200 || errCode === 283) {
      classification = FailureClassification.MISSING_PERMISSION;
      code = 'MISSING_PERMISSION';
    }
  }

  return { classification, code };
}

/**
 * Runs the queue worker: recovers expired leases, claims due jobs, processes them, and returns execution logs.
 */
export async function runQueueWorker(
  workerUuid: string,
  forceJobId?: string
): Promise<string[]> {
  const logs: string[] = [];
  const log = (msg: string) => {
    logs.push(`[Worker ${workerUuid.slice(0, 8)}] ${msg}`);
  };

  log('Scanning for expired job leases to recover...');
  const expiredJobs = await prisma.videoJob.findMany({
    where: {
      lockExpiresAt: { lt: new Date() }
    }
  });

  for (const job of expiredJobs) {
    log(`Recovering expired lease on Job "${job.englishTitle}" (${job.id}) in state ${job.status}`);
    try {
      await prisma.$transaction(async (tx) => {
        await recoverExpiredLease(tx, job.id);
      });
      log(`Success: lease recovered for Job ${job.id}`);
    } catch (e) {
      log(`Error recovering lease for Job ${job.id}: ${String(e)}`);
    }
  }

  log('Scanning for eligible jobs...');
  const now = new Date();

  // Load eligible scheduled/retryable jobs
  const eligibleScheduled = await prisma.videoJob.findMany({
    where: {
      status: JobStatus.SCHEDULED,
      scheduledTimeUTC: { lte: now },
      OR: [
        { lockExpiresAt: null },
        { lockExpiresAt: { lt: now } }
      ]
    },
    orderBy: { scheduledTimeUTC: 'asc' }
  });

  // Filter candidates using job.attemptCount < job.maxAttempts
  const candidates = eligibleScheduled.filter(job => job.attemptCount < job.maxAttempts);

  // Filter if we target a specific forceJobId
  const scheduledQueue = forceJobId 
    ? candidates.filter(j => j.id === forceJobId)
    : candidates;

  for (const job of scheduledQueue) {
    log(`Attempting to claim scheduled Job "${job.englishTitle}" (${job.id})...`);
    let claimedJob: VideoJob | null = null;
    try {
      claimedJob = await prisma.$transaction(async (tx) => {
        return await claimScheduledJob(tx, job.id, workerUuid);
      });
    } catch (e) {
      log(`Failed to claim Job ${job.id}: ${String(e)}`);
    }

    if (claimedJob) {
      log(`Claimed Job ${job.id}. Starting processing run...`);
      await processClaimedJob(claimedJob, workerUuid, log);
    }
  }

  // Load eligible META_PROCESSING jobs due for status checking
  const eligibleProcessing = await prisma.videoJob.findMany({
    where: {
      status: JobStatus.META_PROCESSING,
      nextAttemptAt: { lte: now },
      OR: [
        { lockExpiresAt: null },
        { lockExpiresAt: { lt: now } }
      ]
    },
    orderBy: { updatedAt: 'asc' }
  });

  const processingQueue = forceJobId
    ? eligibleProcessing.filter(j => j.id === forceJobId)
    : eligibleProcessing;

  for (const job of processingQueue) {
    log(`Attempting to claim META_PROCESSING resume check on Job "${job.englishTitle}" (${job.id})...`);
    let claimedJob: VideoJob | null = null;
    try {
      claimedJob = await prisma.$transaction(async (tx) => {
        return await claimMetaProcessingJob(tx, job.id, workerUuid);
      });
    } catch (e) {
      log(`Failed to claim META_PROCESSING Job ${job.id}: ${String(e)}`);
    }

    if (claimedJob) {
      log(`Claimed META_PROCESSING Job ${job.id}. Resuming status check...`);
      await resumeMetaProcessingCheck(claimedJob, workerUuid, log);
    }
  }

  log('Queue scan complete.');
  return logs;
}

/**
 * Handles processing steps for a claimed job in PREPARING status.
 */
async function processClaimedJob(
  job: VideoJob,
  workerUuid: string,
  log: (msg: string) => void
): Promise<void> {
  const scenario = job.mockScenario || MockScenario.SUCCESS;
  const now = new Date();

  try {
    // 1. Reconciliation Check (duplicate-post prevention)
    if (job.providerProcessingId) {
      log(`Reconciliation active for Job ${job.id}. Checking providerProcessingId: ${job.providerProcessingId}`);

      const appConfig = await prisma.appConfiguration.findUnique({ where: { id: 'default' } });
      if (appConfig?.liveMetaMode === true) {
        const page = await prisma.facebookPage.findUnique({
          where: { id: job.pageId }
        });
        if (!page) throw new Error('FACEBOOK_PAGE_NOT_FOUND');
        const { decryptToken } = await import('./crypto');
        const pageToken = decryptToken(page.encryptedPageToken);

        const { FacebookPublishingService } = await import('./facebook/facebook-publishing-service');
        const checkResult = await FacebookPublishingService.checkVideoStatus(job.providerProcessingId, pageToken);

        if (checkResult.status === 'ready') {
          await prisma.$transaction(async (tx) => {
            await transitionJobState(tx, job.id, workerUuid, JobStatus.PUBLISHED, job.userId!, {
              completedAt: new Date(),
              metaPostId: job.providerProcessingId,
              errorLog: 'Reconciled: Video was already successfully published on Meta during worker crash.'
            });
          });
          log(`Job ${job.id} reconciled successfully as PUBLISHED.`);
          return;
        } else if (checkResult.status === 'processing') {
          await prisma.$transaction(async (tx) => {
            await transitionJobState(tx, job.id, workerUuid, JobStatus.META_PROCESSING, job.userId!, {
              nextAttemptAt: new Date(Date.now() + 10 * 1000)
            });
          });
          log(`Job ${job.id} reconciled as META_PROCESSING.`);
          return;
        } else {
          const { classification, code } = classifyFailure(checkResult);
          await prisma.$transaction(async (tx) => {
            await transitionJobState(tx, job.id, workerUuid, JobStatus.FAILED_PERMANENT, job.userId!, {
              failedAt: new Date(),
              lastErrorCode: code,
              lastErrorMessage: checkResult.errorMsg || 'Meta transcoding failed',
              failureClassification: classification
            });
          });
          return;
        }
      } else {
        await prisma.$transaction(async (tx) => {
          await transitionJobState(tx, job.id, workerUuid, JobStatus.PUBLISHED, job.userId!, {
            completedAt: new Date(),
            metaPostId: job.providerProcessingId,
            errorLog: 'Reconciled: Video was already successfully published on Meta during worker crash.'
          });
        });
        log(`Job ${job.id} reconciled successfully as PUBLISHED.`);
        return;
      }
    }

    const appConfig = await prisma.appConfiguration.findUnique({
      where: { id: 'default' }
    });
    const isLive = appConfig?.liveMetaMode === true;

    if (isLive) {
      log(`[PREPARING] Live Meta Mode active. Resolving page credentials...`);
      const page = await prisma.facebookPage.findUnique({
        where: { id: job.pageId }
      });
      if (!page) {
        throw new Error('FACEBOOK_PAGE_NOT_FOUND');
      }

      let pageToken: string;
      try {
        const { decryptToken } = await import('./crypto');
        pageToken = decryptToken(page.encryptedPageToken);
      } catch (err: unknown) {
        const error = err as Error;
        throw new Error(`DECRYPTION_ERROR: Failed to decrypt page token. ${error.message}`);
      }

      if (!pageToken || pageToken.trim() === '') {
        throw new Error('EMPTY_PAGE_TOKEN');
      }

      log(`[PREPARING] Page credentials decrypted. Retrieving asset details...`);
      if (!job.uploadAssetId) {
        throw new Error('NO_UPLOAD_ASSET_LINKED');
      }

      const asset = await prisma.uploadAsset.findUnique({
        where: { id: job.uploadAssetId }
      });

      if (!asset) {
        throw new Error('UPLOAD_ASSET_NOT_FOUND');
      }

      if (asset.status !== 'VALIDATED') {
        throw new Error(`UPLOAD_ASSET_NOT_VALIDATED: status is ${asset.status}`);
      }

      if (asset.objectDeletedAt !== null) {
        throw new Error('UPLOAD_ASSET_DELETED');
      }

      const fileSize = Number(asset.expectedSize);
      if (!fileSize || isNaN(fileSize) || fileSize <= 0) {
        throw new Error('INVALID_ASSET_SIZE');
      }

      const isReel =
        job.contentType?.toUpperCase() === 'REEL';

      log(
        `[PREPARING] Video metadata validation successful. Initializing Meta ${isReel ? 'Reel' : 'video'} upload session...`,
      );

      let uploadReference = isReel ? job.providerReference : null;
      let videoId = isReel ? job.providerProcessingId : null;
      let startOffset = 0;
      let endOffset = 0;

      const { FacebookPublishingService } =
        await import(
          './facebook/facebook-publishing-service'
        );

      if (!uploadReference || !videoId) {
        try {
          if (isReel) {
            const startResult =
              await FacebookPublishingService.startReelUploadSession(
                pageToken,
              );

            uploadReference =
              startResult.uploadUrl;
            videoId = startResult.videoId;
          } else {
            const startResult =
              await FacebookPublishingService.startUploadSession(
                page.facebookPageId,
                pageToken,
                fileSize,
              );

            uploadReference =
              startResult.uploadSessionId;
            videoId = startResult.videoId;
            startOffset = startResult.startOffset;
            endOffset = startResult.endOffset;
          }

          await prisma.$transaction(async (tx) => {
            await transitionJobState(
              tx,
              job.id,
              workerUuid,
              JobStatus.UPLOADING_TO_META,
              job.userId!,
              {
                providerReference: uploadReference,
                providerProcessingId: videoId,
              },
            );
          });

          log(
            `[UPLOADING_TO_META] Initiated ${isReel ? 'Reel' : 'video'} upload. Video ID: ${videoId}`,
          );
        } catch (err: unknown) {
          const error = err as Error;

          if (
            error.message?.includes(
              'META_AUTH_ERROR',
            ) ||
            error.message?.includes('OAuth') ||
            error.message?.includes('token')
          ) {
            await prisma.$transaction(
              async (tx) => {
                await tx.facebookPage.updateMany({
                  where: {
                    accountId: page.accountId,
                  },
                  data: {
                    isSynced: false,
                  },
                });

                await transitionJobState(
                  tx,
                  job.id,
                  workerUuid,
                  JobStatus.FACEBOOK_RECONNECT_REQUIRED,
                  job.userId!,
                  {
                    failedAt: new Date(),
                    lastErrorCode: 'REVOKED_TOKEN',
                    lastErrorMessage:
                      error.message,
                    failureClassification:
                      FailureClassification.REVOKED_TOKEN,
                  },
                );
              },
            );

            return;
          }

          throw err;
        }
      } else {
        log(
          `[UPLOADING_TO_META] Resuming existing ${isReel ? 'Reel' : 'video'} upload for Video ID: ${videoId}`,
        );

        if (
          job.status !==
          JobStatus.UPLOADING_TO_META
        ) {
          await prisma.$transaction(
            async (tx) => {
              await transitionJobState(
                tx,
                job.id,
                workerUuid,
                JobStatus.UPLOADING_TO_META,
                job.userId!,
                {
                  providerReference:
                    uploadReference,
                  providerProcessingId:
                    videoId,
                },
              );
            },
          );
        }
      }

      log(
        `[UPLOADING_TO_META] Retrieving download stream from ${asset.provider}...`,
      );

      let mediaStream: Readable;

      if (asset.provider === 'GOOGLE_DRIVE') {
        const { GoogleDriveMediaReader } =
          await import(
            './google-drive/google-drive-media-reader'
          );

        try {
          mediaStream =
            await GoogleDriveMediaReader.getDownloadStream(
              job.userId,
              asset,
            );
        } catch (err: unknown) {
          const error = err as Error;

          if (
            error.message ===
            'GOOGLE_DRIVE_CONNECTION_REVOKED'
          ) {
            await prisma.$transaction(
              async (tx) => {
                await transitionJobState(
                  tx,
                  job.id,
                  workerUuid,
                  JobStatus.FAILED_PERMANENT,
                  job.userId!,
                  {
                    failedAt: new Date(),
                    lastErrorCode:
                      'GOOGLE_DRIVE_CONNECTION_REVOKED',
                    lastErrorMessage:
                      'Google Drive refresh token is missing or has been revoked.',
                    failureClassification:
                      FailureClassification.REVOKED_TOKEN,
                  },
                );
              },
            );

            return;
          }

          if (
            error.message ===
            'GOOGLE_DRIVE_FILE_NOT_FOUND'
          ) {
            await prisma.$transaction(
              async (tx) => {
                await transitionJobState(
                  tx,
                  job.id,
                  workerUuid,
                  JobStatus.FAILED_PERMANENT,
                  job.userId!,
                  {
                    failedAt: new Date(),
                    lastErrorCode:
                      'GOOGLE_DRIVE_FILE_NOT_FOUND',
                    lastErrorMessage:
                      'The linked Google Drive file was not found (404) or was trashed.',
                    failureClassification:
                      FailureClassification.INVALID_MEDIA,
                  },
                );
              },
            );

            return;
          }

          throw error;
        }
      } else if (
        asset.provider === 'R2' ||
        asset.provider === 'GCS'
      ) {
        const { getStorageAdapter } =
          await import('./storage');

        const adapter = getStorageAdapter();

        mediaStream =
          await adapter.createReadStream(
            asset.bucket,
            asset.objectKey,
          );
      } else {
        throw new Error(
          `UNSUPPORTED_PROVIDER: ${asset.provider}`,
        );
      }

      if (isReel) {
        try {
          log(
            `[UPLOADING_TO_META] Streaming the Reel binary to Meta...`,
          );

          await FacebookPublishingService.uploadReelMedia(
            uploadReference!,
            pageToken,
            fileSize,
            mediaStream,
          );

          mediaStream.destroy();

          log(
            `[UPLOADING_TO_META] Reel transfer completed. Publishing Reel...`,
          );

          if (job.thumbnailAssetId) {
            log(
              `[THUMBNAIL] A permanent thumbnail is linked, but the current Meta Reel publishing flow has no enabled thumbnail capability. Meta will select the Reel cover.`,
            );
          }

          await FacebookPublishingService.finishReelUploadSession(
            pageToken,
            videoId!,
            job.englishTitle,
            job.englishCaption,
            job.hashtags,
          );

          const nextPollTime = new Date(
            Date.now() + 10 * 1000,
          );

          await prisma.$transaction(
            async (tx) => {
              await transitionJobState(
                tx,
                job.id,
                workerUuid,
                JobStatus.META_PROCESSING,
                job.userId!,
                {
                  nextAttemptAt: nextPollTime,
                },
              );
            },
          );

          log(
            `[META_PROCESSING] Reel publishing initialized under Meta Video ID: ${videoId}. Resuming check at ${nextPollTime.toISOString()}`,
          );
        } catch (err: unknown) {
          mediaStream.destroy();
          throw err;
        }
      } else {
        log(
          `[UPLOADING_TO_META] Commencing transfer loop following Meta authoritative offsets...`,
        );

        let totalTransferred = 0;
        const accumulator = new StreamAccumulator(mediaStream);

        try {
          while (startOffset < fileSize) {
            const neededBytes = endOffset - startOffset;
            if (neededBytes <= 0) {
              throw new Error(`META_UPLOAD_INVALID_CHUNK_SIZE: Meta requested non-positive chunk size: ${neededBytes}`);
            }

            const chunk = await accumulator.readBytes(neededBytes);
            if (!chunk || chunk.length === 0) {
              throw new Error(`META_UPLOAD_EOF_REACHED: Reached end of stream but Meta requested more bytes. Transferred: ${totalTransferred}, offset: ${startOffset}, needed: ${neededBytes}`);
            }

            log(
              `[UPLOADING_TO_META] Uploading chunk: Job ID: ${job.id}, bytes ${startOffset}-${startOffset + chunk.length - 1}/${fileSize}, chunk size: ${chunk.length}`,
            );

            const uploadResult = await FacebookPublishingService.uploadChunk(
              page.facebookPageId,
              pageToken,
              uploadReference!,
              startOffset,
              chunk,
            );

            const prevStartOffset = startOffset;
            const newStartOffset = uploadResult.startOffset;
            const newEndOffset = uploadResult.endOffset;

            log(
              `[PROGRESS] Job ID: ${job.id}, previous offset: ${prevStartOffset}, returned start offset: ${newStartOffset}, returned end offset: ${newEndOffset}, source file size: ${fileSize}, transferred byte count: ${chunk.length}`,
            );

            if (newStartOffset < prevStartOffset) {
              throw new Error(`META_UPLOAD_BACKWARD_OFFSET: Meta returned start_offset ${newStartOffset} moved backward from ${prevStartOffset}.`);
            }

            if (newStartOffset === prevStartOffset) {
              throw new Error(`META_UPLOAD_NO_PROGRESS: Meta returned start_offset ${newStartOffset} made no progress.`);
            }

            if (newStartOffset > fileSize || newEndOffset > fileSize) {
              throw new Error(`META_UPLOAD_EXCEEDS_FILE_SIZE: Meta returned offset ${newStartOffset}/${newEndOffset} exceeds file size ${fileSize}.`);
            }

            if (newStartOffset < prevStartOffset + chunk.length) {
              throw new Error(`META_UPLOAD_CONSUMED_BYTES: Meta requested already-consumed bytes. New start_offset: ${newStartOffset}, expected at least ${prevStartOffset + chunk.length}.`);
            }

            if (newStartOffset > newEndOffset) {
              throw new Error(`META_UPLOAD_CONTRADICTORY_RANGE: Meta returned start_offset ${newStartOffset} greater than end_offset ${newEndOffset}.`);
            }

            totalTransferred += chunk.length;
            startOffset = newStartOffset;
            endOffset = newEndOffset;

            const isComplete = (startOffset === endOffset) || (startOffset === fileSize);
            if (isComplete) {
              if (startOffset !== fileSize) {
                throw new Error(`META_UPLOAD_INCOMPLETE: Meta indicated completion but final offset ${startOffset} does not equal file size ${fileSize}.`);
              }
              break;
            }
          }

          if (startOffset !== fileSize) {
            throw new Error(`META_UPLOAD_UNFINISHED: Upload finished loop but final offset ${startOffset} does not match file size ${fileSize}.`);
          }

          log(
            `[UPLOADING_TO_META] Chunks transfer completed. Finalizing Meta upload session...`,
          );

          mediaStream.destroy();

          if (!job.thumbnailAssetId) {
            await FacebookPublishingService.finishUploadSession(
              page.facebookPageId,
              pageToken,
              uploadReference!,
              job.englishTitle,
              job.englishCaption,
              job.hashtags,
            );
          } else {
            const {
              getFacebookThumbnailPublishingCapability,
            } = await import(
              './facebook/facebook-thumbnail-publishing-capability'
            );

            const thumbnailCapability =
              getFacebookThumbnailPublishingCapability(
                process.env,
                {
                  jobId: job.id,
                  pageId:
                    page.facebookPageId,
                },
              );

            if (
              !thumbnailCapability.enabled ||
              !thumbnailCapability.regularVideoSupported
            ) {
              log(
                `[THUMBNAIL] A permanent thumbnail is linked, but Meta thumbnail publishing is disabled (${thumbnailCapability.reason}). Meta will select the video thumbnail.`,
              );

              await FacebookPublishingService.finishUploadSession(
                page.facebookPageId,
                pageToken,
                uploadReference!,
                job.englishTitle,
                job.englishCaption,
                job.hashtags,
              );
            } else {
              const {
                resolvePublishingThumbnailSource,
              } = await import(
                './thumbnails/thumbnail-publishing-source'
              );

              const publishingThumbnail =
                await resolvePublishingThumbnailSource({
                  ownerUserId: job.userId,
                  sourceUploadAssetId:
                    job.uploadAssetId,
                  thumbnailAssetId:
                    job.thumbnailAssetId,
                });

              try {
                log(
                  `[THUMBNAIL] Experimental regular-video thumbnail capability enabled. Sending the validated server-side JPEG during the finish phase.`,
                );

                await FacebookPublishingService
                  .finishUploadSessionWithExperimentalThumbnail(
                    page.facebookPageId,
                    pageToken,
                    uploadReference!,
                    job.englishTitle,
                    job.englishCaption,
                    job.hashtags,
                    publishingThumbnail,
                  );
              } finally {
                publishingThumbnail.stream.destroy();
              }
            }
          }

          const nextPollTime = new Date(
            Date.now() + 10 * 1000,
          );

          await prisma.$transaction(
            async (tx) => {
              await transitionJobState(
                tx,
                job.id,
                workerUuid,
                JobStatus.META_PROCESSING,
                job.userId!,
                {
                  nextAttemptAt: nextPollTime,
                },
              );
            },
          );

          log(
            `[META_PROCESSING] Video processing initialized on Meta under Video ID: ${videoId}. Resuming check at ${nextPollTime.toISOString()}`,
          );
        } catch (err: unknown) {
          mediaStream.destroy();
          throw err;
        }
      }
    } else {
      // Mock Publishing scenario flow
      log(`[PREPARING] Running video formatting and size validations...`);

      if (scenario === MockScenario.INVALID_MEDIA_FORMAT) {
        await prisma.$transaction(async (tx) => {
          await transitionJobState(tx, job.id, workerUuid, JobStatus.FAILED_PERMANENT, job.userId!, {
            failedAt: new Date(),
            lastErrorCode: 'INVALID_MEDIA_FORMAT',
            lastErrorMessage: 'Video Aspect Ratio must be vertical 9:16 for Reels.',
            failureClassification: FailureClassification.INVALID_MEDIA
          });
        });
        log(`[ERROR] Job failed permanently due to invalid video format.`);
        return;
      }

      if (scenario === MockScenario.REVOKED_FACEBOOK_TOKEN) {
        await prisma.$transaction(async (tx) => {
          const page = await tx.facebookPage.findUnique({ where: { id: job.pageId } });
          if (page) {
            await tx.facebookPage.updateMany({
              where: { accountId: page.accountId },
              data: { isSynced: false }
            });
          }

          await transitionJobState(tx, job.id, workerUuid, JobStatus.FACEBOOK_RECONNECT_REQUIRED, job.userId!, {
            failedAt: new Date(),
            lastErrorCode: 'REVOKED_TOKEN',
            lastErrorMessage: 'Meta API Subcode 463: User password change or token revoked. Please reconnect account.',
            failureClassification: FailureClassification.REVOKED_TOKEN
          });
        });
        log(`[ERROR] Job failed: Page credentials revoked. Token flagged as Expired.`);
        return;
      }

      if (scenario === MockScenario.MISSING_FACEBOOK_PERMISSION) {
        await prisma.$transaction(async (tx) => {
          await transitionJobState(tx, job.id, workerUuid, JobStatus.FAILED_PERMANENT, job.userId!, {
            failedAt: new Date(),
            lastErrorCode: 'MISSING_PERMISSION',
            lastErrorMessage: 'Meta Graph API Error: permission pages_manage_posts is missing.',
            failureClassification: FailureClassification.MISSING_PERMISSION
          });
        });
        log(`[ERROR] Job failed permanently: missing Graph API publishing scope.`);
        return;
      }

      log(`[PREPARING] Validation checks successful. Initiating chunks transfer...`);

      await prisma.$transaction(async (tx) => {
        await transitionJobState(tx, job.id, workerUuid, JobStatus.UPLOADING_TO_META, job.userId!, {
          providerReference: `session_ref_${randomUUID().slice(0, 8)}`
        });
      });

      log(`[UPLOADING_TO_META] Streaming video raw chunks to Graph API endpoint...`);

      if (scenario === MockScenario.TEMPORARY_NETWORK_FAILURE) {
        throw new Error('Connection lost during chunk upload.');
      }

      log(`[UPLOADING_TO_META] Upload completed successfully. Registering video session...`);

      const mockVideoId = Math.floor(100000000000 + Math.random() * 900000000000).toString();
      const nextPollTime = new Date(Date.now() + 5 * 1000);

      await prisma.$transaction(async (tx) => {
        await transitionJobState(tx, job.id, workerUuid, JobStatus.META_PROCESSING, job.userId!, {
          providerProcessingId: mockVideoId,
          nextAttemptAt: nextPollTime
        });
      });

      log(`[META_PROCESSING] Processing registered under Meta Video ID: ${mockVideoId}. Next checking session at ${nextPollTime.toISOString()}`);
    }
  } catch (error: unknown) {
    const err = error as Error;
    log(`System Exception during execution: ${String(error)}`);

    // Classify error type
    let classification: FailureClassification = FailureClassification.UNKNOWN_ERROR;
    let errorCode = 'UNKNOWN_SYSTEM_ERR';
    const errorMessage = err.message || String(error);

    if (err.message?.includes('GOOGLE_DRIVE_DECRYPTION_FAILED')) {
      classification = FailureClassification.REVOKED_TOKEN;
      errorCode = 'GOOGLE_DRIVE_DECRYPTION_FAILED';
    } else if (err.message?.includes('GOOGLE_DRIVE_CONNECTION_REVOKED') || err.message?.includes('invalid_grant')) {
      classification = FailureClassification.REVOKED_TOKEN;
      errorCode = 'GOOGLE_DRIVE_CONNECTION_REVOKED';
    } else if (err.message?.includes('GOOGLE_DRIVE_FILE_NOT_FOUND')) {
      classification = FailureClassification.INVALID_MEDIA;
      errorCode = 'GOOGLE_DRIVE_FILE_NOT_FOUND';
    } else if (err.message?.includes('THUMBNAIL_PUBLISHING_') || err.message?.includes('META_THUMBNAIL_')) {
      classification = FailureClassification.INVALID_MEDIA;
      errorCode = 'THUMBNAIL_PUBLISHING_FAILED';
    } else if (err.message?.includes('META_UPLOAD_')) {
      classification = FailureClassification.NETWORK_ERROR;
      errorCode = 'META_UPLOAD_FAILED';
    } else if (err.message?.includes('META_AUTH_ERROR')) {
      classification = FailureClassification.REVOKED_TOKEN;
      errorCode = 'REVOKED_TOKEN';
    } else if (err.message?.includes('META_API_ERROR') || err.message?.includes('timeout') || err.message?.includes('Connection lost') || err.message?.includes('fetch')) {
      classification = FailureClassification.NETWORK_ERROR;
      errorCode = 'NET_TIMEOUT';
    }

    try {
      const isExhausted = job.attemptCount >= job.maxAttempts;
      const isTerminal = isExhausted ||
        errorCode === 'GOOGLE_DRIVE_CONNECTION_REVOKED' ||
        errorCode === 'GOOGLE_DRIVE_FILE_NOT_FOUND' ||
        errorCode === 'GOOGLE_DRIVE_DECRYPTION_FAILED' ||
        errorCode === 'THUMBNAIL_PUBLISHING_FAILED';

      if (isTerminal) {
        await prisma.$transaction(async (tx) => {
          await transitionJobState(tx, job.id, workerUuid, JobStatus.FAILED_PERMANENT, job.userId!, {
            failedAt: new Date(),
            lastErrorCode: errorCode,
            lastErrorMessage: errorMessage,
            failureClassification: classification
          });
        });
      } else {
        // Reschedule retry back to SCHEDULED status with backoff using a single atomic update
        await prisma.$transaction(async (tx) => {
          // Fetch current attempts log array
          const currentJob = await tx.videoJob.findUnique({ where: { id: job.id } });
          const attemptsArr = Array.isArray(currentJob?.attempts) ? [...currentJob.attempts] : [];
          attemptsArr.push({
            attemptNumber: job.attemptCount,
            startTime: job.lockedAt?.toISOString() || job.startedAt?.toISOString() || now.toISOString(),
            completionTime: new Date().toISOString(),
            resultingState: JobStatus.FAILED_RETRYABLE,
            errorCode: errorCode,
            explanation: errorMessage
          });

          const backoffMs = Math.pow(2, job.attemptCount) * 10 * 1000;
          const nextAttempt = new Date(Date.now() + backoffMs);

          await tx.videoJob.update({
            where: { id: job.id },
            data: {
              status: JobStatus.SCHEDULED,
              lastErrorCode: errorCode,
              lastErrorMessage: errorMessage,
              failureClassification: classification,
              scheduledTimeUTC: nextAttempt,
              lockToken: null,
              lockedAt: null,
              lockExpiresAt: null,
              attempts: attemptsArr
            }
          });
        });
      }
    } catch (e) {
      log(`Failed writing catch-all system error state: ${String(e)}`);
    }
  }
}

/**
 * Handles checking status for a claimed job in META_PROCESSING state.
 */
async function resumeMetaProcessingCheck(
  job: VideoJob,
  workerUuid: string,
  log: (msg: string) => void
): Promise<void> {
  const scenario = job.mockScenario || MockScenario.SUCCESS;
  const now = new Date();

  try {
    log(`[META_PROCESSING] Resuming check for Meta Video ID: ${job.providerProcessingId}`);

    const appConfig = await prisma.appConfiguration.findUnique({
      where: { id: 'default' }
    });
    const isLive = appConfig?.liveMetaMode === true;

    if (isLive) {
      log(`[META_PROCESSING] Live Meta Mode active. Checking transcoding status...`);
      const page = await prisma.facebookPage.findUnique({
        where: { id: job.pageId }
      });
      if (!page) {
        throw new Error('FACEBOOK_PAGE_NOT_FOUND');
      }

      let pageToken: string;
      try {
        const { decryptToken } = await import('./crypto');
        pageToken = decryptToken(page.encryptedPageToken);
      } catch (err: unknown) {
        const error = err as Error;
        throw new Error(`DECRYPTION_ERROR: Failed to decrypt page token. ${error.message}`);
      }

      if (!job.providerProcessingId) {
        throw new Error('MISSING_PROVIDER_PROCESSING_ID');
      }

      const { FacebookPublishingService } = await import('./facebook/facebook-publishing-service');
      const checkResult = await FacebookPublishingService.checkVideoStatus(job.providerProcessingId, pageToken);

      if (checkResult.status === 'ready') {
        log(`[META_PROCESSING] Video transcoding completed. Transitioning to PUBLISHED.`);
        await prisma.$transaction(async (tx) => {
          await transitionJobState(tx, job.id, workerUuid, JobStatus.PUBLISHING, job.userId!, {
            startedAt: job.startedAt || new Date()
          });
          await transitionJobState(tx, job.id, workerUuid, JobStatus.PUBLISHED, job.userId!, {
            completedAt: new Date(),
            metaPostId: job.providerProcessingId
          });
        });
        log(`[PUBLISHED] Success! Published video to Meta Page. Post ID: ${job.providerProcessingId}`);
      } else if (checkResult.status === 'processing') {
        const nextPollTime = new Date(Date.now() + 15 * 1000);
        await prisma.$transaction(async (tx) => {
          await tx.videoJob.update({
            where: { id: job.id },
            data: {
              lockToken: null,
              lockedAt: null,
              lockExpiresAt: null,
              nextAttemptAt: nextPollTime
            }
          });
        });
        log(`[META_PROCESSING] Video transcoding still in progress. Reset locks for polling resumption in 15 seconds.`);
      } else if (checkResult.status === 'error') {
        log(`[ERROR] Meta transcoding failed: ${checkResult.errorMsg}`);
        const { classification, code } = classifyFailure(checkResult);
        await prisma.$transaction(async (tx) => {
          await transitionJobState(tx, job.id, workerUuid, JobStatus.FAILED_PERMANENT, job.userId!, {
            failedAt: new Date(),
            lastErrorCode: code,
            lastErrorMessage: checkResult.errorMsg || 'Meta transcoding failed',
            failureClassification: classification
          });
        });
      }
    } else {
      // Mock scenario flows
      if (scenario === MockScenario.META_RATE_LIMIT) {
        throw new Error('Graph API Rate limits reached (Code 4).');
      }

      if (scenario === MockScenario.PERMANENT_PUBLISHING_FAILURE) {
        await prisma.$transaction(async (tx) => {
          await transitionJobState(tx, job.id, workerUuid, JobStatus.FAILED_PERMANENT, job.userId!, {
            failedAt: new Date(),
            lastErrorCode: 'META_API_ABORT',
            lastErrorMessage: 'Meta transcoding failed: video encoding corrupted.',
            failureClassification: FailureClassification.INVALID_MEDIA
          });
        });
        log(`[ERROR] Job failed permanently: video encoding corrupted on Meta.`);
        return;
      }

      if (scenario === MockScenario.META_PROCESSING_DELAY) {
        const checkCount = Array.isArray(job.attempts) ? job.attempts.length : 0;
        if (checkCount < 2) {
          const nextPollTime = new Date(Date.now() + 10 * 1000);
          await prisma.$transaction(async (tx) => {
            const attemptsArr = Array.isArray(job.attempts) ? [...job.attempts] : [];
            attemptsArr.push({
              attemptNumber: job.attemptCount,
              startTime: job.lockedAt?.toISOString() || now.toISOString(),
              completionTime: now.toISOString(),
              resultingState: JobStatus.META_PROCESSING,
              errorCode: null,
              explanation: 'Meta video transcoding still processing.'
            });

            await tx.videoJob.update({
              where: { id: job.id },
              data: {
                lockToken: null,
                lockedAt: null,
                lockExpiresAt: null,
                nextAttemptAt: nextPollTime,
                attempts: attemptsArr
              }
            });
          });
          log(`[META_PROCESSING] Mock delay: Video is still transcoding. Rescheduled.`);
          return;
        }
      }

      log(`[META_PROCESSING] Transcoding complete. Confirming publish status...`);

      await prisma.$transaction(async (tx) => {
        await transitionJobState(tx, job.id, workerUuid, JobStatus.PUBLISHING, job.userId!, {
          startedAt: job.startedAt || new Date()
        });

        await transitionJobState(tx, job.id, workerUuid, JobStatus.PUBLISHED, job.userId!, {
          completedAt: new Date(),
          metaPostId: job.providerProcessingId
        });
      });

      log(`[PUBLISHED] Success! Published video to Meta Page. Post ID Link: fb.com/${job.providerProcessingId}`);
    }
  } catch (error: unknown) {
    const err = error as Error;
    log(`System Exception during resumption: ${String(error)}`);

    let classification: FailureClassification = FailureClassification.UNKNOWN_ERROR;
    let errorCode = 'UNKNOWN_SYSTEM_ERR';
    const errorMessage = err.message || String(error);

    if (err.message?.includes('Graph API Rate limits')) {
      classification = FailureClassification.RATE_LIMIT;
      errorCode = 'META_RATE_LIMIT';
    } else if (err.message?.includes('timeout') || err.message?.includes('Connection lost') || err.message?.includes('fetch')) {
      classification = FailureClassification.NETWORK_ERROR;
      errorCode = 'NET_TIMEOUT';
    }

    try {
      const isExhausted = job.attemptCount >= job.maxAttempts;
      const isTerminal = isExhausted;

      if (isTerminal) {
        await prisma.$transaction(async (tx) => {
          await transitionJobState(tx, job.id, workerUuid, JobStatus.FAILED_PERMANENT, job.userId!, {
            failedAt: new Date(),
            lastErrorCode: errorCode,
            lastErrorMessage: errorMessage,
            failureClassification: classification
          });
        });
      } else {
        // Reschedule check back to META_PROCESSING status with backoff
        await prisma.$transaction(async (tx) => {
          const backoffMs = Math.pow(2, job.attemptCount) * 10 * 1000;
          const nextAttempt = new Date(Date.now() + backoffMs);

          await tx.videoJob.update({
            where: { id: job.id },
            data: {
              status: JobStatus.META_PROCESSING,
              lockToken: null,
              lockedAt: null,
              lockExpiresAt: null,
              nextAttemptAt: nextAttempt
            }
          });
        });
      }
    } catch (e) {
      log(`Failed writing check system error state: ${String(e)}`);
    }
  }
}
