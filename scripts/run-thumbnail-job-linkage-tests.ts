import fs from 'node:fs';
import path from 'node:path';

import {
  JobStatus,
  MockScenario,
  UserApprovalStatus,
  UserRole,
  UserStatus,
  type User,
  type VideoJob,
} from '@prisma/client';
import { NextRequest } from 'next/server';

import {
  handleJobsPost,
  type JobsRouteDependencies,
} from '../src/app/api/facebook/jobs/route';
import {
  bulkCreateScheduledJobs,
  type BulkCreateScheduledJobsTx,
} from '../src/lib/job-state-machine';
import {
  buildThumbnailGenerationUrl,
  getThumbnailGenerationErrorMessage,
  parseThumbnailGenerationResponse,
  requestPersistedThumbnailWithRetry,
} from '../src/lib/thumbnails/thumbnail-dashboard-client';

const USER_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PAGE_ID = '22222222-2222-2222-2222-222222222222';
const UPLOAD_ID = '33333333-3333-3333-3333-333333333333';
const OTHER_UPLOAD_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const THUMBNAIL_ID = '44444444-4444-4444-4444-444444444444';

function assert(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function assertRejects(
  action: () => Promise<unknown>,
  expectedMessage: string,
): Promise<void> {
  let thrown: unknown;

  try {
    await action();
  } catch (error: unknown) {
    thrown = error;
  }

  assert(thrown instanceof Error, 'Expected action to reject.');
  assert(
    thrown.message.includes(expectedMessage),
    `Expected error containing "${expectedMessage}", received "${thrown.message}".`,
  );
}

function createUser(): User {
  const now = new Date();

  return {
    id: USER_ID,
    email: 'owner@example.com',
    passwordHash: 'test-hash',
    name: 'Owner',
    role: UserRole.USER,
    status: UserStatus.ACTIVE,
    approvalStatus: UserApprovalStatus.APPROVED,
    approvedAt: now,
    approvedById: null,
    rejectedAt: null,
    rejectionReason: null,
    registrationIp: null,
    lastLoginAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

function createVideoJob(
  overrides: Partial<VideoJob> = {},
): VideoJob {
  const now = new Date();

  return {
    id: '55555555-5555-5555-5555-555555555555',
    pageId: PAGE_ID,
    gcsVideoUri: null,
    storageUri: 'gdrive://source-file-id',
    gcsThumbnailUri: null,
    thumbnailAssetId: THUMBNAIL_ID,
    englishTitle: 'Title',
    englishCaption: 'Caption',
    hashtags: '#One #Two',
    scheduledTimeUTC: new Date(Date.now() + 10 * 60 * 1000),
    status: JobStatus.SCHEDULED,
    contentType: 'VIDEO',
    metaPostId: null,
    cloudTaskName: null,
    retryCount: 0,
    maxAttempts: 3,
    attemptCount: 0,
    lastErrorCode: null,
    lastErrorMessage: null,
    failureClassification: null,
    providerReference: null,
    providerProcessingId: null,
    mockScenario: MockScenario.SUCCESS,
    attempts: null,
    lockToken: null,
    lockedAt: null,
    lockExpiresAt: null,
    nextAttemptAt: null,
    startedAt: null,
    completedAt: null,
    failedAt: null,
    errorLog: null,
    userId: USER_ID,
    uploadAssetId: UPLOAD_ID,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createRequest(
  job: Record<string, unknown>,
): NextRequest {
  return new NextRequest(
    'http://localhost:3000/api/facebook/jobs',
    {
      method: 'POST',
      headers: {
        host: 'localhost:3000',
        origin: 'http://localhost:3000',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jobs: [job] }),
    },
  );
}

function createRouteDependencies(input?: {
  thumbnail?: {
    id: string;
    userId: string;
    sourceUploadAssetId: string;
    provider: string;
    storageUri: string;
    deletedAt: Date | null;
  } | null;
  capture?: {
    jobs?: Array<Parameters<typeof bulkCreateScheduledJobs>[2][number]>;
  };
}): JobsRouteDependencies {
  const user = createUser();

  return {
    getSessionUser: async () => user,
    verifyAdminSession: async () => user,
    getVideoJobs: async () => [],
    findUploadAsset: async (id) => {
      if (id !== UPLOAD_ID) {
        return null;
      }

      return {
        id: UPLOAD_ID,
        userId: USER_ID,
        status: 'VALIDATED',
        provider: 'GOOGLE_DRIVE',
        bucket: 'drive-folder-id',
        objectKey: 'source-file-id',
        objectDeletedAt: null,
      };
    },
    findThumbnailAsset: async (id) => {
      if (id !== THUMBNAIL_ID) {
        return null;
      }

      return input?.thumbnail === undefined
        ? {
            id: THUMBNAIL_ID,
            userId: USER_ID,
            sourceUploadAssetId: UPLOAD_ID,
            provider: 'GOOGLE_DRIVE',
            storageUri: 'gdrive://thumbnail-file-id',
            deletedAt: null,
          }
        : input.thumbnail;
    },
    findUserPages: async () => [{ id: PAGE_ID }],
    bulkCreateScheduledJobs: async (userId, jobs) => {
      if (input?.capture) {
        input.capture.jobs = jobs;
      }

      return jobs.map((job) => ({
        ...createVideoJob({
          userId,
          pageId: job.pageId,
          uploadAssetId: job.uploadAssetId ?? null,
          thumbnailAssetId: job.thumbnailAssetId ?? null,
          gcsVideoUri: job.gcsVideoUri ?? null,
          storageUri: job.storageUri ?? null,
          gcsThumbnailUri: job.gcsThumbnailUri ?? null,
          englishTitle: job.englishTitle,
          englishCaption: job.englishCaption,
          hashtags: job.hashtags ?? null,
          scheduledTimeUTC: job.scheduledTimeUTC,
          mockScenario: job.mockScenario ?? MockScenario.SUCCESS,
          contentType: job.contentType ?? 'VIDEO',
        }),
        isReused: false,
        accessToken: 'must-not-leak',
        bucket: 'must-not-leak',
        objectKey: 'must-not-leak',
      }));
    },
  };
}

function createValidJob(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    pageId: PAGE_ID,
    uploadAssetId: UPLOAD_ID,
    thumbnailAssetId: THUMBNAIL_ID,
    englishTitle: 'Scheduled video',
    englishCaption: 'Caption',
    hashtags: '#One #Two',
    scheduledTimeUTC: new Date(
      Date.now() + 10 * 60 * 1000,
    ).toISOString(),
    contentType: 'VIDEO',
    ...overrides,
  };
}

async function runRouteTests(): Promise<void> {
  console.log('Thumbnail job-linkage route tests...');

  const capture: {
    jobs?: Array<Parameters<typeof bulkCreateScheduledJobs>[2][number]>;
  } = {};
  let response = await handleJobsPost(
    createRequest(createValidJob()),
    createRouteDependencies({ capture }),
  );

  assert(response.status === 200, 'Valid thumbnail linkage should schedule successfully.');
  const validBody = await response.json() as {
    jobs: Array<Record<string, unknown>>;
    results: Array<{ status: string }>;
  };
  assert(capture.jobs?.[0]?.thumbnailAssetId === THUMBNAIL_ID, 'Validated thumbnail ID must reach transaction input.');
  assert(capture.jobs?.[0]?.gcsThumbnailUri === null, 'Legacy thumbnail URI must stay server-controlled and null.');
  assert(validBody.jobs[0].thumbnailAssetId === THUMBNAIL_ID, 'Safe response should expose thumbnailAssetId.');
  assert(!('gcsVideoUri' in validBody.jobs[0]), 'Safe response must omit gcsVideoUri.');
  assert(!('storageUri' in validBody.jobs[0]), 'Safe response must omit storageUri.');
  assert(!('gcsThumbnailUri' in validBody.jobs[0]), 'Safe response must omit gcsThumbnailUri.');
  assert(!('bucket' in validBody.jobs[0]), 'Safe response must omit bucket.');
  assert(!('objectKey' in validBody.jobs[0]), 'Safe response must omit objectKey.');
  assert(!('accessToken' in validBody.jobs[0]), 'Safe response must omit credentials.');
  console.log('  ✓ valid owned thumbnail is linked and response is sanitized');

  response = await handleJobsPost(
    createRequest(createValidJob({ gcsThumbnailUri: null })),
    createRouteDependencies(),
  );
  assert(response.status === 400, 'Browser-supplied legacy thumbnail field must be rejected even when null.');
  assert(
    JSON.stringify(await response.json()).includes('thumbnail storage references'),
    'Legacy thumbnail field rejection should be explicit.',
  );
  console.log('  ✓ browser-supplied thumbnail storage fields are rejected');

  response = await handleJobsPost(
    createRequest(createValidJob({ gcsVideoUri: null })),
    createRouteDependencies(),
  );
  assert(response.status === 400, 'Browser-supplied video storage field must be rejected even when null.');
  assert(
    JSON.stringify(await response.json()).includes('storage references'),
    'Video storage-field rejection should be explicit.',
  );
  console.log('  ✓ browser-supplied video storage fields are rejected even when null');

  response = await handleJobsPost(
    createRequest(createValidJob({ thumbnailAssetId: '' })),
    createRouteDependencies(),
  );
  assert(response.status === 400, 'Empty thumbnailAssetId must be rejected.');
  assert(
    JSON.stringify(await response.json()).includes('valid UUID'),
    'Empty thumbnail ID rejection should be explicit.',
  );
  console.log('  ✓ empty thumbnail asset IDs are rejected');

  response = await handleJobsPost(
    createRequest(createValidJob()),
    createRouteDependencies({
      thumbnail: {
        id: THUMBNAIL_ID,
        userId: OTHER_USER_ID,
        sourceUploadAssetId: UPLOAD_ID,
        provider: 'GOOGLE_DRIVE',
        storageUri: 'gdrive://thumbnail-file-id',
        deletedAt: null,
      },
    }),
  );
  assert(response.status === 400, 'Cross-user thumbnail must be rejected.');
  assert(JSON.stringify(await response.json()).includes('Unauthorized thumbnail asset'), 'Cross-user error missing.');
  console.log('  ✓ cross-user thumbnail is rejected');

  response = await handleJobsPost(
    createRequest(createValidJob()),
    createRouteDependencies({
      thumbnail: {
        id: THUMBNAIL_ID,
        userId: USER_ID,
        sourceUploadAssetId: OTHER_UPLOAD_ID,
        provider: 'GOOGLE_DRIVE',
        storageUri: 'gdrive://thumbnail-file-id',
        deletedAt: null,
      },
    }),
  );
  assert(response.status === 400, 'Thumbnail from another upload must be rejected.');
  assert(JSON.stringify(await response.json()).includes('does not belong to the selected upload asset'), 'Source-upload mismatch error missing.');
  console.log('  ✓ thumbnail/source upload mismatch is rejected');

  response = await handleJobsPost(
    createRequest(createValidJob()),
    createRouteDependencies({
      thumbnail: {
        id: THUMBNAIL_ID,
        userId: USER_ID,
        sourceUploadAssetId: UPLOAD_ID,
        provider: 'GOOGLE_DRIVE',
        storageUri: 'gdrive://thumbnail-file-id',
        deletedAt: new Date(),
      },
    }),
  );
  assert(response.status === 400, 'Soft-deleted thumbnail must be rejected.');
  assert(JSON.stringify(await response.json()).includes('Thumbnail asset is deleted'), 'Deleted-thumbnail error missing.');
  console.log('  ✓ deleted thumbnail is rejected');

  const noThumbnailCapture: {
    jobs?: Array<Parameters<typeof bulkCreateScheduledJobs>[2][number]>;
  } = {};
  const noThumbnailJob = createValidJob();
  delete noThumbnailJob.thumbnailAssetId;
  response = await handleJobsPost(
    createRequest(noThumbnailJob),
    createRouteDependencies({ capture: noThumbnailCapture }),
  );
  assert(response.status === 200, 'Facebook Auto job without thumbnail should remain supported.');
  assert(noThumbnailCapture.jobs?.[0]?.thumbnailAssetId === null, 'No-thumbnail job should store null linkage.');
  console.log('  ✓ legacy no-thumbnail scheduling remains supported');
}

async function runTransactionTests(): Promise<void> {
  console.log('Thumbnail transaction linkage tests...');

  let createdData: Parameters<BulkCreateScheduledJobsTx['videoJob']['create']>[0]['data'] | undefined;
  let duplicateWhere: Parameters<NonNullable<BulkCreateScheduledJobsTx['videoJob']['findFirst']>>[0]['where'] | undefined;
  const transactionOrder: string[] = [];
  const tx: BulkCreateScheduledJobsTx = {
    $executeRaw: async () => {
      transactionOrder.push('lock');
      return 1;
    },
    facebookPage: {
      findMany: async () => [{ id: PAGE_ID, userId: USER_ID }],
    },
    thumbnailAsset: {
      findMany: async () => {
        transactionOrder.push('thumbnail-revalidation');
        return [{
          id: THUMBNAIL_ID,
          userId: USER_ID,
          sourceUploadAssetId: UPLOAD_ID,
          deletedAt: null,
        }];
      },
    },
    videoJob: {
      findFirst: async ({ where }) => {
        duplicateWhere = where;
        return null;
      },
      create: async ({ data }) => {
        createdData = data;
        return createVideoJob({
          userId: data.userId,
          pageId: data.pageId,
          uploadAssetId: data.uploadAssetId,
          thumbnailAssetId: data.thumbnailAssetId,
          gcsVideoUri: data.gcsVideoUri,
          storageUri: data.storageUri,
          gcsThumbnailUri: data.gcsThumbnailUri,
          englishTitle: data.englishTitle,
          englishCaption: data.englishCaption,
          hashtags: data.hashtags,
          scheduledTimeUTC: data.scheduledTimeUTC,
          status: data.status,
          mockScenario: data.mockScenario,
          contentType: data.contentType,
        });
      },
    },
    auditLog: {
      create: async () => ({ id: '66666666-6666-6666-6666-666666666666' }),
    },
  };

  const scheduledTime = new Date(Date.now() + 20 * 60 * 1000);
  const created = await bulkCreateScheduledJobs(
    tx,
    USER_ID,
    [{
      pageId: PAGE_ID,
      uploadAssetId: UPLOAD_ID,
      thumbnailAssetId: THUMBNAIL_ID,
      gcsVideoUri: null,
      storageUri: 'gdrive://source-file-id',
      gcsThumbnailUri: null,
      englishTitle: 'Title',
      englishCaption: 'Caption',
      hashtags: '#One',
      scheduledTimeUTC: scheduledTime,
      mockScenario: MockScenario.SUCCESS,
      contentType: 'VIDEO',
    }],
  );

  assert(created.length === 1, 'Expected one scheduled job.');
  assert(createdData?.thumbnailAssetId === THUMBNAIL_ID, 'Transaction create must persist thumbnailAssetId.');
  assert(
    transactionOrder.indexOf('lock') !== -1 &&
      transactionOrder.indexOf('thumbnail-revalidation') >
        transactionOrder.lastIndexOf('lock'),
    'Thumbnail ownership/state must be revalidated after all row locks are acquired.',
  );
  assert(duplicateWhere?.uploadAssetId === UPLOAD_ID, 'Duplicate identity must preserve uploadAssetId.');
  assert(!('thumbnailAssetId' in (duplicateWhere ?? {})), 'Duplicate identity must not allow a second job solely because the thumbnail changed.');
  console.log('  ✓ transaction revalidates and persists thumbnail linkage');

  const conflictTx: BulkCreateScheduledJobsTx = {
    ...tx,
    videoJob: {
      ...tx.videoJob,
      findFirst: async () => createVideoJob({
        thumbnailAssetId: null,
      }),
    },
  };

  await assertRejects(
    async () => await bulkCreateScheduledJobs(
      conflictTx,
      USER_ID,
      [{
        pageId: PAGE_ID,
        uploadAssetId: UPLOAD_ID,
        thumbnailAssetId: THUMBNAIL_ID,
        englishTitle: 'Title',
        englishCaption: '',
        scheduledTimeUTC: new Date(Date.now() + 25 * 60 * 1000),
      }],
    ),
    'different thumbnail',
  );
  console.log('  ✓ duplicate scheduling with a different thumbnail is rejected');

  const mismatchTx: BulkCreateScheduledJobsTx = {
    ...tx,
    thumbnailAsset: {
      findMany: async () => [{
        id: THUMBNAIL_ID,
        userId: USER_ID,
        sourceUploadAssetId: OTHER_UPLOAD_ID,
        deletedAt: null,
      }],
    },
  };

  await assertRejects(
    async () => await bulkCreateScheduledJobs(
      mismatchTx,
      USER_ID,
      [{
        pageId: PAGE_ID,
        uploadAssetId: UPLOAD_ID,
        thumbnailAssetId: THUMBNAIL_ID,
        englishTitle: 'Title',
        englishCaption: '',
        scheduledTimeUTC: new Date(Date.now() + 30 * 60 * 1000),
      }],
    ),
    'does not belong to the scheduled upload asset',
  );
  console.log('  ✓ transaction blocks thumbnail/source mismatch');

  const unavailableTx: BulkCreateScheduledJobsTx = {
    ...tx,
    thumbnailAsset: undefined,
  };

  await assertRejects(
    async () => await bulkCreateScheduledJobs(
      unavailableTx,
      USER_ID,
      [{
        pageId: PAGE_ID,
        uploadAssetId: UPLOAD_ID,
        thumbnailAssetId: THUMBNAIL_ID,
        englishTitle: 'Title',
        englishCaption: '',
        scheduledTimeUTC: new Date(Date.now() + 40 * 60 * 1000),
      }],
    ),
    'Thumbnail asset validation is unavailable',
  );
  console.log('  ✓ transaction refuses thumbnail linkage without validation delegate');
}

async function runDashboardClientTests(): Promise<void> {
  console.log('Thumbnail dashboard client tests...');

  assert(
    buildThumbnailGenerationUrl(UPLOAD_ID) === `/api/uploads/${UPLOAD_ID}/thumbnail`,
    'Thumbnail API URL is incorrect.',
  );

  const parsed = parseThumbnailGenerationResponse(
    {
      success: true,
      reused: false,
      thumbnail: {
        id: THUMBNAIL_ID,
        sourceUploadAssetId: UPLOAD_ID,
        source: 'MANUAL_FRAME',
        timestampSeconds: 2.5,
        mimeType: 'image/jpeg',
        sizeBytes: 12345,
        createdAt: new Date().toISOString(),
      },
    },
    UPLOAD_ID,
  );
  assert(parsed.thumbnail.id === THUMBNAIL_ID, 'Safe thumbnail response should parse.');

  let rejectedInvalidId = false;
  try {
    parseThumbnailGenerationResponse(
      {
        success: true,
        reused: false,
        thumbnail: {
          id: 'not-a-uuid',
          sourceUploadAssetId: UPLOAD_ID,
          source: 'MANUAL_FRAME',
          timestampSeconds: 2.5,
          mimeType: 'image/jpeg',
          sizeBytes: 12345,
          createdAt: new Date().toISOString(),
        },
      },
      UPLOAD_ID,
    );
  } catch {
    rejectedInvalidId = true;
  }
  assert(rejectedInvalidId, 'Dashboard parser must reject malformed thumbnail IDs.');

  let rejectedUnsafe = false;
  try {
    parseThumbnailGenerationResponse(
      {
        success: true,
        reused: false,
        thumbnail: {
          id: THUMBNAIL_ID,
          sourceUploadAssetId: UPLOAD_ID,
          source: 'MANUAL_FRAME',
          timestampSeconds: 2.5,
          mimeType: 'image/jpeg',
          sizeBytes: 12345,
          createdAt: new Date().toISOString(),
          storageUri: 'gdrive://must-not-be-exposed',
        },
      },
      UPLOAD_ID,
    );
  } catch {
    rejectedUnsafe = true;
  }
  assert(rejectedUnsafe, 'Dashboard parser must reject exposed storage metadata.');
  assert(
    getThumbnailGenerationErrorMessage(503, null).includes('Google Drive'),
    'Safe 503 error mapping is missing.',
  );

  let retryCalls = 0;
  let waitCalls = 0;
  const retryResult =
    await requestPersistedThumbnailWithRetry(
      {
        assetId: UPLOAD_ID,
        timestampSeconds: 2.5,
        source: 'MANUAL_FRAME',
      },
      {
        fetchImplementation:
          (async () => {
            retryCalls += 1;

            if (retryCalls < 3) {
              return new Response(
                'temporary proxy error',
                { status: 504 },
              );
            }

            return Response.json(
              {
                success: true,
                reused: true,
                thumbnail: {
                  id: THUMBNAIL_ID,
                  sourceUploadAssetId:
                    UPLOAD_ID,
                  source: 'MANUAL_FRAME',
                  timestampSeconds: 2.5,
                  mimeType: 'image/jpeg',
                  sizeBytes: 12345,
                  createdAt:
                    new Date().toISOString(),
                },
              },
              { status: 200 },
            );
          }) as typeof fetch,
        wait: async () => {
          waitCalls += 1;
        },
      },
    );

  assert(retryCalls === 3, 'Retryable thumbnail failures must be retried twice.');
  assert(waitCalls === 2, 'Automatic retries must use bounded backoff waits.');
  assert(retryResult.attempts === 3, 'Successful retry attempt count is incorrect.');
  assert(retryResult.reused, 'Completed thumbnail must be safely reused after retry.');

  let permanentCalls = 0;
  await assertRejects(
    async () =>
      await requestPersistedThumbnailWithRetry(
        {
          assetId: UPLOAD_ID,
          timestampSeconds: 2.5,
          source: 'MANUAL_FRAME',
        },
        {
          fetchImplementation:
            (async () => {
              permanentCalls += 1;
              return Response.json(
                {
                  message:
                    'Thumbnail timestamp is invalid.',
                },
                { status: 400 },
              );
            }) as typeof fetch,
          wait: async () => {
            throw new Error('Permanent failures must not wait or retry.');
          },
        },
      ),
    'Thumbnail timestamp is invalid.',
  );
  assert(permanentCalls === 1, 'Permanent thumbnail failures must not be retried.');
  console.log('  ✓ dashboard parser accepts safe metadata and rejects storage internals');
  console.log('  ✓ transient thumbnail failures retry automatically without retrying permanent errors');
}

function runSourceBoundaryTests(): void {
  console.log('Thumbnail source-boundary checks...');

  const root = process.cwd();
  const dashboard = fs.readFileSync(
    path.join(root, 'src/app/DashboardClient.tsx'),
    'utf8',
  );
  const queue = fs.readFileSync(
    path.join(root, 'src/lib/uploads/upload-queue-controller.ts'),
    'utf8',
  );
  const route = fs.readFileSync(
    path.join(root, 'src/app/api/facebook/jobs/route.ts'),
    'utf8',
  );
  const stateMachine = fs.readFileSync(
    path.join(root, 'src/lib/job-state-machine.ts'),
    'utf8',
  );

  assert(dashboard.includes('requestPersistedThumbnailWithRetry'), 'Dashboard must use resilient thumbnail generation requests.');
  assert(dashboard.includes('thumbnailAssetId:'), 'Dashboard scheduling payload must include thumbnailAssetId.');
  assert(dashboard.includes('Captured thumbnail must be generated and stored before scheduling.'), 'Dashboard must block unsaved captured thumbnails.');
  assert(!dashboard.includes('Local video URL not available. Frame capture is only supported for local uploaded files.'), 'Restored validated uploads must not be blocked by a missing local object URL.');
  assert(dashboard.includes('extracted server-side from the stored Google'), 'Dashboard must explain server-side frame extraction after refresh.');
  assert(dashboard.includes('job.localVideoUrl || ""'), 'Frame selection must open for restored validated uploads without a local preview URL.');
  assert(dashboard.includes('Generate Permanent Thumbnail'), 'Restored uploads must expose a server-side thumbnail action.');
  assert(queue.includes('thumbnailGenerationStatus'), 'Queue recovery must persist thumbnail generation state.');
  assert(queue.includes('thumbnailAssetId'), 'Queue recovery must persist thumbnailAssetId.');
  assert(route.includes('Manually specified thumbnail storage references are not accepted.'), 'Jobs route must reject browser thumbnail storage fields.');
  assert(route.includes("hasOwnProperty.call(job, 'gcsVideoUri')"), 'Jobs route must reject browser video storage fields even when null.');
  assert(stateMachine.includes('Lock source uploads and thumbnails before re-reading thumbnail ownership/state.'), 'Transaction must lock rows before thumbnail revalidation.');
  assert(stateMachine.includes('Thumbnail asset does not belong to the scheduled upload asset.'), 'Transaction must enforce source-upload linkage.');
  console.log('  ✓ dashboard, queue, route, and transaction boundaries are present');
}

async function main(): Promise<void> {
  await runDashboardClientTests();
  await runRouteTests();
  await runTransactionTests();
  runSourceBoundaryTests();

  console.log('PHASE6I_THUMBNAIL_JOB_LINKAGE_TESTS=PASSED');
  console.log('No real database, Google Drive, Gemini, FFmpeg, or Facebook call occurred.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
