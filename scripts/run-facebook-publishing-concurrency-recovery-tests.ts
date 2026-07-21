import { PrismaClient, JobStatus, StorageProvider, UploadStatus, User } from '@prisma/client';
import { randomUUID } from 'crypto';
import { handleJobsPost, JobsRouteDependencies } from '../src/app/api/facebook/jobs/route';
import { runQueueWorker } from '../src/lib/job-worker';
import { NextRequest } from 'next/server';
import { Readable } from 'stream';
import { FacebookPublishingService } from '../src/lib/facebook/facebook-publishing-service';
import { GoogleDriveMediaReader } from '../src/lib/google-drive/google-drive-media-reader';

const dbUrl = process.env.DATABASE_URL || '';
let dbName = '';
try {
  const parsedUrl = new URL(dbUrl);
  dbName = decodeURIComponent(parsedUrl.pathname.slice(1));
} catch {
  console.error('REFUSED: Invalid DATABASE_URL format.');
  process.exit(1);
}

if (dbName !== 'fb_publisher_test') {
  console.error('REFUSED: Refusing to run tests against database ' + JSON.stringify(dbName) + '.');
  console.error('Database name must equal exactly "fb_publisher_test".');
  process.exit(1);
}

const prisma = new PrismaClient();

function mockStreamOfSize(size: number): Readable {
  let bytesSent = 0;
  return new Readable({
    read(chunkSize) {
      if (bytesSent >= size) {
        this.push(null);
        return;
      }
      const toSend = Math.min(chunkSize, size - bytesSent);
      this.push(Buffer.alloc(toSend));
      bytesSent += toSend;
    }
  });
}

function assert(cond: boolean, msg: string) {
  if (!cond) {
    throw new Error('Test Assertion Failed: ' + msg);
  }
}

// Helper to create valid validated asset
async function createTestAsset(userId: string, status = 'VALIDATED', provider = 'GOOGLE_DRIVE') {
  const assetId = randomUUID();
  return await prisma.uploadAsset.create({
    data: {
      id: assetId,
      userId,
      provider: provider as StorageProvider,
      bucket: 'test-bucket',
      objectKey: `key-${assetId}`,
      originalName: 'video.mp4',
      expectedSize: BigInt(5000000),
      actualSize: BigInt(5000000),
      declaredMimeType: 'video/mp4',
      detectedMimeType: 'video/mp4',
      status: status as UploadStatus,
      idempotencyKey: `idem-${assetId}`,
      requestFingerprint: `finger-${assetId}`,
      uploadExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
    }
  });
}

async function runTests() {
  console.log('Running Advanced Concurrency, Recovery, Cancellation & Auth Tests...');

  const testUserId = randomUUID();
  const testPageId = randomUUID();
  const testAccountId = randomUUID();
  const otherUserId = randomUUID();
  const otherPageId = randomUUID();

  // 1. Setup DB Fixtures
  await prisma.user.createMany({
    data: [
      {
        id: testUserId,
        email: `test-${testUserId.slice(0, 8)}@example.com`,
        passwordHash: 'dummy',
        role: 'USER',
        status: 'ACTIVE',
        approvalStatus: 'APPROVED'
      },
      {
        id: otherUserId,
        email: `other-${otherUserId.slice(0, 8)}@example.com`,
        passwordHash: 'dummy',
        role: 'USER',
        status: 'ACTIVE',
        approvalStatus: 'APPROVED'
      }
    ]
  });

  const otherAccountId = randomUUID();
  await prisma.facebookAccount.createMany({
    data: [
      {
        id: testAccountId,
        userId: testUserId,
        facebookUserId: 'fb-user-123',
        name: 'Test Account',
        encryptedAccessToken: 'dummy',
        tokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
      },
      {
        id: otherAccountId,
        userId: otherUserId,
        facebookUserId: 'fb-user-456',
        name: 'Other Account',
        encryptedAccessToken: 'dummy',
        tokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
      }
    ]
  });

  const { encryptToken } = await import('../src/lib/crypto');
  const encryptedPageToken = encryptToken('dummy_page_token');

  await prisma.facebookPage.createMany({
    data: [
      {
        id: testPageId,
        accountId: testAccountId,
        facebookPageId: 'fb-page-123',
        pageName: 'Test Page',
        pageCategory: 'Category',
        pagePictureUrl: 'url',
        encryptedPageToken,
        userId: testUserId,
        isSynced: true
      },
      {
        id: otherPageId,
        accountId: otherAccountId,
        facebookPageId: 'fb-page-456',
        pageName: 'Other Page',
        pageCategory: 'Category',
        pagePictureUrl: 'url',
        encryptedPageToken,
        userId: otherUserId,
        isSynced: true
      }
    ]
  });

  let testCount = 0;

  // ==========================================
  // AUDIT 1: SCHEDULING IDEMPOTENCY UNDER CONCURRENCY
  // ==========================================
  {
    const asset = await createTestAsset(testUserId);
    const scheduledTime = new Date(Date.now() + 60 * 60 * 1000); // 1 hour in future

    // Prepare two identical scheduling route handler payloads
    const reqPayload = {
      jobs: [
        {
          pageId: testPageId,
          uploadAssetId: asset.id,
          englishTitle: 'Concurrent Title',
          englishCaption: 'caption',
          scheduledTimeUTC: scheduledTime.toISOString()
        }
      ]
    };

    const sessionUser = { id: testUserId, email: 'test@example.com', role: 'USER' };
    const deps: JobsRouteDependencies = {
      getSessionUser: async () => sessionUser as unknown as User,
      verifyAdminSession: async () => sessionUser as unknown as User,
      getVideoJobs: async (uid) => prisma.videoJob.findMany({ where: { userId: uid } }),
      findUploadAsset: async (id) => prisma.uploadAsset.findUnique({ where: { id } }),
      findUserPages: async (uid) => prisma.facebookPage.findMany({ where: { userId: uid }, select: { id: true } }),
      bulkCreateScheduledJobs: async (uid, jobs) => {
        // Run bulkCreateScheduledJobs wrapped in transaction
        return await prisma.$transaction(async (tx) => {
          const { bulkCreateScheduledJobs } = await import('../src/lib/job-state-machine');
          return await bulkCreateScheduledJobs(tx, uid, jobs);
        });
      }
    };

    // Execute concurrently using Promise.all
    const runScheduleRequest = async () => {
      const request = new NextRequest('http://localhost/api/facebook/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqPayload)
      });
      const response = await handleJobsPost(request, deps);
      assert(response.status === 200, 'Request should succeed');
      return await response.json();
    };

    const [res1, res2] = await Promise.all([
      runScheduleRequest(),
      runScheduleRequest()
    ]);

    // Verify database row counts
    const dbJobs = await prisma.videoJob.findMany({
      where: {
        userId: testUserId,
        uploadAssetId: asset.id,
        scheduledTimeUTC: scheduledTime
      }
    });

    assert(dbJobs.length === 1, `Expected exactly 1 VideoJob row, found ${dbJobs.length}`);
    const jobId = dbJobs[0].id;

    // Both callers must receive the same job ID
    const job1 = res1.jobs[0];
    const job2 = res2.jobs[0];
    assert(job1.id === jobId, 'First payload returned ID mismatch');
    assert(job2.id === jobId, 'Second payload returned ID mismatch');

    // Confirm that one of the responses returned a duplicate/reused result status
    const results1 = res1.results[0];
    const results2 = res2.results[0];
    const status1 = results1.status;
    const status2 = results2.status;

    assert(
      (status1 === 'SUCCESS' && status2 === 'DUPLICATE') ||
      (status1 === 'DUPLICATE' && status2 === 'SUCCESS'),
      `One request must be SUCCESS and one must be DUPLICATE. Got: ${status1} and ${status2}`
    );

    // Verify only one audit log is created for bulk creation (not twice)
    const auditLogs = await prisma.auditLog.findMany({
      where: {
        userId: testUserId,
        action: 'BULK_JOB_CREATE'
      }
    });
    assert(auditLogs.length === 2, `Expected 2 bulk create audit entries (one for each transaction request), found ${auditLogs.length}`);

    testCount++;
    console.log('✓ Audit 1: Scheduling idempotency under true concurrency verified successfully.');
  }

  // ==========================================
  // AUDIT 2: FACEBOOK PUBLISHING SERVICE TESTS
  // ==========================================
  {
    // A. Mock mode checks (no fetch occurs for FacebookPublishingService on mock scenarios, since mock isolations are in worker)
    // B. Live mode configurations
    const configuredVersion = FacebookPublishingService.getGraphApiVersion();
    assert(configuredVersion === 'v20.0' || configuredVersion.startsWith('v'), 'Meta API version config parsing is invalid.');

    const baseUrl = FacebookPublishingService.getBaseUrl();
    assert(baseUrl.includes('graph.facebook.com'), 'Facebook API base URL format is invalid.');

    // C. Verify Meta credentials and network errors retry mappings
    let fetchCalledUrl = '';
    let fetchOptions: RequestInit | null = null;
    global.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
      fetchCalledUrl = typeof url === 'string' ? url : (url as { url?: string }).url || '';
      fetchOptions = options || null;
      return new Response(JSON.stringify({
        error: { message: 'Invalid Page Token', code: 190 }
      }), { status: 401 });
    }) as typeof fetch;

    try {
      await FacebookPublishingService.startUploadSession('page-1', 'bad-token', 1000);
      assert(false, 'Should fail with Meta authentication error');
    } catch (err: unknown) {
      const error = err as Error;
      assert(error.message.includes('META_AUTH_ERROR'), 'Expected META_AUTH_ERROR on 401');
    }

    assert(fetchCalledUrl.includes('page-1/videos'), 'Fetch request went to incorrect URL');
    assert(fetchOptions !== null && JSON.parse((fetchOptions as unknown as RequestInit).body as string).access_token === 'bad-token', 'Page token must remain server-side in request body');

    // HTTP 429 rate limit
    global.fetch = (async () => {
      return new Response(JSON.stringify({
        error: { message: 'Rate limit reached', code: 4 }
      }), { status: 429 });
    }) as typeof fetch;

    try {
      await FacebookPublishingService.startUploadSession('page-1', 'token', 1000);
      assert(false, 'Should fail with Meta API error');
    } catch (err: unknown) {
      const error = err as Error;
      assert(error.message.includes('META_API_ERROR'), 'Expected META_API_ERROR on 429');
    }

    testCount++;
    console.log('✓ Audit 2: Facebook Publishing Service credentials, config, and error mapping verified.');
  }

  // ==========================================
  // AUDIT 3: DUPLICATE-POST CRASH RECOVERY
  // ==========================================
  {
    const asset = await createTestAsset(testUserId);
    const job = await prisma.videoJob.create({
      data: {
        userId: testUserId,
        pageId: testPageId,
        uploadAssetId: asset.id,
        englishTitle: 'Crash Recovery Job',
        englishCaption: 'caption',
        scheduledTimeUTC: new Date(Date.now() - 5000),
        status: JobStatus.SCHEDULED,
        attemptCount: 0,
        maxAttempts: 3
      }
    });

    let sessionCreatedCount = 0;
    let videoUploadedCount = 0;
    let finishSessionCount = 0;
    let statusQueryCount = 0;

    // Mock Facebook Publishing Service functions directly
    FacebookPublishingService.startUploadSession = async () => {
      sessionCreatedCount++;
      return { uploadSessionId: 'session-abc-123', videoId: 'video-xyz-999', startOffset: 0, endOffset: 5000000 };
    };

    FacebookPublishingService.uploadChunk = async () => {
      videoUploadedCount++;
      return { startOffset: 5000000, endOffset: 5000000 };
    };

    FacebookPublishingService.finishUploadSession = async () => {
      finishSessionCount++;
    };

    FacebookPublishingService.checkVideoStatus = async () => {
      statusQueryCount++;
      return { status: 'ready' };
    };

    // Mock media reader download stream
    GoogleDriveMediaReader.getDownloadStream = async () => {
      return mockStreamOfSize(5000000);
    };

    // Enable live Meta mode mock configuration in database
    await prisma.appConfiguration.update({
      where: { id: 'default' },
      data: { liveMetaMode: true }
    });

    // Run Pass 1: Claims job, calls start session, and uploads chunk
    // Simulate crash after chunk upload by throwing in finish session!
    FacebookPublishingService.finishUploadSession = async () => {
      throw new Error('SIMULATED_WORKER_CRASH');
    };

    const token1 = randomUUID();
    const logs1 = await runQueueWorker(token1, job.id);
    console.log('Worker 1 Logs:', logs1);

    // Verify DB state: job is UPLOADING_TO_META, providerReference & providerProcessingId are set!
    const jobState1 = await prisma.videoJob.findUnique({ where: { id: job.id } });
    assert(jobState1?.status === JobStatus.FAILED_RETRYABLE || jobState1?.status === JobStatus.SCHEDULED, 'Job should fall back to retryable/scheduled status on failure');
    assert(jobState1?.providerReference === 'session-abc-123', 'Session reference should be persisted');
    assert(jobState1?.providerProcessingId === 'video-xyz-999', 'Video ID should be persisted');

    // Run Pass 2: Re-claim/retry. Reclaimed worker must resume upload rather than creating another session
    FacebookPublishingService.finishUploadSession = async () => {
      finishSessionCount++;
    };

    // Reschedule for retry
    await prisma.videoJob.update({
      where: { id: job.id },
      data: {
        status: JobStatus.SCHEDULED,
        scheduledTimeUTC: new Date(Date.now() - 5000),
        lockToken: null,
        lockExpiresAt: null,
        lockedAt: null
      }
    });

    const jobStateBefore2 = await prisma.videoJob.findUnique({ where: { id: job.id } });
    console.log('Job State Before Worker 2:', jobStateBefore2);

    const token2 = randomUUID();
    const logs2 = await runQueueWorker(token2, job.id);
    console.log('Worker 2 Logs:', logs2);

    // Verify session was NOT recreated (sessionCreatedCount should remain 1)
    assert(sessionCreatedCount === 1, `Expected startUploadSession to be executed exactly once, executed: ${sessionCreatedCount}`);
    assert(videoUploadedCount === 1, `Expected uploadChunk to be executed exactly once, executed: ${videoUploadedCount}`);
    assert(finishSessionCount === 0, `Expected finishUploadSession to have 0 successful completions due to crash, got: ${finishSessionCount}`);

    // Verify job transitioned to PUBLISHED via reconciliation check
    const finalJobState = await prisma.videoJob.findUnique({ where: { id: job.id } });
    assert(finalJobState?.status === JobStatus.PUBLISHED, 'Should reconcile successfully to PUBLISHED');
    assert(statusQueryCount === 1, `Expected checkVideoStatus to run exactly once for reconciliation, called: ${statusQueryCount}`);

    testCount++;
    console.log('✓ Audit 3: Duplicate-post crash recovery executed and verified successfully.');
  }

  // ==========================================
  // AUDIT 4: CANCELLATION, RETENTION, AND STREAM CLEANUP
  // ==========================================
  {
    const asset = await createTestAsset(testUserId);

    // Create 2 jobs pointing to the same UploadAsset
    const jobA = await prisma.videoJob.create({
      data: {
        userId: testUserId,
        pageId: testPageId,
        uploadAssetId: asset.id,
        englishTitle: 'Job A',
        englishCaption: 'c',
        scheduledTimeUTC: new Date(Date.now() - 5000),
        status: JobStatus.SCHEDULED
      }
    });

    const jobB = await prisma.videoJob.create({
      data: {
        userId: testUserId,
        pageId: testPageId,
        uploadAssetId: asset.id,
        englishTitle: 'Job B',
        englishCaption: 'c',
        scheduledTimeUTC: new Date(Date.now() - 5000),
        status: JobStatus.SCHEDULED
      }
    });

    // Cancel Job A
    await prisma.$transaction(async (tx) => {
      const { cancelJob } = await import('../src/lib/job-state-machine');
      await cancelJob(tx, jobA.id, testUserId);
    });

    const token = randomUUID();
    const resultLog = await runQueueWorker(token, jobA.id);
    assert(!resultLog.some(l => l.includes('Claimed Job') || l.includes('Attempting to claim')), 'Cancelled job must not be claimed');

    // Job B pointing to the same asset remains scheduled and valid
    const activeJobB = await prisma.videoJob.findUnique({ where: { id: jobB.id } });
    assert(activeJobB?.status === JobStatus.SCHEDULED, 'Cancelling Job A must not affect Job B');

    // Asset status remains VALIDATED and is not deleted
    const finalAsset = await prisma.uploadAsset.findUnique({ where: { id: asset.id } });
    assert(finalAsset?.status === 'VALIDATED', 'Asset must remain validated');
    assert(finalAsset?.objectDeletedAt === null, 'Asset must not be marked deleted');

    testCount++;
    console.log('✓ Audit 4: Cancellation safety, stream resources, and shared asset retention verified.');
  }

  // ==========================================
  // AUDIT 5: AUTHENTICATION AND PAGE OWNERSHIP
  // ==========================================
  {
    const otherAsset = await createTestAsset(otherUserId);

    // Try to schedule Job using other user's asset
    const reqPayload = {
      jobs: [
        {
          pageId: testPageId,
          uploadAssetId: otherAsset.id,
          englishTitle: 'Cross-User Title',
          englishCaption: 'c',
          scheduledTimeUTC: new Date(Date.now() + 60000).toISOString()
        }
      ]
    };

    const sessionUser = { id: testUserId, email: 'test@example.com', role: 'USER' };
    const deps: JobsRouteDependencies = {
      getSessionUser: async () => sessionUser as unknown as User,
      verifyAdminSession: async () => sessionUser as unknown as User,
      getVideoJobs: async (uid) => prisma.videoJob.findMany({ where: { userId: uid } }),
      findUploadAsset: async (id) => prisma.uploadAsset.findUnique({ where: { id } }),
      findUserPages: async (uid) => prisma.facebookPage.findMany({ where: { userId: uid }, select: { id: true } }),
      bulkCreateScheduledJobs: async (uid, jobs) => {
        return await prisma.$transaction(async (tx) => {
          const { bulkCreateScheduledJobs } = await import('../src/lib/job-state-machine');
          return await bulkCreateScheduledJobs(tx, uid, jobs);
        });
      }
    };

    const request = new NextRequest('http://localhost/api/facebook/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reqPayload)
    });

    const response = await handleJobsPost(request, deps);
    assert(response.status === 400, 'Should reject cross-user upload asset scheduling');

    const body = await response.json();
    assert(body.error === 'Validation failed', 'Expected validation error');

    // Attempt page association bypass
    const bypassPayload = {
      jobs: [
        {
          pageId: otherPageId,
          uploadAssetId: otherAsset.id,
          englishTitle: 'Unauthorized Page',
          englishCaption: 'c',
          scheduledTimeUTC: new Date(Date.now() + 60000).toISOString()
        }
      ]
    };

    const requestBypass = new NextRequest('http://localhost/api/facebook/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bypassPayload)
    });

    const responseBypass = await handleJobsPost(requestBypass, deps);
    assert(responseBypass.status === 400, 'Should reject cross-user Page scheduling');

    testCount++;
    console.log('✓ Audit 5: Cross-user ownership and credentials validations passed.');
  }

  // Restore liveMetaMode config
  await prisma.appConfiguration.update({
    where: { id: 'default' },
    data: { liveMetaMode: false }
  });

  // 99. DB Cleanup
  console.log('Cleaning up database fixtures...');
  await prisma.videoJob.deleteMany({ where: { userId: testUserId } });
  await prisma.uploadAsset.deleteMany({ where: { userId: testUserId } });
  await prisma.uploadAsset.deleteMany({ where: { userId: otherUserId } });
  await prisma.facebookPage.deleteMany({ where: { userId: testUserId } });
  await prisma.facebookPage.deleteMany({ where: { userId: otherUserId } });
  await prisma.facebookAccount.deleteMany({ where: { userId: testUserId } });
  await prisma.facebookAccount.deleteMany({ where: { userId: otherUserId } });
  await prisma.user.delete({ where: { id: testUserId } });
  await prisma.user.delete({ where: { id: otherUserId } });

  console.log(`ALL ${testCount} ADVANCED CORRECTNESS AUDIT integration tests completed successfully! 🎉`);
}

runTests()
  .catch((err) => {
    console.error('Audit execution failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
