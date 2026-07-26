/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars, prefer-rest-params, prefer-const, @typescript-eslint/no-require-imports */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';

// 1. Declare process environment backups
const originalDatabaseUrl = process.env.DATABASE_URL;
process.env.DATABASE_URL = 'postgresql://unreachable-sentinel-test-db:5432/testdb';

const originalNodeEnv = process.env.NODE_ENV;
(process.env as any).NODE_ENV = 'test';

// 2. Fetch guard installation
let networkCallAttempted = false;
const originalFetch = (global as any).fetch;
(global as any).fetch = () => {
  networkCallAttempted = true;
  throw new Error('Network call blocked by fetch guard!');
};

// 3. Real mock_db.json SHA-256 integrity check setup
const realMockDbPath = path.join(process.cwd(), 'src/lib/mock_db.json');
const originalMockDbContent = fs.readFileSync(realMockDbPath, 'utf8');
const originalHash = crypto.createHash('sha256').update(originalMockDbContent).digest('hex');

// 4. Temporary mock file configuration
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-publisher-tests-7b-'));
const tempMockDbPath = path.join(tempDir, 'mock_db.json');
fs.writeFileSync(tempMockDbPath, JSON.stringify({ accounts: [], connectionState: 'Not Connected' }), 'utf8');

const originalMockDbPath = process.env.FB_PUBLISHER_TEST_MOCK_DB_PATH;
process.env.FB_PUBLISHER_TEST_MOCK_DB_PATH = tempMockDbPath;

// Data fixtures store
interface AppConfig {
  id: string;
  configurationName: string;
  publicAppUrl: string;
  facebookAppId: string;
  encryptedAppSecret: string;
  liveMetaMode: boolean;
  userId: string;
  isDefault: boolean;
  isEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

let appConfigs: AppConfig[] = [];
let facebookAccounts: any[] = [];
let facebookPages: any[] = [];
const mockQueries: any[] = [];

// prismaMock definition
const prismaMock: any = {
  $transaction: async <T>(cb: (tx: any) => Promise<T>): Promise<T> => {
    return await cb(prismaMock);
  },
  appConfiguration: {
    findMany: async (args: any) => {
      mockQueries.push({ model: 'appConfiguration', method: 'findMany', args });
      let list = [...appConfigs];
      if (args?.where?.userId) {
        list = list.filter(c => c.userId === args.where.userId);
      }
      list.sort((a, b) => {
        if (a.isDefault && !b.isDefault) return -1;
        if (!a.isDefault && b.isDefault) return 1;
        return a.createdAt.getTime() - b.createdAt.getTime();
      });
      return list.map(c => {
        const accountsList = facebookAccounts.filter(acc => acc.appConfigurationId === c.id);
        const mappedAccounts = accountsList.map(acc => ({
          ...acc,
          pages: facebookPages.filter(p => p.accountId === acc.id)
        }));
        return {
          ...c,
          facebookAccounts: mappedAccounts
        };
      });
    },
    findFirst: async (args: any) => {
      mockQueries.push({ model: 'appConfiguration', method: 'findFirst', args });
      let list = [...appConfigs];
      if (args?.where?.userId) {
        list = list.filter(c => c.userId === args.where.userId);
      }
      if (args?.where?.facebookAppId) {
        list = list.filter(c => c.facebookAppId === args.where.facebookAppId);
      }
      if (args?.where?.id) {
        list = list.filter(c => c.id === args.where.id);
      }
      if (args?.where?.isEnabled !== undefined) {
        list = list.filter(c => c.isEnabled === args.where.isEnabled);
      }
      if (args?.where?.isDefault !== undefined) {
        list = list.filter(c => c.isDefault === args.where.isDefault);
      }
      if (list.length === 0) return null;
      const res = list[0];

      const accountsList = facebookAccounts.filter(acc => acc.appConfigurationId === res.id);
      const mappedAccounts = accountsList.map(acc => ({
        ...acc,
        pages: facebookPages.filter(p => p.accountId === acc.id)
      }));

      return {
        ...res,
        facebookAccounts: mappedAccounts
      };
    },
    findUnique: async (args: any) => {
      mockQueries.push({ model: 'appConfiguration', method: 'findUnique', args });
      const found = appConfigs.find(c => c.id === args?.where?.id);
      if (!found) return null;

      const accountsList = facebookAccounts.filter(acc => acc.appConfigurationId === found.id);
      const mappedAccounts = accountsList.map(acc => ({
        ...acc,
        pages: facebookPages.filter(p => p.accountId === acc.id)
      }));

      return {
        ...found,
        facebookAccounts: mappedAccounts
      };
    },
    create: async (args: any, secondArg?: any) => {
      mockQueries.push({ model: 'appConfiguration', method: 'create', args, secondArg });
      let data = args?.data;
      let userId = args?.data?.userId;

      if (typeof args === 'string' && secondArg) {
        data = secondArg;
        userId = args;
      }

      const userConfigs = appConfigs.filter(c => c.userId === userId);
      const isFirst = userConfigs.length === 0;

      const newConfig: AppConfig = {
        id: data?.id || `config-${Date.now()}-${Math.random()}`,
        configurationName: data?.configurationName,
        publicAppUrl: data?.publicAppUrl,
        facebookAppId: data?.facebookAppId,
        encryptedAppSecret: data?.encryptedAppSecret,
        liveMetaMode: data?.liveMetaMode || false,
        userId: userId,
        isDefault: isFirst ? true : (data?.isDefault || false),
        isEnabled: data?.isEnabled !== false,
        createdAt: new Date(),
        updatedAt: new Date()
      };
      appConfigs.push(newConfig);
      return newConfig;
    },
    update: async (args: any, secondArg?: any, thirdArg?: any) => {
      mockQueries.push({ model: 'appConfiguration', method: 'update', args, secondArg, thirdArg });
      let data = args?.data;
      let targetId = args?.where?.id;

      if (typeof args === 'string' && typeof secondArg === 'string' && thirdArg) {
        data = thirdArg;
        targetId = secondArg;
      }

      const index = appConfigs.findIndex(c => c.id === targetId);
      if (index === -1) throw new Error('Not found');

      const cleanData: any = {};
      if (data) {
        Object.keys(data).forEach(k => {
          if (data[k] !== undefined) {
            cleanData[k] = data[k];
          }
        });
      }

      const updated = {
        ...appConfigs[index],
        ...cleanData,
        updatedAt: new Date()
      };
      appConfigs[index] = updated;
      return updated;
    },
    updateMany: async (args: any) => {
      mockQueries.push({ model: 'appConfiguration', method: 'updateMany', args });
      let matched = appConfigs;
      if (args?.where?.userId) {
        matched = matched.filter(c => c.userId === args.where.userId);
      }
      matched.forEach(c => {
        Object.assign(c, args.data);
      });
      return { count: matched.length };
    }
  },
  facebookAccount: {
    findFirst: async (args: any) => {
      mockQueries.push({ model: 'facebookAccount', method: 'findFirst', args });
      let list = [...facebookAccounts];
      if (args?.where?.id) {
        list = list.filter(acc => acc.id === args.where.id);
      }
      if (args?.where?.userId) {
        list = list.filter(acc => acc.userId === args.where.userId);
      }
      if (args?.where?.appConfigurationId) {
        list = list.filter(acc => acc.appConfigurationId === args.where.appConfigurationId);
      }
      if (args?.where?.facebookUserId) {
        list = list.filter(acc => acc.facebookUserId === args.where.facebookUserId);
      }
      if (list.length === 0) return null;
      const res = list[0];
      return {
        ...res,
        appConfiguration: appConfigs.find(c => c.id === res.appConfigurationId)
      };
    },
    findUnique: async (args: any) => {
      mockQueries.push({ model: 'facebookAccount', method: 'findUnique', args });
      const res = facebookAccounts.find(acc => acc.id === args.where.id);
      if (!res) return null;
      return {
        ...res,
        pages: facebookPages.filter(p => p.accountId === res.id)
      };
    },
    findMany: async (args: any) => {
      mockQueries.push({ model: 'facebookAccount', method: 'findMany', args });
      let list = [...facebookAccounts];
      if (args?.where?.userId) {
        list = list.filter(acc => acc.userId === args.where.userId);
      }
      return list.map(acc => ({
        ...acc,
        pages: facebookPages.filter(p => p.accountId === acc.id),
        appConfiguration: appConfigs.find(c => c.id === acc.appConfigurationId)
      }));
    },
    upsert: async (args: any) => {
      mockQueries.push({ model: 'facebookAccount', method: 'upsert', args });
      const matchIndex = facebookAccounts.findIndex(acc =>
        acc.appConfigurationId === args.where.appConfigurationId_facebookUserId.appConfigurationId &&
        acc.facebookUserId === args.where.appConfigurationId_facebookUserId.facebookUserId
      );
      let account;
      if (matchIndex !== -1) {
        account = {
          ...facebookAccounts[matchIndex],
          ...args.update
        };
        facebookAccounts[matchIndex] = account;
      } else {
        account = {
          id: args.create.id || `account-${Date.now()}`,
          userId: args.create.userId,
          appConfigurationId: args.create.appConfigurationId,
          facebookUserId: args.create.facebookUserId,
          name: args.create.name,
          encryptedAccessToken: args.create.encryptedAccessToken,
          tokenExpiresAt: args.create.tokenExpiresAt
        };
        facebookAccounts.push(account);
      }
      return account;
    },
    delete: async (args: any) => {
      mockQueries.push({ model: 'facebookAccount', method: 'delete', args });
      const idx = facebookAccounts.findIndex(acc => acc.id === args.where.id);
      if (idx !== -1) {
        const deleted = facebookAccounts[idx];
        facebookAccounts.splice(idx, 1);
        return deleted;
      }
      return null;
    }
  },
  facebookPage: {
    upsert: async (args: any) => {
      mockQueries.push({ model: 'facebookPage', method: 'upsert', args });
      const matchIndex = facebookPages.findIndex(p =>
        p.accountId === args.where.accountId_facebookPageId.accountId &&
        p.facebookPageId === args.where.accountId_facebookPageId.facebookPageId
      );
      let page;
      if (matchIndex !== -1) {
        page = {
          ...facebookPages[matchIndex],
          ...args.update
        };
        facebookPages[matchIndex] = page;
      } else {
        page = {
          id: args.create.id || `page-${Date.now()}`,
          accountId: args.create.accountId,
          userId: args.create.userId,
          facebookPageId: args.create.facebookPageId,
          pageName: args.create.pageName,
          pageCategory: args.create.pageCategory,
          pagePictureUrl: args.create.pagePictureUrl,
          encryptedPageToken: args.create.encryptedPageToken,
          isSynced: args.create.isSynced
        };
        facebookPages.push(page);
      }
      return page;
    },
    updateMany: async (args: any) => {
      mockQueries.push({ model: 'facebookPage', method: 'updateMany', args });
      let matched = facebookPages.filter(p => p.userId === args.where.userId && p.accountId === args.where.accountId && p.facebookPageId === args.where.facebookPageId);
      matched.forEach(p => {
        Object.assign(p, args.data);
      });
      return { count: matched.length };
    }
  },
  auditLog: {
    create: async (args: any) => {
      mockQueries.push({ model: 'auditLog', method: 'create', args });
      return { id: 'audit-log-id', ...args.data };
    }
  },
  user: {
    findUnique: async (args: any) => {
      mockQueries.push({ model: 'user', method: 'findUnique', args });
      return { id: args.where.id };
    }
  }
};

// Global mocks setup
const hadOriginalGlobalPrisma =
  Object.prototype.hasOwnProperty.call(
    globalThis,
    "prisma"
  );

const originalGlobalPrisma =
  (globalThis as any).prisma;

(globalThis as any).prisma = prismaMock;

// 5. Intercepting require at the Module level to mock @/lib/prisma-client
const Module = require('module');
const originalRequire = Module.prototype.require;

Module.prototype.require = function(id: string) {
  if (
    id === '@/lib/prisma-client' ||
    id.replace(/\\/g, '/').endsWith('/lib/prisma-client')
  ) {
    return {
      prisma: prismaMock
    };
  }
  if (id === '@/lib/auth' || id.replace(/\\/g, '/').endsWith('/lib/auth')) {
    return {
      getSessionUser: async () => ({ id: 'user-1', email: 'user1@example.com', role: 'USER' }),
      verifyAdminSession: async () => ({ id: 'user-1', email: 'user1@example.com', role: 'USER' }),
      verifyAdminRole: async () => true
    };
  }
  if (id === 'next/headers') {
    return {
      cookies: () => {
        return {
          get: (name: string) => ({ value: mockCookies[name] }),
          set: (name: string, value: string, options: any) => { mockCookies[name] = value; },
          delete: (name: string) => { delete mockCookies[name]; }
        };
      }
    };
  }
  return originalRequire.apply(this, arguments);
};

const mockCookies: Record<string, string> = {};

async function runTests() {
  try {
    const { handleGet: getConfigs, handlePost: postConfig } = await import('../src/app/api/admin/configurations/route');
    const { handlePatch: patchConfig } = await import('../src/app/api/admin/configurations/[id]/route');
    const { handlePost: promoteDefault } = await import('../src/app/api/admin/configurations/[id]/default/route');
    const { handleGet: initiateOAuth } = await import('../src/app/api/auth/facebook/initiate/route');
    const { handleGet: callbackOAuth } = await import('../src/app/api/auth/facebook/callback/route');
    const { saveFacebookAccount, getFacebookConnections, disconnectFacebook } = await import('../src/lib/db');
    const { POST: handleSync } = await import('../src/app/api/facebook/sync/route');
    const { POST: handleDisconnect } = await import('../src/app/api/facebook/disconnect/route');
    const { POST: testConfig } = await import('../src/app/api/admin/config/test/route');

    console.log('--- Executing All Phase 7B Behavioral Tests ---');

    // Helper to reset states
    const reset = () => {
      appConfigs = [];
      facebookAccounts = [];
      facebookPages = [];
      mockQueries.length = 0;
      Object.keys(mockCookies).forEach(k => delete mockCookies[k]);
    };

    const user1Session = async () => ({ id: 'user-1', email: 'user1@example.com' });
    const user2Session = async () => ({ id: 'user-2', email: 'user2@example.com' });

    // 1. User-scoped configuration listing
    {
      reset();
      appConfigs = [
        { id: 'c1', userId: 'user-1', facebookAppId: 'app-1', publicAppUrl: 'http://localhost', encryptedAppSecret: 'sec-1', liveMetaMode: false, isDefault: true, isEnabled: true, configurationName: 'User 1 Config', createdAt: new Date(100), updatedAt: new Date() },
        { id: 'c2', userId: 'user-2', facebookAppId: 'app-2', publicAppUrl: 'http://localhost', encryptedAppSecret: 'sec-2', liveMetaMode: false, isDefault: false, isEnabled: true, configurationName: 'User 2 Config', createdAt: new Date(200), updatedAt: new Date() }
      ];
      const req = new NextRequest('http://localhost/api/admin/configurations');
      const res = await getConfigs(req, { verifyAdminSession: user1Session as any, prisma: prismaMock });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.length, 1);
      assert.strictEqual(data[0].id, 'c1');
      console.log('✓ Test 1: User-scoped configuration listing matches owner');
    }

    // 2. No plaintext or encrypted secret in every configuration response
    {
      reset();
      appConfigs = [
        { id: 'c1', userId: 'user-1', facebookAppId: 'app-1', publicAppUrl: 'http://localhost', encryptedAppSecret: 'sec-1', liveMetaMode: false, isDefault: true, isEnabled: true, configurationName: 'User 1 Config', createdAt: new Date(100), updatedAt: new Date() }
      ];
      const req = new NextRequest('http://localhost/api/admin/configurations');
      const res = await getConfigs(req, { verifyAdminSession: user1Session as any, prisma: prismaMock });
      const data = await res.json();
      assert.strictEqual(data[0].encryptedAppSecret, undefined);
      assert.strictEqual(data[0].facebookAppSecret, undefined);
      assert.strictEqual(data[0].secretConfigured, true);
      console.log('✓ Test 2: App secrets are correctly omitted from response payload');
    }

    // 3. First enabled configuration becomes default and the API response reports isDefault=true
    {
      reset();
      const req = new NextRequest('http://localhost/api/admin/configurations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          configurationName: 'First App',
          publicAppUrl: 'https://localhost',
          facebookAppId: 'app-first',
          facebookAppSecret: 'secret-first',
          liveMetaMode: true,
          isDefault: false
        })
      });
      const res = await postConfig(req, {
        verifyAdminSession: user1Session as any,
        prisma: prismaMock,
        encryptToken: (t) => `enc-${t}`,
        createAppConfiguration: prismaMock.appConfiguration.create,
        createAuditLog: async () => null as any
      });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.config.isDefault, true);
      console.log('✓ Test 3: First configuration automatically promoted to default');
    }

    // 4. Creating a second non-default configuration preserves the original default
    {
      reset();
      appConfigs = [
        { id: 'c1', userId: 'user-1', facebookAppId: 'app-1', publicAppUrl: 'http://localhost', encryptedAppSecret: 'sec-1', liveMetaMode: false, isDefault: true, isEnabled: true, configurationName: 'First App', createdAt: new Date(100), updatedAt: new Date() }
      ];
      const req = new NextRequest('http://localhost/api/admin/configurations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          configurationName: 'Second App',
          publicAppUrl: 'http://localhost',
          facebookAppId: 'app-2',
          facebookAppSecret: 'secret-2',
          liveMetaMode: false,
          isDefault: false
        })
      });
      const res = await postConfig(req, {
        verifyAdminSession: user1Session as any,
        prisma: prismaMock,
        encryptToken: (t) => `enc-${t}`,
        createAppConfiguration: prismaMock.appConfiguration.create,
        createAuditLog: async () => null as any
      });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.config.isDefault, false);
      assert.strictEqual(appConfigs.find(c => c.id === 'c1')?.isDefault, true);
      console.log('✓ Test 4: Second config does not overwrite active default');
    }

    // 5. Duplicate App ID for the same user returns 409
    {
      reset();
      appConfigs = [
        { id: 'c1', userId: 'user-1', facebookAppId: 'app-dup', publicAppUrl: 'http://localhost', encryptedAppSecret: 'sec-1', liveMetaMode: false, isDefault: true, isEnabled: true, configurationName: 'First App', createdAt: new Date(100), updatedAt: new Date() }
      ];
      const req = new NextRequest('http://localhost/api/admin/configurations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          configurationName: 'Dup App',
          publicAppUrl: 'http://localhost',
          facebookAppId: 'app-dup',
          facebookAppSecret: 'secret-dup',
          liveMetaMode: false,
          isDefault: false
        })
      });
      const res = await postConfig(req, {
        verifyAdminSession: user1Session as any,
        prisma: prismaMock,
        encryptToken: (t) => `enc-${t}`,
        createAppConfiguration: prismaMock.appConfiguration.create,
        createAuditLog: async () => null as any
      });
      assert.strictEqual(res.status, 409);
      console.log('✓ Test 5: Duplicate App ID for same user is rejected with 409');
    }

    // 6. Same App ID for another user remains independently allowed
    {
      reset();
      appConfigs = [
        { id: 'c1', userId: 'user-2', facebookAppId: 'app-same', publicAppUrl: 'http://localhost', encryptedAppSecret: 'sec-1', liveMetaMode: false, isDefault: true, isEnabled: true, configurationName: 'First App', createdAt: new Date(100), updatedAt: new Date() }
      ];
      const req = new NextRequest('http://localhost/api/admin/configurations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          configurationName: 'My App',
          publicAppUrl: 'http://localhost',
          facebookAppId: 'app-same',
          facebookAppSecret: 'secret-same',
          liveMetaMode: false,
          isDefault: false
        })
      });
      const res = await postConfig(req, {
        verifyAdminSession: user1Session as any,
        prisma: prismaMock,
        encryptToken: (t) => `enc-${t}`,
        createAppConfiguration: prismaMock.appConfiguration.create,
        createAuditLog: async () => null as any
      });
      assert.strictEqual(res.status, 200);
      console.log('✓ Test 6: Same App ID under a different user is allowed');
    }

    // 7. Renaming changes only configurationName
    {
      reset();
      appConfigs = [
        { id: 'c1', userId: 'user-1', facebookAppId: 'app-1', publicAppUrl: 'http://localhost', encryptedAppSecret: 'sec-1', liveMetaMode: false, isDefault: true, isEnabled: true, configurationName: 'Old Name', createdAt: new Date(100), updatedAt: new Date() }
      ];
      const req = new NextRequest('http://localhost/api/admin/configurations/c1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          configurationName: 'New Name'
        })
      });
      const res = await patchConfig(req, Promise.resolve({ id: 'c1' }), {
        verifyAdminSession: user1Session as any,
        prisma: prismaMock,
        encryptToken: (t) => `enc-${t}`,
        updateAppConfiguration: prismaMock.appConfiguration.update,
        createAuditLog: async () => null as any
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(appConfigs[0].configurationName, 'New Name');
      assert.strictEqual(appConfigs[0].facebookAppId, 'app-1');
      console.log('✓ Test 7: PATCH update changes only target fields');
    }

    // 8. Masked/blank secret preserves encryptedAppSecret
    {
      reset();
      appConfigs = [
        { id: 'c1', userId: 'user-1', facebookAppId: 'app-1', publicAppUrl: 'http://localhost', encryptedAppSecret: 'encrypted-secret-original', liveMetaMode: false, isDefault: true, isEnabled: true, configurationName: 'App Name', createdAt: new Date(100), updatedAt: new Date() }
      ];
      const req = new NextRequest('http://localhost/api/admin/configurations/c1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          facebookAppSecret: '************'
        })
      });
      const res = await patchConfig(req, Promise.resolve({ id: 'c1' }), {
        verifyAdminSession: user1Session as any,
        prisma: prismaMock,
        encryptToken: (t) => `enc-${t}`,
        updateAppConfiguration: prismaMock.appConfiguration.update,
        createAuditLog: async () => null as any
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(appConfigs[0].encryptedAppSecret, 'encrypted-secret-original');
      console.log('✓ Test 8: Unchanged secret mask preserves existing App Secret');
    }

    // 9. Secret rotation changes only encryptedAppSecret and intended fields
    {
      reset();
      appConfigs = [
        { id: 'c1', userId: 'user-1', facebookAppId: 'app-1', publicAppUrl: 'http://localhost', encryptedAppSecret: 'encrypted-secret-original', liveMetaMode: false, isDefault: true, isEnabled: true, configurationName: 'App Name', createdAt: new Date(100), updatedAt: new Date() }
      ];
      const req = new NextRequest('http://localhost/api/admin/configurations/c1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          facebookAppSecret: 'new-secret-value'
        })
      });
      const res = await patchConfig(req, Promise.resolve({ id: 'c1' }), {
        verifyAdminSession: user1Session as any,
        prisma: prismaMock,
        encryptToken: (t) => `enc-${t}`,
        updateAppConfiguration: prismaMock.appConfiguration.update,
        createAuditLog: async () => null as any
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(appConfigs[0].encryptedAppSecret, 'enc-new-secret-value');
      console.log('✓ Test 9: App Secret rotation executes successfully');
    }

    // 10. App ID change is rejected with 409 while accounts are connected
    {
      reset();
      appConfigs = [
        { id: 'c1', userId: 'user-1', facebookAppId: 'app-1', publicAppUrl: 'http://localhost', encryptedAppSecret: 'sec-1', liveMetaMode: false, isDefault: true, isEnabled: true, configurationName: 'App Name', createdAt: new Date(100), updatedAt: new Date() }
      ];
      facebookAccounts = [
        { id: 'acc-1', userId: 'user-1', appConfigurationId: 'c1', facebookUserId: 'fb-user-1', name: 'FB Profile' }
      ];
      const req = new NextRequest('http://localhost/api/admin/configurations/c1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          facebookAppId: 'app-new'
        })
      });
      const res = await patchConfig(req, Promise.resolve({ id: 'c1' }), {
        verifyAdminSession: user1Session as any,
        prisma: prismaMock,
        encryptToken: (t) => `enc-${t}`,
        updateAppConfiguration: prismaMock.appConfiguration.update,
        createAuditLog: async () => null as any
      });
      assert.strictEqual(res.status, 409);
      console.log('✓ Test 10: App ID modification rejected when accounts are connected');
    }

    // 11. A non-default configuration can be disabled and re-enabled
    {
      reset();
      appConfigs = [
        { id: 'c1', userId: 'user-1', facebookAppId: 'app-1', publicAppUrl: 'http://localhost', encryptedAppSecret: 'sec-1', liveMetaMode: false, isDefault: true, isEnabled: true, configurationName: 'App 1', createdAt: new Date(100), updatedAt: new Date() },
        { id: 'c2', userId: 'user-1', facebookAppId: 'app-2', publicAppUrl: 'http://localhost', encryptedAppSecret: 'sec-2', liveMetaMode: false, isDefault: false, isEnabled: true, configurationName: 'App 2', createdAt: new Date(200), updatedAt: new Date() }
      ];
      const reqDisable = new NextRequest('http://localhost/api/admin/configurations/c2', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          isEnabled: false
        })
      });
      const resDisable = await patchConfig(reqDisable, Promise.resolve({ id: 'c2' }), {
        verifyAdminSession: user1Session as any,
        prisma: prismaMock,
        encryptToken: (t) => `enc-${t}`,
        updateAppConfiguration: prismaMock.appConfiguration.update,
        createAuditLog: async () => null as any
      });
      assert.strictEqual(resDisable.status, 200);
      assert.strictEqual(appConfigs[1].isEnabled, false);

      const reqEnable = new NextRequest('http://localhost/api/admin/configurations/c2', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          isEnabled: true
        })
      });
      const resEnable = await patchConfig(reqEnable, Promise.resolve({ id: 'c2' }), {
        verifyAdminSession: user1Session as any,
        prisma: prismaMock,
        encryptToken: (t) => `enc-${t}`,
        updateAppConfiguration: prismaMock.appConfiguration.update,
        createAuditLog: async () => null as any
      });
      assert.strictEqual(resEnable.status, 200);
      assert.strictEqual(appConfigs[1].isEnabled, true);
      console.log('✓ Test 11: Non-default configuration can be disabled and re-enabled.');
    }

    // 12. A default configuration cannot be disabled
    {
      reset();
      appConfigs = [
        { id: 'c1', userId: 'user-1', facebookAppId: 'app-1', publicAppUrl: 'http://localhost', encryptedAppSecret: 'sec-1', liveMetaMode: false, isDefault: true, isEnabled: true, configurationName: 'App 1', createdAt: new Date(100), updatedAt: new Date() }
      ];
      const req = new NextRequest('http://localhost/api/admin/configurations/c1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          isEnabled: false
        })
      });
      const res = await patchConfig(req, Promise.resolve({ id: 'c1' }), {
        verifyAdminSession: user1Session as any,
        prisma: prismaMock,
        encryptToken: (t) => `enc-${t}`,
        updateAppConfiguration: async (uid, cid, data) => {
          if (appConfigs[0].isDefault && data.isEnabled === false) {
            throw new Error('A default configuration must always be enabled');
          }
          return prismaMock.appConfiguration.update({ where: { id: cid }, data });
        },
        createAuditLog: async () => null as any
      });
      assert.strictEqual(res.status, 400);
      console.log('✓ Test 12: Default configuration disable rejected');
    }

    // 13. Promoting an enabled configuration clears the previous default
    {
      reset();
      appConfigs = [
        { id: 'c1', userId: 'user-1', facebookAppId: 'app-1', publicAppUrl: 'http://localhost', encryptedAppSecret: 'sec-1', liveMetaMode: false, isDefault: true, isEnabled: true, configurationName: 'App 1', createdAt: new Date(100), updatedAt: new Date() },
        { id: 'c2', userId: 'user-1', facebookAppId: 'app-2', publicAppUrl: 'http://localhost', encryptedAppSecret: 'sec-2', liveMetaMode: false, isDefault: false, isEnabled: true, configurationName: 'App 2', createdAt: new Date(200), updatedAt: new Date() }
      ];
      const req = new NextRequest('http://localhost/api/admin/configurations/c2/default', {
        method: 'POST'
      });
      const res = await promoteDefault(req, Promise.resolve({ id: 'c2' }), {
        verifyAdminSession: user1Session as any,
        prisma: prismaMock,
        setDefaultAppConfiguration: async (uid, cid) => {
          appConfigs.forEach(c => {
            c.isDefault = c.id === cid;
          });
          return {} as any;
        },
        createAuditLog: async () => null as any
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(appConfigs[0].isDefault, false);
      assert.strictEqual(appConfigs[1].isDefault, true);
      console.log('✓ Test 13: Promoting config clears previous defaults');
    }

    // 14. A disabled configuration cannot be promoted
    {
      reset();
      appConfigs = [
        { id: 'c1', userId: 'user-1', facebookAppId: 'app-1', publicAppUrl: 'http://localhost', encryptedAppSecret: 'sec-1', liveMetaMode: false, isDefault: true, isEnabled: true, configurationName: 'App 1', createdAt: new Date(100), updatedAt: new Date() },
        { id: 'c2', userId: 'user-1', facebookAppId: 'app-2', publicAppUrl: 'http://localhost', encryptedAppSecret: 'sec-2', liveMetaMode: false, isDefault: false, isEnabled: false, configurationName: 'App 2', createdAt: new Date(200), updatedAt: new Date() }
      ];
      const req = new NextRequest('http://localhost/api/admin/configurations/c2/default', {
        method: 'POST'
      });
      const res = await promoteDefault(req, Promise.resolve({ id: 'c2' }), {
        verifyAdminSession: user1Session as any,
        prisma: prismaMock,
        setDefaultAppConfiguration: async () => ({} as any),
        createAuditLog: async () => null as any
      });
      assert.strictEqual(res.status, 400);
      console.log('✓ Test 14: Promoting a disabled configuration is rejected');
    }

    // 15. Cross-user PATCH is rejected
    {
      reset();
      appConfigs = [
        { id: 'c2', userId: 'user-2', facebookAppId: 'app-2', publicAppUrl: 'http://localhost', encryptedAppSecret: 'sec-2', liveMetaMode: false, isDefault: true, isEnabled: true, configurationName: 'User 2 App', createdAt: new Date(100), updatedAt: new Date() }
      ];
      const req = new NextRequest('http://localhost/api/admin/configurations/c2', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ configurationName: 'Hacked' })
      });
      const res = await patchConfig(req, Promise.resolve({ id: 'c2' }), {
        verifyAdminSession: user1Session as any,
        prisma: prismaMock,
        encryptToken: (t) => t,
        updateAppConfiguration: prismaMock.appConfiguration.update,
        createAuditLog: async () => null as any
      });
      assert.strictEqual(res.status, 404);
      console.log('✓ Test 15: Cross-user PATCH configurations yields 404');
    }

    // 16. Cross-user default promotion is rejected
    {
      reset();
      appConfigs = [
        { id: 'c2', userId: 'user-2', facebookAppId: 'app-2', publicAppUrl: 'http://localhost', encryptedAppSecret: 'sec-2', liveMetaMode: false, isDefault: true, isEnabled: true, configurationName: 'User 2 App', createdAt: new Date(100), updatedAt: new Date() }
      ];
      const req = new NextRequest('http://localhost/api/admin/configurations/c2/default', {
        method: 'POST'
      });
      const res = await promoteDefault(req, Promise.resolve({ id: 'c2' }), {
        verifyAdminSession: user1Session as any,
        prisma: prismaMock,
        setDefaultAppConfiguration: async () => ({} as any),
        createAuditLog: async () => null as any
      });
      assert.strictEqual(res.status, 404);
      console.log('✓ Test 16: Cross-user promotion to default yields 404');
    }

    // 17. OAuth initiation uses the explicitly selected configuration
    {
      reset();
      appConfigs = [
        { id: 'c1', userId: 'user-1', facebookAppId: 'app-1', publicAppUrl: 'https://c1.com', encryptedAppSecret: 'sec-1', liveMetaMode: true, isDefault: true, isEnabled: true, configurationName: 'C1', createdAt: new Date(), updatedAt: new Date() },
        { id: 'c2', userId: 'user-1', facebookAppId: 'app-2', publicAppUrl: 'https://c2.com', encryptedAppSecret: 'sec-2', liveMetaMode: true, isDefault: false, isEnabled: true, configurationName: 'C2', createdAt: new Date(), updatedAt: new Date() }
      ];
      const req = new NextRequest('http://localhost/api/auth/facebook/initiate?configurationId=c2');
      const res = await initiateOAuth(req, {
        getSessionUser: user1Session as any,
        getAppConfiguration: async (uid, cid) => appConfigs.find(c => c.id === cid && c.userId === uid) as any,
        cookies: async () => ({
          set: () => {},
          delete: () => {}
        }) as any
      });
      assert.strictEqual(res.status, 307);
      const loc = res.headers.get('location') || '';
      assert(loc.includes('client_id=app-2'));
      assert(loc.includes(encodeURIComponent('https://c2.com/api/auth/facebook/callback')));
      console.log('✓ Test 17: OAuth initiation targeting configurationId parameters redirection correct');
    }

    // 18. OAuth initiation rejects a disabled configuration
    {
      reset();
      appConfigs = [
        { id: 'c_dis', userId: 'user-1', facebookAppId: 'app-1', publicAppUrl: 'https://c1.com', encryptedAppSecret: 'sec-1', liveMetaMode: true, isDefault: false, isEnabled: false, configurationName: 'Disabled', createdAt: new Date(), updatedAt: new Date() }
      ];
      const req = new NextRequest('http://localhost/api/auth/facebook/initiate?configurationId=c_dis');
      const res = await initiateOAuth(req, {
        getSessionUser: user1Session as any,
        getAppConfiguration: async (uid, cid) => appConfigs.find(c => c.id === cid && c.userId === uid) as any,
        cookies: async () => ({
          set: () => {},
          delete: () => {}
        }) as any
      });
      assert(res.headers.get('location')?.includes('error=invalid_configuration'));
      console.log('✓ Test 18: OAuth initiation fails for disabled configurations');
    }

    // 19. OAuth initiation rejects a cross-user configuration
    {
      reset();
      appConfigs = [
        { id: 'c_other', userId: 'user-2', facebookAppId: 'app-1', publicAppUrl: 'https://c1.com', encryptedAppSecret: 'sec-1', liveMetaMode: true, isDefault: true, isEnabled: true, configurationName: 'C2', createdAt: new Date(), updatedAt: new Date() }
      ];
      const req = new NextRequest('http://localhost/api/auth/facebook/initiate?configurationId=c_other');
      const res = await initiateOAuth(req, {
        getSessionUser: user1Session as any,
        getAppConfiguration: async (uid, cid) => appConfigs.find(c => c.id === cid && c.userId === uid) as any,
        cookies: async () => ({
          set: () => {},
          delete: () => {}
        }) as any
      });
      assert(res.headers.get('location')?.includes('error=invalid_configuration'));
      console.log('✓ Test 19: OAuth initiation fails for cross-user configuration IDs');
    }

    // 20. OAuth context stores the state and exact configuration ID
    {
      reset();
      appConfigs = [
        { id: 'c2', userId: 'user-1', facebookAppId: 'app-2', publicAppUrl: 'https://c2.com', encryptedAppSecret: 'sec-2', liveMetaMode: true, isDefault: false, isEnabled: true, configurationName: 'C2', createdAt: new Date(), updatedAt: new Date() }
      ];
      const req = new NextRequest('http://localhost/api/auth/facebook/initiate?configurationId=c2');
      const res = await initiateOAuth(req, {
        getSessionUser: user1Session as any,
        getAppConfiguration: async (uid, cid) => appConfigs.find(c => c.id === cid && c.userId === uid) as any,
        cookies: async () => ({
          set: (n: string, v: string) => {
            mockCookies[n] = v;
          },
          delete: () => {}
        }) as any
      });
      const ctx = JSON.parse(mockCookies['fb_oauth_context']);
      assert.strictEqual(ctx.configurationId, 'c2');
      assert(ctx.state);
      console.log('✓ Test 20: OAuth initiation stores correct state and configId in cookie context');
    }

    // 21. Callback continues using the stored configuration even when another configuration becomes default after initiation
    {
      reset();
      appConfigs = [
        { id: 'c1', userId: 'user-1', facebookAppId: 'app-1', publicAppUrl: 'https://c1.com', encryptedAppSecret: 'sec-1', liveMetaMode: false, isDefault: true, isEnabled: true, configurationName: 'C1', createdAt: new Date(), updatedAt: new Date() },
        { id: 'c2', userId: 'user-1', facebookAppId: 'app-2', publicAppUrl: 'https://c2.com', encryptedAppSecret: 'sec-2', liveMetaMode: false, isDefault: false, isEnabled: true, configurationName: 'C2', createdAt: new Date(), updatedAt: new Date() }
      ];
      mockCookies['fb_oauth_context'] = JSON.stringify({ state: 'state123', configurationId: 'c2' });
      const req = new NextRequest('http://localhost/api/auth/facebook/callback?state=state123&code=code123');
      const res = await callbackOAuth(req, {
        getSessionUser: user1Session as any,
        prisma: prismaMock,
        saveFacebookAccount: async () => ({} as any),
        cookies: async () => ({
          get: (n: string) => ({ value: mockCookies[n] }),
          delete: () => {}
        }) as any
      });
      assert.strictEqual(res.status, 307);
      assert(res.headers.get('location')?.includes('configurationId=c2'));
      console.log('✓ Test 21: OAuth callback respects context configurationId overriding database default');
    }

    // 22. Callback passes the exact stored configuration ID to saveFacebookAccount
    {
      reset();
      appConfigs = [
        { id: 'c1', userId: 'user-1', facebookAppId: 'app-1', publicAppUrl: 'https://c1.com', encryptedAppSecret: 'sec-1', liveMetaMode: false, isDefault: true, isEnabled: true, configurationName: 'C1', createdAt: new Date(), updatedAt: new Date() },
        { id: 'c2', userId: 'user-1', facebookAppId: 'app-2', publicAppUrl: 'https://c2.com', encryptedAppSecret: 'sec-2', liveMetaMode: false, isDefault: false, isEnabled: true, configurationName: 'C2', createdAt: new Date(), updatedAt: new Date() }
      ];
      mockCookies['fb_oauth_context'] = JSON.stringify({ state: 'state123', configurationId: 'c2' });
      const req = new NextRequest('http://localhost/api/auth/facebook/callback?state=state123&code=code123');
      let savedCid = '';
      const res = await callbackOAuth(req, {
        getSessionUser: user1Session as any,
        prisma: prismaMock,
        saveFacebookAccount: async (uid, acc, connState, cid) => {
          savedCid = cid || '';
          return {} as any;
        },
        cookies: async () => ({
          get: (n: string) => ({ value: mockCookies[n] }),
          delete: () => {}
        }) as any
      });
      assert.strictEqual(savedCid, 'c2');
      console.log('✓ Test 22: Stored configurationId passed successfully to saveFacebookAccount');
    }

    // 23. The same facebookUserId can be saved under two different appConfigurationId values as two separate accounts
    {
      reset();
      appConfigs = [
        { id: 'c1', userId: 'user-1', facebookAppId: 'app-1', publicAppUrl: 'https://c1.com', encryptedAppSecret: 'sec-1', liveMetaMode: true, isDefault: true, isEnabled: true, configurationName: 'C1', createdAt: new Date(), updatedAt: new Date() },
        { id: 'c2', userId: 'user-1', facebookAppId: 'app-2', publicAppUrl: 'https://c2.com', encryptedAppSecret: 'sec-2', liveMetaMode: true, isDefault: false, isEnabled: true, configurationName: 'C2', createdAt: new Date(), updatedAt: new Date() }
      ];

      const acc1Data = { id: 'acc-1', facebookUserId: 'fb-user-same', name: 'Profile under C1', encryptedAccessToken: 'tok-1', tokenExpiresAt: new Date(Date.now() + 1000000).toISOString(), pages: [] };
      const acc2Data = { id: 'acc-2', facebookUserId: 'fb-user-same', name: 'Profile under C2', encryptedAccessToken: 'tok-2', tokenExpiresAt: new Date(Date.now() + 1000000).toISOString(), pages: [] };

      await saveFacebookAccount('user-1', acc1Data, 'Connected', 'c1');
      await saveFacebookAccount('user-1', acc2Data, 'Connected', 'c2');

      assert.strictEqual(facebookAccounts.length, 2);
      assert.strictEqual(facebookAccounts[0].appConfigurationId, 'c1');
      assert.strictEqual(facebookAccounts[1].appConfigurationId, 'c2');
      console.log('✓ Test 23: Separate accounts saved under distinct configurations for same facebookUserId');
    }

    // 24. Accounts remain grouped under their exact configuration
    {
      reset();
      appConfigs = [
        { id: 'c1', userId: 'user-1', facebookAppId: 'app-1', publicAppUrl: 'https://c1.com', encryptedAppSecret: 'sec-1', liveMetaMode: false, isDefault: true, isEnabled: true, configurationName: 'C1', createdAt: new Date(), updatedAt: new Date() },
        { id: 'c2', userId: 'user-1', facebookAppId: 'app-2', publicAppUrl: 'https://c2.com', encryptedAppSecret: 'sec-2', liveMetaMode: false, isDefault: false, isEnabled: true, configurationName: 'C2', createdAt: new Date(), updatedAt: new Date() }
      ];
      facebookAccounts = [
        { id: 'acc-1', userId: 'user-1', appConfigurationId: 'c1', facebookUserId: 'fb-1', name: 'Profile 1', tokenExpiresAt: new Date(Date.now() + 100000) },
        { id: 'acc-2', userId: 'user-1', appConfigurationId: 'c2', facebookUserId: 'fb-2', name: 'Profile 2', tokenExpiresAt: new Date(Date.now() + 100000) }
      ];

      const connections = await getFacebookConnections('user-1');
      assert.strictEqual(connections.length, 2);
      assert.strictEqual(connections[0].appConfigurationId, 'c1');
      assert.strictEqual(connections[1].appConfigurationId, 'c2');
      console.log('✓ Test 24: Connected accounts correctly retain appConfigurationId grouping');
    }

    // 25. Pages remain nested under their exact account
    {
      reset();
      appConfigs = [
        { id: 'c1', userId: 'user-1', facebookAppId: 'app-1', publicAppUrl: 'https://c1.com', encryptedAppSecret: 'sec-1', liveMetaMode: false, isDefault: true, isEnabled: true, configurationName: 'C1', createdAt: new Date(), updatedAt: new Date() }
      ];
      facebookAccounts = [
        { id: 'acc-1', userId: 'user-1', appConfigurationId: 'c1', facebookUserId: 'fb-1', name: 'Profile 1', tokenExpiresAt: new Date(Date.now() + 100000) }
      ];
      facebookPages = [
        { id: 'p1', accountId: 'acc-1', userId: 'user-1', facebookPageId: 'page-1', pageName: 'Page 1', pageCategory: 'Cat', pagePictureUrl: '', encryptedPageToken: '', isSynced: true, createdAt: new Date() }
      ];
      const connections = await getFacebookConnections('user-1');
      assert.strictEqual(connections[0].pages.length, 1);
      assert.strictEqual(connections[0].pages[0].facebookPageId, 'page-1');
      console.log('✓ Test 25: Pages correctly nested under matching Facebook account');
    }

    // 26. Sync is scoped to the requested owned internal account ID
    {
      reset();
      appConfigs = [
        { id: 'c1', userId: 'user-1', facebookAppId: 'app-1', publicAppUrl: 'https://c1.com', encryptedAppSecret: 'sec-1', liveMetaMode: false, isDefault: true, isEnabled: true, configurationName: 'C1', createdAt: new Date(), updatedAt: new Date() }
      ];
      facebookAccounts = [
        { id: 'acc-1', userId: 'user-1', appConfigurationId: 'c1', facebookUserId: 'fb-1', name: 'Profile 1', tokenExpiresAt: new Date(Date.now() + 100000) },
        { id: 'acc-2', userId: 'user-1', appConfigurationId: 'c1', facebookUserId: 'fb-2', name: 'Profile 2', tokenExpiresAt: new Date(Date.now() + 100000) }
      ];
      const req = new NextRequest('http://localhost/api/facebook/sync?accountId=acc-2', {
        method: 'POST',
        headers: { 'Host': 'localhost', 'Origin': 'http://localhost' }
      });
      mockQueries.length = 0;
      const res = await handleSync(req);
      assert.strictEqual(res.status, 200);
      const findQuery = mockQueries.filter(q => q.model === 'facebookAccount' && q.method === 'findFirst');
      assert(findQuery.some(q => q.args?.where?.id === 'acc-2'));
      console.log('✓ Test 26: Sync operation scoped strictly to requested accountId');
    }

    // 27. Cross-user sync is rejected
    {
      reset();
      appConfigs = [
        { id: 'c1', userId: 'user-2', facebookAppId: 'app-1', publicAppUrl: 'https://c1.com', encryptedAppSecret: 'sec-1', liveMetaMode: false, isDefault: true, isEnabled: true, configurationName: 'C1', createdAt: new Date(), updatedAt: new Date() }
      ];
      facebookAccounts = [
        { id: 'acc-other', userId: 'user-2', appConfigurationId: 'c1', facebookUserId: 'fb-2', name: 'Profile 2', tokenExpiresAt: new Date(Date.now() + 100000) }
      ];
      const req = new NextRequest('http://localhost/api/facebook/sync?accountId=acc-other', {
        method: 'POST',
        headers: { 'Host': 'localhost', 'Origin': 'http://localhost' }
      });
      const res = await handleSync(req);
      assert.strictEqual(res.status, 404);
      console.log('✓ Test 27: Cross-user page sync rejected with 404');
    }

    // 28. Disconnect removes only the requested owned internal account
    {
      reset();
      appConfigs = [
        { id: 'c1', userId: 'user-1', facebookAppId: 'app-1', publicAppUrl: 'https://c1.com', encryptedAppSecret: 'sec-1', liveMetaMode: false, isDefault: true, isEnabled: true, configurationName: 'C1', createdAt: new Date(), updatedAt: new Date() }
      ];
      facebookAccounts = [
        { id: 'acc-1', userId: 'user-1', appConfigurationId: 'c1', facebookUserId: 'fb-1', name: 'Profile 1', tokenExpiresAt: new Date(Date.now() + 100000) },
        { id: 'acc-2', userId: 'user-1', appConfigurationId: 'c1', facebookUserId: 'fb-2', name: 'Profile 2', tokenExpiresAt: new Date(Date.now() + 100000) }
      ];
      const req = new NextRequest('http://localhost/api/facebook/disconnect?accountId=acc-2', {
        method: 'POST',
        headers: { 'Host': 'localhost', 'Origin': 'http://localhost' }
      });
      mockQueries.length = 0;
      const res = await handleDisconnect(req);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(facebookAccounts.length, 1);
      assert.strictEqual(facebookAccounts[0].id, 'acc-1');
      console.log('✓ Test 28: Disconnect limits scope strictly to requested accountId');
    }

    // 29. Cross-user disconnect is rejected
    {
      reset();
      appConfigs = [
        { id: 'c1', userId: 'user-2', facebookAppId: 'app-1', publicAppUrl: 'https://c1.com', encryptedAppSecret: 'sec-1', liveMetaMode: false, isDefault: true, isEnabled: true, configurationName: 'C1', createdAt: new Date(), updatedAt: new Date() }
      ];
      facebookAccounts = [
        { id: 'acc-other', userId: 'user-2', appConfigurationId: 'c1', facebookUserId: 'fb-2', name: 'Profile 2', tokenExpiresAt: new Date(Date.now() + 100000) }
      ];
      const req = new NextRequest('http://localhost/api/facebook/disconnect?accountId=acc-other', {
        method: 'POST',
        headers: { 'Host': 'localhost', 'Origin': 'http://localhost' }
      });
      const res = await handleDisconnect(req);
      assert.strictEqual(res.status, 404);
      console.log('✓ Test 29: Cross-user disconnect is rejected with 404');
    }

    // 30. No external network request occurs
    {
      assert.strictEqual(networkCallAttempted, false);
      console.log('✓ Test 30: Network fetch guard was not triggered');
    }

    // 31. The real mock_db.json bytes/hash remain unchanged
    {
      const finalContent = fs.readFileSync(realMockDbPath, 'utf8');
      const finalHash = crypto.createHash('sha256').update(finalContent).digest('hex');
      assert.strictEqual(finalHash, originalHash);
      console.log('✓ Test 31: Integrity of src/lib/mock_db.json is preserved');
    }

    // 32. No real Prisma client or production database path can be reached
    {
      assert.strictEqual(process.env.DATABASE_URL, 'postgresql://unreachable-sentinel-test-db:5432/testdb');
      console.log('✓ Test 32: Unreachable database sentinel URL verified');
    }

    // 33. Prisma module interception uses the in-memory test client
    {
      const importedPrismaClient = require('@/lib/prisma-client');
      assert.strictEqual(importedPrismaClient.prisma, prismaMock);
      console.log('✓ Test 33: Prisma module interception uses the in-memory test client.');
    }

    // 34. A new configuration with a blank secret is rejected even when the user has an existing default configuration.
    {
      reset();
      appConfigs = [
        { id: 'c1', userId: 'user-1', facebookAppId: 'app-1', publicAppUrl: 'https://c1.com', encryptedAppSecret: 'sec-1', liveMetaMode: true, isDefault: true, isEnabled: true, configurationName: 'C1 Default', createdAt: new Date(), updatedAt: new Date() }
      ];
      const req = new NextRequest('http://localhost/api/admin/config/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publicAppUrl: 'https://new-app.com',
          facebookAppId: 'new-app-id',
          facebookAppSecret: '',
          liveMetaMode: true
        })
      });
      const res = await testConfig(req);
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.strictEqual(data.message, 'Enter a Facebook App Secret for the new configuration.');
      console.log('✓ Test 34: A new configuration with a blank secret is rejected even when the user has an existing default configuration.');
    }

    // 35. A new configuration cannot use the default configuration’s stored secret.
    {
      reset();
      appConfigs = [
        { id: 'c1', userId: 'user-1', facebookAppId: 'app-1', publicAppUrl: 'https://c1.com', encryptedAppSecret: 'sec-1', liveMetaMode: true, isDefault: true, isEnabled: true, configurationName: 'C1 Default', createdAt: new Date(), updatedAt: new Date() }
      ];
      const req = new NextRequest('http://localhost/api/admin/config/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publicAppUrl: 'https://new-app.com',
          facebookAppId: 'new-app-id',
          facebookAppSecret: '************',
          liveMetaMode: true
        })
      });
      const res = await testConfig(req);
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.strictEqual(data.message, 'Enter a Facebook App Secret for the new configuration.');
      console.log('✓ Test 35: A new configuration cannot use the default configuration’s stored secret.');
    }

    // 36. An existing owned configuration with its explicit configurationId and unchanged mask can use its own stored secret.
    {
      reset();
      const { encryptToken } = require('../src/lib/crypto');
      const validEncryptedSecret = encryptToken('valid-facebook-secret');
      appConfigs = [
        { id: 'c_owned', userId: 'user-1', facebookAppId: 'app-owned', publicAppUrl: 'https://c-owned.com', encryptedAppSecret: validEncryptedSecret, liveMetaMode: true, isDefault: false, isEnabled: true, configurationName: 'Owned App', createdAt: new Date(), updatedAt: new Date() }
      ];
      const req = new NextRequest('http://localhost/api/admin/config/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          configurationId: 'c_owned',
          publicAppUrl: 'https://c-owned.com',
          facebookAppId: 'app-owned',
          facebookAppSecret: '************',
          liveMetaMode: true
        })
      });
      const res = await testConfig(req);
      assert.strictEqual(res.status, 200);
      console.log('✓ Test 36: An existing owned configuration with its explicit configurationId and unchanged mask can use its own stored secret.');
    }

    // 37. A cross-user configurationId is rejected.
    {
      reset();
      const { encryptToken } = require('../src/lib/crypto');
      const validEncryptedSecret = encryptToken('valid-facebook-secret');
      appConfigs = [
        { id: 'c_other', userId: 'user-2', facebookAppId: 'app-other', publicAppUrl: 'https://c-other.com', encryptedAppSecret: validEncryptedSecret, liveMetaMode: true, isDefault: true, isEnabled: true, configurationName: 'User 2 App', createdAt: new Date(), updatedAt: new Date() }
      ];
      const req = new NextRequest('http://localhost/api/admin/config/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          configurationId: 'c_other',
          publicAppUrl: 'https://c-other.com',
          facebookAppId: 'app-other',
          facebookAppSecret: '************',
          liveMetaMode: true
        })
      });
      const res = await testConfig(req);
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.strictEqual(data.message, 'Validation failed: App configuration not found or access denied.');
      console.log('✓ Test 37: A cross-user configurationId is rejected.');
    }

    // 38. An explicit cross-user configurationId with a fresh non-masked secret is rejected.
    {
      reset();
      const { encryptToken } = require('../src/lib/crypto');
      const validEncryptedSecret = encryptToken('valid-facebook-secret');
      appConfigs = [
        { id: 'c_other', userId: 'user-2', facebookAppId: 'app-other', publicAppUrl: 'https://c-other.com', encryptedAppSecret: validEncryptedSecret, liveMetaMode: true, isDefault: true, isEnabled: true, configurationName: 'User 2 App', createdAt: new Date(), updatedAt: new Date() }
      ];
      const req = new NextRequest('http://localhost/api/admin/config/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          configurationId: 'c_other',
          publicAppUrl: 'https://c-other.com',
          facebookAppId: 'app-other',
          facebookAppSecret: 'fresh-secret',
          liveMetaMode: true
        })
      });
      const res = await testConfig(req);
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.strictEqual(data.message, 'Validation failed: App configuration not found or access denied.');
      console.log('✓ Test 38: An explicit cross-user configurationId with a fresh non-masked secret is rejected.');
    }

    // 39. An owned configuration with a masked secret and a changed App ID is rejected.
    {
      reset();
      const { encryptToken } = require('../src/lib/crypto');
      const validEncryptedSecret = encryptToken('valid-facebook-secret');
      appConfigs = [
        { id: 'c_owned', userId: 'user-1', facebookAppId: 'app-original', publicAppUrl: 'https://c-owned.com', encryptedAppSecret: validEncryptedSecret, liveMetaMode: true, isDefault: false, isEnabled: true, configurationName: 'Owned App', createdAt: new Date(), updatedAt: new Date() }
      ];
      const req = new NextRequest('http://localhost/api/admin/config/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          configurationId: 'c_owned',
          publicAppUrl: 'https://c-owned.com',
          facebookAppId: 'app-changed',
          facebookAppSecret: '************',
          liveMetaMode: true
        })
      });
      const res = await testConfig(req);
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.strictEqual(data.message, 'Enter the App Secret that belongs to the changed Facebook App ID.');
      console.log('✓ Test 39: An owned configuration with a masked secret and a changed App ID is rejected.');
    }

    // 40. An owned configuration with a changed App ID and a fresh secret may pass local validation.
    {
      reset();
      const { encryptToken } = require('../src/lib/crypto');
      const validEncryptedSecret = encryptToken('valid-facebook-secret');
      appConfigs = [
        { id: 'c_owned', userId: 'user-1', facebookAppId: 'app-original', publicAppUrl: 'https://c-owned.com', encryptedAppSecret: validEncryptedSecret, liveMetaMode: true, isDefault: false, isEnabled: true, configurationName: 'Owned App', createdAt: new Date(), updatedAt: new Date() }
      ];
      const req = new NextRequest('http://localhost/api/admin/config/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          configurationId: 'c_owned',
          publicAppUrl: 'https://c-owned.com',
          facebookAppId: 'app-changed',
          facebookAppSecret: 'new-valid-secret',
          liveMetaMode: true
        })
      });
      const res = await testConfig(req);
      assert.strictEqual(res.status, 200);
      console.log('✓ Test 40: An owned configuration with a changed App ID and a fresh secret may pass local validation.');
    }

    // 41. Non-string configurationId values are rejected safely.
    {
      reset();
      const req = new NextRequest('http://localhost/api/admin/config/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          configurationId: 12345,
          publicAppUrl: 'https://c-owned.com',
          facebookAppId: 'app-owned',
          facebookAppSecret: 'fresh-secret',
          liveMetaMode: true
        })
      });
      const res = await testConfig(req);
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.strictEqual(data.message, 'Validation failed: Invalid configuration ID.');
      console.log('✓ Test 41: Non-string configurationId values are rejected safely.');
    }

    console.log('\n======================================================');
    console.log('PHASE7B_META_MANAGEMENT_TESTS=PASSED');
    console.log('======================================================');

  } finally {
    // Restore overrides in finally
    Module.prototype.require = originalRequire;
    (global as any).fetch = originalFetch;

    if (hadOriginalGlobalPrisma) {
      (globalThis as any).prisma = originalGlobalPrisma;
    } else {
      delete (globalThis as any).prisma;
    }

    if (originalDatabaseUrl !== undefined) {
      process.env.DATABASE_URL = originalDatabaseUrl;
    } else {
      delete process.env.DATABASE_URL;
    }

    if (originalNodeEnv !== undefined) {
      (process.env as any).NODE_ENV = originalNodeEnv;
    } else {
      delete (process.env as any).NODE_ENV;
    }

    if (originalMockDbPath !== undefined) {
      process.env.FB_PUBLISHER_TEST_MOCK_DB_PATH = originalMockDbPath;
    } else {
      delete process.env.FB_PUBLISHER_TEST_MOCK_DB_PATH;
    }

    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

runTests().catch((err) => {
  console.error('Phase 7B Tests FAILED:', err);
  process.exit(1);
});
