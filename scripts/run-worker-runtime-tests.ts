import { loadEnvConfig } from '@next/env';

// Load environment variables before importing Prisma Client
loadEnvConfig(process.cwd());

import { JobStatus, MockScenario, User, UserRole, UserStatus, UserApprovalStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { exec, spawn } from 'child_process';
import { executeWorkerCycle, startWorkerDaemon, parseIntegerEnv, WorkerController } from '../src/lib/worker-runtime';
import { prisma } from '../src/lib/prisma-client';
import { handleHealthGet } from '../src/app/api/admin/worker/health/route';
import { NextRequest } from 'next/server';
import { sanitizeErrorMessage, updateWorkerHeartbeat } from '../src/lib/worker-health';

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

function cleanEnvForChild(env: Record<string, string>): Record<string, string | undefined> {
  const allowedKeys = [
    'PATH', 'SystemRoot', 'SystemDrive', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT', 'WINDIR',
    'USERNAME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
    'DATABASE_URL', 'NODE_ENV'
  ];
  const childEnv: Record<string, string | undefined> = {};
  for (const key of allowedKeys) {
    if (process.env[key] !== undefined) {
      childEnv[key] = process.env[key]!;
    }
  }

  const targetDbUrl = env.DATABASE_URL || childEnv.DATABASE_URL || '';
  let childDbName = '';
  try {
    const parsedUrl = new URL(targetDbUrl);
    childDbName = decodeURIComponent(parsedUrl.pathname.slice(1));
  } catch {
    throw new Error('Refusing to run child process: Invalid or missing DATABASE_URL.');
  }
  if (childDbName !== 'fb_publisher_test') {
    throw new Error(`Refusing to run child process: DATABASE_URL points to "${childDbName}", not "fb_publisher_test".`);
  }

  for (const [key, val] of Object.entries(env)) {
    childEnv[key] = val;
  }

  delete childEnv.FORCE_MOCK_FAILURE;

  return childEnv;
}

function runWorkerProcess(env: Record<string, string>, omitConditions = false): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let childEnv: Record<string, string | undefined>;
    try {
      childEnv = cleanEnvForChild(env);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
    const command = omitConditions
      ? 'node --import tsx scripts/run-production-worker.ts'
      : 'node --conditions=react-server --import tsx scripts/run-production-worker.ts';

    exec(command, { env: childEnv as NodeJS.ProcessEnv }, (error, stdout, stderr) => {
      resolve({
        code: error ? (error.code || 1) : 0,
        stdout,
        stderr
      });
    });
  });
}

function runWorkerOnceProcess(env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let childEnv: Record<string, string | undefined>;
    try {
      childEnv = cleanEnvForChild(env);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
    const command = 'node --conditions=react-server --import tsx scripts/run-worker-once.ts';

    exec(command, { env: childEnv as NodeJS.ProcessEnv }, (error, stdout, stderr) => {
      resolve({
        code: error ? (error.code || 1) : 0,
        stdout,
        stderr
      });
    });
  });
}

function runWorkerOnceFailedProcess(env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let childEnv: Record<string, string | undefined>;
    try {
      childEnv = cleanEnvForChild(env);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
    const command = 'node --conditions=react-server --import tsx scripts/run-test-worker-once-failed.ts';

    exec(command, { env: childEnv as NodeJS.ProcessEnv }, (error, stdout, stderr) => {
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
  // Test 5: Daemon start and graceful shutdown (Comprehensive Race-Safety and Idempotency)
  // ==========================================
  console.log('Test 5: Daemon start and graceful shutdown (Comprehensive)...');

  // Helper function to wait for heartbeat status in DB
  const waitForStatus = async (workerId: string, allowedStatuses: string[], timeoutMs = 5000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const hb = await prisma.workerHeartbeat.findUnique({ where: { workerId } });
      if (hb && allowedStatuses.includes(hb.currentStatus)) {
        return hb;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    const finalHb = await prisma.workerHeartbeat.findUnique({ where: { workerId } });
    throw new Error(`Timeout waiting for status ${allowedStatuses.join('/')}. Current status: ${finalHb?.currentStatus}`);
  };

  // Test 5.1: Repository explicit null update verification
  console.log('  Subtest 5.1: Repository update with explicit null / undefined...');
  const repoTestWorkerId = randomUUID();
  await updateWorkerHeartbeat({
    workerId: repoTestWorkerId,
    startedAt: new Date(),
    currentStatus: 'IDLE',
    nextPollEstimate: new Date(Date.now() + 60000),
    lastError: 'test-error-string'
  });

  const repoHb1 = await prisma.workerHeartbeat.findUnique({ where: { workerId: repoTestWorkerId } });
  assert(repoHb1?.nextPollEstimate !== null, 'nextPollEstimate should be set');
  assert(repoHb1?.lastError === 'test-error-string', 'lastError should be set');

  // Update using explicit null to clear nextPollEstimate and lastError
  await updateWorkerHeartbeat({
    workerId: repoTestWorkerId,
    startedAt: new Date(),
    currentStatus: 'STOPPING',
    nextPollEstimate: null,
    lastError: null
  });

  const repoHb2 = await prisma.workerHeartbeat.findUnique({ where: { workerId: repoTestWorkerId } });
  assert(repoHb2?.nextPollEstimate === null, 'STOPPING must clear nextPollEstimate (null)');
  assert(repoHb2?.lastError === null, 'STOPPING must clear lastError (null)');

  // Update using undefined to verify fields are NOT modified
  await updateWorkerHeartbeat({
    workerId: repoTestWorkerId,
    startedAt: new Date(),
    currentStatus: 'RUNNING'
    // nextPollEstimate and lastError omitted (undefined)
  });

  const repoHb3 = await prisma.workerHeartbeat.findUnique({ where: { workerId: repoTestWorkerId } });
  assert(repoHb3?.currentStatus === 'RUNNING', 'currentStatus should be updated');
  assert(repoHb3?.nextPollEstimate === null, 'nextPollEstimate should remain null');
  assert(repoHb3?.lastError === null, 'lastError should remain null');

  // Test 5.2: Case A - Shutdown after a successful IDLE cycle
  console.log('  Subtest 5.2: Case A - Shutdown after a successful IDLE cycle...');
  const workerAId = randomUUID();
  const controllerA = startWorkerDaemon({
    workerId: workerAId,
    pollIntervalMs: 500,
    errorBackoffMs: 2000,
    registerSignals: false
  });

  // Wait for the daemon to run at least one successful cycle and enter IDLE state
  const hbAIdle = await waitForStatus(workerAId, ['IDLE']);
  assert(hbAIdle.lastSuccessAt !== null, 'lastSuccessAt must be set');
  assert(hbAIdle.nextPollEstimate !== null, 'nextPollEstimate must be set to a future time');
  const prevSuccessAt = hbAIdle.lastSuccessAt;

  // Trigger shutdown
  await controllerA.shutdown();
  await controllerA.completionPromise;

  const hbAShutdown = await prisma.workerHeartbeat.findUnique({ where: { workerId: workerAId } });
  assert(hbAShutdown?.currentStatus === 'STOPPED', 'Final status must be STOPPED');
  assert(hbAShutdown?.nextPollEstimate === null, 'STOPPED heartbeat must not have next poll estimate');
  assert(hbAShutdown?.lastSuccessAt !== null && hbAShutdown?.lastSuccessAt !== undefined, 'lastSuccessAt must be preserved');
  assert(prevSuccessAt !== null && hbAShutdown!.lastSuccessAt!.getTime() === prevSuccessAt.getTime(), 'lastSuccessAt value must remain unchanged');
  assert(hbAShutdown?.lastError === null, 'lastError must be null');

  // Test 5.3: Case B - Shutdown while sleeping between polls (interrupt safety)
  console.log('  Subtest 5.3: Case B - Shutdown while sleeping between polls...');
  const workerBId = randomUUID();
  const controllerB = startWorkerDaemon({
    workerId: workerBId,
    pollIntervalMs: 10000, // Very long sleep
    errorBackoffMs: 20000,
    registerSignals: false
  });

  // Wait for daemon to finish first cycle and enter IDLE sleep
  await waitForStatus(workerBId, ['IDLE']);

  const shutdownStartB = Date.now();
  await controllerB.shutdown();
  await controllerB.completionPromise;
  const shutdownDurationB = Date.now() - shutdownStartB;

  console.log(`    Shutdown during sleep took ${shutdownDurationB}ms`);
  assert(shutdownDurationB < 2000, 'Sleep must be interrupted promptly');
  const hbBShutdown = await prisma.workerHeartbeat.findUnique({ where: { workerId: workerBId } });
  assert(hbBShutdown?.currentStatus === 'STOPPED', 'Final status must be STOPPED');
  assert(hbBShutdown?.nextPollEstimate === null, 'nextPollEstimate must be null');

  // Test 5.4: Case C - Shutdown during an active cycle (race safety)
  console.log('  Subtest 5.4: Case C - Shutdown during active cycle...');
  const { VideoValidationService: serviceC } = await import('../src/lib/storage/video-validation-service');
  const originalValidateOneAssetC = serviceC.validateOneAsset;
  serviceC.validateOneAsset = async () => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    return null;
  };

  const workerCId = randomUUID();
  const controllerC = startWorkerDaemon({
    workerId: workerCId,
    pollIntervalMs: 1000,
    errorBackoffMs: 2000,
    registerSignals: false
  });

  try {
    // Wait for it to start running
    await waitForStatus(workerCId, ['RUNNING']);

    // We request shutdown concurrently while running
    const shutdownPromiseC = controllerC.shutdown();

    // Wait for shutdown and completion to resolve
    await shutdownPromiseC;
    await controllerC.completionPromise;
  } finally {
    serviceC.validateOneAsset = originalValidateOneAssetC;
  }

  const hbCShutdown = await prisma.workerHeartbeat.findUnique({ where: { workerId: workerCId } });
  assert(hbCShutdown?.currentStatus === 'STOPPED', 'Final status must be STOPPED');
  assert(hbCShutdown?.nextPollEstimate === null, 'nextPollEstimate must be null');

  // Wait a short time to verify no deferred heartbeat writes to DB can change STOPPED back to IDLE
  await new Promise((r) => setTimeout(r, 600));
  const hbCShutdownAfterDelay = await prisma.workerHeartbeat.findUnique({ where: { workerId: workerCId } });
  assert(hbCShutdownAfterDelay?.currentStatus === 'STOPPED', 'No delayed heartbeat changes STOPPED back to IDLE');
  assert(hbCShutdownAfterDelay?.nextPollEstimate === null, 'nextPollEstimate must remain null');

  // Test 5.5: Case D - Repeated shutdown calls (idempotence)
  console.log('  Subtest 5.5: Case D - Repeated shutdown calls...');
  const workerCaseDId = randomUUID();
  const controllerCaseD = startWorkerDaemon({
    workerId: workerCaseDId,
    pollIntervalMs: 500,
    errorBackoffMs: 1000,
    registerSignals: false
  });

  await waitForStatus(workerCaseDId, ['IDLE', 'RUNNING']);
  await controllerCaseD.shutdown();
  await controllerCaseD.completionPromise;

  // Verify first shutdown
  const hbD1 = await prisma.workerHeartbeat.findUnique({ where: { workerId: workerCaseDId } });
  assert(hbD1?.currentStatus === 'STOPPED', 'Status must be STOPPED');
  assert(hbD1?.nextPollEstimate === null, 'nextPollEstimate must be null');

  // Call shutdown again
  let repeatedThrew = false;
  try {
    await controllerCaseD.shutdown();
  } catch {
    repeatedThrew = true;
  }
  assert(!repeatedThrew, 'Repeated shutdown calls must not throw any exception');

  const hbD2 = await prisma.workerHeartbeat.findUnique({ where: { workerId: workerCaseDId } });
  assert(hbD2?.currentStatus === 'STOPPED', 'Status must remain STOPPED');
  assert(hbD2?.nextPollEstimate === null, 'nextPollEstimate must remain null');

  // Test 5.6: Case E - Shutdown after BACKING_OFF
  console.log('  Subtest 5.6: Case E - Shutdown after BACKING_OFF...');
  const workerEId = randomUUID();

  // Temporarily force failure inside findMany to trigger error/backing off
  const originalFindManyE = prisma.videoJob.findMany;
  const mockVideoJobE = prisma.videoJob as unknown as { findMany: unknown };
  mockVideoJobE.findMany = () => {
    throw new Error('Forced backing off test failure');
  };

  const controllerE = startWorkerDaemon({
    workerId: workerEId,
    pollIntervalMs: 500,
    errorBackoffMs: 2000,
    registerSignals: false
  });

  try {
    const hbEBackingOff = await waitForStatus(workerEId, ['BACKING_OFF']);
    assert(hbEBackingOff.lastFailureAt !== null, 'lastFailureAt must be set');
    assert(hbEBackingOff.lastError !== null, 'lastError must be set');
    const prevFailureAt = hbEBackingOff.lastFailureAt;

    await controllerE.shutdown();
    await controllerE.completionPromise;

    const hbEShutdown = await prisma.workerHeartbeat.findUnique({ where: { workerId: workerEId } });
    assert(hbEShutdown?.currentStatus === 'STOPPED', 'Final status must be STOPPED');
    assert(hbEShutdown?.nextPollEstimate === null, 'nextPollEstimate must be null');
    assert(hbEShutdown?.lastFailureAt !== null && hbEShutdown?.lastFailureAt !== undefined, 'lastFailureAt must be preserved');
    assert(prevFailureAt !== null && hbEShutdown!.lastFailureAt!.getTime() === prevFailureAt.getTime(), 'lastFailureAt value must remain unchanged');
    assert(hbEShutdown?.lastError === null, 'Successful shutdown must set lastError: null');
  } finally {
    mockVideoJobE.findMany = originalFindManyE;
  }

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
      workerId: { notIn: [workerId, workerAId, workerBId, workerCId, workerCaseDId, workerEId, repoTestWorkerId] }
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
  console.log('Awaiting quick boot check for valid daemon configuration (using spawn)...');

  const bootRes = await new Promise<{ startupConfirmed: boolean; childExited: boolean; childExitCode: number | null; stdout: string; stderr: string }>(async (resolve) => {
    let stdoutStr = '';
    let stderrStr = '';
    let childExited = false;
    let childExitCode: number | null = null;
    let startupConfirmed = false;

    let childEnv: Record<string, string | undefined>;
    try {
      childEnv = cleanEnvForChild({
        WORKER_ENABLED: 'true',
        WORKER_ID: validWorkerId,
        WORKER_POLL_INTERVAL_MS: '1000',
        WORKER_ERROR_BACKOFF_MS: '5000'
      });
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }

    const child = spawn(
      process.execPath,
      [
        '--conditions=react-server',
        '--import',
        'tsx',
        'scripts/run-production-worker.ts'
      ],
      {
        shell: false,
        windowsHide: true,
        env: childEnv as NodeJS.ProcessEnv
      }
    );

    child.stdout?.on('data', (data) => {
      stdoutStr += data.toString();
    });
    child.stderr?.on('data', (data) => {
      stderrStr += data.toString();
    });

    child.on('exit', (code) => {
      childExited = true;
      childExitCode = code;
    });

    // Poll for database heartbeat presence or log indicators
    const startTime = Date.now();
    while (Date.now() - startTime < 3500) {
      if (childExited) {
        break;
      }

      const childHeartbeat = await prisma.workerHeartbeat.findUnique({
        where: { workerId: validWorkerId }
      });
      if (childHeartbeat !== null) {
        startupConfirmed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    // Forcefully clean up child process cleanly
    child.kill('SIGINT');

    // Wait for exit
    await new Promise<void>((r) => {
      if (childExited) r();
      child.on('exit', () => r());
      setTimeout(r, 1000);
    });

    resolve({
      startupConfirmed,
      childExited,
      childExitCode,
      stdout: stdoutStr,
      stderr: stderrStr
    });
  });

  console.log('Boot check completed. Startup Confirmed:', bootRes.startupConfirmed);
  assert(bootRes.startupConfirmed, `Failed to confirm worker startup. Stdout: ${bootRes.stdout}. Stderr: ${bootRes.stderr}`);

  // Assert stderr doesn't contain server-only client import warnings or unhandled rejections
  assert(!bootRes.stderr.includes('Startup configuration error'), 'Stderr must not contain configuration error');
  assert(!bootRes.stderr.includes('Fatal error'), 'Stderr must not contain Fatal error');
  assert(!bootRes.stderr.includes('This module cannot be imported from a Client Component module'), 'Stderr must not contain client component import error');
  assert(!bootRes.stderr.includes('unhandledRejection') && !bootRes.stderr.includes('UnhandledPromiseRejectionWarning'), 'Stderr must not contain unhandled rejection');

  // Check if heartbeat row was successfully created in the test database by the child process
  const childHeartbeat = await prisma.workerHeartbeat.findUnique({
    where: { workerId: validWorkerId }
  });
  assert(childHeartbeat !== null, 'Heartbeat record must be created by the booted daemon process');
  assert(childHeartbeat!.currentStatus === 'STOPPED' || childHeartbeat!.currentStatus === 'IDLE' || childHeartbeat!.currentStatus === 'STOPPING' || childHeartbeat!.currentStatus === 'RUNNING', 'Heartbeat status was written successfully');

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

  // ==========================================
  // Test 11: Successful worker:once process test (Part 4A)
  // ==========================================
  console.log('Test 11: Successful worker:once process test (creates no work)...');
  const workerOnceId1 = randomUUID();
  const resOnce1 = await runWorkerOnceProcess({
    WORKER_ID: workerOnceId1
  });
  assert(resOnce1.code === 0, 'Successful one-cycle execution must exit with code 0');

  const hbOnce1 = await prisma.workerHeartbeat.findUnique({ where: { workerId: workerOnceId1 } });
  assert(hbOnce1 !== null, 'Heartbeat record must be created');
  assert(hbOnce1!.currentStatus === 'IDLE', 'Final status must be IDLE');
  assert(hbOnce1!.lastSuccessAt !== null, 'lastSuccessAt must be set');
  assert(hbOnce1!.lastFailureAt === null, 'lastFailureAt must be null');
  assert(hbOnce1!.lastError === null, 'lastError must be null');
  assert(hbOnce1!.jobsProcessedLastCycle === 0, 'jobsProcessedLastCycle must be 0');
  assert(hbOnce1!.nextPollEstimate === null, 'nextPollEstimate must be null');

  // ==========================================
  // Test 12: Successful worker:once with one mock eligible item (Part 4B)
  // ==========================================
  console.log('Test 12: Successful worker:once with one mock eligible item...');
  const workerOnceId2 = randomUUID();
  await prisma.videoJob.deleteMany({});

  const dueJobIdOnce = randomUUID();
  await prisma.videoJob.create({
    data: {
      id: dueJobIdOnce,
      userId: testUserId,
      pageId: testPageId,
      uploadAssetId: asset.id,
      englishTitle: 'Once Due Job',
      englishCaption: 'This is due for once test',
      scheduledTimeUTC: new Date(Date.now() - 10000),
      status: JobStatus.SCHEDULED,
      mockScenario: MockScenario.SUCCESS,
    }
  });

  const resOnce2 = await runWorkerOnceProcess({
    WORKER_ID: workerOnceId2
  });
  assert(resOnce2.code === 0, 'One-cycle execution must exit with code 0');

  const hbOnce2 = await prisma.workerHeartbeat.findUnique({ where: { workerId: workerOnceId2 } });
  assert(hbOnce2 !== null, 'Heartbeat must exist');
  assert(hbOnce2!.currentStatus === 'IDLE', 'Final status must be IDLE');
  assert(hbOnce2!.jobsProcessedLastCycle === 1, 'jobsProcessedLastCycle must be 1');

  // ==========================================
  // Test 13: Failed worker:once (Part 4C)
  // ==========================================
  console.log('Test 13: Failed worker:once...');
  const workerOnceId3 = randomUUID();
  const resOnce3 = await runWorkerOnceFailedProcess({
    WORKER_ID: workerOnceId3
  });
  assert(resOnce3.code === 1, 'Failed one-cycle execution must exit with code 1');

  const hbOnce3 = await prisma.workerHeartbeat.findUnique({ where: { workerId: workerOnceId3 } });
  assert(hbOnce3 !== null, 'Heartbeat must exist');
  assert(hbOnce3!.currentStatus === 'FAILED', 'Final status must be FAILED');
  assert(hbOnce3!.lastFailureAt !== null, 'lastFailureAt must be set');
  const errOnce3 = hbOnce3!.lastError || '';
  assert(errOnce3.includes('[REDACTED]'), 'Error message must be sanitized');
  assert(!errOnce3.includes('token_secret_xyz'), 'Token secret must be redacted');
  assert(hbOnce3!.nextPollEstimate === null, 'nextPollEstimate must be null');

  // ==========================================
  // Test 14: Success overrides failure on same worker ID (Part 2 regression test)
  // ==========================================
  console.log('Test 14: Success overrides failure on same worker ID regression test...');
  const regressionWorkerId = randomUUID();

  // 1. Run failed execution
  let regressionErrorCaught = false;
  try {
    await executeWorkerCycle(regressionWorkerId, new Date(), {
      updateFinalHeartbeat: true,
      runQueueWorker: async () => {
        throw new Error('Forced regression test failure containing secret=bearer_token_123');
      }
    });
  } catch {
    regressionErrorCaught = true;
  }
  assert(regressionErrorCaught, 'Should propagate regression error');

  const hbReg1 = await prisma.workerHeartbeat.findUnique({ where: { workerId: regressionWorkerId } });
  assert(hbReg1 !== null, 'Heartbeat record must exist');
  assert(hbReg1!.currentStatus === 'FAILED', 'Status must be FAILED');
  const errReg1 = hbReg1!.lastError || '';
  assert(errReg1.includes('[REDACTED]'), 'Error message must be sanitized');
  assert(!errReg1.includes('bearer_token_123'), 'Secret must be redacted');

  // 2. Run successful execution using same worker ID
  await executeWorkerCycle(regressionWorkerId, new Date(), {
    updateFinalHeartbeat: true,
    runQueueWorker: async () => {
      return ['[Worker] Claimed Job success'];
    }
  });

  const hbReg2 = await prisma.workerHeartbeat.findUnique({ where: { workerId: regressionWorkerId } });
  assert(hbReg2 !== null, 'Heartbeat record must exist');
  assert(hbReg2!.currentStatus === 'IDLE', 'Status must be IDLE');
  assert(hbReg2!.lastSuccessAt !== null, 'lastSuccessAt must be set');
  assert(hbReg2!.lastError === null, 'lastError must be cleared to null');
  assert(hbReg2!.nextPollEstimate === null, 'nextPollEstimate must be null');
  assert(hbReg2!.jobsProcessedLastCycle === 1, 'jobsProcessedLastCycle must be updated to 1');

  // ==========================================
  // Test A: No validating assets
  // ==========================================
  console.log('Test A: No validating assets (one-shot)...');
  await cleanDatabase();
  const testAWorkerId = randomUUID();
  const resA = await runWorkerOnceProcess({
    WORKER_ID: testAWorkerId
  });
  assert(resA.code === 0, 'Exit code must be 0 for no validating assets');
  assert(!resA.stdout.includes('[Asset Validation] [ERROR]'), 'Should not have validation error log');
  assert(resA.stdout.includes('[Asset Validation] No assets in VALIDATING state require validation.'), 'Should log no assets');
  const hbA = await prisma.workerHeartbeat.findUnique({ where: { workerId: testAWorkerId } });
  assert(hbA !== null, 'Heartbeat record must exist');
  assert(hbA!.currentStatus === 'IDLE', 'Heartbeat status must be IDLE');
  assert(hbA!.lastSuccessAt !== null, 'lastSuccessAt must be set');
  assert(hbA!.lastError === null, 'lastError must be null');

  // ==========================================
  // Test B: One mock validating asset
  // ==========================================
  console.log('Test B: One mock validating asset (context binding)...');
  await cleanDatabase();
  const testBUserId = randomUUID();
  await prisma.user.create({
    data: {
      id: testBUserId,
      email: `testb-user-${testBUserId.slice(0, 8)}@example.com`,
      passwordHash: 'dummy',
      role: 'USER',
      status: 'ACTIVE',
      approvalStatus: 'APPROVED'
    }
  });
  const testBAsset = await prisma.uploadAsset.create({
    data: {
      id: randomUUID(),
      userId: testBUserId,
      provider: 'R2',
      bucket: 'test-bucket',
      objectKey: 'testb-video.mp4',
      originalName: 'testb-video.mp4',
      expectedSize: BigInt(100),
      actualSize: BigInt(100),
      declaredMimeType: 'video/mp4',
      status: 'VALIDATING',
      idempotencyKey: `idem-testb-${randomUUID()}`,
      requestFingerprint: `finger-testb-${randomUUID()}`,
      uploadExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
    }
  });

  const { VideoValidationService } = await import('../src/lib/storage/video-validation-service');
  const { getStorageAdapter } = await import('../src/lib/storage');
  const adapterB = getStorageAdapter();
  (adapterB as unknown as { storedObjects: Map<string, unknown> }).storedObjects = new Map();
  (adapterB as unknown as { storedObjects: Map<string, unknown> }).storedObjects.set(`test-bucket/${testBAsset.objectKey}`, {
    size: 100,
    etag: '"etag-testb"',
    contentType: 'video/mp4',
    content: Buffer.alloc(100, 'v'),
    lastModified: new Date()
  });

  const mockProbeB = {
    probe: async () => ({
      containerFormat: 'mp4',
      durationMs: 5000,
      videoCodec: 'h264',
      audioCodec: 'aac',
      width: 1920,
      height: 1080,
      frameRate: 30.0,
      detectedMimeType: 'video/mp4'
    })
  };
  VideoValidationService.setProbe(mockProbeB);

  const testBWorkerId = randomUUID();
  const resB = await executeWorkerCycle(testBWorkerId, new Date(), {
    updateFinalHeartbeat: true,
    validateOneAsset: () => VideoValidationService.validateOneAsset() // arrow wrapper!
  });
  assert(resB.processedCount === 1, 'Processed count must be 1');
  assert(!resB.logs.some(l => l.includes('Cannot read properties of undefined')), 'Should not fail with undefined error');
  assert(resB.logs.some(l => l.includes('Success: true, Status: VALIDATED')), 'Asset must be successfully validated');

  // ==========================================
  // Test C: Injected validation failure
  // ==========================================
  console.log('Test C: Injected validation failure (one-shot exit code 1)...');
  await cleanDatabase();
  const testCWorkerId = randomUUID();
  // We run the script that we created
  const resC = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    let childEnv: Record<string, string | undefined>;
    try {
      childEnv = cleanEnvForChild({
        WORKER_ID: testCWorkerId
      });
    } catch (err) {
      console.error((err as Error).message);
      reject(err);
      return;
    }
    const command = 'node --conditions=react-server --import tsx scripts/run-test-worker-once-validation-failed.ts';
    exec(command, { env: childEnv as NodeJS.ProcessEnv }, (error, stdout, stderr) => {
      resolve({
        code: error ? (error.code || 1) : 0,
        stdout,
        stderr
      });
    });
  });

  assert(resC.code === 1, `One-shot with validation failure must exit with code 1, got code: ${resC.code}`);
  const hbC = await prisma.workerHeartbeat.findUnique({ where: { workerId: testCWorkerId } });
  assert(hbC !== null, 'Heartbeat record must exist');
  assert(hbC!.currentStatus === 'FAILED', `Heartbeat status must be FAILED, got: ${hbC!.currentStatus}`);
  assert(hbC!.lastFailureAt !== null, 'lastFailureAt must be set');
  assert(hbC!.lastError !== null, 'lastError must be logged');
  assert(hbC!.lastError!.includes('[REDACTED]'), 'Error message must be sanitized');
  assert(!hbC!.lastError!.includes('bearer_12345'), 'Credentials must not leak');
  assert(hbC!.nextPollEstimate === null, 'nextPollEstimate must be null');

  // ==========================================
  // Test D: Daemon injected validation failure
  // ==========================================
  console.log('Test D: Daemon injected validation failure (BACKING_OFF)...');
  await cleanDatabase();
  const testDWorkerId = randomUUID();

  // Temporary mock of claimOneAsset and validateAsset on VideoValidationService
  const originalClaim = VideoValidationService.claimOneAsset;
  const originalValidate = VideoValidationService.validateAsset;

  let controllerD: WorkerController | null = null;

  try {
    VideoValidationService.claimOneAsset = async () => ({
      assetId: 'test-d-asset-id',
      userId: 'test-d-user-id',
      lockToken: 'lock-testd',
      lockedAt: new Date(),
      lockExpiresAt: new Date()
    });

    VideoValidationService.validateAsset = async () => {
      throw new Error('Forced daemon validation failure with credential_key=bearer_54321');
    };

    controllerD = startWorkerDaemon({
      workerId: testDWorkerId,
      pollIntervalMs: 500,
      errorBackoffMs: 2000,
      registerSignals: false
    });

    // Poll the test heartbeat until it reaches BACKING_OFF (timeout after 5 seconds)
    const startTime = Date.now();
    let statusD = '';
    let hbD: { currentStatus: string; lastFailureAt: Date | null; lastError: string | null } | null = null;
    while (Date.now() - startTime < 5000) {
      hbD = await prisma.workerHeartbeat.findUnique({ where: { workerId: testDWorkerId } });
      if (hbD && hbD.currentStatus === 'BACKING_OFF') {
        statusD = 'BACKING_OFF';
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    assert(statusD === 'BACKING_OFF', `Status must reach BACKING_OFF, got: ${hbD?.currentStatus}`);
    assert(hbD!.lastFailureAt !== null, 'lastFailureAt must be set');
    assert(hbD!.lastError !== null, 'lastError must be logged');
    assert(hbD!.lastError!.includes('[REDACTED]'), 'Error must be sanitized');
    assert(!hbD!.lastError!.includes('bearer_54321'), 'Credentials must not leak');

  } finally {
    // Shutdown daemon
    if (controllerD) {
      await controllerD.shutdown();
      await controllerD.completionPromise;
    }

    // Restore VideoValidationService
    VideoValidationService.claimOneAsset = originalClaim;
    VideoValidationService.validateAsset = originalValidate;
  }

  // ==========================================
  // Test E: Admin worker route validation
  // ==========================================
  console.log('Test E: Admin worker route validation...');
  const { handleWorkerPost } = await import('../src/app/api/admin/worker/route');

  // Test E1: Real service wrapper (successful null result returns HTTP 200)
  console.log('Test E1: Real service wrapper (successful null result)...');
  await cleanDatabase();
  const mockReqE1 = mockRequest({ 'authorization': 'Bearer admin-token' });
  const mockPublishingCalledE1 = { val: false };

  const successDepsE1 = {
    verifyAdminSession: async () => adminUser,
    verifyAdminRole: () => true,
    runQueueWorker: async () => {
      mockPublishingCalledE1.val = true;
      return ['Queue completed successfully.'];
    },
    validateOneAsset: () => VideoValidationService.validateOneAsset() // arrow wrapper!
  };

  const resE1 = await handleWorkerPost(mockReqE1, successDepsE1);
  assert(resE1.status === 200, `Admin route status must be 200, got: ${resE1.status}`);
  const bodyE1 = await resE1.json() as Record<string, unknown>;
  assert(bodyE1.success === true, 'Response success must be true');
  assert(mockPublishingCalledE1.val === true, 'Queue worker should have been called');
  assert(!(bodyE1.logs as string[]).some((l: string) => l.includes('Cannot read properties of undefined')), 'No undefined context errors in logs');
  assert((bodyE1.logs as string[]).some((l: string) => l.includes('No assets in VALIDATING state require validation.')), 'Expected "No assets" log in response');

  // Test E2: Injected validation failure (returns HTTP 500, no success true, raw credentials redacted)
  console.log('Test E2: Injected validation failure (returns HTTP 500)...');
  const mockReqE2 = mockRequest({ 'authorization': 'Bearer admin-token' });
  const mockPublishingCalledE2 = { val: false };

  const failDepsE2 = {
    verifyAdminSession: async () => adminUser,
    verifyAdminRole: () => true,
    runQueueWorker: async () => {
      mockPublishingCalledE2.val = true;
      return ['Queue completed successfully.'];
    },
    validateOneAsset: async () => {
      throw new Error('Forced validation failure with credentials_secret=bearer_99999');
    }
  };

  const resE2 = await handleWorkerPost(mockReqE2, failDepsE2);
  assert(resE2.status === 500, `Admin route status must be 500, got: ${resE2.status}`);
  const bodyE2 = await resE2.json() as Record<string, unknown>;
  assert(bodyE2.success !== true, 'Response success must not be true');
  const errE2 = (bodyE2.error as string) || '';
  assert(errE2.includes('[REDACTED]'), 'Error message must be sanitized');
  assert(!errE2.includes('bearer_99999'), 'Credentials must not leak');

  console.log('All Expanded Background Worker Runtime and Observability Tests Passed successfully! 🎉');
}

runTests()
  .then(() => {
    // Let event loop flush naturally
  })
  .catch((e) => {
    console.error('Test execution failed:', e);
    process.exitCode = 1;
  });
