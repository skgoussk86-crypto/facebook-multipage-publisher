import fs from 'fs';
import path from 'path';
import { prisma } from './prisma-client';

const MOCK_DB_PATH = (
  process.env.NODE_ENV === 'test' && process.env.FB_PUBLISHER_TEST_MOCK_DB_PATH
) ? process.env.FB_PUBLISHER_TEST_MOCK_DB_PATH : path.join(
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
  appConfigurationId?: string;
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
  appConfigurationId?: string;
  configurationName?: string;
  facebookAppId?: string;
  liveMetaMode?: boolean;
  isDefault?: boolean;
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

  try {
    // 1. Load user's default configuration if it exists
    const userDefaultConfig = await getAppConfiguration(userId);

    // 2. Load mock accounts from JSON database
    const database = loadMockDb();
    const mockAccountsForUser = database.accounts.filter(
      (account) => account.userId === userId
    );

    // 3. Synchronize mock accounts if their config is mock mode
    for (const account of mockAccountsForUser) {
      const configId = account.appConfigurationId || userDefaultConfig?.id;
      if (!configId) {
        logWarn(`Skipped syncing mock record ${account.facebookUserId} for user ${userId} because no configuration ID was found or resolved.`);
        continue;
      }

      const config = await getAppConfiguration(userId, configId);
      if (!config) {
        logWarn(`Skipped syncing mock record ${account.facebookUserId} for user ${userId} because AppConfiguration ${configId} does not exist or is disabled.`);
        continue;
      }

      if (!config.liveMetaMode) {
        const dbAccount = await prisma.facebookAccount.upsert({
          where: {
            appConfigurationId_facebookUserId: {
              appConfigurationId: config.id,
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
            userId: userId,
            appConfigurationId: config.id,
            facebookUserId: account.facebookUserId,
            name: account.name,
            encryptedAccessToken: account.encryptedAccessToken,
            tokenExpiresAt: new Date(account.tokenExpiresAt)
          }
        });

        for (const page of account.pages) {
          await prisma.facebookPage.upsert({
            where: {
              accountId_facebookPageId: {
                accountId: dbAccount.id,
                facebookPageId: page.id
              }
            },
            update: {
              pageName: page.name,
              pageCategory: page.category,
              pagePictureUrl: page.pictureUrl,
              encryptedPageToken: page.encryptedPageToken || "",
              isSynced: page.tokenStatus === 'Valid'
            },
            create: {
              accountId: dbAccount.id,
              userId: userId,
              facebookPageId: page.id,
              pageName: page.name,
              pageCategory: page.category,
              pagePictureUrl: page.pictureUrl,
              encryptedPageToken: page.encryptedPageToken || "",
              isSynced: page.tokenStatus === 'Valid'
            }
          });
        }
      }
    }

    // 4. Query Prisma for all FacebookAccount records owned by the user
    const dbAccounts = await prisma.facebookAccount.findMany({
      where: {
        userId
      },
      include: {
        pages: {
          orderBy: {
            createdAt: 'asc'
          }
        },
        appConfiguration: true
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    // 5. Return all accounts mapped to UI structure (without exposing secrets and with app id masked)
    return dbAccounts.map((account) => {
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

      const pages = account.pages.map((page) => ({
        id: page.id,
        facebookPageId: page.facebookPageId,
        name: page.pageName,
        category: page.pageCategory,
        pictureUrl: page.pagePictureUrl,
        tokenStatus: (page.isSynced
          ? 'Valid'
          : 'Expired') as 'Valid' | 'Expired',
        connectedAt: page.createdAt.toISOString()
      }));

      const appConfig = account.appConfiguration;
      const maskedAppId = appConfig
        ? (appConfig.facebookAppId.length > 4
            ? '*'.repeat(appConfig.facebookAppId.length - 4) + appConfig.facebookAppId.slice(-4)
            : appConfig.facebookAppId)
        : undefined;

      return {
        id: account.id,
        facebookUserId: account.facebookUserId,
        name: account.name,
        tokenExpiresAt: account.tokenExpiresAt.toISOString(),
        connectionState,
        pages,
        appConfigurationId: appConfig?.id,
        configurationName: appConfig?.configurationName,
        facebookAppId: maskedAppId,
        liveMetaMode: appConfig?.liveMetaMode,
        isDefault: appConfig?.isDefault
      };
    });
  } catch (error) {
    logError(
      `Prisma fetch error in getFacebookConnections: ${String(error)}`
    );

    return [];
  }
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
  state: MockDbSchema['connectionState'],
  appConfigurationId?: string
) {
  if (!userId) {
    throw new Error(
      'A user ID is required to save a Facebook account.'
    );
  }

  // Resolve the selected owned and enabled configuration
  const config = await getAppConfiguration(userId, appConfigurationId);
  if (!config) {
    throw new Error('No valid, enabled AppConfiguration resolved.');
  }

  const isLive = config.liveMetaMode;

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
                    appConfigurationId_facebookUserId: {
                      appConfigurationId: config.id,
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
                    appConfigurationId: config.id,
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
                  accountId_facebookPageId: {
                    accountId: account.id,
                    facebookPageId: page.id
                  }
                },
                update: {
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
    connectionState: state,
    appConfigurationId: config.id
  };

  const existingAccountIndex =
    database.accounts.findIndex(
      (account) =>
        account.userId === userId &&
        account.appConfigurationId === config.id &&
        account.facebookUserId ===
          accountData.facebookUserId
    );

  if (existingAccountIndex !== -1) {
    const existing = database.accounts[existingAccountIndex];
    database.accounts[existingAccountIndex] = {
      ...accountDataWithUser,
      id: existing.id
    };
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

  try {
    if (accountId) {
      // 1. Verify account ownership and load the Prisma account details
      const account = await prisma.facebookAccount.findFirst({
        where: { id: accountId, userId }
      });
      if (!account) {
        logWarn(`Account ${accountId} not found or not owned by user ${userId} for disconnect.`);
        return false;
      }

      // Preserve details before deleting
      const preservedId = account.id;
      const preservedUserId = account.userId;
      const preservedAppConfigId = account.appConfigurationId;
      const preservedFacebookUserId = account.facebookUserId;

      // 2. Delete only that owned Prisma account
      await prisma.facebookAccount.delete({
        where: { id: accountId }
      });

      // 3. Remove the mock record using configuration + Facebook identity or raw matching ID
      const database = loadMockDb();
      database.accounts = database.accounts.filter((acc) => {
        const matchesId =
          acc.userId === preservedUserId &&
          acc.id === preservedId;
        const matchesIdentity =
          acc.userId === preservedUserId &&
          acc.appConfigurationId === preservedAppConfigId &&
          acc.facebookUserId === preservedFacebookUserId;

        return !(matchesId || matchesIdentity);
      });

      if (database.accounts.length === 0) {
        database.connectionState = 'Not Connected';
      }
      saveMockDb(database);

      logInfo(`Deleted Facebook account ${accountId} for user ${userId}.`);
      return true;
    } else {
      // Legacy "disconnect all": delete all accounts strictly scoped to user ID in both stores
      await prisma.facebookAccount.deleteMany({
        where: { userId }
      });

      const database = loadMockDb();
      database.accounts = database.accounts.filter(
        (acc) => acc.userId !== userId
      );
      database.connectionState = 'Not Connected';
      saveMockDb(database);

      logInfo(`Deleted all Facebook accounts for user ${userId}.`);
      return true;
    }
  } catch (error) {
    logError(
      `Facebook disconnect failed for user ${userId}: ${String(error)}`
    );
    return false;
  }
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
  }>,
  accountId: string
) {
  if (!userId || !accountId) {
    logWarn('Blocked updatePagesStatus call because userId or accountId was missing.');
    return false;
  }

  try {
    // Load and verify the owned FacebookAccount
    const dbAccount = await prisma.facebookAccount.findFirst({
      where: {
        id: accountId,
        userId
      }
    });

    if (!dbAccount) {
      logWarn(`Facebook account ${accountId} not found or not owned by user ${userId} for status update.`);
      return false;
    }

    const targetAppConfigId = dbAccount.appConfigurationId;
    const targetFacebookUserId = dbAccount.facebookUserId;

    // 1. Update Prisma records strictly scoped to this account
    for (const pageStatus of pagesStatus) {
      await prisma.facebookPage.updateMany({
        where: {
          userId,
          accountId,
          facebookPageId: pageStatus.id
        },
        data: {
          isSynced: pageStatus.tokenStatus === 'Valid'
        }
      });
    }

    // 2. Update mock account (in mock_db.json) using stable identity + raw ID fallback
    const database = loadMockDb();
    database.accounts = database.accounts.map((account) => {
      const matchesIdentity =
        account.userId === userId &&
        account.appConfigurationId === targetAppConfigId &&
        account.facebookUserId === targetFacebookUserId;
      const matchesRawId =
        account.userId === userId &&
        account.id === accountId;

      if (!matchesIdentity && !matchesRawId) {
        return account;
      }

      const updatedPages = account.pages.map((page) => {
        // Match the page in pagesStatus (by page.id or page.facebookPageId)
        const matchingStatus = pagesStatus.find(
          (status) => status.id === page.id || status.id === page.facebookPageId
        );

        if (!matchingStatus) {
          return page;
        }

        return {
          ...page,
          tokenStatus: matchingStatus.tokenStatus
        };
      });

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
    });

    saveMockDb(database);
    return true;
  } catch (error) {
    logError(`updatePagesStatus failed for user ${userId}: ${String(error)}`);
    return false;
  }
}

export async function getAppConfigurations(userId: string) {
  if (!userId) {
    return [];
  }
  return await prisma.appConfiguration.findMany({
    where: { userId },
    orderBy: [
      { isDefault: 'desc' },
      { createdAt: 'asc' }
    ]
  });
}

export async function getAppConfigurationById(userId: string, configurationId: string) {
  if (!userId || !configurationId) {
    return null;
  }
  return await prisma.appConfiguration.findFirst({
    where: {
      id: configurationId,
      userId
    }
  });
}

export async function getAppConfiguration(
  userId?: string,
  configurationId?: string
) {
  try {
    if (!userId) {
      return null;
    }

    if (configurationId) {
      return await prisma.appConfiguration.findFirst({
        where: {
          id: configurationId,
          userId,
          isEnabled: true
        }
      });
    }

    // Otherwise return the user's enabled default configuration
    const defaultConf = await prisma.appConfiguration.findFirst({
      where: {
        userId,
        isDefault: true,
        isEnabled: true
      }
    });

    if (defaultConf) {
      return defaultConf;
    }

    // If no default exists, return the oldest enabled configuration
    return await prisma.appConfiguration.findFirst({
      where: {
        userId,
        isEnabled: true
      },
      orderBy: {
        createdAt: 'asc'
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

export async function resolveAccountSyncContext(
  userId: string,
  targetAccountId: string
) {
  if (!userId || !targetAccountId) {
    return { error: 'Invalid parameters', status: 400 };
  }

  const databaseAccount = await prisma.facebookAccount.findFirst({
    where: {
      id: targetAccountId,
      userId
    },
    include: {
      appConfiguration: true
    }
  });

  if (!databaseAccount) {
    return {
      error: 'The Facebook account does not exist or is not owned by your user account.',
      status: 404
    };
  }

  const config = databaseAccount.appConfiguration;
  if (!config) {
    return {
      error: 'The Facebook account configuration is missing.',
      status: 400
    };
  }

  if (config.userId !== userId) {
    return {
      error: 'The Facebook account configuration is not owned by your user account.',
      status: 400
    };
  }

  if (databaseAccount.appConfigurationId !== config.id) {
    return {
      error: 'The Facebook account configuration relation is mismatched.',
      status: 400
    };
  }

  if (config.isEnabled !== true) {
    return {
      error: 'The Facebook account configuration is disabled.',
      status: 400
    };
  }

  return {
    databaseAccount,
    liveMetaMode: config.liveMetaMode
  };
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

  const defaultAppConfig = await prisma.appConfiguration.findFirst({
    where: { userId, isDefault: true }
  });

  if (defaultAppConfig) {
    return await prisma.appConfiguration.update({
      where: { id: defaultAppConfig.id },
      data
    });
  } else {
    // Check if any configuration exists for the user
    const firstAppConfig = await prisma.appConfiguration.findFirst({
      where: { userId }
    });

    if (firstAppConfig) {
      return await prisma.appConfiguration.update({
        where: { id: firstAppConfig.id },
        data: {
          ...data,
          isDefault: true,
          isEnabled: true
        }
      });
    } else {
      // None exists, create the first one
      return await prisma.appConfiguration.create({
        data: {
          userId,
          configurationName: 'Default Meta App',
          isDefault: true,
          isEnabled: true,
          ...data
        }
      });
    }
  }
}

export async function createAppConfiguration(
  userId: string,
  data: {
    configurationName: string;
    publicAppUrl: string;
    facebookAppId: string;
    encryptedAppSecret: string;
    liveMetaMode: boolean;
    isDefault?: boolean;
    isEnabled?: boolean;
  }
) {
  if (!userId) {
    throw new Error('A user ID is required to create a configuration.');
  }

  const isDefault = data.isDefault === true;
  const isEnabled = data.isEnabled !== false;

  if (isDefault && !isEnabled) {
    throw new Error('A default configuration must always be enabled.');
  }

  return await prisma.$transaction(async (tx) => {
    if (isDefault) {
      await tx.appConfiguration.updateMany({
        where: { userId },
        data: { isDefault: false }
      });
    }

    const config = await tx.appConfiguration.create({
      data: {
        userId,
        configurationName: data.configurationName,
        publicAppUrl: data.publicAppUrl,
        facebookAppId: data.facebookAppId,
        encryptedAppSecret: data.encryptedAppSecret,
        liveMetaMode: data.liveMetaMode,
        isDefault,
        isEnabled
      }
    });

    // Preserve exactly one enabled default whenever the user has enabled configurations
    const activeDefault = await tx.appConfiguration.findFirst({
      where: { userId, isDefault: true, isEnabled: true }
    });

    if (!activeDefault) {
      const oldestEnabled = await tx.appConfiguration.findFirst({
        where: { userId, isEnabled: true },
        orderBy: { createdAt: 'asc' }
      });
      if (oldestEnabled) {
        await tx.appConfiguration.update({
          where: { id: oldestEnabled.id },
          data: { isDefault: true }
        });
      }
    }

    return config;
  });
}

export async function updateAppConfiguration(
  userId: string,
  configurationId: string,
  data: {
    configurationName?: string;
    publicAppUrl?: string;
    facebookAppId?: string;
    encryptedAppSecret?: string;
    liveMetaMode?: boolean;
    isDefault?: boolean;
    isEnabled?: boolean;
  }
) {
  if (!userId || !configurationId) {
    throw new Error('User ID and Configuration ID are required.');
  }

  return await prisma.$transaction(async (tx) => {
    const existing = await tx.appConfiguration.findFirst({
      where: { id: configurationId, userId }
    });

    if (!existing) {
      throw new Error('App configuration not found or not owned by user.');
    }

    const proposedDefault = data.isDefault !== undefined ? data.isDefault : existing.isDefault;
    const proposedEnabled = data.isEnabled !== undefined ? data.isEnabled : existing.isEnabled;

    // 1. A default configuration must always be enabled.
    if (proposedDefault && !proposedEnabled) {
      throw new Error('A default configuration must always be enabled.');
    }

    // 2. A current default cannot be disabled or demoted directly.
    if (existing.isDefault && !proposedEnabled) {
      throw new Error('Cannot disable the default configuration without promoting another enabled configuration first.');
    }
    if (existing.isDefault && data.isDefault === false) {
      throw new Error('Cannot remove default status. Use setDefaultAppConfiguration on another configuration to promote it.');
    }

    // 3. Handle default promotion: if setting this one to default, set others to false
    if (proposedDefault && !existing.isDefault) {
      await tx.appConfiguration.updateMany({
        where: { userId },
        data: { isDefault: false }
      });
    }

    // 4. Update the configuration
    const updated = await tx.appConfiguration.update({
      where: { id: configurationId },
      data: {
        ...data,
        isDefault: proposedDefault,
        isEnabled: proposedEnabled
      }
    });

    // 5. Preserve exactly one enabled default whenever the user has enabled configurations.
    const activeDefault = await tx.appConfiguration.findFirst({
      where: { userId, isDefault: true, isEnabled: true }
    });

    if (!activeDefault) {
      const oldestEnabled = await tx.appConfiguration.findFirst({
        where: { userId, isEnabled: true },
        orderBy: { createdAt: 'asc' }
      });
      if (oldestEnabled) {
        await tx.appConfiguration.update({
          where: { id: oldestEnabled.id },
          data: { isDefault: true }
        });
      }
    }

    return updated;
  });
}

export async function setDefaultAppConfiguration(
  userId: string,
  configurationId: string
) {
  if (!userId || !configurationId) {
    throw new Error('User ID and Configuration ID are required.');
  }

  return await prisma.$transaction(async (tx) => {
    const config = await tx.appConfiguration.findFirst({
      where: { id: configurationId, userId, isEnabled: true }
    });

    if (!config) {
      throw new Error('Enabled app configuration not found or not owned by user.');
    }

    await tx.appConfiguration.updateMany({
      where: { userId },
      data: { isDefault: false }
    });

    return await tx.appConfiguration.update({
      where: { id: configurationId },
      data: { isDefault: true }
    });
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
        facebookPage: true,
        uploadAsset: {
          select: {
            originalName: true,
          },
        },
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