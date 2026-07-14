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

// Generates a unique UUID token for the worker execution run
export function generateWorkerToken(): string {
  return randomUUID();
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

  try {
    // Check if job was crashed previously and contains provider details for reconciliation
    if (job.providerProcessingId) {
      log(`Reconciliation active for Job ${job.id}. Checking providerProcessingId: ${job.providerProcessingId}`);
      // Simulate checking Meta API and finding it already published
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

    // Step 1: PREPARING -> Validation checks
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
        // Revoke page tokens under the same account
        const page = await tx.facebookPage.findUnique({ where: { id: job.pageId } });
        if (page) {
          // De-sync all pages linked under that account ID
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

    // Step 2: PREPARING -> UPLOADING_TO_META
    log(`[PREPARING] Validation checks successful. Initiating chunks transfer...`);
    
    await prisma.$transaction(async (tx) => {
      await transitionJobState(tx, job.id, workerUuid, JobStatus.UPLOADING_TO_META, job.userId!, {
        providerReference: `session_ref_${randomUUID().slice(0, 8)}`
      });
    });

    log(`[UPLOADING_TO_META] Streaming video raw chunks to Graph API endpoint...`);

    if (scenario === MockScenario.TEMPORARY_NETWORK_FAILURE) {
      const isExhausted = job.attemptCount >= job.maxAttempts;
      const nextStatus = isExhausted ? JobStatus.FAILED_PERMANENT : JobStatus.FAILED_RETRYABLE;

      await prisma.$transaction(async (tx) => {
        await transitionJobState(tx, job.id, workerUuid, nextStatus, job.userId!, {
          failedAt: new Date(),
          lastErrorCode: 'NET_TIMEOUT',
          lastErrorMessage: `Connection lost during chunk upload. Attempt ${job.attemptCount}/${job.maxAttempts} failed.`,
          failureClassification: FailureClassification.NETWORK_ERROR
        });
      });
      log(`[ERROR] Job failed: connection timeout during raw stream. State set to ${nextStatus}.`);
      return;
    }

    // Step 3: UPLOADING_TO_META -> META_PROCESSING
    log(`[UPLOADING_TO_META] Upload completed successfully. Registering video session...`);

    const mockVideoId = Math.floor(100000000000 + Math.random() * 900000000000).toString();
    const nextPollTime = new Date(Date.now() + 5 * 1000); // Poll in 5 seconds

    await prisma.$transaction(async (tx) => {
      await transitionJobState(tx, job.id, workerUuid, JobStatus.META_PROCESSING, job.userId!, {
        providerProcessingId: mockVideoId,
        nextAttemptAt: nextPollTime
      });
    });

    log(`[META_PROCESSING] Processing registered under Meta Video ID: ${mockVideoId}. Next checking session at ${nextPollTime.toISOString()}`);

  } catch (error) {
    log(`System Exception during execution: ${String(error)}`);
    try {
      await prisma.$transaction(async (tx) => {
        const isExhausted = job.attemptCount >= job.maxAttempts;
        const nextStatus = isExhausted ? JobStatus.FAILED_PERMANENT : JobStatus.FAILED_RETRYABLE;
        
        await transitionJobState(tx, job.id, workerUuid, nextStatus, job.userId!, {
          failedAt: new Date(),
          lastErrorCode: 'UNKNOWN_SYSTEM_ERR',
          lastErrorMessage: String(error),
          failureClassification: FailureClassification.UNKNOWN_ERROR
        });
      });
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

  try {
    log(`[META_PROCESSING] Resuming check for Meta Video ID: ${job.providerProcessingId}`);

    if (scenario === MockScenario.META_RATE_LIMIT) {
      const isExhausted = job.attemptCount >= job.maxAttempts;
      const nextStatus = isExhausted ? JobStatus.FAILED_PERMANENT : JobStatus.FAILED_RETRYABLE;

      await prisma.$transaction(async (tx) => {
        await transitionJobState(tx, job.id, workerUuid, nextStatus, job.userId!, {
          failedAt: new Date(),
          lastErrorCode: 'META_RATE_LIMIT',
          lastErrorMessage: 'Graph API Rate limits reached (Code 4). Calls restricted.',
          failureClassification: FailureClassification.RATE_LIMIT
        });
      });
      log(`[ERROR] Job failed: Rate Limit exceeded. Transitioned to ${nextStatus}.`);
      return;
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

    // Step 4: META_PROCESSING -> PUBLISHING -> PUBLISHED
    log(`[META_PROCESSING] Transcoding complete. Confirming publish status...`);

    await prisma.$transaction(async (tx) => {
      // Transition through PUBLISHING state
      await transitionJobState(tx, job.id, workerUuid, JobStatus.PUBLISHING, job.userId!, {
        startedAt: job.startedAt || new Date()
      });

      // Complete publish to PUBLISHED
      await transitionJobState(tx, job.id, workerUuid, JobStatus.PUBLISHED, job.userId!, {
        completedAt: new Date(),
        metaPostId: job.providerProcessingId
      });
    });

    log(`[PUBLISHED] Success! Published video to Meta Page. Post ID Link: fb.com/${job.providerProcessingId}`);

  } catch (error) {
    log(`System Exception during resumption: ${String(error)}`);
    try {
      await prisma.$transaction(async (tx) => {
        const isExhausted = job.attemptCount >= job.maxAttempts;
        const nextStatus = isExhausted ? JobStatus.FAILED_PERMANENT : JobStatus.FAILED_RETRYABLE;

        await transitionJobState(tx, job.id, workerUuid, nextStatus, job.userId!, {
          failedAt: new Date(),
          lastErrorCode: 'UNKNOWN_SYSTEM_ERR',
          lastErrorMessage: String(error),
          failureClassification: FailureClassification.UNKNOWN_ERROR
        });
      });
    } catch (e) {
      log(`Failed writing check system error state: ${String(e)}`);
    }
  }
}
