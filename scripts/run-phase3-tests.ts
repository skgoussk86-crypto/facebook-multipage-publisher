import { PrismaClient, JobStatus } from '@prisma/client';
import {
  canTransition,
  claimScheduledJob,
  recoverExpiredLease
} from '../src/lib/job-state-machine';
import { randomUUID } from 'crypto';

const dbUrl = process.env.DATABASE_URL || '';

if (!dbUrl) {
  console.error('================================================================================');
  console.error('REFUSED: DATABASE_URL env variable is missing.');
  console.error('================================================================================');
  process.exit(1);
}

let dbName = '';
try {
  const parsedUrl = new URL(dbUrl);
  dbName = decodeURIComponent(parsedUrl.pathname.slice(1));
} catch {
  console.error('================================================================================');
  console.error('REFUSED: Invalid DATABASE_URL format.');
  console.error('================================================================================');
  process.exit(1);
}

if (dbName !== 'fb_publisher_test') {
  console.error('================================================================================');
  console.error('REFUSED: Refusing to run tests against database ' + JSON.stringify(dbName) + '.');
  console.error('Database name must equal exactly "fb_publisher_test".');
  console.error('================================================================================');
  process.exit(1);
}

const prisma = new PrismaClient();

async function runTests() {
  console.log('Starting Phase 3 state machine integration tests against test database...');

  // Setup mock user & page
  const testUserId = randomUUID();
  const testPageId = randomUUID();
  const testAccountId = randomUUID();

  await prisma.user.create({
    data: {
      id: testUserId,
      email: `test-${testUserId.slice(0,8)}@example.com`,
      passwordHash: 'dummy',
      role: 'USER',
      status: 'ACTIVE',
      approvalStatus: 'APPROVED'
    }
  });

  const configId = randomUUID();
  await prisma.appConfiguration.create({
    data: {
      id: configId,
      userId: testUserId,
      configurationName: 'Default Meta App',
      publicAppUrl: 'http://localhost:3000',
      facebookAppId: 'dummy_app_id',
      encryptedAppSecret: 'dummy_secret',
      liveMetaMode: false,
      isDefault: true,
      isEnabled: true
    }
  });

  await prisma.facebookAccount.create({
    data: {
      id: testAccountId,
      userId: testUserId,
      appConfigurationId: configId,
      facebookUserId: 'dummy_fb_user',
      name: 'Test account',
      encryptedAccessToken: 'dummy_token',
      tokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
    }
  });

  await prisma.facebookPage.create({
    data: {
      id: testPageId,
      userId: testUserId,
      accountId: testAccountId,
      facebookPageId: 'dummy_page_id',
      pageName: 'Test Page',
      encryptedPageToken: 'dummy_page_token',
      pageCategory: 'Mock',
      pagePictureUrl: 'dummy_url',
      isSynced: true
    }
  });

  console.log('Setup completed. Running individual test assertions...');

  // Test 1: canTransition logic
  console.log('Test 1: Transition logic validation...');
  if (canTransition(JobStatus.PUBLISHED, JobStatus.SCHEDULED)) throw new Error('Assertion failed: PUBLISHED must be terminal');
  if (!canTransition(JobStatus.DRAFT, JobStatus.SCHEDULED)) throw new Error('Assertion failed: DRAFT -> SCHEDULED allowed');

  // Test 2: claimScheduledJob - Future schedule is not claimed
  console.log('Test 2: Future scheduled jobs are ignored...');
  const futureJob = await prisma.videoJob.create({
    data: {
      userId: testUserId,
      pageId: testPageId,
      gcsVideoUri: 'gcs://video.mp4',
      englishTitle: 'Future Video',
      englishCaption: 'caption',
      scheduledTimeUTC: new Date(Date.now() + 60 * 60 * 1000), // 1 hour future
      status: JobStatus.SCHEDULED
    }
  });
  
  const workerUuid = randomUUID();
  const claimedFuture = await prisma.$transaction(async (tx) => {
    return await claimScheduledJob(tx, futureJob.id, workerUuid);
  });
  if (claimedFuture !== null) throw new Error('Assertion failed: Future job must not be claimed.');

  // Test 3: claimScheduledJob - Due job is claimed
  console.log('Test 3: Due scheduled jobs are claimed...');
  const dueJob = await prisma.videoJob.create({
    data: {
      userId: testUserId,
      pageId: testPageId,
      gcsVideoUri: 'gcs://video.mp4',
      englishTitle: 'Due Video',
      englishCaption: 'caption',
      scheduledTimeUTC: new Date(Date.now() - 1000), // past
      status: JobStatus.SCHEDULED
    }
  });

  const claimedDue = await prisma.$transaction(async (tx) => {
    return await claimScheduledJob(tx, dueJob.id, workerUuid);
  });
  if (!claimedDue || claimedDue.status !== JobStatus.PREPARING) throw new Error('Assertion failed: Due job must be claimed into PREPARING.');
  if (claimedDue.attemptCount !== 1) throw new Error('Assertion failed: attemptCount must increment to 1.');

  // Test 4: Attempt limits
  console.log('Test 4: Attempt limit check...');
  const limitJob = await prisma.videoJob.create({
    data: {
      userId: testUserId,
      pageId: testPageId,
      gcsVideoUri: 'gcs://video.mp4',
      englishTitle: 'Exhausted Video',
      englishCaption: 'caption',
      scheduledTimeUTC: new Date(Date.now() - 1000),
      status: JobStatus.SCHEDULED,
      attemptCount: 3,
      maxAttempts: 3
    }
  });

  const claimedLimit = await prisma.$transaction(async (tx) => {
    return await claimScheduledJob(tx, limitJob.id, workerUuid);
  });
  if (claimedLimit !== null) throw new Error('Assertion failed: Job with attempts >= maxAttempts must not be claimed.');

  const limitCheckDb = await prisma.videoJob.findUnique({ where: { id: limitJob.id } });
  if (limitCheckDb?.status !== JobStatus.FAILED_PERMANENT) throw new Error('Assertion failed: Inconsistent job must transition to FAILED_PERMANENT.');

  // Test 5: Expired lease recovery - PREPARING
  console.log('Test 5: Lease expiration recovery in PREPARING...');
  const preparingStuckJob = await prisma.videoJob.create({
    data: {
      userId: testUserId,
      pageId: testPageId,
      gcsVideoUri: 'gcs://video.mp4',
      englishTitle: 'Stuck Preparing',
      englishCaption: 'caption',
      scheduledTimeUTC: new Date(Date.now() - 1000),
      status: JobStatus.PREPARING,
      lockToken: workerUuid,
      lockExpiresAt: new Date(Date.now() - 1000), // expired
      attemptCount: 1,
      maxAttempts: 3
    }
  });

  await prisma.$transaction(async (tx) => {
    await recoverExpiredLease(tx, preparingStuckJob.id);
  });

  const recoveredDb = await prisma.videoJob.findUnique({ where: { id: preparingStuckJob.id } });
  if (recoveredDb?.status !== JobStatus.FAILED_RETRYABLE) throw new Error('Assertion failed: Lease recovery in PREPARING must move to FAILED_RETRYABLE.');

  // Test 6: Expired lease recovery - META_PROCESSING
  console.log('Test 6: Lease expiration recovery in META_PROCESSING...');
  const metaStuckJob = await prisma.videoJob.create({
    data: {
      userId: testUserId,
      pageId: testPageId,
      gcsVideoUri: 'gcs://video.mp4',
      englishTitle: 'Stuck Meta Processing',
      englishCaption: 'caption',
      scheduledTimeUTC: new Date(Date.now() - 1000),
      status: JobStatus.META_PROCESSING,
      lockToken: workerUuid,
      lockExpiresAt: new Date(Date.now() - 1000), // expired
      attemptCount: 1,
      maxAttempts: 3
    }
  });

  await prisma.$transaction(async (tx) => {
    await recoverExpiredLease(tx, metaStuckJob.id);
  });

  const recoveredMetaDb = await prisma.videoJob.findUnique({ where: { id: metaStuckJob.id } });
  if (recoveredMetaDb?.status !== JobStatus.META_PROCESSING) throw new Error('Assertion failed: Lease recovery in META_PROCESSING must remain in META_PROCESSING.');
  if (recoveredMetaDb?.lockToken !== null) throw new Error('Assertion failed: Lease recovery in META_PROCESSING must clear lockToken.');

  // Clean up test data
  console.log('Cleaning up test fixtures...');
  await prisma.videoJob.deleteMany({ where: { userId: testUserId } });
  await prisma.facebookPage.deleteMany({ where: { userId: testUserId } });
  await prisma.facebookAccount.deleteMany({ where: { userId: testUserId } });
  await prisma.appConfiguration.deleteMany({ where: { userId: testUserId } });
  await prisma.user.delete({ where: { id: testUserId } });

  console.log('All Phase 3 integration tests completed successfully! 🎉');
}

runTests()
  .catch(err => {
    console.error('Test execution failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
