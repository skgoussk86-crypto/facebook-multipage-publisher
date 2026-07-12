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

export async function getFacebookConnection() {
  const isLive = process.env.LIVE_META_MODE === 'true';
  if (isLive) {
    try {
      const account = await prisma.facebookAccount.findFirst({
        include: { pages: true }
      });
      if (!account) {
        return { account: null, connectionState: 'Not Connected' as const };
      }
      
      const now = new Date();
      let state: 'Not Connected' | 'Connected' | 'Token Expiring' | 'Reconnection Required' | 'Permission Missing' = 'Connected';
      
      if (account.tokenExpiresAt < now) {
        state = 'Reconnection Required';
      } else if (account.tokenExpiresAt.getTime() - now.getTime() < 7 * 24 * 60 * 60 * 1000) {
        state = 'Token Expiring';
      } else if (account.pages.some(p => !p.isSynced)) {
        // If some page is not synced (e.g. token expired), we flag Reconnection Required
        state = 'Reconnection Required';
      }
      
      // Transform page objects to match our frontend interface shape
      const pages = account.pages.map(p => ({
        id: p.facebookPageId,
        name: p.pageName,
        category: p.pageCategory,
        pictureUrl: p.pagePictureUrl,
        tokenStatus: p.isSynced ? ('Valid' as const) : ('Expired' as const),
        connectedAt: account.createdAt.toISOString()
      }));

      return {
        account: {
          id: account.id,
          facebookUserId: account.facebookUserId,
          name: account.name,
          tokenExpiresAt: account.tokenExpiresAt.toISOString(),
          pages
        },
        connectionState: state
      };
    } catch (e) {
      logError(`Prisma fetch error, falling back to mock DB: ${e}`);
    }
  }

  // Simulation fallback mode
  const db = loadMockDb();
  return {
    account: db.accounts[0] || null,
    connectionState: db.connectionState
  };
}

export async function saveFacebookAccount(accountData: MockFacebookAccount, state: MockDbSchema['connectionState']) {
  const isLive = process.env.LIVE_META_MODE === 'true';
  if (isLive) {
    try {
      let user = await prisma.user.findFirst();
      if (!user) {
        user = await prisma.user.create({
          data: {
            email: 'admin@example.com',
            passwordHash: 'mock_password_hash'
          }
        });
      }

      // Delete existing Facebook accounts to enforce a single active profile link
      await prisma.facebookAccount.deleteMany({
        where: { userId: user.id }
      });

      const savedAccount = await prisma.facebookAccount.create({
        data: {
          userId: user.id,
          facebookUserId: accountData.facebookUserId,
          encryptedAccessToken: accountData.encryptedAccessToken,
          tokenExpiresAt: new Date(accountData.tokenExpiresAt),
          name: accountData.name,
          pages: {
            create: accountData.pages.map(p => ({
              facebookPageId: p.id,
              pageName: p.name,
              pageCategory: p.category,
              pagePictureUrl: p.pictureUrl,
              encryptedPageToken: p.encryptedPageToken,
              isSynced: p.tokenStatus === 'Valid'
            }))
          }
        },
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
  db.accounts = [accountData];
  db.connectionState = state;
  saveMockDb(db);
  logInfo(`Saved mock Facebook account ${accountData.name} and ${accountData.pages.length} pages in mock_db.json.`);
  return accountData;
}

export async function disconnectFacebook() {
  const isLive = process.env.LIVE_META_MODE === 'true';
  if (isLive) {
    try {
      await prisma.facebookAccount.deleteMany();
      logInfo('Deleted live Facebook account linkages in PostgreSQL.');
      return true;
    } catch (e) {
      logError(`Prisma delete error, falling back to mock DB: ${e}`);
    }
  }

  // Simulation mode
  const db = loadMockDb();
  db.accounts = [];
  db.connectionState = 'Not Connected';
  saveMockDb(db);
  logInfo('Deleted mock Facebook account linkages in mock_db.json.');
  return true;
}

export async function updateConnectionState(state: MockDbSchema['connectionState']) {
  const db = loadMockDb();
  db.connectionState = state;
  saveMockDb(db);
  return true;
}

export async function updatePagesStatus(pagesStatus: { id: string, tokenStatus: 'Valid' | 'Expired' }[]) {
  const isLive = process.env.LIVE_META_MODE === 'true';
  if (isLive) {
    try {
      for (const status of pagesStatus) {
        await prisma.facebookPage.updateMany({
          where: { facebookPageId: status.id },
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
    db.accounts[0].pages = db.accounts[0].pages.map(p => {
      const match = pagesStatus.find(ps => ps.id === p.id);
      if (match) {
        p.tokenStatus = match.tokenStatus;
      }
      return p;
    });

    if (db.accounts[0].pages.some(p => p.tokenStatus === 'Expired')) {
      db.connectionState = 'Reconnection Required';
    } else {
      db.connectionState = 'Connected';
    }
    saveMockDb(db);
  }
}
