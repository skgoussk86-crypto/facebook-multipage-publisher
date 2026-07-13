import fs from 'fs';
import path from 'path';
import { prisma } from './prisma-client';

const MOCK_DB_PATH = path.join(process.cwd(), 'src/lib/mock_db.json');

export interface MockFacebookPage {
  id: string; // pageId (e.g., 1029384756)
  name: string;
  category: string;
  pictureUrl: string;
  tokenStatus: 'Valid' | 'Expired';
  connectedAt: string;
  encryptedPageToken: string;
}

export interface MockFacebookAccount {
  id: string; // accountId
  facebookUserId: string;
  name: string;
  encryptedAccessToken: string;
  tokenExpiresAt: string;
  pages: MockFacebookPage[];
  userId?: string;
}

export interface MockDbSchema {
  accounts: MockFacebookAccount[];
  connectionState: 'Not Connected' | 'Connected' | 'Token Expiring' | 'Reconnection Required' | 'Permission Missing';
}

function loadMockDb(): MockDbSchema {
  try {
    if (fs.existsSync(MOCK_DB_PATH)) {
      const data = fs.readFileSync(MOCK_DB_PATH, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.error('Error loading mock DB, returning default:', e);
  }
  return {
    accounts: [],
    connectionState: 'Not Connected'
  };
}

function saveMockDb(data: MockDbSchema) {
  try {
    const dir = path.dirname(MOCK_DB_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(MOCK_DB_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('Error saving mock DB:', e);
  }
}

export function sanitizeLog(message: string): string {
  // Redact Facebook access tokens starting with EAA
  return message.replace(/EAA[A-Za-z0-9]+/g, '[REDACTED_TOKEN]');
}

export function logInfo(msg: string) {
  console.log(sanitizeLog(`[FB_PUBLISHER] INFO: ${msg}`));
}

export function logWarn(msg: string) {
  console.warn(sanitizeLog(`[FB_PUBLISHER] WARN: ${msg}`));
}

export function logError(msg: string) {
  console.error(sanitizeLog(`[FB_PUBLISHER] ERROR: ${msg}`));
}

export interface FacebookAccountUI {
  id: string;
  facebookUserId: string;
  name: string;
  tokenExpiresAt: string;
  connectionState: 'Connected' | 'Token Expiring' | 'Reconnection Required' | 'Permission Missing';
  pages: MockFacebookPage[];
}

export async function getFacebookConnections(userId?: string): Promise<FacebookAccountUI[]> {
  const isLive = await isLiveMetaMode(userId);
  if (isLive) {
    try {
      const accounts = await prisma.facebookAccount.findMany({
        where: { userId },
        include: { pages: true }
      });

      const transformedAccounts: FacebookAccountUI[] = accounts.map(account => {
        const now = new Date();
        let state: 'Connected' | 'Token Expiring' | 'Reconnection Required' | 'Permission Missing' = 'Connected';
        
        if (account.tokenExpiresAt < now) {
          state = 'Reconnection Required';
        } else if (account.tokenExpiresAt.getTime() - now.getTime() < 7 * 24 * 60 * 60 * 1000) {
          state = 'Token Expiring';
        } else if (account.pages.some(p => !p.isSynced)) {
          state = 'Reconnection Required';
        }

        const pages = account.pages.map(p => ({
          id: p.facebookPageId,
          name: p.pageName,
          category: p.pageCategory,
          pictureUrl: p.pagePictureUrl,
          tokenStatus: p.isSynced ? ('Valid' as const) : ('Expired' as const),
          connectedAt: p.createdAt.toISOString(),
          encryptedPageToken: p.encryptedPageToken
        }));

        return {
          id: account.id,
          facebookUserId: account.facebookUserId,
          name: account.name,
          tokenExpiresAt: account.tokenExpiresAt.toISOString(),
          connectionState: state,
          pages
        };
      });

      return transformedAccounts;
    } catch (e) {
      logError(`Prisma fetch error in getFacebookConnections, falling back to mock DB: ${e}`);
    }
  }

  // Simulation fallback mode
  const db = loadMockDb();
  const filteredAccounts = db.accounts.filter(acc => !userId || acc.userId === userId);
  return filteredAccounts.map(acc => {
    let state = db.connectionState;
    if (state === 'Not Connected') {
      state = 'Connected';
    }
    const hasExpired = acc.pages.some(p => p.tokenStatus === 'Expired');
    if (hasExpired) {
      state = 'Reconnection Required';
    }
    return {
      id: acc.id,
      facebookUserId: acc.facebookUserId,
      name: acc.name,
      tokenExpiresAt: acc.tokenExpiresAt,
      connectionState: state as FacebookAccountUI['connectionState'],
      pages: acc.pages
    };
  });
}

export async function getFacebookConnection(userId?: string) {
  const connections = await getFacebookConnections(userId);
  if (connections.length === 0) {
    return { account: null, connectionState: 'Not Connected' as const };
  }
  return {
    account: connections[0],
    connectionState: connections[0].connectionState
  };
}

export async function saveFacebookAccount(userId: string, accountData: MockFacebookAccount, state: MockDbSchema['connectionState']) {
  const isLive = await isLiveMetaMode(userId);
  if (isLive) {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId }
      });
      if (!user) {
        throw new Error('User not found.');
      }

      // Upsert the FacebookAccount by facebookUserId
      const existingAccount = await prisma.facebookAccount.findUnique({
        where: { facebookUserId: accountData.facebookUserId }
      });

      let accountId: string;
      if (existingAccount) {
        accountId = existingAccount.id;
        await prisma.facebookAccount.update({
          where: { id: accountId },
          data: {
            userId: userId,
            encryptedAccessToken: accountData.encryptedAccessToken,
            tokenExpiresAt: new Date(accountData.tokenExpiresAt),
            name: accountData.name,
          }
        });
      } else {
        const newAccount = await prisma.facebookAccount.create({
          data: {
            userId: userId,
            facebookUserId: accountData.facebookUserId,
            encryptedAccessToken: accountData.encryptedAccessToken,
            tokenExpiresAt: new Date(accountData.tokenExpiresAt),
            name: accountData.name,
          }
        });
        accountId = newAccount.id;
      }

      // Upsert page records for this account
      for (const p of accountData.pages) {
        await prisma.facebookPage.upsert({
          where: { facebookPageId: p.id },
          update: {
            accountId: accountId,
            userId: userId,
            pageName: p.name,
            pageCategory: p.category,
            pagePictureUrl: p.pictureUrl,
            encryptedPageToken: p.encryptedPageToken,
            isSynced: p.tokenStatus === 'Valid'
          },
          create: {
            accountId: accountId,
            facebookPageId: p.id,
            userId: userId,
            pageName: p.name,
            pageCategory: p.category,
            pagePictureUrl: p.pictureUrl,
            encryptedPageToken: p.encryptedPageToken,
            isSynced: p.tokenStatus === 'Valid'
          }
        });
      }

      const savedAccount = await prisma.facebookAccount.findUnique({
        where: { id: accountId },
        include: { pages: true }
      });

      logInfo(`Saved live Facebook account ${accountData.name} and ${accountData.pages.length} pages in PostgreSQL.`);
      return savedAccount;
    } catch (e) {
      logError(`Prisma write error, falling back to mock DB: ${e}`);
    }
  }

  // Simulation mode
  const db = loadMockDb();
  const accountDataWithUser = { ...accountData, userId };
  const index = db.accounts.findIndex(acc => acc.facebookUserId === accountData.facebookUserId);
  if (index !== -1) {
    db.accounts[index] = accountDataWithUser;
  } else {
    db.accounts.push(accountDataWithUser);
  }
  db.connectionState = state;
  saveMockDb(db);
  logInfo(`Saved mock Facebook account ${accountData.name} and ${accountData.pages.length} pages in mock_db.json.`);
  return accountData;
}

export async function disconnectFacebook(userId: string, accountId?: string) {
  const isLive = await isLiveMetaMode(userId);
  if (isLive) {
    try {
      if (accountId) {
        await prisma.facebookAccount.deleteMany({
          where: { id: accountId, userId }
        });
        logInfo(`Deleted live Facebook account ${accountId} in PostgreSQL.`);
      } else {
        await prisma.facebookAccount.deleteMany({
          where: { userId }
        });
        logInfo('Deleted all live Facebook account linkages in PostgreSQL.');
      }
      return true;
    } catch (e) {
      logError(`Prisma delete error, falling back to mock DB: ${e}`);
    }
  }

  // Simulation mode
  const db = loadMockDb();
  if (accountId) {
    db.accounts = db.accounts.filter(acc => acc.id !== accountId || acc.userId !== userId);
    logInfo(`Deleted mock Facebook account ${accountId} in mock_db.json.`);
  } else {
    db.accounts = db.accounts.filter(acc => acc.userId !== userId);
    logInfo('Deleted all mock Facebook account linkages in mock_db.json.');
  }
  if (db.accounts.length === 0) {
    db.connectionState = 'Not Connected';
  }
  saveMockDb(db);
  return true;
}

export async function updateConnectionState(state: MockDbSchema['connectionState']) {
  const db = loadMockDb();
  db.connectionState = state;
  saveMockDb(db);
  return true;
}

export async function updatePagesStatus(userId: string, pagesStatus: { id: string, tokenStatus: 'Valid' | 'Expired' }[]) {
  const isLive = await isLiveMetaMode(userId);
  if (isLive) {
    try {
      for (const status of pagesStatus) {
        await prisma.facebookPage.updateMany({
          where: { 
            facebookPageId: status.id,
            facebookAccount: { userId }
          },
          data: { isSynced: status.tokenStatus === 'Valid' }
        });
      }
    } catch (e) {
      logError(`Prisma update pages error: ${e}`);
    }
  }

  // Mock sync fallback
  const db = loadMockDb();
  if (db.accounts.length > 0) {
    db.accounts = db.accounts.map(acc => {
      if (acc.userId === userId) {
        acc.pages = acc.pages.map(p => {
          const match = pagesStatus.find(ps => ps.id === p.id);
          if (match) {
            p.tokenStatus = match.tokenStatus;
          }
          return p;
        });
      }
      return acc;
    });

    // Check if any account has expired pages to trigger Reconnection Required state
    const anyExpired = db.accounts.some(acc => acc.userId === userId && acc.pages.some(p => p.tokenStatus === 'Expired'));
    if (anyExpired) {
      db.connectionState = 'Reconnection Required';
    } else {
      db.connectionState = 'Connected';
    }
    saveMockDb(db);
  }
}

export async function getAppConfiguration(userId?: string) {
  try {
    if (!userId) return null;
    return await prisma.appConfiguration.findUnique({
      where: { userId }
    });
  } catch (e) {
    logError(`Error reading app configuration: ${e}`);
    return null;
  }
}

export async function isLiveMetaMode(userId?: string): Promise<boolean> {
  const config = await getAppConfiguration(userId);
  if (config) {
    return config.liveMetaMode;
  }
  return process.env.LIVE_META_MODE === 'true';
}

export async function saveAppConfiguration(userId: string, data: {
  publicAppUrl: string;
  facebookAppId: string;
  encryptedAppSecret: string;
  liveMetaMode: boolean;
}) {
  return await prisma.appConfiguration.upsert({
    where: { userId },
    update: data,
    create: {
      id: userId,
      userId,
      ...data
    }
  });
}

export async function createAuditLog(action: string, details: string, ipAddress?: string | null, userId?: string | null) {
  try {
    return await prisma.auditLog.create({
      data: {
        action,
        details,
        ipAddress: ipAddress || null,
        userId: userId || null
      }
    });
  } catch (e) {
    logError(`Error creating audit log: ${e}`);
  }
}

export async function getAuditLogs(userId?: string, isAdmin?: boolean) {
  try {
    if (isAdmin) {
      return await prisma.auditLog.findMany({
        orderBy: { createdAt: 'desc' }
      });
    }
    return await prisma.auditLog.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' }
    });
  } catch (e) {
    logError(`Error fetching audit logs: ${e}`);
    return [];
  }
}

