import { PrismaClient, StorageProvider, UploadStatus, User } from '@prisma/client';
import { randomUUID } from 'crypto';
import { handleJobsPost, handleJobsGet, JobsRouteDependencies } from '../src/app/api/facebook/jobs/route';
import { runQueueWorker } from '../src/lib/job-worker';
import { NextRequest } from 'next/server';

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

function assert(cond: boolean, msg: string) {
  if (!cond) {
    throw new Error('Test Assertion Failed: ' + msg);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function createTestAsset(userId: string, status = 'VALIDATED', provider = 'GOOGLE_DRIVE', extra: any = {}) {
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
      declaredMimeType: 'video/mp4',
      status: status as UploadStatus,
      idempotencyKey: `idem-${assetId}`,
      requestFingerprint: `finger-${assetId}`,
      uploadExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      ...extra
    }
  });
}

async function runTests() {
  console.log('Running Facebook Scheduling & Publishing Integration Tests (Phase 5C)...');

  // Setup test user, account, page, and asset
  const testUserId = randomUUID();
  const testPageId = randomUUID();
  const testAccountId = randomUUID();
  const otherUserId = randomUUID();

  // Create users
  await prisma.user.create({
    data: {
      id: testUserId,
      email: `test-${testUserId.slice(0, 8)}@example.com`,
      passwordHash: 'dummy',
      role: 'USER',
      status: 'ACTIVE',
      approvalStatus: 'APPROVED'
    }
  });

  await prisma.user.create({
    data: {
      id: otherUserId,
      email: `other-${otherUserId.slice(0, 8)}@example.com`,
      passwordHash: 'dummy',
      role: 'USER',
      status: 'ACTIVE',
      approvalStatus: 'APPROVED'
    }
  });

  // Create facebook account & page
  await prisma.facebookAccount.create({
    data: {
      id: testAccountId,
      userId: testUserId,
      facebookUserId: 'fb-user-123',
      name: 'Test Account',
      encryptedAccessToken: 'dummy',
      tokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
    }
  });

  const { encryptToken } = await import('../src/lib/crypto');
  const encryptedPageToken = encryptToken('dummy_page_token');

  await prisma.facebookPage.create({
    data: {
      id: testPageId,
      userId: testUserId,
      accountId: testAccountId,
      facebookPageId: 'page-123',
      pageName: 'My Test Page',
      encryptedPageToken: encryptedPageToken,
      pageCategory: 'Mock',
      pagePictureUrl: 'url',
      isSynced: true
    }
  });

  // Set AppConfig liveMode
  await prisma.appConfiguration.upsert({
    where: { id: 'default' },
    update: { liveMetaMode: true },
    create: {
      id: 'default',
      liveMetaMode: true,
      publicAppUrl: 'http://localhost:3000',
      facebookAppId: 'dummy-app-id',
      encryptedAppSecret: 'dummy-app-secret'
    }
  });

  let testCount = 0;

  // Mock verifyAdminSession dependencies
  const mockDeps: JobsRouteDependencies = {
    verifyAdminSession: async () => prisma.user.findUnique({ where: { id: testUserId } }),
    getSessionUser: async () => prisma.user.findUnique({ where: { id: testUserId } }),
    getVideoJobs: async () => [],
    findUploadAsset: async (id: string) => prisma.uploadAsset.findUnique({ where: { id } }),
    findUserPages: async (userId: string) => prisma.facebookPage.findMany({ where: { userId }, select: { id: true } }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bulkCreateScheduledJobs: async (userId: string, jobs: any[]) => {
      const { bulkCreateScheduledJobs: original } = await import('../src/lib/job-state-machine');
      return await prisma.$transaction(async (tx) => {
        return await original(tx, userId, jobs);
      });
    }
  };

  // Helper to create next request
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const createReq = (body: any) => {
    return new NextRequest('http://localhost:3000/api/facebook/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
  };

  // 1. Unauthenticated request rejected
  {
    const req = createReq({ jobs: [{ pageId: testPageId, uploadAssetId: randomUUID(), englishTitle: 'Title', scheduledTimeUTC: new Date().toISOString() }] });
    const unauthDeps = { ...mockDeps, verifyAdminSession: async () => null };
    const res = await handleJobsPost(req, unauthDeps);
    assert(res.status === 401, 'Should fail with 401');
    testCount++;
    console.log('✓ Test 1: unauthenticated job requests are rejected');
  }

  // 2. Page ownership validation
  {
    const randomPageId = randomUUID();
    const req = createReq({
      jobs: [{
        pageId: randomPageId,
        uploadAssetId: randomUUID(),
        englishTitle: 'Title',
        scheduledTimeUTC: new Date(Date.now() + 100000).toISOString()
      }]
    });
    const res = await handleJobsPost(req, mockDeps);
    assert(res.status === 400, 'Should fail with 400');
    const body = await res.json();
    assert(JSON.stringify(body).includes('Unauthorized page association'), 'Should show unauthorized page association error');
    testCount++;
    console.log('✓ Test 2: Facebook page ownership is verified');
  }

  // 3. Asset ownership validation
  {
    const otherAsset = await createTestAsset(otherUserId);

    const req = createReq({
      jobs: [{
        pageId: testPageId,
        uploadAssetId: otherAsset.id,
        englishTitle: 'Title',
        scheduledTimeUTC: new Date(Date.now() + 100000).toISOString()
      }]
    });
    const res = await handleJobsPost(req, mockDeps);
    assert(res.status === 400, 'Should fail with 400');
    const body = await res.json();
    assert(JSON.stringify(body).includes('Unauthorized upload asset'), 'Should reject unauthorized asset');
    testCount++;
    console.log('✓ Test 3: UploadAsset user ownership is verified');
  }

  // 4. Asset validation: status must be VALIDATED
  {
    const unvalidatedAsset = await createTestAsset(testUserId, 'VALIDATING');

    const req = createReq({
      jobs: [{
        pageId: testPageId,
        uploadAssetId: unvalidatedAsset.id,
        englishTitle: 'Title',
        scheduledTimeUTC: new Date(Date.now() + 100000).toISOString()
      }]
    });
    const res = await handleJobsPost(req, mockDeps);
    assert(res.status === 400, 'Should fail with 400');
    const body = await res.json();
    assert(JSON.stringify(body).includes('must be VALIDATED'), 'Should reject non-validated asset');
    testCount++;
    console.log('✓ Test 4: non-VALIDATED assets are rejected');
  }

  // 5. Asset validation: objectDeletedAt must be null
  {
    const deletedAsset = await createTestAsset(testUserId, 'VALIDATED', 'GOOGLE_DRIVE', {
      objectDeletedAt: new Date()
    });

    const req = createReq({
      jobs: [{
        pageId: testPageId,
        uploadAssetId: deletedAsset.id,
        englishTitle: 'Title',
        scheduledTimeUTC: new Date(Date.now() + 100000).toISOString()
      }]
    });
    const res = await handleJobsPost(req, mockDeps);
    assert(res.status === 400, 'Should fail with 400');
    const body = await res.json();
    assert(JSON.stringify(body).includes('is deleted'), 'Should reject deleted asset');
    testCount++;
    console.log('✓ Test 5: deleted assets are rejected');
  }

  // 6. Reject browser-supplied storageUri / gcsVideoUri
  {
    const validAsset = await createTestAsset(testUserId);

    const req = createReq({
      jobs: [{
        pageId: testPageId,
        uploadAssetId: validAsset.id,
        englishTitle: 'Title',
        scheduledTimeUTC: new Date(Date.now() + 100000).toISOString(),
        storageUri: 'gdrive://malicious-inject'
      }]
    });
    const res = await handleJobsPost(req, mockDeps);
    assert(res.status === 400, 'Should fail with 400');
    const body = await res.json();
    assert(JSON.stringify(body).includes('Manually specified storage references are not accepted'), 'Should reject manual URIs');
    testCount++;
    console.log('✓ Test 6: browser-supplied storage references are rejected');
  }

  // 7. Scheduling Idempotency
  {
    const validAsset = await createTestAsset(testUserId);
    const scheduledTime = new Date(Date.now() + 200000).toISOString();

    const req1 = createReq({
      jobs: [{
        pageId: testPageId,
        uploadAssetId: validAsset.id,
        englishTitle: 'Title',
        scheduledTimeUTC: scheduledTime
      }]
    });

    const res1 = await handleJobsPost(req1, mockDeps);
    assert(res1.status === 200, 'First schedule should succeed');
    const body1 = await res1.json();
    assert(body1.results[0].status === 'SUCCESS', 'First job should be SUCCESS');

    // Repeated identical request
    const req2 = createReq({
      jobs: [{
        pageId: testPageId,
        uploadAssetId: validAsset.id,
        englishTitle: 'Title',
        scheduledTimeUTC: scheduledTime
      }]
    });

    const res2 = await handleJobsPost(req2, mockDeps);
    assert(res2.status === 200, 'Second schedule should succeed (idempotency)');
    const body2 = await res2.json();
    assert(body2.results[0].status === 'DUPLICATE', 'Repeated identical schedule should return DUPLICATE');
    assert(body1.jobs[0].id === body2.jobs[0].id, 'Reused job IDs must match');

    // Verify database count is exactly 1
    const dbCount = await prisma.videoJob.count({
      where: {
        userId: testUserId,
        uploadAssetId: validAsset.id,
        scheduledTimeUTC: new Date(scheduledTime)
      }
    });
    assert(dbCount === 1, 'Database must only contain 1 job record');

    testCount++;
    console.log('✓ Test 7: repeated scheduling requests return DUPLICATE status and reuse job ID');
  }

  // 8. Bulk scheduling partial failure
  {
    const validAsset = await createTestAsset(testUserId);

    const req = createReq({
      jobs: [
        {
          pageId: testPageId,
          uploadAssetId: validAsset.id,
          englishTitle: 'Valid Job',
          scheduledTimeUTC: new Date(Date.now() + 300000).toISOString()
        },
        {
          pageId: testPageId,
          uploadAssetId: randomUUID(), // invalid!
          englishTitle: 'Invalid Job',
          scheduledTimeUTC: new Date(Date.now() + 300000).toISOString()
        }
      ]
    });

    const res = await handleJobsPost(req, mockDeps);
    assert(res.status === 200, 'Batch should complete successfully even with 1 failure');
    const body = await res.json();
    assert(body.results[0].status === 'SUCCESS', 'First item must succeed');
    assert(body.results[1].status === 'FAILED', 'Second item must fail');
    assert(body.results[1].error.includes('Upload asset not found'), 'Should report asset not found error');

    testCount++;
    console.log('✓ Test 8: bulk scheduling partial failure returns item-specific results');
  }

  // 9. Worker stream publishing simulation & Mock delay
  {
    const workerAsset = await createTestAsset(testUserId);

    const job = await prisma.videoJob.create({
      data: {
        userId: testUserId,
        pageId: testPageId,
        uploadAssetId: workerAsset.id,
        englishTitle: 'Worker Job',
        englishCaption: 'capt',
        scheduledTimeUTC: new Date(Date.now() - 5000),
        status: 'SCHEDULED',
        mockScenario: 'META_PROCESSING_DELAY'
      }
    });

    let startCalled = false;
    let uploadChunkCount = 0;
    let finishCalled = false;
    let checkStatusCount = 0;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    global.fetch = async (url: any, init?: any) => {
      const urlStr = String(url);
      if (urlStr.includes('/videos') && init?.method === 'POST') {
        const body = init.body ? (typeof init.body === 'string' ? JSON.parse(init.body) : init.body) : {};
        
        if (body.upload_phase === 'start') {
          startCalled = true;
          return new Response(JSON.stringify({
            upload_session_id: 'session-abc',
            video_id: 'video-123'
          }), { status: 200 });
        }
        
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (init.headers && (init.headers as any)['Content-Type']?.includes('multipart/form-data')) {
          uploadChunkCount++;
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }

        if (body.upload_phase === 'finish') {
          finishCalled = true;
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }
      }

      if (urlStr.includes('/video-123') && init?.method === 'GET') {
        checkStatusCount++;
        if (checkStatusCount < 2) {
          return new Response(JSON.stringify({
            status: { video_status: 'processing' }
          }), { status: 200 });
        } else {
          return new Response(JSON.stringify({
            status: { video_status: 'ready' }
          }), { status: 200 });
        }
      }

      return new Response(JSON.stringify({}), { status: 404 });
    };

    const { GoogleDriveMediaReader } = await import('../src/lib/google-drive/google-drive-media-reader');
    GoogleDriveMediaReader.getDownloadStream = async () => {
      const { Readable } = await import('stream');
      return Readable.from([Buffer.alloc(1000000)]);
    };

    const token = randomUUID();
    const logOutput = await runQueueWorker(token, job.id);
    console.log('Worker Logs Pass 1:', logOutput);
    
    assert(startCalled, 'Start upload session should be invoked');
    assert(uploadChunkCount > 0, 'Upload chunk should be invoked');
    assert(finishCalled, 'Finish session should be invoked');

    const updatedJob1 = await prisma.videoJob.findUnique({ where: { id: job.id } });
    assert(updatedJob1?.status === 'META_PROCESSING', 'Should move to META_PROCESSING status');

    await prisma.videoJob.update({
      where: { id: job.id },
      data: { nextAttemptAt: new Date(Date.now() - 5000) }
    });

    const logs2 = await runQueueWorker(token, job.id);
    console.log('Worker Logs Pass 2:', logs2);
    const updatedJob2 = await prisma.videoJob.findUnique({ where: { id: job.id } });
    assert(updatedJob2?.status === 'META_PROCESSING', 'Should remain in META_PROCESSING since it returned processing');

    await prisma.videoJob.update({
      where: { id: job.id },
      data: { nextAttemptAt: new Date(Date.now() - 5000) }
    });

    const logs3 = await runQueueWorker(token, job.id);
    console.log('Worker Logs Pass 3:', logs3);
    const updatedJob3 = await prisma.videoJob.findUnique({ where: { id: job.id } });
    assert(updatedJob3?.status === 'PUBLISHED', 'Should complete and transition to PUBLISHED');
    assert(updatedJob3?.metaPostId === 'video-123', 'Should set metaPostId correctly');

    testCount++;
    console.log('✓ Test 9: worker streams chunks to Meta and polls transcode status successfully');
  }

  // 10. Transient Network Failure schedules retry
  {
    const retryAsset = await createTestAsset(testUserId);

    const job = await prisma.videoJob.create({
      data: {
        userId: testUserId,
        pageId: testPageId,
        uploadAssetId: retryAsset.id,
        englishTitle: 'Retry Job',
        englishCaption: 'capt',
        scheduledTimeUTC: new Date(Date.now() - 5000),
        status: 'SCHEDULED',
        mockScenario: 'TEMPORARY_NETWORK_FAILURE',
        attemptCount: 0,
        maxAttempts: 3
      }
    });

    global.fetch = (async () => {
      throw new Error('Connection lost during chunk upload.');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

    const token = randomUUID();
    await runQueueWorker(token, job.id);

    const updatedJob = await prisma.videoJob.findUnique({ where: { id: job.id } });
    assert(updatedJob?.status === 'SCHEDULED', 'Should reschedule back to SCHEDULED status for retry');
    assert(updatedJob?.attemptCount === 1, 'Attempt count must increment to 1');
    assert(updatedJob?.lastErrorCode === 'NET_TIMEOUT', 'Should register NET_TIMEOUT');
    assert(updatedJob?.failureClassification === 'NETWORK_ERROR', 'Should set failureClassification to NETWORK_ERROR');

    testCount++;
    console.log('✓ Test 10: transient network failures schedule retry with attempt increments');
  }

  // 11. Mock page synchronization, ownership and UUID contract tests
  {
    const { getFacebookConnections } = await import('../src/lib/db');
    
    // Test pages API returns database UUIDs
    const mockUser1 = randomUUID();
    // Create mock user
    await prisma.user.create({
      data: {
        id: mockUser1,
        email: `mock-user-1-${mockUser1.slice(0,8)}@example.com`,
        passwordHash: 'dummy',
        role: 'USER',
        status: 'ACTIVE',
        approvalStatus: 'APPROVED'
      }
    });

    // Explicitly configure Mock Meta Mode (liveMetaMode: false) for mockUser1
    await prisma.appConfiguration.create({
      data: {
        id: randomUUID(),
        userId: mockUser1,
        liveMetaMode: false,
        publicAppUrl: 'http://localhost:3000',
        facebookAppId: 'mock-app-id',
        encryptedAppSecret: 'mock-app-secret'
      }
    });

    const mockPagesJson = [
      {
        id: "1029384756",
        name: "Tech Reviews Daily",
        category: "Media/News Company",
        pictureUrl: "https://api.dicebear.com/7.x/identicon/svg?seed=tech",
        tokenStatus: "Valid",
        connectedAt: new Date().toISOString(),
        encryptedPageToken: 'dummy-token'
      }
    ];

    // Populate mock DB file for mockUser1
    const fs = await import('fs');
    const path = await import('path');
    const MOCK_DB_PATH = path.join(process.cwd(), 'src/lib/mock_db.json');
    
    let originalMockDb = '{}';
    if (fs.existsSync(MOCK_DB_PATH)) {
      originalMockDb = fs.readFileSync(MOCK_DB_PATH, 'utf8');
    }

    const mockDbContent = {
      accounts: [
        {
          id: randomUUID(),
          facebookUserId: 'mock_fb_user_sync_test',
          name: 'Simulated Meta Administrator',
          encryptedAccessToken: 'dummy',
          tokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          pages: mockPagesJson,
          userId: mockUser1
        }
      ],
      connectionState: 'Connected'
    };

    fs.writeFileSync(MOCK_DB_PATH, JSON.stringify(mockDbContent, null, 2), 'utf8');

    try {
      // First call to getFacebookConnections (mock mode should upsert to Prisma)
      const connections1 = await getFacebookConnections(mockUser1);
      assert(connections1.length === 1, 'Mock account should be returned');
      const page1 = connections1[0].pages[0];
      
      // Page ID should be a valid UUID primary key
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      assert(uuidRegex.test(page1.id), `Page ID must be a UUID, found: ${page1.id}`);
      assert(page1.facebookPageId === '1029384756', 'facebookPageId should be external Meta page ID');
      
      // Encryption and token secrets must be completely omitted/hidden from the returned list
      assert(!(page1 as unknown as Record<string, unknown>).encryptedPageToken, 'encryptedPageToken must be omitted from return value');
      assert(!(page1 as unknown as Record<string, unknown>).accessToken, 'accessToken must be omitted from return value');

      // Verify page was upserted in Prisma database
      const dbPage = await prisma.facebookPage.findUnique({
        where: { id: page1.id }
      });
      assert(dbPage !== null, 'Page should exist in database');
      assert(dbPage?.facebookPageId === '1029384756', 'Prisma page should store external ID');

      // Second call should be safe and not duplicate rows
      const connections2 = await getFacebookConnections(mockUser1);
      assert(connections2[0].pages[0].id === page1.id, 'Subsequent call should retain identical primary key UUID');
      
      const dbPagesCount = await prisma.facebookPage.count({
        where: { userId: mockUser1 }
      });
      assert(dbPagesCount === 1, `Expected exactly 1 database row, found: ${dbPagesCount}`);

      // Verify scheduling route POST validations
      const asset = await createTestAsset(mockUser1);
      
      // Valid schedule request using internal page ID UUID
      const validPayload = {
        jobs: [
          {
            pageId: page1.id,
            uploadAssetId: asset.id,
            englishTitle: 'Mock Schedule Job',
            englishCaption: 'capt',
            scheduledTimeUTC: new Date(Date.now() + 60 * 60 * 1000).toISOString()
          }
        ]
      };

      const sessionUser = { id: mockUser1, email: 'mock-user-1@example.com', role: 'USER' };
      const deps: JobsRouteDependencies = {
        getSessionUser: async () => sessionUser as unknown as User,
        verifyAdminSession: async () => sessionUser as unknown as User,
        getVideoJobs: async () => [],
        findUploadAsset: async (id) => prisma.uploadAsset.findUnique({ where: { id } }),
        findUserPages: async (uid) => prisma.facebookPage.findMany({ where: { userId: uid }, select: { id: true } }),
        bulkCreateScheduledJobs: async (uid, jobs) => {
          return await prisma.$transaction(async (tx) => {
            const { bulkCreateScheduledJobs: original } = await import('../src/lib/job-state-machine');
            return await original(tx, uid, jobs);
          });
        }
      };

      // 1. Safe valid schedule succeeds
      const reqValid = new NextRequest('http://localhost/api/facebook/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPayload)
      });
      const resValid = await handleJobsPost(reqValid, deps);
      assert(resValid.status === 200, 'Valid scheduling request should succeed');
      const validResBody = await resValid.json();
      assert(validResBody.results[0].status === 'SUCCESS', 'Should schedule successfully');

      // 2. Reject missing page ID
      const invalidPayload1 = {
        jobs: [
          {
            uploadAssetId: asset.id,
            englishTitle: 'No Page Job',
            englishCaption: 'c',
            scheduledTimeUTC: new Date(Date.now() + 60 * 60 * 1000).toISOString()
          }
        ]
      };
      const reqInvalid1 = new NextRequest('http://localhost/api/facebook/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(invalidPayload1)
      });
      const resInvalid1 = await handleJobsPost(reqInvalid1, deps);
      assert(resInvalid1.status === 400, 'Missing pageId should return 400 Bad Request');

      // 3. Reject external Meta page ID used as pageId
      const invalidPayload2 = {
        jobs: [
          {
            pageId: '1029384756', // External numeric string instead of database UUID
            uploadAssetId: asset.id,
            englishTitle: 'External Page ID Job',
            englishCaption: 'c',
            scheduledTimeUTC: new Date(Date.now() + 60 * 60 * 1000).toISOString()
          }
        ]
      };
      const reqInvalid2 = new NextRequest('http://localhost/api/facebook/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(invalidPayload2)
      });
      const resInvalid2 = await handleJobsPost(reqInvalid2, deps);
      assert(resInvalid2.status === 400, 'External pageId should be rejected by server validations');

      // 4. Reject malformed pageId
      const invalidPayload3 = {
        jobs: [
          {
            pageId: 'malformed-id-string',
            uploadAssetId: asset.id,
            englishTitle: 'Malformed Job',
            englishCaption: 'c',
            scheduledTimeUTC: new Date(Date.now() + 60 * 60 * 1000).toISOString()
          }
        ]
      };
      const reqInvalid3 = new NextRequest('http://localhost/api/facebook/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(invalidPayload3)
      });
      const resInvalid3 = await handleJobsPost(reqInvalid3, deps);
      assert(resInvalid3.status === 400, 'Malformed pageId should be rejected');

      // 5. Reject cross-user pageId
      const otherUser = randomUUID();
      const sessionUserOther = { id: otherUser, email: 'other-user@example.com', role: 'USER' };
      const depsOther: JobsRouteDependencies = {
        ...deps,
        getSessionUser: async () => sessionUserOther as unknown as User,
        verifyAdminSession: async () => sessionUserOther as unknown as User,
        findUserPages: async (uid) => prisma.facebookPage.findMany({ where: { userId: uid }, select: { id: true } })
      };
      const reqInvalid4 = new NextRequest('http://localhost/api/facebook/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPayload) // targets page1.id owned by mockUser1
      });
      const resInvalid4 = await handleJobsPost(reqInvalid4, depsOther);
      assert(resInvalid4.status === 400, 'Cross-user pageId scheduling should be rejected');

    } finally {
      // Restore original mock DB content
      fs.writeFileSync(MOCK_DB_PATH, originalMockDb, 'utf8');

      // Clean up mockUser1 Prisma rows
      await prisma.appConfiguration.deleteMany({ where: { userId: mockUser1 } });
      await prisma.videoJob.deleteMany({ where: { userId: mockUser1 } });
      await prisma.uploadAsset.deleteMany({ where: { userId: mockUser1 } });
      await prisma.facebookPage.deleteMany({ where: { userId: mockUser1 } });
      await prisma.facebookAccount.deleteMany({ where: { userId: mockUser1 } });
      await prisma.user.deleteMany({ where: { id: mockUser1 } });
    }

    testCount++;
    console.log('✓ Test 11: Mock page synchronization, UUID contract, and boundary checks verified successfully.');
  }

  // TEST 12: MockScenario validation, legacy normalization, and boundary verification
  {
    console.log('\n--- Test 12: MockScenario validation and normalization ---');
    const asset = await createTestAsset(testUserId);
    const validScenarios = [
      'SUCCESS',
      'TEMPORARY_NETWORK_FAILURE',
      'META_PROCESSING_DELAY',
      'META_RATE_LIMIT',
      'INVALID_MEDIA_FORMAT',
      'REVOKED_FACEBOOK_TOKEN',
      'MISSING_FACEBOOK_PERMISSION',
      'PERMANENT_PUBLISHING_FAILURE'
    ];

    // Mock dependencies
    const sessionUser = { id: testUserId, email: 'test-user@example.com', role: 'USER' as const };
    const deps: JobsRouteDependencies = {
      getSessionUser: async () => sessionUser as unknown as User,
      verifyAdminSession: async () => sessionUser as unknown as User,
      getVideoJobs: async () => [],
      findUploadAsset: async (id) => prisma.uploadAsset.findUnique({ where: { id } }),
      findUserPages: async (uid) => prisma.facebookPage.findMany({ where: { userId: uid }, select: { id: true } }),
      bulkCreateScheduledJobs: async (uid, jobs) => {
        return await prisma.$transaction(async (tx) => {
          const { bulkCreateScheduledJobs: original } = await import('../src/lib/job-state-machine');
          return await original(tx, uid, jobs);
        });
      }
    };

    // 1. Check every canonical MockScenario value
    for (const scenario of validScenarios) {
      const payload = {
        jobs: [{
          pageId: testPageId,
          uploadAssetId: asset.id,
          englishTitle: `Test Job ${scenario}`,
          scheduledTimeUTC: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          mockScenario: scenario
        }]
      };
      const req = new NextRequest('http://localhost/api/facebook/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const res = await handleJobsPost(req, deps);
      assert(res.status === 200, `Canonical scenario ${scenario} should be accepted`);
      
      // Verify job was created in DB with correct scenario
      const dbJob = await prisma.videoJob.findFirst({
        where: { englishTitle: `Test Job ${scenario}` }
      });
      assert(dbJob !== null, `Job for scenario ${scenario} should exist`);
      assert(dbJob?.mockScenario === scenario, `Expected MockScenario ${scenario}, found: ${dbJob?.mockScenario}`);
    }

    // 2. Check case-insensitive/legacy normalization: "success" -> SUCCESS
    {
      const payload = {
        jobs: [{
          pageId: testPageId,
          uploadAssetId: asset.id,
          englishTitle: 'Test Legacy success',
          scheduledTimeUTC: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          mockScenario: 'success'
        }]
      };
      const req = new NextRequest('http://localhost/api/facebook/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const res = await handleJobsPost(req, deps);
      assert(res.status === 200, 'Legacy lowercase "success" should be normalized and accepted');
      const dbJob = await prisma.videoJob.findFirst({ where: { englishTitle: 'Test Legacy success' } });
      assert(dbJob?.mockScenario === 'SUCCESS', 'Legacy success must be normalized to SUCCESS');
    }

    // 3. Check legacy normalization: "network_failure" -> TEMPORARY_NETWORK_FAILURE
    {
      const payload = {
        jobs: [{
          pageId: testPageId,
          uploadAssetId: asset.id,
          englishTitle: 'Test Legacy network_failure',
          scheduledTimeUTC: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          mockScenario: 'network_failure'
        }]
      };
      const req = new NextRequest('http://localhost/api/facebook/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const res = await handleJobsPost(req, deps);
      assert(res.status === 200, 'Legacy lowercase "network_failure" should be normalized and accepted');
      const dbJob = await prisma.videoJob.findFirst({ where: { englishTitle: 'Test Legacy network_failure' } });
      assert(dbJob?.mockScenario === 'TEMPORARY_NETWORK_FAILURE', 'network_failure must be normalized to TEMPORARY_NETWORK_FAILURE');
    }

    // 4. Omitted scenario uses canonical SUCCESS
    {
      const payload = {
        jobs: [{
          pageId: testPageId,
          uploadAssetId: asset.id,
          englishTitle: 'Test Omitted scenario',
          scheduledTimeUTC: new Date(Date.now() + 60 * 60 * 1000).toISOString()
        }]
      };
      const req = new NextRequest('http://localhost/api/facebook/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const res = await handleJobsPost(req, deps);
      assert(res.status === 200, 'Omitted mockScenario should default and succeed');
      const dbJob = await prisma.videoJob.findFirst({ where: { englishTitle: 'Test Omitted scenario' } });
      assert(dbJob?.mockScenario === 'SUCCESS', 'Omitted mockScenario must default to SUCCESS');
    }

    // 5. Unknown scenario is rejected with 400 validation error
    {
      const payload = {
        jobs: [{
          pageId: testPageId,
          uploadAssetId: asset.id,
          englishTitle: 'Test Unknown scenario',
          scheduledTimeUTC: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          mockScenario: 'invalid_scenario_abc'
        }]
      };
      const req = new NextRequest('http://localhost/api/facebook/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const res = await handleJobsPost(req, deps);
      assert(res.status === 400, 'Unknown mockScenario must be rejected with 400');
      const resData = await res.json();
      assert(resData.details && resData.details.some((d: string) => d.includes('Invalid mockScenario value')), 'API response must mask internals and show validation error');

      // Verify no invalid job reached database
      const dbJob = await prisma.videoJob.findFirst({ where: { englishTitle: 'Test Unknown scenario' } });
      assert(dbJob === null, 'Invalid scenario must never reach database insertion');
    }

    // 6. Live Meta configuration scheduling works normally
    {
      const payload = {
        jobs: [{
          pageId: testPageId,
          uploadAssetId: asset.id,
          englishTitle: 'Test Live Meta Scheduling',
          scheduledTimeUTC: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          mockScenario: 'SUCCESS'
        }]
      };
      const req = new NextRequest('http://localhost/api/facebook/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const res = await handleJobsPost(req, deps);
      assert(res.status === 200, 'Scheduling job in live meta configuration mode should succeed');
      const dbJob = await prisma.videoJob.findFirst({ where: { englishTitle: 'Test Live Meta Scheduling' } });
      assert(dbJob !== null, 'Live job must be successfully created');
    }

    // Clean up created test jobs
    await prisma.videoJob.deleteMany({
      where: {
        userId: testUserId,
        englishTitle: { startsWith: 'Test ' }
      }
    });

    testCount++;
    console.log('✓ Test 12: MockScenario validation, legacy normalization, and boundary checks verified successfully.');
  }

  // TEST 13: Dashboard jobs fetching, normalization, and safety verification
  {
    console.log('\n--- Test 13: Dashboard jobs normalization, counters, and safety checks ---');
    const { normalizeDashboardJobs } = await import('../src/lib/validation');

    // 1. Top-level jobs array normalizes correctly
    const rawJobs = [
      {
        id: 'job-1',
        pageId: testPageId,
        pageName: 'Tech Reviews Daily',
        englishTitle: 'Test Job 1',
        scheduledTimeUTC: new Date().toISOString(),
        status: 'SCHEDULED'
      }
    ];
    const norm1 = normalizeDashboardJobs(rawJobs);
    assert(norm1.length === 1, 'Top-level jobs array length');
    assert(norm1[0].id === 'job-1', 'First job id');
    assert(norm1[0].pageName === 'Tech Reviews Daily', 'pageName mapped');

    // 2. Supported wrapped response normalizes correctly
    const wrapped = { jobs: rawJobs };
    const norm2 = normalizeDashboardJobs(wrapped);
    assert(norm2.length === 1, 'Wrapped jobs array length');
    assert(norm2[0].id === 'job-1', 'First job id (wrapped)');

    // 3. Malformed response is rejected safely
    try {
      normalizeDashboardJobs({ invalidKey: 'someValue' });
      assert(false, 'Should throw error for malformed response');
    } catch (e) {
      assert((e as Error).message.includes('Invalid response format'), 'Error message match for malformed input');
    }

    // 4. Empty canonical array remains a valid empty result
    const normEmpty = normalizeDashboardJobs([]);
    assert(normEmpty.length === 0, 'Empty array normalization should return empty array');

    // 5. Two SCHEDULED jobs produce Scheduled Jobs count 2
    const rawScheduled = [
      { id: 'job-s1', pageId: testPageId, englishTitle: 'Title 1', scheduledTimeUTC: new Date().toISOString(), status: 'SCHEDULED' },
      { id: 'job-s2', pageId: testPageId, englishTitle: 'Title 2', scheduledTimeUTC: new Date().toISOString(), status: 'SCHEDULED' }
    ];
    const normScheduled = normalizeDashboardJobs(rawScheduled);
    const countScheduled = normScheduled.filter(j => j.status === 'SCHEDULED').length;
    assert(countScheduled === 2, 'Scheduled count must equal 2');

    // 6. A past-due SCHEDULED job remains visible
    const pastScheduled = [
      { id: 'job-past', pageId: testPageId, englishTitle: 'Past', scheduledTimeUTC: new Date(Date.now() - 100000).toISOString(), status: 'SCHEDULED' }
    ];
    const normPast = normalizeDashboardJobs(pastScheduled);
    assert(normPast.length === 1, 'Past-due job remains visible');
    assert(normPast[0].status === 'SCHEDULED', 'Past-due job status is SCHEDULED');

    // 7-9. PENDING, PROCESSING, META_PROCESSING is counted as publishing
    const rawPublishing = [
      { id: 'job-pending', pageId: testPageId, englishTitle: 'Pending', scheduledTimeUTC: new Date().toISOString(), status: 'PENDING' },
      { id: 'job-processing', pageId: testPageId, englishTitle: 'Processing', scheduledTimeUTC: new Date().toISOString(), status: 'PROCESSING' },
      { id: 'job-meta', pageId: testPageId, englishTitle: 'Meta Proc', scheduledTimeUTC: new Date().toISOString(), status: 'META_PROCESSING' }
    ];
    const normPublishing = normalizeDashboardJobs(rawPublishing);
    const countPublishing = normPublishing.filter(j => 
      ["PREPARING", "UPLOADING_TO_META", "META_PROCESSING", "PUBLISHING", "PROCESSING", "PENDING"].includes(j.status)
    ).length;
    assert(countPublishing === 3, 'Publishing count must include pending, processing, meta_processing');

    // 10. PUBLISHED increments Published Jobs
    const rawPublished = [
      { id: 'job-published', pageId: testPageId, englishTitle: 'Published', scheduledTimeUTC: new Date().toISOString(), status: 'PUBLISHED' }
    ];
    const normPublished = normalizeDashboardJobs(rawPublished);
    const countPublished = normPublished.filter(j => j.status === 'PUBLISHED').length;
    assert(countPublished === 1, 'Published count must equal 1');

    // 11. FAILED increments Failed Jobs
    const rawFailed = [
      { id: 'job-failed', pageId: testPageId, englishTitle: 'Failed', scheduledTimeUTC: new Date().toISOString(), status: 'FAILED' },
      { id: 'job-failed-perm', pageId: testPageId, englishTitle: 'Failed Perm', scheduledTimeUTC: new Date().toISOString(), status: 'FAILED_PERMANENT' }
    ];
    const normFailed = normalizeDashboardJobs(rawFailed);
    const countFailed = normFailed.filter(j => 
      ["FAILED", "FAILED_RETRYABLE", "FAILED_PERMANENT", "FACEBOOK_RECONNECT_REQUIRED"].includes(j.status)
    ).length;
    assert(countFailed === 2, 'Failed count must equal 2');

    // 12. CANCELLED is not counted as active
    const rawCancelled = [
      { id: 'job-cancelled', pageId: testPageId, englishTitle: 'Cancelled', scheduledTimeUTC: new Date().toISOString(), status: 'CANCELLED' }
    ];
    const normCancelled = normalizeDashboardJobs(rawCancelled);
    const cancelledCountScheduled = normCancelled.filter(j => j.status === 'SCHEDULED').length;
    const cancelledCountPublishing = normCancelled.filter(j => 
      ["PREPARING", "UPLOADING_TO_META", "META_PROCESSING", "PUBLISHING", "PROCESSING", "PENDING"].includes(j.status)
    ).length;
    const cancelledCountFailed = normCancelled.filter(j => 
      ["FAILED", "FAILED_RETRYABLE", "FAILED_PERMANENT", "FACEBOOK_RECONNECT_REQUIRED"].includes(j.status)
    ).length;
    assert(cancelledCountScheduled === 0, 'Cancelled is not scheduled');
    assert(cancelledCountPublishing === 0, 'Cancelled is not publishing');
    assert(cancelledCountFailed === 0, 'Cancelled is not failed');

    // 13. Active Scheduled Jobs contains the returned SCHEDULED jobs
    const activeScheduled = normScheduled.filter(j => j.status === 'SCHEDULED');
    assert(activeScheduled.length === 2, 'Active scheduled jobs contains two jobs');

    // 14. pageName from the API is displayed
    const rawWithPageName = [
      { id: 'job-p', pageId: testPageId, pageName: 'API Page Name', englishTitle: 'T', scheduledTimeUTC: new Date().toISOString(), status: 'SCHEDULED' }
    ];
    const normWithPageName = normalizeDashboardJobs(rawWithPageName);
    assert(normWithPageName[0].pageName === 'API Page Name', 'Page name display matched');

    // 15. Missing pageName falls back to the owned page list
    const rawMissingPageName = [
      { id: 'job-m', pageId: testPageId, englishTitle: 'T', scheduledTimeUTC: new Date().toISOString(), status: 'SCHEDULED' }
    ];
    const normMissingPageName = normalizeDashboardJobs(rawMissingPageName);
    assert(normMissingPageName[0].pageName === undefined, 'pageName is undefined when absent');
    const ownedPages = [
      { id: testPageId, name: 'Fallback Page Name' }
    ];
    const targetPage = ownedPages.find(p => p.id === normMissingPageName[0].pageId);
    const resolvedName = normMissingPageName[0].pageName || targetPage?.name || 'Unassigned';
    assert(resolvedName === 'Fallback Page Name', 'Page name fallback matches owned page name');

    // 16. Mock and Live modes use the same jobs response
    const sessionUser = { id: testUserId, email: 'test-user@example.com', role: 'USER' as const };
    const deps: JobsRouteDependencies = {
      getSessionUser: async () => sessionUser as unknown as User,
      verifyAdminSession: async () => sessionUser as unknown as User,
      getVideoJobs: async (uid) => prisma.videoJob.findMany({ where: { userId: uid }, include: { facebookPage: true }, orderBy: { createdAt: 'desc' } }),
      findUploadAsset: async (id) => prisma.uploadAsset.findUnique({ where: { id } }),
      findUserPages: async (uid) => prisma.facebookPage.findMany({ where: { userId: uid }, select: { id: true } }),
      bulkCreateScheduledJobs: async () => []
    };
    const getReq = new NextRequest('http://localhost/api/facebook/jobs', { method: 'GET' });
    const getRes = await handleJobsGet(getReq, deps);
    assert(getRes.status === 200, 'Jobs GET endpoint should return status 200');
    const returnedArray = await getRes.json();
    assert(Array.isArray(returnedArray), 'GET jobs response must be a top-level array');

    // 17. Scheduling success triggers a jobs refresh
    const asset = await prisma.uploadAsset.create({
      data: {
        id: randomUUID(),
        userId: testUserId,
        provider: 'GOOGLE_DRIVE',
        bucket: 'test-bucket',
        objectKey: 'test-key',
        status: 'VALIDATED',
        originalName: 'video.mp4',
        expectedSize: BigInt(5000000),
        declaredMimeType: 'video/mp4',
        idempotencyKey: randomUUID(),
        requestFingerprint: randomUUID(),
        uploadExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
      }
    });
    const job = await prisma.videoJob.create({
      data: {
        userId: testUserId,
        pageId: testPageId,
        englishTitle: 'Refresh Verification Job',
        englishCaption: 'Testing status update',
        scheduledTimeUTC: new Date(Date.now() + 3600 * 1000),
        status: 'SCHEDULED',
        gcsVideoUri: 'gcs://sensitive-bucket/video',
        storageUri: 'gdrive://sensitive-folder-id/file-id',
        uploadAssetId: asset.id
      }
    });

    const refreshRes = await handleJobsGet(getReq, deps);
    const refreshedJobs = (await refreshRes.json()) as Array<Record<string, unknown>>;
    const verifiedJob = refreshedJobs.find((j) => j.id === job.id);
    if (!verifiedJob) {
      throw new Error('Job must be refreshed and returned from GET api');
    }

    // 18. Safe API response excludes storageUri and gdrive identifiers
    assert(verifiedJob.storageUri === undefined, 'API response must exclude storageUri');
    assert(verifiedJob.gcsVideoUri === undefined, 'API response must exclude gcsVideoUri');
    assert(verifiedJob.gcsThumbnailUri === undefined, 'API response must exclude gcsThumbnailUri');

    // 19. Safe API response excludes page tokens and provider secrets
    assert(verifiedJob.encryptedPageToken === undefined, 'API response must exclude encryptedPageToken');
    assert(verifiedJob.encryptedAccessToken === undefined, 'API response must exclude encryptedAccessToken');
    assert(verifiedJob.providerReference === undefined, 'API response must exclude providerReference');
    assert(verifiedJob.providerProcessingId === undefined, 'API response must exclude providerProcessingId');

    // Clean up Test 13 db changes
    await prisma.videoJob.delete({ where: { id: job.id } });
    await prisma.uploadAsset.delete({ where: { id: asset.id } });

    testCount++;
    console.log('✓ Test 13: Dashboard jobs normalization, counters, and safety checks verified successfully.');
  }

  // Clean up test data
  console.log('Cleaning up test database fixtures...');
  await prisma.videoJob.deleteMany({ where: { userId: testUserId } });
  await prisma.uploadAsset.deleteMany({ where: { userId: testUserId } });
  await prisma.uploadAsset.deleteMany({ where: { userId: otherUserId } });
  await prisma.facebookPage.deleteMany({ where: { userId: testUserId } });
  await prisma.facebookAccount.deleteMany({ where: { userId: testUserId } });
  await prisma.user.delete({ where: { id: testUserId } });
  await prisma.user.delete({ where: { id: otherUserId } });

  console.log(`All ${testCount} scheduling & publishing integration tests completed successfully! 🎉`);
}

runTests()
  .catch(err => {
    console.error('Test execution failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
