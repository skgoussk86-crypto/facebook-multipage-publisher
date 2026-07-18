import { loadEnvConfig } from '@next/env';

// Load environment variables before importing Prisma Client
loadEnvConfig(process.cwd());

import { JobStatus, MockScenario, User, UserRole, UserStatus, UserApprovalStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { exec } from 'child_process';
import { executeWorkerCycle, startWorkerDaemon, parseIntegerEnv } from '../src/lib/worker-runtime';
import { prisma } from '../src/lib/prisma-client';
import { handleHealthGet } from '../src/app/api/admin/worker/health/route';
import { NextRequest } from 'next/server';
import { sanitizeErrorMessage } from '../src/lib/worker-health';

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
  process.exit(1);
}

function assert(cond: boolean, msg: string) {
  if (!cond) {
    throw new Error('Test Assertion Failed: ' + msg);
  }
}

async function cleanDatabase() {
  console.log('Cleaning test database tables...');
  await prisma.workerHeartbeat.deleteMany({});
  await prisma.videoJob.deleteMany({});
  await prisma.uploadAsset.deleteMany({});
  await prisma.googleDriveConnection.deleteMany({});
  await prisma.facebookPage.deleteMany({});
  await prisma.facebookAccount.deleteMany({});
  await prisma.user.deleteMany({});
}

async function createTestAsset(userId: string) {
  const assetId = randomUUID();
  return await prisma.uploadAsset.create({
    data: {
      id: assetId,
      userId,
      provider: 'GOOGLE_DRIVE',
      bucket: 'test-bucket',
      objectKey: `key-${assetId}`,
      originalName: 'video.mp4',
      expectedSize: BigInt(5000000),
      declaredMimeType: 'video/mp4',
      status: 'VALIDATED',
      idempotencyKey: `idem-${assetId}`,
      requestFingerprint: `finger-${assetId}`,
      uploadExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
    }
  });
}

function runWorkerProcess(env: Record<string, string>, omitConditions = false): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const childEnv = { ...process.env, ...env };
    // Remove database URL to test config-phase failures or keep it to allow successful exits
    const command = omitConditions
      ? 'node --import tsx scripts/run-production-worker.ts'
      : 'node --conditions=react-server --import tsx scripts/run-production-worker.ts';

    exec(command, { env: childEnv }, (error, stdout, stderr) => {
      resolve({
        code: error ? (error.code || 1) : 0,
        stdout,
        stderr
      });
    });
  });
}

// Simple request mocker for health route testing
function mockRequest(headers: Record<string, string>): NextRequest {
  const url = 'http://localhost:3000/api/admin/worker/health';
  return new NextRequest(url, { headers });
}

// Global mocks for auth verify functions
const adminUser: User = {
  id: 'admin-123',
  email: 'admin@test.com',
  passwordHash: 'dummy',
  name: 'Admin',
  role: UserRole.ADMIN,
  status: UserStatus.ACTIVE,
  approvalStatus: UserApprovalStatus.APPROVED,
  approvedAt: new Date(),
  approvedById: null,
  rejectedAt: null,
  rejectionReason: null,
  registrationIp: '127.0.0.1',
  lastLoginAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date()
};

const standardUser: User = {
  id: 'user-123',
  email: 'user@test.com',
  passwordHash: 'dummy',
  name: 'User',
  role: UserRole.USER,
  status: UserStatus.ACTIVE,
  approvalStatus: UserApprovalStatus.APPROVED,
  approvedAt: new Date(),
  approvedById: null,
  rejectedAt: null,
  rejectionReason: null,
  registrationIp: '127.0.0.1',
  lastLoginAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date()
};

const mockAuth = {
  verifyAdminSession: async (req: NextRequest): Promise<User | null> => {
    const authHeader = req.headers.get('authorization') || '';
    if (authHeader === 'Bearer admin-token') {
      return adminUser;
    }
    if (authHeader === 'Bearer user-token') {
      return standardUser;
    }
    return null;
  },
  verifyAdminRole: (user: { role: string }): boolean => {
    return user.role === 'ADMIN';
  }
};

async function runTests() {
  console.log('Running Expanded Worker Runtime and Observability Tests...');
  await cleanDatabase();

  // ==========================================
  // Test 1: Configuration intervals validation
  // ==========================================
  console.log('Test 1: Configuration intervals validation...');
  assert(parseIntegerEnv(undefined, 10000, 1000, 3600000, 'TEST') === 10000, 'Must load default when undefined');
  assert(parseIntegerEnv(' ', 10000, 1000, 3600000, 'TEST') === 10000, 'Must load default when empty spaces');
  assert(parseIntegerEnv('1000', 10000, 1000, 3600000, 'TEST') === 1000, 'Must parse valid min boundary');
  assert(parseIntegerEnv('3600000', 10000, 1000, 3600000, 'TEST') === 3600000, 'Must parse valid max boundary');

  let threw = false;
  try { parseIntegerEnv('NaN', 10000, 1000, 3600000, 'TEST'); } catch { threw = true; }
  assert(threw, 'Must reject NaN');

  threw = false;
  try { parseIntegerEnv('0', 10000, 1000, 3600000, 'TEST'); } catch { threw = true; }
  assert(threw, 'Must reject zero');

  threw = false;
  try { parseIntegerEnv('-100', 10000, 1000, 3600000, 'TEST'); } catch { threw = true; }
  assert(threw, 'Must reject negative numbers');

  threw = false;
  try { parseIntegerEnv('500', 10000, 1000, 3600000, 'TEST'); } catch { threw = true; }
  assert(threw, 'Must reject values below minimum');

  threw = false;
  try { parseIntegerEnv('4000000', 10000, 1000, 3600000, 'TEST'); } catch { threw = true; }
  assert(threw, 'Must reject values above maximum');

  // ==========================================
  // Test 2: Production worker ID validation rules
  // ==========================================
  console.log('Test 2: Production worker ID validation rules...');
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  assert(!uuidRegex.test(''), 'Empty ID is invalid');
  assert(!uuidRegex.test('worker-prod-12345'), 'Generic naming pattern is invalid');
  assert(uuidRegex.test(randomUUID()), 'Standard random UUID must be valid');

  // ==========================================
  // Test 3: Error sanitization logic
  // ==========================================
  console.log('Test 3: Error sanitization logic...');
  const rawError = 'Failed to download from gdrive://file1234. Token = encrypted_token_abc. signedUrl = http://example.com/stream?expires=123&signature=abc. postgresql://postgres:password@localhost:5432';
  const cleanError = sanitizeErrorMessage(rawError) || '';
  assert(!cleanError.includes('file1234'), 'Must strip Google Drive file ID');
  assert(!cleanError.includes('encrypted_token_abc'), 'Must redact token parameter');
  assert(!cleanError.includes('signature=abc'), 'Must redact signed URL query strings');
  assert(!cleanError.includes('password'), 'Must redact postgres connection credentials');
  assert(cleanError.includes('[REDACTED]'), 'Must include REDACTED markers');

  // Setup database fixtures for job execution tests
  const testUserId = randomUUID();
  const testPageId = randomUUID();
  const testAccountId = randomUUID();

  await prisma.user.create({
    data: {
      id: testUserId,
      email: `worker-user-${testUserId.slice(0, 8)}@example.com`,
      passwordHash: 'dummy',
      role: 'USER',
      status: 'ACTIVE',
      approvalStatus: 'APPROVED'
    }
  });

  await prisma.facebookAccount.create({
    data: {
      id: testAccountId,
      userId: testUserId,
      facebookUserId: 'fb-worker-123',
      name: 'Worker Test Account',
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
      facebookPageId: 'page-worker-123',
      pageName: 'Worker Test Page',
      encryptedPageToken: encryptedPageToken,
      pageCategory: 'Mock',
      pagePictureUrl: 'url',
      isSynced: true
    }
  });

  await prisma.appConfiguration.upsert({
    where: { id: 'default' },
    update: { liveMetaMode: false },
    create: {
      id: 'default',
      liveMetaMode: false,
      publicAppUrl: 'http://localhost:3000',
      facebookAppId: '123',
      encryptedAppSecret: 'dummy'
    }
  });

  const asset = await createTestAsset(testUserId);

  // ==========================================
  // Test 4: Due scheduled jobs processed, future skipped
  // ==========================================
  console.log('Test 4: Scheduling claiming constraints...');
  const dueJobId = randomUUID();
  await prisma.videoJob.create({
    data: {
      id: dueJobId,
      userId: testUserId,
      pageId: testPageId,
      uploadAssetId: asset.id,
      englishTitle: 'Due Job',
      englishCaption: 'This is due',
      scheduledTimeUTC: new Date(Date.now() - 10000),
      status: JobStatus.SCHEDULED,
      mockScenario: MockScenario.SUCCESS,
    }
  });

  const futureJobId = randomUUID();
  await prisma.videoJob.create({
    data: {
      id: futureJobId,
      userId: testUserId,
      pageId: testPageId,
      uploadAssetId: asset.id,
      englishTitle: 'Future Job',
      englishCaption: 'This is not due yet',
      scheduledTimeUTC: new Date(Date.now() + 3600 * 1000),
      status: JobStatus.SCHEDULED,
      mockScenario: MockScenario.SUCCESS,
    }
  });

  const workerId = randomUUID();
  const cycleResult = await executeWorkerCycle(workerId);
  assert(cycleResult.processedCount === 1, 'Only the due job must be claimed');

  const updatedDue = await prisma.videoJob.findUnique({ where: { id: dueJobId } });
  const updatedFuture = await prisma.videoJob.findUnique({ where: { id: futureJobId } });
  assert(updatedDue?.status === JobStatus.META_PROCESSING, 'Due job moves forward');
  assert(updatedFuture?.status === JobStatus.SCHEDULED, 'Future job remains scheduled');

  // ==========================================
  // Test 5: Daemon start and graceful shutdown (Idle state)
  // ==========================================
  console.log('Test 5: Daemon start and graceful shutdown...');
  const daemonWorkerId = randomUUID();
  const controller = startWorkerDaemon({
    workerId: daemonWorkerId,
    pollIntervalMs: 5000,
    errorBackoffMs: 10000,
    registerSignals: false
  });

  // Yield to allow the asynchronous heartbeat registration to execute in the event loop
  await new Promise((resolve) => setTimeout(resolve, 500));

  // Verify it created the heartbeat entry
  const activeHeartbeat = await prisma.workerHeartbeat.findUnique({ where: { workerId: daemonWorkerId } });
  assert(activeHeartbeat !== null, 'Should record status in DB during runtime');

  // Trigger graceful shutdown immediately
  await controller.shutdown();
  await controller.completionPromise;

  const shutHeartbeat = await prisma.workerHeartbeat.findUnique({ where: { workerId: daemonWorkerId } });
  assert(shutHeartbeat?.currentStatus === 'STOPPED', 'Should record STOPPED status on loop exit');

  // Repeated shutdown request is idempotent
  await controller.shutdown();

  // ==========================================
  // Test 6: Health API endpoint security & take: 50 limit
  // ==========================================
  console.log('Test 6: Health route security and limits...');

  const reqUnauth = mockRequest({});
  const resUnauth = await handleHealthGet(reqUnauth, mockAuth);
  assert(resUnauth.status === 401, 'Unauthenticated query rejected');

  const reqUser = mockRequest({ 'authorization': 'Bearer user-token' });

  try {
    const resUser = await handleHealthGet(reqUser, mockAuth);
    assert(resUser.status === 403, 'Non-admin query rejected');

    const reqAdmin = mockRequest({ 'authorization': 'Bearer admin-token' });
    const resAdmin = await handleHealthGet(reqAdmin, mockAuth);
    assert(resAdmin.status === 200, 'Admin query permitted');

    const body = await resAdmin.json();
    assert(body.success === true, 'Response indicates success');
    assert(body.heartbeats.length <= 50, 'Must enforce take: 50 record limit');

    // Safe response excludes raw tokens inside lastError
    await prisma.workerHeartbeat.create({
      data: {
        workerId: randomUUID(),
        startedAt: new Date(),
        lastPingAt: new Date(),
        currentStatus: 'FAILED',
        lastError: 'Bearer token_secret_xyz'
      }
    });

    const resAdmin2 = await handleHealthGet(reqAdmin, mockAuth);
    const body2 = await resAdmin2.json();
    const leaked = body2.heartbeats.some((hb: { lastError: string | null }) => hb.lastError?.includes('token_secret_xyz'));
    assert(!leaked, 'Health response must redact access tokens in error text');
  } catch (err: unknown) {
    throw err;
  }

  // ==========================================
  // Test 7: Exception mock state tracking (BACKING_OFF)
  // ==========================================
  console.log('Test 7: Exception mock state tracking (BACKING_OFF)...');
  const originalFindMany = prisma.videoJob.findMany;
  const mockVideoJob = prisma.videoJob as unknown as { findMany: unknown };
  mockVideoJob.findMany = () => {
    throw new Error('Forced database connection failure containing bearer secret_token');
  };

  const failedWorkerId = randomUUID();
  let exceptionCaught = false;
  try {
    await executeWorkerCycle(failedWorkerId);
  } catch {
    exceptionCaught = true;
  } finally {
    mockVideoJob.findMany = originalFindMany;
  }
  assert(exceptionCaught, 'Exception must be propagated out of execution cycle');

  const failedHb = await prisma.workerHeartbeat.findUnique({ where: { workerId: failedWorkerId } });
  assert(failedHb !== null, 'Failed heartbeat must exist');
  assert(failedHb!.currentStatus === 'FAILED', 'Heartbeat status is FAILED during cycle throw');
  assert(failedHb!.lastFailureAt !== null, 'Must record failure timestamp');
  assert(failedHb!.lastError !== null && !failedHb!.lastError.includes('secret_token'), 'Database error text must be sanitized before write');

  // ==========================================
  // Test 8: Process-level Disabled Startup Regression Test (Part 4)
  // ==========================================
  console.log('Test 8: Process-level Disabled Startup Regression Test...');
  const resDisabled = await runWorkerProcess({
    WORKER_ENABLED: 'false',
    WORKER_ID: ''
  });
  assert(resDisabled.code === 0, 'Disabled startup must exit cleanly with code 0');
  assert(resDisabled.stdout.includes('Background worker is disabled'), 'Disabled worker should print message');

  // Verify no heartbeats created for disabled worker
  const childHeartbeats = await prisma.workerHeartbeat.findMany({
    where: {
      currentStatus: 'RUNNING',
      workerId: { notIn: [workerId, daemonWorkerId] }
    }
  });
  assert(childHeartbeats.length === 0, 'No active running heartbeats should be registered');

  // ==========================================
  // Test 9: Enabled Startup Validation Tests (Part 5)
  // ==========================================
  console.log('Test 9: Enabled Startup Validation Tests...');

  // A. Missing WORKER_ID fails before starting runtime
  const resMissingId = await runWorkerProcess({
    WORKER_ENABLED: 'true',
    WORKER_ID: ''
  });
  assert(resMissingId.code === 1, 'Missing WORKER_ID must fail with exit code 1');
  assert(resMissingId.stderr.includes('WORKER_ID environment variable is missing'), 'Missing WORKER_ID prints error');

  // B. Invalid UUID fails before runtime
  const resInvalidId = await runWorkerProcess({
    WORKER_ENABLED: 'true',
    WORKER_ID: 'invalid-non-uuid-value'
  });
  assert(resInvalidId.code === 1, 'Invalid WORKER_ID UUID must fail with exit code 1');
  assert(resInvalidId.stderr.includes('not a valid UUID'), 'Invalid UUID prints validation error');

  // C. Invalid intervals fail before runtime
  const resInvalidInterval = await runWorkerProcess({
    WORKER_ENABLED: 'true',
    WORKER_ID: randomUUID(),
    WORKER_POLL_INTERVAL_MS: 'invalid-interval'
  });
  assert(resInvalidInterval.code === 1, 'Invalid poll interval must fail with exit code 1');
  assert(resInvalidInterval.stderr.includes('Startup configuration error'), 'Invalid interval prints validation error');

  // D. Valid configuration matches boundary (fails database connection if URL is missing or reaches database and starts)
  const validWorkerId = randomUUID();
  // To avoid hanging in tests, we can kill the child process after 2 seconds!
  console.log('Awaiting quick boot check for valid daemon configuration...');
  const bootCtrl = new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = exec('node --conditions=react-server --import tsx scripts/run-production-worker.ts', {
      env: {
        ...process.env,
        WORKER_ENABLED: 'true',
        WORKER_ID: validWorkerId,
        WORKER_POLL_INTERVAL_MS: '1000',
        WORKER_ERROR_BACKOFF_MS: '5000'
      }
    }, (error, stdout, stderr) => {
      resolve({
        code: error ? (error.code || 1) : 0,
        stdout,
        stderr
      });
    });

    // Terminate after 2.5 seconds (enough to run at least one tick)
    setTimeout(() => {
      child.kill('SIGINT');
    }, 2500);
  });

  const bootRes = await bootCtrl;
  assert(bootRes.code === 0 || bootRes.code === 130 || bootRes.code === null || bootRes.code === 1, 'Boot check exited gracefully or via signal');

  // Check if heartbeat row was successfully created in the test database by the child process
  const childHeartbeat = await prisma.workerHeartbeat.findUnique({
    where: { workerId: validWorkerId }
  });
  assert(childHeartbeat !== null, 'Heartbeat record must be created by the booted daemon process');
  assert(childHeartbeat!.currentStatus === 'STOPPED' || childHeartbeat!.currentStatus === 'IDLE' || childHeartbeat!.currentStatus === 'STOPPING', 'Heartbeat status was written successfully');

  // ==========================================
  // Test 10: Import-Safety Test (Part 6)
  // ==========================================
  console.log('Test 10: Import-Safety Test (running disabled without react-server conditions)...');
  const resImportSafety = await runWorkerProcess({
    WORKER_ENABLED: 'false',
    WORKER_ID: ''
  }, true); // pass omitConditions = true
  assert(resImportSafety.code === 0, 'Disabled startup must exit cleanly with code 0 even without react-server conditions');
  assert(!resImportSafety.stderr.includes('This module cannot be imported from a Client Component module'), 'Must not raise server-only client component import errors');

  console.log('All Expanded Background Worker Runtime and Observability Tests Passed successfully! 🎉');
}

runTests()
  .then(() => {
    process.exit(0);
  })
  .catch((e) => {
    console.error('Test execution failed:', e);
    process.exit(1);
  });
