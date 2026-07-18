import fs from 'fs';
import path from 'path';
import { prisma } from './prisma-client';

const MOCK_DB_PATH = path.join(
  process.cwd(),
  'src/lib/mock_db.json'
);

export interface MockFacebookPage {
  id: string;
  facebookPageId?: string;
  name: string;
  category: string;
  pictureUrl: string;
  tokenStatus: 'Valid' | 'Expired';
  connectedAt: string;
  encryptedPageToken?: string;
}

export interface MockFacebookAccount {
  id: string;
  facebookUserId: string;
  name: string;
  encryptedAccessToken: string;
  tokenExpiresAt: string;
  pages: MockFacebookPage[];
  userId?: string;
  connectionState?: MockDbSchema['connectionState'];
}

export interface MockDbSchema {
  accounts: MockFacebookAccount[];
  connectionState:
    | 'Not Connected'
    | 'Connected'
    | 'Token Expiring'
    | 'Reconnection Required'
    | 'Permission Missing';
}

export interface FacebookAccountUI {
  id: string;
  facebookUserId: string;
  name: string;
  tokenExpiresAt: string;
  connectionState:
    | 'Connected'
    | 'Token Expiring'
    | 'Reconnection Required'
    | 'Permission Missing';
  pages: MockFacebookPage[];
}

function loadMockDb(): MockDbSchema {
  try {
    if (fs.existsSync(MOCK_DB_PATH)) {
      const data = fs.readFileSync(MOCK_DB_PATH, 'utf8');

      return JSON.parse(data) as MockDbSchema;
    }
  } catch (error) {
    console.error(
      'Error loading mock DB, returning default:',
      error
    );
  }

  return {
    accounts: [],
    connectionState: 'Not Connected'
  };
}

function saveMockDb(data: MockDbSchema) {
  try {
    const directory = path.dirname(MOCK_DB_PATH);

    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, {
        recursive: true
      });
    }

    fs.writeFileSync(
      MOCK_DB_PATH,
      JSON.stringify(data, null, 2),
      'utf8'
    );
  } catch (error) {
    console.error('Error saving mock DB:', error);
  }
}

export function sanitizeLog(message: string): string {
  return message.replace(
    /EAA[A-Za-z0-9_-]+/g,
    '[REDACTED_TOKEN]'
  );
}

export function logInfo(message: string) {
  console.log(
    sanitizeLog(`[FB_PUBLISHER] INFO: ${message}`)
  );
}

export function logWarn(message: string) {
  console.warn(
    sanitizeLog(`[FB_PUBLISHER] WARN: ${message}`)
  );
}

export function logError(message: string) {
  console.error(
    sanitizeLog(`[FB_PUBLISHER] ERROR: ${message}`)
  );
}

export async function getFacebookConnections(
  userId?: string
): Promise<FacebookAccountUI[]> {
  if (!userId) {
    logWarn(
      'Blocked Facebook connection lookup without a user ID.'
    );

    return [];
  }

  const isLive = await isLiveMetaMode(userId);

  if (isLive) {
    try {
      const accounts =
        await prisma.facebookAccount.findMany({
          where: {
            userId
          },
          include: {
            pages: {
              orderBy: {
                createdAt: 'asc'
              }
            }
          },
          orderBy: {
            createdAt: 'desc'
          }
        });

      return accounts.map((account) => {
        const now = new Date();

        let connectionState:
          | 'Connected'
          | 'Token Expiring'
          | 'Reconnection Required'
          | 'Permission Missing' = 'Connected';

        if (account.tokenExpiresAt < now) {
          connectionState = 'Reconnection Required';
        } else if (
          account.tokenExpiresAt.getTime() -
            now.getTime() <
          7 * 24 * 60 * 60 * 1000
        ) {
          connectionState = 'Token Expiring';
        } else if (
          account.pages.some((page) => !page.isSynced)
        ) {
          connectionState = 'Reconnection Required';
        }

        const pages: MockFacebookPage[] =
          account.pages.map((page) => ({
            id: page.id,
            facebookPageId: page.facebookPageId,
            name: page.pageName,
            category: page.pageCategory,
            pictureUrl: page.pagePictureUrl,
            tokenStatus: page.isSynced
              ? 'Valid'
              : 'Expired',
            connectedAt: page.createdAt.toISOString()
          }));

        return {
          id: account.id,
          facebookUserId: account.facebookUserId,
          name: account.name,
          tokenExpiresAt:
            account.tokenExpiresAt.toISOString(),
          connectionState,
          pages
        };
      });
    } catch (error) {
      logError(
        `Prisma fetch error in getFacebookConnections: ${String(
          error
        )}`
      );

      return [];
    }
  }

  const database = loadMockDb();

  const filteredAccounts = database.accounts.filter(
    (account) => account.userId === userId
  );

  const resultAccounts: FacebookAccountUI[] = [];
  for (const account of filteredAccounts) {
    const dbAccount = await prisma.facebookAccount.upsert({
      where: {
        userId_facebookUserId: {
          userId: userId!,
          facebookUserId: account.facebookUserId
        }
      },
      update: {
        name: account.name,
        encryptedAccessToken: account.encryptedAccessToken,
        tokenExpiresAt: new Date(account.tokenExpiresAt)
      },
      create: {
        id: account.id,
        userId: userId!,
        facebookUserId: account.facebookUserId,
        name: account.name,
        encryptedAccessToken: account.encryptedAccessToken,
        tokenExpiresAt: new Date(account.tokenExpiresAt)
      }
    });

    const dbPages: MockFacebookPage[] = [];
    for (const page of account.pages) {
      const dbPage = await prisma.facebookPage.upsert({
        where: {
          userId_facebookPageId: {
            userId: userId!,
            facebookPageId: page.id
          }
        },
        update: {
          accountId: dbAccount.id,
          pageName: page.name,
          pageCategory: page.category,
          pagePictureUrl: page.pictureUrl,
          encryptedPageToken: page.encryptedPageToken || "",
          isSynced: page.tokenStatus === 'Valid'
        },
        create: {
          accountId: dbAccount.id,
          userId: userId!,
          facebookPageId: page.id,
          pageName: page.name,
          pageCategory: page.category,
          pagePictureUrl: page.pictureUrl,
          encryptedPageToken: page.encryptedPageToken || "",
          isSynced: page.tokenStatus === 'Valid'
        }
      });

      dbPages.push({
        id: dbPage.id,
        facebookPageId: dbPage.facebookPageId,
        name: dbPage.pageName,
        category: dbPage.pageCategory,
        pictureUrl: dbPage.pagePictureUrl,
        tokenStatus: dbPage.isSynced ? 'Valid' : 'Expired',
        connectedAt: dbPage.createdAt.toISOString()
      });
    }

    resultAccounts.push({
      id: dbAccount.id,
      facebookUserId: dbAccount.facebookUserId,
      name: dbAccount.name,
      tokenExpiresAt: dbAccount.tokenExpiresAt.toISOString(),
      connectionState: (account.connectionState || 'Connected') as FacebookAccountUI['connectionState'],
      pages: dbPages
    });
  }

  return resultAccounts;
}

export async function getFacebookConnection(
  userId?: string
) {
  const connections =
    await getFacebookConnections(userId);

  if (connections.length === 0) {
    return {
      account: null,
      connectionState: 'Not Connected' as const
    };
  }

  return {
    account: connections[0],
    connectionState:
      connections[0].connectionState
  };
}

export async function saveFacebookAccount(
  userId: string,
  accountData: MockFacebookAccount,
  state: MockDbSchema['connectionState']
) {
  if (!userId) {
    throw new Error(
      'A user ID is required to save a Facebook account.'
    );
  }

  const isLive = await isLiveMetaMode(userId);

  if (isLive) {
    try {
      const user = await prisma.user.findUnique({
        where: {
          id: userId
        },
        select: {
          id: true
        }
      });

      if (!user) {
        throw new Error('User not found.');
      }

      const savedAccount =
        await prisma.$transaction(
          async (transaction) => {
            const account =
              await transaction.facebookAccount.upsert(
                {
                  where: {
                    userId_facebookUserId: {
                      userId,
                      facebookUserId:
                        accountData.facebookUserId
                    }
                  },
                  update: {
                    encryptedAccessToken:
                      accountData.encryptedAccessToken,
                    tokenExpiresAt: new Date(
                      accountData.tokenExpiresAt
                    ),
                    name: accountData.name
                  },
                  create: {
                    userId,
                    facebookUserId:
                      accountData.facebookUserId,
                    encryptedAccessToken:
                      accountData.encryptedAccessToken,
                    tokenExpiresAt: new Date(
                      accountData.tokenExpiresAt
                    ),
                    name: accountData.name
                  }
                }
              );

            for (const page of accountData.pages) {
              await transaction.facebookPage.upsert({
                where: {
                  userId_facebookPageId: {
                    userId,
                    facebookPageId: page.id
                  }
                },
                update: {
                  accountId: account.id,
                  pageName: page.name,
                  pageCategory: page.category,
                  pagePictureUrl: page.pictureUrl,
                  encryptedPageToken:
                    page.encryptedPageToken || "",
                  isSynced:
                    page.tokenStatus === 'Valid'
                },
                create: {
                  accountId: account.id,
                  userId,
                  facebookPageId: page.id,
                  pageName: page.name,
                  pageCategory: page.category,
                  pagePictureUrl: page.pictureUrl,
                  encryptedPageToken:
                    page.encryptedPageToken || "",
                  isSynced:
                    page.tokenStatus === 'Valid'
                }
              });
            }

            return transaction.facebookAccount.findUnique(
              {
                where: {
                  id: account.id
                },
                include: {
                  pages: true
                }
              }
            );
          }
        );

      if (!savedAccount) {
        throw new Error(
          'Facebook account was not found after saving.'
        );
      }

      logInfo(
        `Saved live Facebook account ${accountData.name} and ${accountData.pages.length} pages for user ${userId}.`
      );

      return savedAccount;
    } catch (error) {
      logError(
        `Prisma Facebook account write failed for user ${userId}: ${String(
          error
        )}`
      );

      throw error;
    }
  }

  const database = loadMockDb();

  const accountDataWithUser: MockFacebookAccount = {
    ...accountData,
    userId,
    connectionState: state
  };

  const existingAccountIndex =
    database.accounts.findIndex(
      (account) =>
        account.userId === userId &&
        account.facebookUserId ===
          accountData.facebookUserId
    );

  if (existingAccountIndex !== -1) {
    database.accounts[existingAccountIndex] =
      accountDataWithUser;
  } else {
    database.accounts.push(accountDataWithUser);
  }

  database.connectionState = state;

  saveMockDb(database);

  logInfo(
    `Saved mock Facebook account ${accountData.name} and ${accountData.pages.length} pages for user ${userId}.`
  );

  return accountDataWithUser;
}

export async function disconnectFacebook(
  userId: string,
  accountId?: string
) {
  if (!userId) {
    return false;
  }

  const isLive = await isLiveMetaMode(userId);

  if (isLive) {
    try {
      if (accountId) {
        await prisma.facebookAccount.deleteMany({
          where: {
            id: accountId,
            userId
          }
        });

        logInfo(
          `Deleted live Facebook account ${accountId} for user ${userId}.`
        );
      } else {
        await prisma.facebookAccount.deleteMany({
          where: {
            userId
          }
        });

        logInfo(
          `Deleted all live Facebook accounts for user ${userId}.`
        );
      }

      return true;
    } catch (error) {
      logError(
        `Prisma Facebook account delete failed for user ${userId}: ${String(
          error
        )}`
      );

      return false;
    }
  }

  const database = loadMockDb();

  if (accountId) {
    database.accounts = database.accounts.filter(
      (account) =>
        account.id !== accountId ||
        account.userId !== userId
    );

    logInfo(
      `Deleted mock Facebook account ${accountId} for user ${userId}.`
    );
  } else {
    database.accounts = database.accounts.filter(
      (account) => account.userId !== userId
    );

    logInfo(
      `Deleted all mock Facebook accounts for user ${userId}.`
    );
  }

  if (database.accounts.length === 0) {
    database.connectionState = 'Not Connected';
  }

  saveMockDb(database);

  return true;
}

export async function updateConnectionState(
  state: MockDbSchema['connectionState']
) {
  const database = loadMockDb();

  database.connectionState = state;

  saveMockDb(database);

  return true;
}

export async function updatePagesStatus(
  userId: string,
  pagesStatus: Array<{
    id: string;
    tokenStatus: 'Valid' | 'Expired';
  }>
) {
  if (!userId) {
    return false;
  }

  const isLive = await isLiveMetaMode(userId);

  if (isLive) {
    try {
      for (const pageStatus of pagesStatus) {
        await prisma.facebookPage.updateMany({
          where: {
            userId,
            facebookPageId: pageStatus.id
          },
          data: {
            isSynced:
              pageStatus.tokenStatus === 'Valid'
          }
        });
      }

      return true;
    } catch (error) {
      logError(
        `Prisma page status update failed for user ${userId}: ${String(
          error
        )}`
      );

      return false;
    }
  }

  const database = loadMockDb();

  database.accounts = database.accounts.map(
    (account) => {
      if (account.userId !== userId) {
        return account;
      }

      const updatedPages = account.pages.map(
        (page) => {
          const matchingStatus = pagesStatus.find(
            (pageStatus) =>
              pageStatus.id === page.id
          );

          if (!matchingStatus) {
            return page;
          }

          return {
            ...page,
            tokenStatus:
              matchingStatus.tokenStatus
          };
        }
      );

      const hasExpiredPage = updatedPages.some(
        (page) => page.tokenStatus === 'Expired'
      );

      return {
        ...account,
        pages: updatedPages,
        connectionState: hasExpiredPage
          ? 'Reconnection Required'
          : 'Connected'
      };
    }
  );

  saveMockDb(database);

  return true;
}

export async function getAppConfiguration(
  userId?: string
) {
  try {
    if (!userId) {
      return null;
    }

    return await prisma.appConfiguration.findUnique({
      where: {
        userId
      }
    });
  } catch (error) {
    logError(
      `Error reading app configuration for user ${userId}: ${String(
        error
      )}`
    );

    return null;
  }
}

export async function isLiveMetaMode(
  userId?: string
): Promise<boolean> {
  const configuration =
    await getAppConfiguration(userId);

  if (configuration) {
    return configuration.liveMetaMode;
  }

  return process.env.LIVE_META_MODE === 'true';
}

export async function saveAppConfiguration(
  userId: string,
  data: {
    publicAppUrl: string;
    facebookAppId: string;
    encryptedAppSecret: string;
    liveMetaMode: boolean;
  }
) {
  if (!userId) {
    throw new Error(
      'A user ID is required to save Meta configuration.'
    );
  }

  return prisma.appConfiguration.upsert({
    where: {
      userId
    },
    update: data,
    create: {
      id: userId,
      userId,
      ...data
    }
  });
}

export async function createAuditLog(
  action: string,
  details: string,
  ipAddress?: string | null,
  userId?: string | null
) {
  try {
    return await prisma.auditLog.create({
      data: {
        action,
        details,
        ipAddress: ipAddress || null,
        userId: userId || null
      }
    });
  } catch (error) {
    logError(
      `Error creating audit log: ${String(error)}`
    );

    return null;
  }
}

export async function getAuditLogs(
  userId?: string,
  isAdmin?: boolean
) {
  try {
    if (isAdmin) {
      return await prisma.auditLog.findMany({
        orderBy: {
          createdAt: 'desc'
        }
      });
    }

    if (!userId) {
      return [];
    }

    return await prisma.auditLog.findMany({
      where: {
        userId
      },
      orderBy: {
        createdAt: 'desc'
      }
    });
  } catch (error) {
    logError(
      `Error fetching audit logs: ${String(error)}`
    );

    return [];
  }
}

export async function getVideoJobs(userId: string) {
  try {
    return await prisma.videoJob.findMany({
      where: {
        userId
      },
      include: {
        facebookPage: true
      },
      orderBy: {
        createdAt: 'desc'
      }
    });
  } catch (error) {
    logError(`Error fetching video jobs: ${String(error)}`);
    return [];
  }
}

export async function getVideoJob(userId: string, jobId: string) {
  try {
    return await prisma.videoJob.findFirst({
      where: {
        id: jobId,
        userId
      }
    });
  } catch (error) {
    logError(`Error fetching video job ${jobId}: ${String(error)}`);
    return null;
  }
}