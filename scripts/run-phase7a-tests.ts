import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { VideoJob } from '@prisma/client';

// 1. Install a fetch guard that throws immediately if any network request occurs
const originalFetch = global.fetch;
let networkCallAttempted = false;
(global as unknown as { fetch: unknown }).fetch = () => {
  networkCallAttempted = true;
  throw new Error('Network call blocked by fetch guard!');
};

// 2. Create unique temporary directory and temporary mock JSON file
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-publisher-tests-'));
const tempMockDbPath = path.join(tempDir, 'mock_db.json');

// Initialize with empty MockDbSchema structure
fs.writeFileSync(tempMockDbPath, JSON.stringify({ accounts: [], connectionState: 'Not Connected' }), 'utf8');

// 3. Set environment overrides BEFORE dynamically importing db.ts
((process as unknown) as { env: Record<string, string> }).env.NODE_ENV = 'test';
((process as unknown) as { env: Record<string, string> }).env.FB_PUBLISHER_TEST_MOCK_DB_PATH = tempMockDbPath;

// Mock the global prisma client
interface MockQueryRecord {
  model: string;
  method: string;
  args: unknown;
}
const mockQueries: MockQueryRecord[] = [];

// Real PrismaClient instantiation check is performed dynamically at startup.

interface MockArgs {
  where?: {
    userId?: string;
    id?: string;
    isEnabled?: boolean;
    isDefault?: boolean;
    appConfigurationId_facebookUserId?: {
      appConfigurationId: string;
      facebookUserId: string;
    };
    accountId_facebookPageId?: {
      accountId: string;
      facebookPageId: string;
    };
  };
  data?: Record<string, unknown>;
  create?: {
    id?: string;
    userId?: string;
    facebookUserId?: string;
    appConfigurationId?: string;
    name?: string;
    encryptedAccessToken?: string;
    tokenExpiresAt?: Date;
  };
}

const prismaMock = {
  $transaction: async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => {
    return await cb(prismaMock);
  },
  appConfiguration: {
    findMany: async (args?: MockArgs) => {
      mockQueries.push({ model: 'appConfiguration', method: 'findMany', args });
      if (args?.where?.userId === 'user-1') {
        return [
          { id: 'config-1', userId: 'user-1', facebookAppId: 'app-1', isDefault: true, isEnabled: true, configurationName: 'App 1', liveMetaMode: false, createdAt: new Date() },
          { id: 'config-2', userId: 'user-1', facebookAppId: 'app-2', isDefault: false, isEnabled: true, configurationName: 'App 2', liveMetaMode: false, createdAt: new Date() },
          { id: 'config-disabled', userId: 'user-1', facebookAppId: 'app-disabled', isDefault: false, isEnabled: false, configurationName: 'Disabled App', liveMetaMode: false, createdAt: new Date() }
        ];
      }
      return [];
    },
    findFirst: async (args?: MockArgs) => {
      mockQueries.push({ model: 'appConfiguration', method: 'findFirst', args });
      if (args?.where?.id === 'config-disabled' && args?.where?.isEnabled === true) {
        return null;
      }
      if (args?.where?.id === 'config-disabled') {
        return { id: 'config-disabled', userId: 'user-1', facebookAppId: 'app-disabled', isDefault: false, isEnabled: false, configurationName: 'Disabled App', liveMetaMode: false, createdAt: new Date() };
      }
      if (args?.where?.id === 'config-1' && args?.where?.userId === 'user-1') {
        return { id: 'config-1', userId: 'user-1', facebookAppId: 'app-1', isDefault: true, isEnabled: true, configurationName: 'App 1', liveMetaMode: false, createdAt: new Date() };
      }
      if (args?.where?.id === 'config-2' && args?.where?.userId === 'user-1') {
        return { id: 'config-2', userId: 'user-1', facebookAppId: 'app-2', isDefault: false, isEnabled: true, configurationName: 'App 2', liveMetaMode: false, createdAt: new Date() };
      }
      if (args?.where?.id === 'config-cross-user') {
        return null; // Cross-user app returns null under user-1
      }
      if (args?.where?.userId === 'user-1' && args?.where?.isDefault === true) {
        return { id: 'config-1', userId: 'user-1', facebookAppId: 'app-1', isDefault: true, isEnabled: true, configurationName: 'App 1', liveMetaMode: false, createdAt: new Date() };
      }
      return null;
    },
    findUnique: async (args?: MockArgs) => {
      mockQueries.push({ model: 'appConfiguration', method: 'findUnique', args });
      if (args?.where?.id === 'config-1') {
        return { id: 'config-1', userId: 'user-1', facebookAppId: 'app-1', isDefault: true, isEnabled: true, configurationName: 'App 1', liveMetaMode: false, createdAt: new Date() };
      }
      if (args?.where?.id === 'config-2') {
        return { id: 'config-2', userId: 'user-1', facebookAppId: 'app-2', isDefault: false, isEnabled: true, configurationName: 'App 2', liveMetaMode: false, createdAt: new Date() };
      }
      if (args?.where?.id === 'config-cross-user') {
        // Cross-user lookup
        return { id: 'config-cross-user', userId: 'user-2', facebookAppId: 'app-cross', isDefault: true, isEnabled: true, configurationName: 'Cross App', liveMetaMode: false, createdAt: new Date() };
      }
      return null;
    },
    updateMany: async (args?: MockArgs) => {
      mockQueries.push({ model: 'appConfiguration', method: 'updateMany', args });
      return { count: 1 };
    },
    update: async (args?: MockArgs) => {
      mockQueries.push({ model: 'appConfiguration', method: 'update', args });
      return { id: args?.where?.id, ...args?.data };
    }
  },
  facebookAccount: {
    findMany: async (args?: MockArgs) => {
      mockQueries.push({ model: 'facebookAccount', method: 'findMany', args });
      if (args?.where?.userId === 'user-no-config') {
        return [];
      }
      // To simulate findMany in sync:
      return [
        { id: 'account-1', userId: 'user-1', appConfigurationId: 'config-1', facebookUserId: 'fb-user-shared', name: 'User on Config 1', encryptedAccessToken: 'token', tokenExpiresAt: new Date(Date.now() + 10000000), pages: [], appConfiguration: { id: 'config-1', userId: 'user-1', facebookAppId: 'app-1', configurationName: 'App 1', liveMetaMode: false } },
        { id: 'account-2', userId: 'user-1', appConfigurationId: 'config-2', facebookUserId: 'fb-user-shared', name: 'User on Config 2', encryptedAccessToken: 'token', tokenExpiresAt: new Date(Date.now() + 10000000), pages: [], appConfiguration: { id: 'config-2', userId: 'user-1', facebookAppId: 'app-2', configurationName: 'App 2', liveMetaMode: false } }
      ];
    },
    findUnique: async (args?: MockArgs) => {
      mockQueries.push({ model: 'facebookAccount', method: 'findUnique', args });
      if (args?.where?.id === 'account-1') {
        return { id: 'account-1', userId: 'user-1', appConfigurationId: 'config-1', facebookUserId: 'fb-user-shared' };
      }
      if (args?.where?.id === 'account-2') {
        return { id: 'account-2', userId: 'user-1', appConfigurationId: 'config-2', facebookUserId: 'fb-user-shared' };
      }
      return null;
    },
    findFirst: async (args?: MockArgs) => {
      mockQueries.push({ model: 'facebookAccount', method: 'findFirst', args });
      if ((args?.where?.id === 'account-1' || args?.where?.id === 'mock-acc-id-1') && args?.where?.userId === 'user-1') {
        return { id: 'mock-acc-id-1', userId: 'user-1', appConfigurationId: 'config-1', facebookUserId: 'fb-user-shared' };
      }
      if ((args?.where?.id === 'account-2' || args?.where?.id === 'mock-acc-id-2') && args?.where?.userId === 'user-1') {
        return { id: 'mock-acc-id-2', userId: 'user-1', appConfigurationId: 'config-2', facebookUserId: 'fb-user-shared' };
      }
      return null;
    },
    upsert: async (args?: MockArgs) => {
      mockQueries.push({ model: 'facebookAccount', method: 'upsert', args });
      return { id: args?.create?.id || 'account-1', ...args?.create };
    },
    delete: async (args?: MockArgs) => {
      mockQueries.push({ model: 'facebookAccount', method: 'delete', args });
      return { id: args?.where?.id };
    }
  },
  facebookPage: {
    findUnique: async (args?: MockArgs) => {
      mockQueries.push({ model: 'facebookPage', method: 'findUnique', args });
      if (args?.where?.id === 'page-1') {
        return { id: 'page-1', userId: 'user-1', accountId: 'account-1', facebookPageId: 'fb-page-shared', encryptedPageToken: 'token' };
      }
      if (args?.where?.id === 'page-2') {
        return { id: 'page-2', userId: 'user-1', accountId: 'account-2', facebookPageId: 'fb-page-shared', encryptedPageToken: 'token' };
      }
      return null;
    },
    upsert: async (args?: MockArgs) => {
      mockQueries.push({ model: 'facebookPage', method: 'upsert', args });
      return { id: args?.create?.id || 'page-1', ...args?.create };
    },
    updateMany: async (args?: MockArgs) => {
      mockQueries.push({ model: 'facebookPage', method: 'updateMany', args });
      return { count: 1 };
    }
  }
};

(global as unknown as { prisma: unknown }).prisma = prismaMock;

async function main() {
  const originalMockDbContent = fs.readFileSync(path.join(process.cwd(), 'src/lib/mock_db.json'), 'utf8');

  try {
    const {
      getAppConfiguration,
      saveFacebookAccount,
      getFacebookConnections,
      disconnectFacebook,
      updatePagesStatus,
      setDefaultAppConfiguration,
      resolveAccountSyncContext
    } = await import('../src/lib/db');
    const { resolvePublishingContext } = await import('../src/lib/job-worker');
    const { prisma: exportedPrisma } = await import('../src/lib/prisma-client');
    assert.strictEqual(exportedPrisma, prismaMock, 'Prisma mock should have intercepted the exported client directly.');

    console.log('--- Executing Behavioral Assertions ---');

    // Assertion 1 & 2: Saving same facebookUserId under config-1 and config-2 creates distinct mock records with different appConfigurationId
    console.log('1 & 2. Verifying distinct mock records when saving same facebookUserId under config-1 and config-2...');
    await saveFacebookAccount('user-1', {
      id: 'mock-acc-id-1',
      facebookUserId: 'fb-user-shared',
      name: 'Account 1',
      encryptedAccessToken: 'token-1',
      tokenExpiresAt: new Date(Date.now() + 100000).toISOString(),
      pages: []
    }, 'Connected', 'config-1');

    await saveFacebookAccount('user-1', {
      id: 'mock-acc-id-2',
      facebookUserId: 'fb-user-shared',
      name: 'Account 2',
      encryptedAccessToken: 'token-2',
      tokenExpiresAt: new Date(Date.now() + 100000).toISOString(),
      pages: []
    }, 'Connected', 'config-2');

    const rawMockContent = JSON.parse(fs.readFileSync(tempMockDbPath, 'utf8')) as { accounts: Array<{ id: string; appConfigurationId: string; facebookUserId: string; pages: Array<unknown> }> };
    assert.strictEqual(rawMockContent.accounts.length, 2, 'Should create exactly two mock records.');
    const [mockRec1, mockRec2] = rawMockContent.accounts;
    assert.strictEqual(mockRec1.appConfigurationId, 'config-1');
    assert.strictEqual(mockRec2.appConfigurationId, 'config-2');
    assert.notStrictEqual(mockRec1.id, mockRec2.id, 'IDs must be distinct.');
    console.log('PASSED.');

    // Assertion 3: Synchronizing those records uses two distinct appConfigurationId + facebookUserId Prisma upsert keys
    console.log('3. Verifying sync uses distinct appConfigurationId + facebookUserId upsert keys...');
    mockQueries.length = 0;
    await getFacebookConnections('user-1');
    const upsertQueries = mockQueries.filter(q => q.model === 'facebookAccount' && q.method === 'upsert');
    assert.strictEqual(upsertQueries.length, 2, 'Should perform exactly 2 upserts.');
    const arg1 = upsertQueries[0].args as MockArgs;
    const arg2 = upsertQueries[1].args as MockArgs;
    assert.strictEqual(arg1.where?.appConfigurationId_facebookUserId?.appConfigurationId, 'config-1');
    assert.strictEqual(arg2.where?.appConfigurationId_facebookUserId?.appConfigurationId, 'config-2');
    console.log('PASSED.');

    // Assertion 4: Same facebookPageId under two different FacebookAccount IDs uses distinct accountId + facebookPageId upsert keys
    console.log('4. Verifying page sync uses distinct accountId + facebookPageId upsert keys...');
    // Setup pages in mock accounts
    rawMockContent.accounts[0].pages = [{ id: 'fb-page-shared', name: 'Page 1', category: 'Category', pictureUrl: 'url', tokenStatus: 'Valid' }];
    rawMockContent.accounts[1].pages = [{ id: 'fb-page-shared', name: 'Page 2', category: 'Category', pictureUrl: 'url', tokenStatus: 'Valid' }];
    fs.writeFileSync(tempMockDbPath, JSON.stringify(rawMockContent), 'utf8');

    mockQueries.length = 0;
    await getFacebookConnections('user-1');
    const pageUpsertQueries = mockQueries.filter(q => q.model === 'facebookPage' && q.method === 'upsert');
    assert.strictEqual(pageUpsertQueries.length, 2, 'Should perform exactly 2 page upserts.');
    const pageArg1 = pageUpsertQueries[0].args as MockArgs;
    const pageArg2 = pageUpsertQueries[1].args as MockArgs;
    assert.notStrictEqual(pageArg1.where?.accountId_facebookPageId?.accountId, pageArg2.where?.accountId_facebookPageId?.accountId);
    console.log('PASSED.');

    // Assertion 5: getAppConfiguration("user-1", cross-user-config-id) returns null
    console.log('5. Verifying cross-user configuration selection returns null...');
    const crossConf = await getAppConfiguration('user-1', 'config-cross-user');
    assert.strictEqual(crossConf, null, 'Should return null for config owned by another user.');
    console.log('PASSED.');

    // Assertion 6: A disabled configuration cannot be passed to saveFacebookAccount
    console.log('6. Verifying disabled configuration rejected in saveFacebookAccount...');
    await assert.rejects(
      async () => {
        await saveFacebookAccount('user-1', {
          id: 'mock-acc-disabled',
          facebookUserId: 'fb-user-disabled',
          name: 'Disabled Account',
          encryptedAccessToken: 'token',
          tokenExpiresAt: new Date(Date.now() + 100000).toISOString(),
          pages: []
        }, 'Connected', 'config-disabled');
      },
      /No valid, enabled AppConfiguration resolved/,
      'Should throw when config is disabled'
    );
    console.log('PASSED.');

    // Assertion 7: setDefaultAppConfiguration rejects a disabled configuration
    console.log('7. Verifying setDefaultAppConfiguration rejects a disabled configuration...');
    await assert.rejects(
      async () => {
        await setDefaultAppConfiguration('user-1', 'config-disabled');
      },
      /Enabled app configuration not found or not owned by user/,
      'Should reject disabled config for default status'
    );
    console.log('PASSED.');

    // Assertion 8: Account-specific disconnect does not remove the same Facebook identity under another configuration
    console.log('8. Verifying account-specific disconnect does not affect identity under another config...');
    // We have account-1 (config-1) and account-2 (config-2) both sharing fb-user-shared.
    // Let's call disconnect on mock-acc-id-1 specifically
    mockQueries.length = 0;
    await disconnectFacebook('user-1', 'mock-acc-id-1');

    const dbDeleteQueries = mockQueries.filter(q => q.model === 'facebookAccount' && q.method === 'delete');
    assert.strictEqual(dbDeleteQueries.length, 1);
    const deleteArg = dbDeleteQueries[0].args as MockArgs;
    assert.strictEqual(deleteArg.where?.id, 'mock-acc-id-1');

    const currentMockContent = JSON.parse(fs.readFileSync(tempMockDbPath, 'utf8')) as { accounts: Array<{ facebookUserId: string; appConfigurationId: string }> };
    const matchedAccounts = currentMockContent.accounts.filter((a) => a.facebookUserId === 'fb-user-shared');
    assert.strictEqual(matchedAccounts.length, 1, 'Only one of the two accounts should remain.');
    assert.strictEqual(matchedAccounts[0].appConfigurationId, 'config-2', 'The config-2 account should remain.');
    console.log('PASSED.');

    // Assertion 9: Account-specific Page status updates do not affect duplicate Page IDs under other accounts
    console.log('9. Verifying page updates are account-specific (strengthened)...');
    // Setup two mock accounts, each having same facebookPageId 'duplicate-page-id' in the mock JSON DB
    fs.writeFileSync(tempMockDbPath, JSON.stringify({
      accounts: [
        {
          id: 'mock-acc-id-1',
          userId: 'user-1',
          appConfigurationId: 'config-1',
          facebookUserId: 'fb-user-1',
          name: 'Account 1',
          encryptedAccessToken: 'token-1',
          tokenExpiresAt: new Date(Date.now() + 100000).toISOString(),
          pages: [{ id: 'duplicate-page-id', name: 'Dup Page', category: 'Cat', pictureUrl: 'url', tokenStatus: 'Valid' }]
        },
        {
          id: 'mock-acc-id-2',
          userId: 'user-1',
          appConfigurationId: 'config-2',
          facebookUserId: 'fb-user-2',
          name: 'Account 2',
          encryptedAccessToken: 'token-2',
          tokenExpiresAt: new Date(Date.now() + 100000).toISOString(),
          pages: [{ id: 'duplicate-page-id', name: 'Dup Page', category: 'Cat', pictureUrl: 'url', tokenStatus: 'Valid' }]
        }
      ],
      connectionState: 'Connected'
    }), 'utf8');

    // Stub findFirst to return config-2's Prisma account
    const originalFindFirstPage = prismaMock.facebookAccount.findFirst;
    prismaMock.facebookAccount.findFirst = async (args?: MockArgs) => {
      mockQueries.push({ model: 'facebookAccount', method: 'findFirst', args });
      if (args?.where?.id === 'mock-acc-id-2' && args?.where?.userId === 'user-1') {
        return {
          id: 'mock-acc-id-2',
          userId: 'user-1',
          appConfigurationId: 'config-2',
          facebookUserId: 'fb-user-2',
          name: 'Account 2'
        };
      }
      return originalFindFirstPage(args);
    };

    mockQueries.length = 0;
    // Update status only for account-2
    await updatePagesStatus('user-1', [{ id: 'duplicate-page-id', tokenStatus: 'Expired' }], 'mock-acc-id-2');

    // Restore findFirst
    prismaMock.facebookAccount.findFirst = originalFindFirstPage;

    // Read the temp mock JSON
    const pageStatusDb = JSON.parse(fs.readFileSync(tempMockDbPath, 'utf8')) as { accounts: Array<{ id: string; pages: Array<{ id: string; tokenStatus: string }> }> };
    const acc1 = pageStatusDb.accounts.find(a => a.id === 'mock-acc-id-1')!;
    const acc2 = pageStatusDb.accounts.find(a => a.id === 'mock-acc-id-2')!;

    // Assert account-2's page status changed to 'Expired'
    assert.strictEqual(acc2.pages[0].tokenStatus, 'Expired', 'account-2 page status should be Expired.');
    // Assert account-1's duplicate page status did not change (remains 'Valid')
    assert.strictEqual(acc1.pages[0].tokenStatus, 'Valid', 'account-1 page status should remain Valid.');

    // Also assert the Prisma update query includes accountId
    const pageUpdateQueries = mockQueries.filter(q => q.model === 'facebookPage' && q.method === 'updateMany');
    assert.ok(pageUpdateQueries.length > 0, 'Should execute page update query.');
    const firstUpdateArg = pageUpdateQueries[0].args as { where: { accountId: string } };
    assert.strictEqual(firstUpdateArg.where.accountId, 'mock-acc-id-2', 'Prisma page update query must include accountId.');
    console.log('PASSED.');

    // Assertion 10: resolvePublishingContext validates Page, Account, Configuration, enabled state, and ownership
    console.log('10. Verifying resolvePublishingContext ownership constraints...');
    const mockJob = {
      id: 'job-1',
      userId: 'user-1',
      pageId: 'page-1'
    } as unknown as VideoJob;
    const context = await resolvePublishingContext(mockJob);
    assert.strictEqual(context.page.id, 'page-1');
    assert.strictEqual(context.account.id, 'account-1');
    assert.strictEqual(context.configuration.id, 'config-1');
    assert.strictEqual(context.isLive, false);
    console.log('PASSED.');

    // Assertion 11: No worker query targets AppConfiguration ID "default"
    console.log('11. Verifying no job worker query targets AppConfiguration ID "default"...');
    const workerPath = path.join(__dirname, '../src/lib/job-worker.ts');
    const workerContent = fs.readFileSync(workerPath, 'utf8');
    const hasDefaultString = workerContent.includes('id: "default"') || workerContent.includes("id: 'default'");
    assert.strictEqual(hasDefaultString, false, 'No worker code should query AppConfiguration ID "default"');
    console.log('PASSED.');

    // Assertion 11A: proving getFacebookConnections does not create dummy configs for users with no configuration
    console.log('11A. Verifying getFacebookConnections does not create dummy configurations for users with no config...');
    fs.writeFileSync(tempMockDbPath, JSON.stringify({
      accounts: [
        {
          id: 'mock-acc-no-config',
          userId: 'user-no-config',
          facebookUserId: 'fb-user-no-config',
          name: 'Account No Config',
          encryptedAccessToken: 'token',
          tokenExpiresAt: new Date(Date.now() + 100000).toISOString(),
          pages: []
        }
      ],
      connectionState: 'Connected'
    }), 'utf8');

    mockQueries.length = 0;
    const connectionsNoConfig = await getFacebookConnections('user-no-config');
    assert.strictEqual(connectionsNoConfig.length, 0, 'Should skip the mock record because no config exists.');
    
    const configWrites = mockQueries.filter(
      q => q.model === 'appConfiguration' && (q.method === 'create' || q.method === 'update' || q.method === 'updateMany')
    );
    assert.strictEqual(configWrites.length, 0, 'No appConfiguration write/create queries should be run.');
    console.log('PASSED.');

    // Assertion 11B: Add a reconnect identity test (stable ID)
    console.log('11B. Verifying reconnect identity test (stable ID)...');
    fs.writeFileSync(tempMockDbPath, JSON.stringify({ accounts: [], connectionState: 'Not Connected' }), 'utf8');

    // Save initial mock account with ID 'ID-A'
    await saveFacebookAccount('user-1', {
      id: 'ID-A',
      facebookUserId: 'reconnect-user',
      name: 'Initial Name',
      encryptedAccessToken: 'token-A',
      tokenExpiresAt: new Date(Date.now() + 100000).toISOString(),
      pages: []
    }, 'Connected', 'config-1');

    // Save same mock account but with ID 'ID-B' and updated token/name
    await saveFacebookAccount('user-1', {
      id: 'ID-B',
      facebookUserId: 'reconnect-user',
      name: 'Updated Name',
      encryptedAccessToken: 'token-B',
      tokenExpiresAt: new Date(Date.now() + 200000).toISOString(),
      pages: []
    }, 'Connected', 'config-1');

    // Read tempMockDbPath
    const reconnectDb = JSON.parse(fs.readFileSync(tempMockDbPath, 'utf8')) as { accounts: Array<{ id: string; name: string; encryptedAccessToken: string }> };
    assert.strictEqual(reconnectDb.accounts.length, 1, 'Should still be exactly 1 mock account.');
    assert.strictEqual(reconnectDb.accounts[0].id, 'ID-A', 'Stable ID must remain ID-A.');
    assert.strictEqual(reconnectDb.accounts[0].name, 'Updated Name', 'Name should be updated.');
    assert.strictEqual(reconnectDb.accounts[0].encryptedAccessToken, 'token-B', 'Token should be updated.');
    console.log('PASSED.');

    // Assertion 11C: Add a disconnect mismatch test
    console.log('11C. Verifying disconnect mismatch test...');
    fs.writeFileSync(tempMockDbPath, JSON.stringify({
      accounts: [
        {
          id: 'mismatch-json-id-1',
          userId: 'user-1',
          appConfigurationId: 'config-1',
          facebookUserId: 'mismatch-fb-user',
          name: 'Mismatch Config 1',
          encryptedAccessToken: 'token-1',
          tokenExpiresAt: new Date(Date.now() + 100000).toISOString(),
          pages: []
        },
        {
          id: 'mismatch-json-id-2',
          userId: 'user-1',
          appConfigurationId: 'config-2',
          facebookUserId: 'mismatch-fb-user',
          name: 'Mismatch Config 2',
          encryptedAccessToken: 'token-2',
          tokenExpiresAt: new Date(Date.now() + 100000).toISOString(),
          pages: []
        }
      ],
      connectionState: 'Connected'
    }), 'utf8');

    const originalFindFirstDis = prismaMock.facebookAccount.findFirst;
    prismaMock.facebookAccount.findFirst = async (args?: MockArgs) => {
      mockQueries.push({ model: 'facebookAccount', method: 'findFirst', args });
      if (args?.where?.id === 'prisma-id-1' && args?.where?.userId === 'user-1') {
        return {
          id: 'prisma-id-1',
          userId: 'user-1',
          appConfigurationId: 'config-1',
          facebookUserId: 'mismatch-fb-user',
          name: 'Mismatch Config 1'
        };
      }
      return originalFindFirstDis(args);
    };

    await disconnectFacebook('user-1', 'prisma-id-1');
    prismaMock.facebookAccount.findFirst = originalFindFirstDis;

    const disconnectDb = JSON.parse(fs.readFileSync(tempMockDbPath, 'utf8')) as { accounts: Array<{ id: string; appConfigurationId: string; facebookUserId: string }> };
    const remainingConfig1 = disconnectDb.accounts.find(a => a.appConfigurationId === 'config-1' && a.facebookUserId === 'mismatch-fb-user');
    assert.strictEqual(remainingConfig1, undefined, 'Mock record under config-1 should be removed.');
    
    const remainingConfig2 = disconnectDb.accounts.find(a => a.appConfigurationId === 'config-2' && a.facebookUserId === 'mismatch-fb-user');
    assert.ok(remainingConfig2, 'Mock record under config-2 should remain.');
    assert.strictEqual(remainingConfig2.id, 'mismatch-json-id-2');
    console.log('PASSED.');

    // Assertion 11D: Add account-specific mode-resolution test
    console.log('11D. Verifying account-specific mode-resolution...');
    const originalFindFirstRes = prismaMock.facebookAccount.findFirst;

    prismaMock.facebookAccount.findFirst = async (args?: MockArgs) => {
      mockQueries.push({ model: 'facebookAccount', method: 'findFirst', args });
      if (args?.where?.id === 'live-acc-id' && args?.where?.userId === 'user-1') {
        return {
          id: 'live-acc-id',
          userId: 'user-1',
          appConfigurationId: 'config-live',
          facebookUserId: 'fb-live-user',
          name: 'Live Account',
          appConfiguration: {
            id: 'config-live',
            userId: 'user-1',
            facebookAppId: 'app-live',
            isEnabled: true,
            liveMetaMode: true
          }
        };
      }
      return originalFindFirstRes(args);
    };

    const contextLive = await resolveAccountSyncContext('user-1', 'live-acc-id');
    assert.ok(contextLive && 'liveMetaMode' in contextLive);
    assert.strictEqual(contextLive.liveMetaMode, true, 'Should resolve to Live mode even if default is Mock.');

    prismaMock.facebookAccount.findFirst = async (args?: MockArgs) => {
      mockQueries.push({ model: 'facebookAccount', method: 'findFirst', args });
      if (args?.where?.id === 'mock-acc-id' && args?.where?.userId === 'user-1') {
        return {
          id: 'mock-acc-id',
          userId: 'user-1',
          appConfigurationId: 'config-mock',
          facebookUserId: 'fb-mock-user',
          name: 'Mock Account',
          appConfiguration: {
            id: 'config-mock',
            userId: 'user-1',
            facebookAppId: 'app-mock',
            isEnabled: true,
            liveMetaMode: false
          }
        };
      }
      return originalFindFirstRes(args);
    };

    const contextMock = await resolveAccountSyncContext('user-1', 'mock-acc-id');
    assert.ok(contextMock && 'liveMetaMode' in contextMock);
    assert.strictEqual(contextMock.liveMetaMode, false, 'Should resolve to Mock mode even if default is Live.');

    prismaMock.facebookAccount.findFirst = originalFindFirstRes;
    console.log('PASSED.');

    // Assertion 11E: Cross-user disconnect with duplicate ID
    console.log('11E. Verifying cross-user disconnect with duplicate raw ID...');
    fs.writeFileSync(tempMockDbPath, JSON.stringify({
      accounts: [
        {
          id: 'duplicate-raw-id',
          userId: 'user-1',
          appConfigurationId: 'config-1',
          facebookUserId: 'fb-user-1',
          name: 'Account User 1',
          encryptedAccessToken: 'token-1',
          tokenExpiresAt: new Date(Date.now() + 100000).toISOString(),
          pages: []
        },
        {
          id: 'duplicate-raw-id',
          userId: 'user-2',
          appConfigurationId: 'config-2',
          facebookUserId: 'fb-user-2',
          name: 'Account User 2',
          encryptedAccessToken: 'token-2',
          tokenExpiresAt: new Date(Date.now() + 100000).toISOString(),
          pages: []
        }
      ],
      connectionState: 'Connected'
    }), 'utf8');

    const originalFindFirstDisCross = prismaMock.facebookAccount.findFirst;
    prismaMock.facebookAccount.findFirst = async (args?: MockArgs) => {
      mockQueries.push({ model: 'facebookAccount', method: 'findFirst', args });
      if (args?.where?.id === 'duplicate-raw-id' && args?.where?.userId === 'user-1') {
        return {
          id: 'duplicate-raw-id',
          userId: 'user-1',
          appConfigurationId: 'config-1',
          facebookUserId: 'fb-user-1',
          name: 'Account User 1'
        };
      }
      return originalFindFirstDisCross(args);
    };

    await disconnectFacebook('user-1', 'duplicate-raw-id');
    prismaMock.facebookAccount.findFirst = originalFindFirstDisCross;

    const crossDisDb = JSON.parse(fs.readFileSync(tempMockDbPath, 'utf8')) as { accounts: Array<{ id: string; userId: string }> };
    assert.strictEqual(crossDisDb.accounts.length, 1, 'Should only remove one of the duplicate ID mock records.');
    assert.strictEqual(crossDisDb.accounts[0].userId, 'user-2', 'user-2 mock record must remain.');
    assert.strictEqual(crossDisDb.accounts[0].id, 'duplicate-raw-id');
    console.log('PASSED.');

    // Assertion 11F: Cross-user updatePagesStatus with duplicate raw ID and same facebookPageId
    console.log('11F. Verifying cross-user updatePagesStatus with duplicate raw ID...');
    fs.writeFileSync(tempMockDbPath, JSON.stringify({
      accounts: [
        {
          id: 'duplicate-raw-id',
          userId: 'user-1',
          appConfigurationId: 'config-1',
          facebookUserId: 'fb-user-1',
          name: 'Account User 1',
          encryptedAccessToken: 'token-1',
          tokenExpiresAt: new Date(Date.now() + 100000).toISOString(),
          pages: [{ id: 'duplicate-page-id', name: 'Page 1', category: 'Cat', pictureUrl: 'url', tokenStatus: 'Valid' }]
        },
        {
          id: 'duplicate-raw-id',
          userId: 'user-2',
          appConfigurationId: 'config-2',
          facebookUserId: 'fb-user-2',
          name: 'Account User 2',
          encryptedAccessToken: 'token-2',
          tokenExpiresAt: new Date(Date.now() + 100000).toISOString(),
          pages: [{ id: 'duplicate-page-id', name: 'Page 2', category: 'Cat', pictureUrl: 'url', tokenStatus: 'Valid' }]
        }
      ],
      connectionState: 'Connected'
    }), 'utf8');

    const originalFindFirstPageCross = prismaMock.facebookAccount.findFirst;
    prismaMock.facebookAccount.findFirst = async (args?: MockArgs) => {
      mockQueries.push({ model: 'facebookAccount', method: 'findFirst', args });
      if (args?.where?.id === 'duplicate-raw-id' && args?.where?.userId === 'user-1') {
        return {
          id: 'duplicate-raw-id',
          userId: 'user-1',
          appConfigurationId: 'config-1',
          facebookUserId: 'fb-user-1',
          name: 'Account User 1'
        };
      }
      return originalFindFirstPageCross(args);
    };

    mockQueries.length = 0;
    await updatePagesStatus('user-1', [{ id: 'duplicate-page-id', tokenStatus: 'Expired' }], 'duplicate-raw-id');
    prismaMock.facebookAccount.findFirst = originalFindFirstPageCross;

    const crossPageStatusDb = JSON.parse(fs.readFileSync(tempMockDbPath, 'utf8')) as { accounts: Array<{ id: string; userId: string; pages: Array<{ id: string; tokenStatus: string }> }> };
    const user1Acc = crossPageStatusDb.accounts.find(a => a.userId === 'user-1')!;
    const user2Acc = crossPageStatusDb.accounts.find(a => a.userId === 'user-2')!;

    assert.strictEqual(user1Acc.pages[0].tokenStatus, 'Expired', 'user-1 page status must change to Expired.');
    assert.strictEqual(user2Acc.pages[0].tokenStatus, 'Valid', 'user-2 page status must remain Valid.');

    const pageUpdateQueriesCross = mockQueries.filter(q => q.model === 'facebookPage' && q.method === 'updateMany');
    assert.ok(pageUpdateQueriesCross.length > 0);
    const updateArgCross = pageUpdateQueriesCross[0].args as { where: { userId: string; accountId: string } };
    assert.strictEqual(updateArgCross.where.userId, 'user-1', 'Prisma page update must scope to user-1.');
    assert.strictEqual(updateArgCross.where.accountId, 'duplicate-raw-id', 'Prisma page update must scope to duplicate-raw-id.');
    console.log('PASSED.');

    // Assertion 12: No real network call occurred
    console.log('12. Verifying fetch guard blocked all network calls...');
    assert.strictEqual(networkCallAttempted, false, 'Fetch guard should not be triggered.');
    console.log('PASSED.');

    // Assertion 13: Mock Prisma client is active and was verified at startup
    console.log('13. Verifying mock Prisma client is active...');
    // Checked at startup using strict equal assertion on imported prisma
    console.log('PASSED.');

    // Assertion 14: src/lib/mock_db.json remains unchanged after the test
    console.log('14. Verifying src/lib/mock_db.json remains unchanged...');
    const postTestMockDbContent = fs.readFileSync(path.join(process.cwd(), 'src/lib/mock_db.json'), 'utf8');
    assert.strictEqual(postTestMockDbContent, originalMockDbContent, 'Original mock DB file must not be modified.');
    console.log('PASSED.');

    console.log('\n======================================================');
    console.log('PHASE7A_MULTI_META_FOUNDATION_TESTS=PASSED');
    console.log('======================================================');

  } finally {
    // Restore global fetch
    global.fetch = originalFetch;

    // Clean up temporary mock database directory & file
    if (fs.existsSync(tempMockDbPath)) {
      fs.unlinkSync(tempMockDbPath);
    }
    if (fs.existsSync(tempDir)) {
      fs.rmdirSync(tempDir);
    }
  }
}

main().catch(err => {
  console.error('Test run failed:', err);
  process.exit(1);
});
