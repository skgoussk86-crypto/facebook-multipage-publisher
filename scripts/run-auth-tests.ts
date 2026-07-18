import { spawn, ChildProcess } from 'child_process';
import { PrismaClient } from '@prisma/client';
import http from 'http';
import { randomUUID } from 'crypto';

const prisma = new PrismaClient();
const PORT = 3001;
const BASE_URL = `http://localhost:${PORT}`;

let serverProcess: ChildProcess | null = null;

async function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper to wait for the test server to become responsive
async function waitForServer(url: string, timeoutMs: number = 25000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.get(url, (res) => {
          if (res.statusCode === 200) {
            resolve();
          } else {
            reject();
          }
        });
        req.on('error', reject);
        req.end();
      });
      console.log('Test server is ready!');
      return true;
    } catch {
      await delay(1000);
    }
  }
  return false;
}

async function runTests() {
  console.log('Starting Test Next.js server on port', PORT);
  
  // Launch the server
  serverProcess = spawn('npx.cmd', ['next', 'dev', '-p', String(PORT)], {
    stdio: 'inherit',
    shell: true
  });

  // Check health endpoint
  const ready = await waitForServer(`${BASE_URL}/api/health`);
  if (!ready) {
    throw new Error('Test server failed to start or become healthy.');
  }

  console.log('Cleaning up existing test data...');
  try {
    const userEmails = ['test-a@example.com', 'test-b@example.com', 'system-admin@example.com'];
    const users = await prisma.user.findMany({
      where: { email: { in: userEmails } },
      select: { id: true }
    });
    const userIds = users.map(u => u.id);

    if (userIds.length > 0) {
      await prisma.appConfiguration.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.videoJob.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.facebookPage.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.facebookAccount.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
  } catch (cleanupErr) {
    console.warn('Warning during initial cleanup:', cleanupErr);
  }

  // Create a dummy approved admin first to satisfy the /api/admin/login requirement
  await prisma.user.create({
    data: {
      id: randomUUID(),
      email: 'system-admin@example.com',
      passwordHash: 'dummy',
      role: 'ADMIN',
      status: 'ACTIVE',
      approvalStatus: 'APPROVED'
    }
  });

  let cookieA = '';
  let cookieB = '';
  let userIdA = '';
  let userIdB = '';

  try {
    // TEST 1: Protected pages and APIs (Unauthorized)
    console.log('\n--- TEST 1: Protected pages and APIs without Session ---');
    const resPagesUnauth = await fetch(`${BASE_URL}/api/facebook/pages`);
    console.log('GET /api/facebook/pages status:', resPagesUnauth.status);
    if (resPagesUnauth.status !== 401) {
      throw new Error(`Expected 401, got ${resPagesUnauth.status}`);
    }

    // TEST 2: Registration
    console.log('\n--- TEST 2: User Registration ---');
    const resRegA = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'test-a@example.com',
        password: 'testpassword123',
        name: 'Test User A'
      })
    });
    const regDataA = await resRegA.json();
    console.log('Register status:', resRegA.status, regDataA);
    if (resRegA.status !== 200 || !regDataA.success) {
      throw new Error(`Registration failed: ${JSON.stringify(regDataA)}`);
    }
    userIdA = regDataA.user.id;

    // TEST 3: Duplicate Registration
    console.log('\n--- TEST 3: Duplicate Registration ---');
    const resRegDup = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'test-a@example.com',
        password: 'anotherpassword',
        name: 'Test User A Duplicate'
      })
    });
    const regDataDup = await resRegDup.json();
    console.log('Duplicate Register status:', resRegDup.status, regDataDup);
    if (resRegDup.status !== 400) {
      throw new Error(`Expected 400 for duplicate, got ${resRegDup.status}`);
    }
    // Approve Test User A in DB so they can login successfully
    await prisma.user.update({
      where: { id: userIdA },
      data: { approvalStatus: 'APPROVED' }
    });
    // TEST 4: Correct Login
    console.log('\n--- TEST 4: Correct Login ---');
    const resLoginA = await fetch(`${BASE_URL}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'test-a@example.com',
        password: 'testpassword123'
      })
    });
    console.log('Login A status:', resLoginA.status);
    if (resLoginA.status !== 200) {
      throw new Error(`Login A failed: ${resLoginA.status}`);
    }
    const setCookieHeaderA = resLoginA.headers.get('set-cookie');
    if (!setCookieHeaderA) {
      throw new Error('No Set-Cookie header returned on login.');
    }
    cookieA = setCookieHeaderA.split(';')[0];
    console.log('Cookie A obtained successfully.');

    // TEST 5: Incorrect Login
    console.log('\n--- TEST 5: Incorrect Login ---');
    const resLoginWrong = await fetch(`${BASE_URL}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'test-a@example.com',
        password: 'wrongpassword'
      })
    });
    console.log('Wrong Login status:', resLoginWrong.status);
    if (resLoginWrong.status !== 401) {
      throw new Error(`Expected 401, got ${resLoginWrong.status}`);
    }

    // Promote User A to ADMIN directly in DB for testing admin operations
    console.log('Promoting Test User A to ADMIN in PostgreSQL...');
    await prisma.user.update({
      where: { id: userIdA },
      data: { role: 'ADMIN' }
    });

    // Create User B (will remain standard USER role)
    console.log('Registering Test User B...');
    const resRegB = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'test-b@example.com',
        password: 'testpassword456',
        name: 'Test User B'
      })
    });
    const regDataB = await resRegB.json();
    userIdB = regDataB.user.id;

    // Approve Test User B in DB so they can login successfully
    await prisma.user.update({
      where: { id: userIdB },
      data: { approvalStatus: 'APPROVED' }
    });

    // Login as B to get cookie B
    const resLoginB = await fetch(`${BASE_URL}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'test-b@example.com',
        password: 'testpassword456'
      })
    });
    const setCookieHeaderB = resLoginB.headers.get('set-cookie');
    if (!setCookieHeaderB) throw new Error('No cookie header for B');
    cookieB = setCookieHeaderB.split(';')[0];

    // TEST 6: Save configurations first to enable Facebook actions
    console.log('\n--- TEST 6: Save Configuration (User A) ---');
    const resSaveConfigA = await fetch(`${BASE_URL}/api/admin/config`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookieA,
        'Origin': `http://localhost:${PORT}`
      },
      body: JSON.stringify({
        publicAppUrl: `http://localhost:${PORT}`,
        facebookAppId: '123456',
        facebookAppSecret: 'secret123',
        liveMetaMode: false
      })
    });
    console.log('Save Config User A status:', resSaveConfigA.status);
    if (resSaveConfigA.status !== 200) {
      const body = await resSaveConfigA.text();
      throw new Error(`Failed to save config: ${resSaveConfigA.status} - ${body}`);
    }

    console.log('\n--- TEST 7: Save Configuration (User B) ---');
    const resSaveConfigB = await fetch(`${BASE_URL}/api/admin/config`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookieB,
        'Origin': `http://localhost:${PORT}`
      },
      body: JSON.stringify({
        publicAppUrl: `http://localhost:${PORT}`,
        facebookAppId: '654321',
        facebookAppSecret: 'secret456',
        liveMetaMode: false
      })
    });
    console.log('Save Config User B status:', resSaveConfigB.status);
    if (resSaveConfigB.status !== 200) {
      const body = await resSaveConfigB.text();
      throw new Error(`Failed to save config B: ${resSaveConfigB.status} - ${body}`);
    }

    // TEST 8: Access Protected API with Session A
    console.log('\n--- TEST 8: Access Protected API with Session A ---');
    const resPagesAuthA = await fetch(`${BASE_URL}/api/facebook/pages`, {
      headers: { 'Cookie': cookieA }
    });
    console.log('GET /api/facebook/pages with Session A status:', resPagesAuthA.status);
    if (resPagesAuthA.status !== 200) {
      throw new Error(`Expected 200, got ${resPagesAuthA.status}`);
    }

    // TEST 9: USER Rejection from Admin Routes (audit logs)
    console.log('\n--- TEST 9: USER Rejection from Admin Routes ---');
    const resLogsUser = await fetch(`${BASE_URL}/api/admin/audit-logs`, {
      headers: { 'Cookie': cookieB }
    });
    console.log('GET /api/admin/audit-logs for B (USER) status:', resLogsUser.status);
    if (resLogsUser.status !== 403) {
      throw new Error(`Expected 403 Forbidden for USER role, got ${resLogsUser.status}`);
    }

    // TEST 10: Admin List Users
    console.log('\n--- TEST 10: ADMIN Access to User Management ---');
    const resAdminUsers = await fetch(`${BASE_URL}/api/admin/users`, {
      headers: { 'Cookie': cookieA }
    });
    const adminUsersData = await resAdminUsers.json();
    console.log('GET /api/admin/users status:', resAdminUsers.status, 'Count:', adminUsersData.users?.length);
    if (resAdminUsers.status !== 200 || !adminUsersData.users) {
      throw new Error(`Failed to list users as ADMIN`);
    }

    // TEST 11: Suspended-User Rejection
    console.log('\n--- TEST 11: Suspended-User Rejection ---');
    // Verify B can access pages initially
    const resPagesBInit = await fetch(`${BASE_URL}/api/facebook/pages`, { headers: { 'Cookie': cookieB } });
    if (resPagesBInit.status !== 200) throw new Error('User B should be able to access initially');

    // Suspend B using Admin A session
    const resSuspendB = await fetch(`${BASE_URL}/api/admin/users`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookieA,
        'Origin': `http://localhost:${PORT}`
      },
      body: JSON.stringify({
        targetUserId: userIdB,
        status: 'SUSPENDED'
      })
    });
    console.log('Suspend User B status:', resSuspendB.status);
    if (resSuspendB.status !== 200) throw new Error('Failed to suspend User B');

    // Try accessing pages as B now
    const resPagesBSuspended = await fetch(`${BASE_URL}/api/facebook/pages`, { headers: { 'Cookie': cookieB } });
    console.log('GET /api/facebook/pages as Suspended B status:', resPagesBSuspended.status);
    if (resPagesBSuspended.status !== 401) {
      throw new Error(`Expected 401 for suspended user, got ${resPagesBSuspended.status}`);
    }

    // Reactivate B
    const resReactivateB = await fetch(`${BASE_URL}/api/admin/users`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookieA,
        'Origin': `http://localhost:${PORT}`
      },
      body: JSON.stringify({
        targetUserId: userIdB,
        status: 'ACTIVE'
      })
    });
    if (resReactivateB.status !== 200) throw new Error('Failed to reactivate User B');

    // TEST 12: Cross-User Data Isolation (Facebook pages)
    console.log('\n--- TEST 12: Cross-User Data Isolation ---');
    // Let's connect a mock Facebook account for User A
    const mockAuthUrl = `${BASE_URL}/api/auth/facebook/callback?mock=true&state=mock_state&code=mock_code`;
    console.log('Simulating Facebook Login OAuth callback for User A...');
    const resOAuthA = await fetch(mockAuthUrl, {
      headers: { 'Cookie': `${cookieA}; fb_oauth_state=mock_state` },
      redirect: 'manual'
    });
    console.log('OAuth A redirect status:', resOAuthA.status);

    // Verify User A sees accounts
    const resPagesA = await fetch(`${BASE_URL}/api/facebook/pages`, { headers: { 'Cookie': cookieA } });
    const pagesDataA = await resPagesA.json();
    console.log('User A pages count:', pagesDataA.accounts?.length || 0);
    if ((pagesDataA.accounts?.length || 0) === 0) {
      throw new Error('Expected User A to have connected account');
    }

    // Verify User B sees ZERO accounts (isolated!)
    const resPagesB = await fetch(`${BASE_URL}/api/facebook/pages`, { headers: { 'Cookie': cookieB } });
    const pagesDataB = await resPagesB.json();
    console.log('User B pages count:', pagesDataB.accounts?.length || 0);
    if ((pagesDataB.accounts?.length || 0) !== 0) {
      throw new Error(`Data isolation violation: User B saw User A's connected account!`);
    }

    // TEST 13: Configuration Isolation verification
    console.log('\n--- TEST 13: Configuration Isolation Verification ---');
    // Fetch config as User B. Assert it matches B's config and NOT A's config
    const resConfigB = await fetch(`${BASE_URL}/api/admin/config`, { headers: { 'Cookie': cookieB } });
    const configDataB = await resConfigB.json();
    console.log('User B config app ID:', configDataB.facebookAppId);
    if (configDataB.facebookAppId === '123456') {
      throw new Error('Data isolation violation: User B shared User A configuration.');
    }

    // TEST 14: Logout
    console.log('\n--- TEST 14: Logout ---');
    const resLogout = await fetch(`${BASE_URL}/api/admin/login`, {
      method: 'DELETE',
      headers: { 'Cookie': cookieA }
    });
    console.log('Logout status:', resLogout.status);
    if (resLogout.status !== 200) {
      throw new Error('Logout failed');
    }

    const setCookie = resLogout.headers.get('set-cookie');
    console.log('Logout Set-Cookie header:', setCookie);
    if (!setCookie || (!setCookie.includes('Max-Age=-1') && !setCookie.includes('1970'))) {
      throw new Error('Expected session cookie to be cleared with Max-Age=-1 or past Expires header');
    }

    console.log('\n==================================');
    console.log('ALL AUTH & DATA ISOLATION TESTS PASSED!');
    console.log('==================================');

  } finally {
    console.log('Cleaning up test users...');
    try {
      const userEmails = ['test-a@example.com', 'test-b@example.com', 'system-admin@example.com'];
      const users = await prisma.user.findMany({
        where: { email: { in: userEmails } },
        select: { id: true }
      });
      const userIds = users.map(u => u.id);

      if (userIds.length > 0) {
        await prisma.appConfiguration.deleteMany({ where: { userId: { in: userIds } } });
        await prisma.videoJob.deleteMany({ where: { userId: { in: userIds } } });
        await prisma.facebookPage.deleteMany({ where: { userId: { in: userIds } } });
        await prisma.facebookAccount.deleteMany({ where: { userId: { in: userIds } } });
        await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      }
    } catch (cleanupErr) {
      console.warn('Warning during test cleanup:', cleanupErr);
    }

    if (serverProcess) {
      console.log('Stopping test server...');
      serverProcess.kill('SIGINT');
    }
  }
}

runTests().catch(err => {
  console.error('Test execution failed:', err);
  if (serverProcess) {
    serverProcess.kill('SIGINT');
  }
  process.exit(1);
});
