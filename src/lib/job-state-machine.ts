import { JobStatus, FailureClassification, MockScenario, Prisma, VideoJob } from '@prisma/client';

export function canTransition(current: JobStatus, next: JobStatus): boolean {
  if (
    current === JobStatus.PUBLISHED ||
    current === JobStatus.CANCELLED ||
    current === JobStatus.FAILED_PERMANENT ||
    current === JobStatus.FAILED
  ) {
    return false; // Terminal states
  }

  const transitions: Record<JobStatus, JobStatus[]> = {
    [JobStatus.DRAFT]: [JobStatus.MEDIA_UPLOADED, JobStatus.SCHEDULED, JobStatus.CANCELLED],
    [JobStatus.MEDIA_UPLOADED]: [JobStatus.SCHEDULED, JobStatus.CANCELLED],
    [JobStatus.SCHEDULED]: [JobStatus.PREPARING, JobStatus.CANCELLED],
    [JobStatus.PREPARING]: [
      JobStatus.UPLOADING_TO_META,
      JobStatus.FAILED_RETRYABLE,
      JobStatus.FAILED_PERMANENT,
      JobStatus.FACEBOOK_RECONNECT_REQUIRED,
      JobStatus.CANCELLED
    ],
    [JobStatus.UPLOADING_TO_META]: [
      JobStatus.META_PROCESSING,
      JobStatus.PUBLISHING,
      JobStatus.FAILED_RETRYABLE,
      JobStatus.FAILED_PERMANENT,
      JobStatus.FACEBOOK_RECONNECT_REQUIRED
    ],
    [JobStatus.META_PROCESSING]: [
      JobStatus.PUBLISHING,
      JobStatus.PUBLISHED,
      JobStatus.FAILED_RETRYABLE,
      JobStatus.FAILED_PERMANENT,
      JobStatus.FACEBOOK_RECONNECT_REQUIRED
    ],
    [JobStatus.PUBLISHING]: [
      JobStatus.PUBLISHED,
      JobStatus.FAILED_RETRYABLE,
      JobStatus.FAILED_PERMANENT,
      JobStatus.FACEBOOK_RECONNECT_REQUIRED
    ],
    [JobStatus.FAILED_RETRYABLE]: [JobStatus.SCHEDULED, JobStatus.CANCELLED],
    [JobStatus.FAILED_PERMANENT]: [],
    [JobStatus.CANCELLED]: [],
    [JobStatus.FACEBOOK_RECONNECT_REQUIRED]: [JobStatus.SCHEDULED, JobStatus.CANCELLED],
    [JobStatus.FAILED]: [],
    [JobStatus.PUBLISHED]: []
  };

  return transitions[current]?.includes(next) ?? false;
}

export interface TransitionMetadata {
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
  failureClassification?: FailureClassification | null;
  providerReference?: string | null;
  providerProcessingId?: string | null;
  metaPostId?: string | null;
  mockScenario?: MockScenario | null;
  nextAttemptAt?: Date | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  failedAt?: Date | null;
  errorLog?: string | null;
  attempts?: Prisma.JsonValue | null;
}

/**
 * Claims a scheduled job atomically inside a transaction.
 */
export async function claimScheduledJob(
  tx: Prisma.TransactionClient,
  jobId: string,
  workerUuid: string,
  leaseDurationMs: number = 10 * 60 * 1000
): Promise<VideoJob | null> {
  const now = new Date();

  // Find job first in read-only to check limit inconsistency
  const job = await tx.videoJob.findUnique({
    where: { id: jobId }
  });

  if (!job) {
    return null;
  }

  // Handle inconsistent scheduled job with attemptCount >= maxAttempts
  if (job.status === JobStatus.SCHEDULED && job.attemptCount >= job.maxAttempts) {
    const updatedRows = await tx.videoJob.updateMany({
      where: {
        id: jobId,
        status: JobStatus.SCHEDULED,
        attemptCount: { gte: job.maxAttempts },
        OR: [
          { lockExpiresAt: null },
          { lockExpiresAt: { lt: now } }
        ]
      },
      data: {
        status: JobStatus.FAILED_PERMANENT,
        lockToken: null,
        lockedAt: null,
        lockExpiresAt: null,
        nextAttemptAt: null,
        failedAt: now,
        errorLog: 'Attempt limit exceeded before processing.'
      }
    });

    if (updatedRows.count > 0) {
      await tx.auditLog.create({
        data: {
          action: 'JOB_INCONSISTENCY_ABORT',
          details: `Job ${jobId} had status SCHEDULED but attemptCount (${job.attemptCount}) >= maxAttempts (${job.maxAttempts}). Moved to FAILED_PERMANENT.`,
          userId: job.userId
        }
      });
    }

    return null;
  }

  // Execute atomic update
  const expiresAt = new Date(now.getTime() + leaseDurationMs);

  // Since Prisma updateMany doesn't return the row and attemptCount check might need raw SQL:
  // Let's write a safer query:
  // Using a raw query or updating via raw query is 100% database atomic. Let's do that!
  // Wait, let's look at raw SQL:
  // "UPDATE \"VideoJob\" SET status = 'PREPARING', \"lockToken\" = $1, \"lockedAt\" = $2, \"lockExpiresAt\" = $3, \"startedAt\" = $4, \"attemptCount\" = \"attemptCount\" + 1 WHERE id = $5 AND status = 'SCHEDULED' AND \"attemptCount\" < \"maxAttempts\" AND \"scheduledTimeUTC\" <= $6 AND (\"lockExpiresAt\" IS NULL OR \"lockExpiresAt\" < $7)"
  // This is completely database agnostic, type-safe, and 100% atomic!
  const rows = await tx.$executeRaw`
    UPDATE "VideoJob"
    SET
      status = ${JobStatus.PREPARING}::"JobStatus",
      "lockToken" = ${workerUuid}::uuid,
      "lockedAt" = ${now},
      "lockExpiresAt" = ${expiresAt},
      "startedAt" = ${now},
      "attemptCount" = "attemptCount" + 1
    WHERE
      id = ${jobId}::uuid
      AND status = 'SCHEDULED'::"JobStatus"
      AND "attemptCount" < "maxAttempts"
      AND "scheduledTimeUTC" <= ${now}
      AND ("lockExpiresAt" IS NULL OR "lockExpiresAt" < ${now})
  `;

  if (rows === 0) {
    return null;
  }

  const updatedJob = await tx.videoJob.findUnique({
    where: { id: jobId }
  });

  if (updatedJob) {
    await tx.auditLog.create({
      data: {
        action: 'JOB_CLAIMED',
        details: `Job ${jobId} claimed by worker. Transitioned SCHEDULED -> PREPARING. Attempt count is now ${updatedJob.attemptCount}.`,
        userId: updatedJob.userId
      }
    });
  }

  return updatedJob;
}

/**
 * Claims a due META_PROCESSING job atomically.
 */
export async function claimMetaProcessingJob(
  tx: Prisma.TransactionClient,
  jobId: string,
  workerUuid: string,
  leaseDurationMs: number = 10 * 60 * 1000
): Promise<VideoJob | null> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + leaseDurationMs);

  const rows = await tx.$executeRaw`
    UPDATE "VideoJob"
    SET
      "lockToken" = ${workerUuid}::uuid,
      "lockedAt" = ${now},
      "lockExpiresAt" = ${expiresAt}
    WHERE
      id = ${jobId}::uuid
      AND status = 'META_PROCESSING'::"JobStatus"
      AND "nextAttemptAt" <= ${now}
      AND ("lockExpiresAt" IS NULL OR "lockExpiresAt" < ${now})
  `;

  if (rows === 0) {
    return null;
  }

  return tx.videoJob.findUnique({
    where: { id: jobId }
  });
}

/**
 * Transition status with strict transition rules, lock-token fencing, and lease cleanup.
 */
export async function transitionJobState(
  tx: Prisma.TransactionClient,
  jobId: string,
  lockToken: string,
  nextStatus: JobStatus,
  userId: string,
  metadata: TransitionMetadata = {}
): Promise<VideoJob> {
  const now = new Date();

  // Find the job to verify fencing and state checks
  const job = await tx.videoJob.findUnique({
    where: { id: jobId }
  });

  if (!job) {
    throw new Error(`Job ${jobId} not found.`);
  }

  // Ownership verification
  if (job.userId !== userId) {
    throw new Error(`Permission denied: Job ${jobId} is not owned by user ${userId}.`);
  }

  // Fencing token check: lockToken must match, and lease must not have expired
  if (job.lockToken !== lockToken) {
    throw new Error(`Fencing block: Worker token mismatch for Job ${jobId}.`);
  }

  if (!job.lockExpiresAt || job.lockExpiresAt < now) {
    throw new Error(`Fencing block: Worker lease has expired for Job ${jobId}.`);
  }

  // Transition rules validation
  if (!canTransition(job.status, nextStatus)) {
    throw new Error(`Invalid state transition: Cannot transition Job ${jobId} from ${job.status} to ${nextStatus}.`);
  }

  const isFinalState = (
    [
      JobStatus.PUBLISHED,
      JobStatus.FAILED_PERMANENT,
      JobStatus.FAILED_RETRYABLE,
      JobStatus.FACEBOOK_RECONNECT_REQUIRED,
      JobStatus.CANCELLED,
      JobStatus.FAILED
    ] as JobStatus[]
  ).includes(nextStatus);

  const isTransitionToLog = (
    [
      JobStatus.PUBLISHED,
      JobStatus.FAILED_RETRYABLE,
      JobStatus.FAILED_PERMANENT,
      JobStatus.FACEBOOK_RECONNECT_REQUIRED
    ] as JobStatus[]
  ).includes(nextStatus);

  const finalErrorCode = metadata.lastErrorCode !== undefined ? metadata.lastErrorCode : job.lastErrorCode;
  const finalErrorMessage = metadata.lastErrorMessage !== undefined ? metadata.lastErrorMessage : job.lastErrorMessage;

  const updateData: Prisma.VideoJobUpdateInput = {
    status: nextStatus,
    lastErrorCode: finalErrorCode,
    lastErrorMessage: finalErrorMessage,
    failureClassification: metadata.failureClassification !== undefined ? metadata.failureClassification : job.failureClassification,
    providerReference: metadata.providerReference !== undefined ? metadata.providerReference : job.providerReference,
    providerProcessingId: metadata.providerProcessingId !== undefined ? metadata.providerProcessingId : job.providerProcessingId,
    metaPostId: metadata.metaPostId !== undefined ? metadata.metaPostId : job.metaPostId,
    mockScenario: metadata.mockScenario !== undefined ? metadata.mockScenario : job.mockScenario,
    nextAttemptAt: metadata.nextAttemptAt !== undefined ? metadata.nextAttemptAt : job.nextAttemptAt,
    startedAt: metadata.startedAt !== undefined ? metadata.startedAt : job.startedAt,
    completedAt: metadata.completedAt !== undefined ? metadata.completedAt : job.completedAt,
    failedAt: metadata.failedAt !== undefined ? metadata.failedAt : job.failedAt,
    errorLog: finalErrorMessage || (metadata.errorLog !== undefined ? metadata.errorLog : job.errorLog),
    attempts: (metadata.attempts !== undefined ? metadata.attempts : job.attempts) as Prisma.InputJsonValue | undefined
  };

  if (isTransitionToLog) {
    const attemptsArr = Array.isArray(job.attempts) ? [...job.attempts] : [];
    attemptsArr.push({
      attemptNumber: job.attemptCount,
      startTime: job.lockedAt?.toISOString() || job.startedAt?.toISOString() || now.toISOString(),
      completionTime: now.toISOString(),
      resultingState: nextStatus,
      errorCode: finalErrorCode || null,
      explanation: finalErrorMessage || (nextStatus === JobStatus.PUBLISHED ? 'Successfully published to Meta.' : 'Unknown failure.')
    });
    updateData.attempts = attemptsArr as Prisma.InputJsonValue;
  }

  // Lock cleanup if entering a final state
  if (isFinalState) {
    updateData.lockToken = null;
    updateData.lockedAt = null;
    updateData.lockExpiresAt = null;
    updateData.nextAttemptAt = null;
  }

  const updatedJob = await tx.videoJob.update({
    where: { id: jobId },
    data: updateData
  });

  // AuditLog logging
  await tx.auditLog.create({
    data: {
      action: 'JOB_STATUS_TRANSITION',
      details: `Job ${jobId} transitioned status from ${job.status} to ${nextStatus}.${metadata.lastErrorCode ? ` (Error: ${metadata.lastErrorCode})` : ''}`,
      userId
    }
  });

  return updatedJob;
}

/**
 * Recovers expired leases contextually.
 */
export async function recoverExpiredLease(
  tx: Prisma.TransactionClient,
  jobId: string
): Promise<void> {
  const now = new Date();

  const job = await tx.videoJob.findUnique({
    where: { id: jobId }
  });

  if (!job || !job.lockExpiresAt || job.lockExpiresAt >= now) {
    return; // Not found or lock still valid
  }

  const attemptsArr = Array.isArray(job.attempts) ? [...job.attempts] : [];
  attemptsArr.push({
    attemptNumber: job.attemptCount,
    startedAt: job.lockedAt?.toISOString() || now.toISOString(),
    completedAt: now.toISOString(),
    status: 'FAILED_RETRYABLE',
    errorCode: 'LEASE_EXPIRED',
    errorMessage: `Worker crashed or lease expired in state ${job.status}`
  });

  if (job.status === JobStatus.PREPARING) {
    // Classify attempt as failed (do not increment again)
    const isExhausted = job.attemptCount >= job.maxAttempts;
    const nextStatus = isExhausted ? JobStatus.FAILED_PERMANENT : JobStatus.FAILED_RETRYABLE;

    await tx.videoJob.update({
      where: { id: jobId },
      data: {
        status: nextStatus,
        lockToken: null,
        lockedAt: null,
        lockExpiresAt: null,
        nextAttemptAt: null,
        failedAt: now,
        failureClassification: FailureClassification.NETWORK_ERROR,
        lastErrorCode: 'LEASE_EXPIRED',
        lastErrorMessage: `Lease expired during job preparation.`,
        attempts: attemptsArr
      }
    });

    await tx.auditLog.create({
      data: {
        action: 'JOB_LEASE_RECOVERY',
        details: `Recovered stuck Job ${jobId} in PREPARING. Transitioned to ${nextStatus}.`,
        userId: job.userId
      }
    });
  } else if (job.status === JobStatus.META_PROCESSING) {
    // Reclaim lease / reset locks and resume polling (do not convert to FAILED_RETRYABLE)
    await tx.videoJob.update({
      where: { id: jobId },
      data: {
        lockToken: null,
        lockedAt: null,
        lockExpiresAt: null,
        nextAttemptAt: now // Ready to poll again
      }
    });

    await tx.auditLog.create({
      data: {
        action: 'JOB_LEASE_RECOVERY',
        details: `Recovered lease for Job ${jobId} in META_PROCESSING. Reset locks for resumption.`,
        userId: job.userId
      }
    });
  } else if (
    job.status === JobStatus.UPLOADING_TO_META ||
    job.status === JobStatus.PUBLISHING
  ) {
    // Transitions to FAILED_RETRYABLE/FAILED_PERMANENT so worker reconciles before any new attempt
    const isExhausted = job.attemptCount >= job.maxAttempts;
    const nextStatus = isExhausted ? JobStatus.FAILED_PERMANENT : JobStatus.FAILED_RETRYABLE;

    await tx.videoJob.update({
      where: { id: jobId },
      data: {
        status: nextStatus,
        lockToken: null,
        lockedAt: null,
        lockExpiresAt: null,
        nextAttemptAt: null,
        failedAt: now,
        failureClassification: FailureClassification.NETWORK_ERROR,
        lastErrorCode: 'LEASE_EXPIRED',
        lastErrorMessage: `Lease expired in state ${job.status}. Re-claim required for reconciliation.`,
        attempts: attemptsArr
      }
    });

    await tx.auditLog.create({
      data: {
        action: 'JOB_LEASE_RECOVERY',
        details: `Recovered stuck Job ${jobId} in ${job.status}. Reset lock and set status to ${nextStatus}.`,
        userId: job.userId
      }
    });
  }
}

/**
 * Cancels an eligible pre-provider job securely inside a transaction.
 */
export async function cancelJob(
  tx: Prisma.TransactionClient,
  jobId: string,
  userId: string
): Promise<VideoJob> {
  const now = new Date();
  const job = await tx.videoJob.findUnique({
    where: { id: jobId }
  });

  if (!job) {
    throw new Error(`Job ${jobId} not found.`);
  }

  if (job.userId !== userId) {
    throw new Error(`Permission denied: Job ${jobId} is not owned by user ${userId}.`);
  }

  const eligibleForCancel = (
    [
      JobStatus.DRAFT,
      JobStatus.MEDIA_UPLOADED,
      JobStatus.SCHEDULED,
      JobStatus.PREPARING,
      JobStatus.FAILED_RETRYABLE
    ] as JobStatus[]
  ).includes(job.status);

  if (!eligibleForCancel) {
    throw new Error(`State lock: Job in status ${job.status} cannot be cancelled.`);
  }

  // PREPARING cancellation is safe only before provider work begins
  if (job.status === JobStatus.PREPARING) {
    if (job.providerReference || job.providerProcessingId) {
      throw new Error(`State lock: Cannot cancel job once provider upload has commenced.`);
    }
  }

  const updated = await tx.videoJob.update({
    where: { id: jobId },
    data: {
      status: JobStatus.CANCELLED,
      lockToken: null,
      lockedAt: null,
      lockExpiresAt: null,
      nextAttemptAt: null,
      failedAt: now
    }
  });

  await tx.auditLog.create({
    data: {
      action: 'JOB_CANCELLED',
      details: `Job ${jobId} cancelled by user ${userId}. Status transitioned to CANCELLED.`,
      userId
    }
  });

  return updated;
}

/**
 * Reschedules a failed/expired job back to SCHEDULED.
 */
export async function retryJob(
  tx: Prisma.TransactionClient,
  jobId: string,
  userId: string
): Promise<VideoJob> {
  const job = await tx.videoJob.findUnique({
    where: { id: jobId }
  });

  if (!job) {
    throw new Error(`Job ${jobId} not found.`);
  }

  if (job.userId !== userId) {
    throw new Error(`Permission denied: Job ${jobId} is not owned by user ${userId}.`);
  }

  const eligibleForRetry = (
    [
      JobStatus.FAILED_RETRYABLE,
      JobStatus.FAILED_PERMANENT,
      JobStatus.CANCELLED,
      JobStatus.FACEBOOK_RECONNECT_REQUIRED
    ] as JobStatus[]
  ).includes(job.status);

  if (!eligibleForRetry) {
    throw new Error(`Job in status ${job.status} cannot be rescheduled/retried.`);
  }

  // Guarded transition check for FACEBOOK_RECONNECT_REQUIRED
  if (job.status === JobStatus.FACEBOOK_RECONNECT_REQUIRED) {
    const page = await tx.facebookPage.findUnique({
      where: { id: job.pageId },
      include: { facebookAccount: true }
    });

    if (!page || !page.isSynced || page.facebookAccount.tokenExpiresAt < new Date()) {
      throw new Error('Guarded transition failure: Re-authentication or Page credentials re-validation required before retry.');
    }
  }

  const updated = await tx.videoJob.update({
    where: { id: jobId },
    data: {
      status: JobStatus.SCHEDULED,
      lockToken: null,
      lockedAt: null,
      lockExpiresAt: null,
      nextAttemptAt: null
    }
  });

  await tx.auditLog.create({
    data: {
      action: 'JOB_RESCHEDULED',
      details: `Job ${jobId} rescheduled to SCHEDULED for retry.`,
      userId
    }
  });

  return updated;
}

/**
 * Manually triggers execution for a job, bypassing scheduled time but enforcing state checks.
 */
export async function manualTriggerJob(
  tx: Prisma.TransactionClient,
  jobId: string,
  userId: string,
  workerUuid: string,
  leaseDurationMs: number = 10 * 60 * 1000
): Promise<VideoJob> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + leaseDurationMs);

  const job = await tx.videoJob.findUnique({
    where: { id: jobId }
  });

  if (!job) {
    throw new Error(`Job ${jobId} not found.`);
  }

  if (job.userId !== userId) {
    throw new Error(`Permission denied: Job ${jobId} is not owned by user ${userId}.`);
  }

  if (job.status !== JobStatus.SCHEDULED) {
    throw new Error(`Job in status ${job.status} cannot be manually executed.`);
  }

  if (job.attemptCount >= job.maxAttempts) {
    throw new Error(`Attempt limit exceeded: Job ${jobId} cannot be triggered (attemptCount: ${job.attemptCount}/${job.maxAttempts}).`);
  }

  const rows = await tx.$executeRaw`
    UPDATE "VideoJob"
    SET
      status = ${JobStatus.PREPARING}::"JobStatus",
      "lockToken" = ${workerUuid}::uuid,
      "lockedAt" = ${now},
      "lockExpiresAt" = ${expiresAt},
      "startedAt" = ${now},
      "attemptCount" = "attemptCount" + 1
    WHERE
      id = ${jobId}::uuid
      AND "userId" = ${userId}::uuid
      AND status = 'SCHEDULED'::"JobStatus"
      AND "attemptCount" < "maxAttempts"
      AND ("lockExpiresAt" IS NULL OR "lockExpiresAt" < ${now})
  `;

  if (rows === 0) {
    throw new Error(`Concurrency block: Job ${jobId} is already claimed or could not be locked.`);
  }

  const updated = await tx.videoJob.findUnique({
    where: { id: jobId }
  });

  if (!updated) {
    throw new Error(`Job ${jobId} vanished after update.`);
  }

  await tx.auditLog.create({
    data: {
      action: 'JOB_MANUAL_TRIGGER',
      details: `Job ${jobId} manually triggered by owner ${userId}. Status transitioned -> PREPARING. Attempt: ${updated.attemptCount}.`,
      userId
    }
  });

  return updated;
}

export interface BulkCreateScheduledJobsTx {
  facebookPage: {
    findMany(args: { where: { userId: string } }): Promise<Array<{ id: string; userId: string }>>;
  };
  videoJob: {
    create(args: {
      data: {
        userId: string;
        pageId: string;
        gcsVideoUri: string | null;
        storageUri: string | null;
        uploadAssetId: string | null;
        gcsThumbnailUri: string | null;
        englishTitle: string;
        englishCaption: string;
        hashtags: string | null;
        scheduledTimeUTC: Date;
        status: JobStatus;
        mockScenario: MockScenario | null;
        contentType: string;
      }
    }): Promise<VideoJob>;
  };
  auditLog: {
    create(args: {
      data: {
        action: string;
        details: string;
        userId: string;
      }
    }): Promise<{ id: string }>;
  };
}

/**
 * Validates, schedules, and logs bulk video publishing jobs inside a single transaction.
 * status assignment is controlled internally.
 */
export async function bulkCreateScheduledJobs(
  tx: BulkCreateScheduledJobsTx,
  userId: string,
  jobsData: Array<{
    pageId: string;
    gcsVideoUri?: string | null;
    storageUri?: string | null;
    uploadAssetId?: string | null;
    gcsThumbnailUri?: string | null;
    englishTitle: string;
    englishCaption: string;
    hashtags?: string | null;
    scheduledTimeUTC: Date;
    mockScenario?: MockScenario | null;
    contentType?: string;
  }>
): Promise<VideoJob[]> {
  // Validate page ownership for all pageIds
  const userPages = await tx.facebookPage.findMany({
    where: { userId }
  });

  const pageIds = new Set(userPages.map((p) => p.id));

  for (const job of jobsData) {
    if (!pageIds.has(job.pageId)) {
      throw new Error(`Unauthorized page association: Page ${job.pageId} is not owned by user.`);
    }
  }

  const createdJobs: VideoJob[] = [];
  for (const job of jobsData) {
    const created = await tx.videoJob.create({
      data: {
        userId,
        pageId: job.pageId,
        gcsVideoUri: job.gcsVideoUri || null,
        storageUri: job.storageUri || null,
        uploadAssetId: job.uploadAssetId || null,
        gcsThumbnailUri: job.gcsThumbnailUri || null,
        englishTitle: job.englishTitle,
        englishCaption: job.englishCaption,
        hashtags: job.hashtags || null,
        scheduledTimeUTC: job.scheduledTimeUTC,
        status: JobStatus.SCHEDULED,
        mockScenario: job.mockScenario || null,
        contentType: job.contentType || 'VIDEO'
      }
    });
    createdJobs.push(created);
  }

  await tx.auditLog.create({
    data: {
      action: 'BULK_JOB_CREATE',
      details: `User scheduled ${createdJobs.length} new video publishing jobs.`,
      userId
    }
  });

  return createdJobs;
}

