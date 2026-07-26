import {
  NextRequest,
  NextResponse
} from 'next/server';
import {
  createAuditLog,
  getFacebookConnections,
  logWarn,
  MockFacebookAccount,
  MockFacebookPage,
  saveFacebookAccount,
  updatePagesStatus,
  resolveAccountSyncContext
} from '@/lib/db';
import { verifyAdminSession } from '@/lib/auth';
import {
  decryptToken,
  encryptToken
} from '@/lib/crypto';
import { prisma } from '@/lib/prisma-client';

interface MetaApiError {
  message?: string;
  code?: number;
}

interface MetaApiErrorPayload {
  error?: MetaApiError;
}

interface MetaPageRecord {
  id?: string;
  name?: string;
  category?: string;
  access_token?: string;
}

interface MetaAccountsResponse
  extends MetaApiErrorPayload {
  data?: MetaPageRecord[];
  paging?: {
    cursors?: {
      after?: string;
    };
    next?: string;
  };
}

interface MetaPictureResponse
  extends MetaApiErrorPayload {
  data?: {
    url?: string;
  };
}

class MetaApiRequestError extends Error {
  readonly code?: number;

  constructor(message: string, code?: number) {
    super(message);
    this.name = 'MetaApiRequestError';
    this.code = code;
  }
}

function getGraphApiVersion(): string {
  const configuredVersion =
    process.env.FACEBOOK_GRAPH_API_VERSION?.trim();

  if (!configuredVersion) {
    return 'v20.0';
  }

  return configuredVersion.startsWith('v')
    ? configuredVersion
    : `v${configuredVersion}`;
}

const GRAPH_API_BASE_URL =
  `https://graph.facebook.com/${getGraphApiVersion()}`;

function getRequestIp(
  request: NextRequest
): string | null {
  return (
    request.headers.get('cf-connecting-ip') ||
    request.headers
      .get('x-forwarded-for')
      ?.split(',')[0]
      ?.trim() ||
    request.headers.get('x-real-ip') ||
    null
  );
}

async function readJson<T>(
  response: Response
): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    return {} as T;
  }
}

function getMetaErrorMessage(
  payload: MetaApiErrorPayload,
  fallback: string
): string {
  return payload.error?.message || fallback;
}

async function fetchAllFacebookPages(
  userAccessToken: string
): Promise<MetaPageRecord[]> {
  const pages: MetaPageRecord[] = [];
  const seenCursors = new Set<string>();

  let afterCursor: string | undefined;

  for (
    let requestNumber = 0;
    requestNumber < 20;
    requestNumber += 1
  ) {
    const url = new URL(
      `${GRAPH_API_BASE_URL}/me/accounts`
    );

    url.searchParams.set(
      'fields',
      'id,name,category,access_token'
    );
    url.searchParams.set('limit', '100');

    if (afterCursor) {
      url.searchParams.set(
        'after',
        afterCursor
      );
    }

    const response = await fetch(url, {
      headers: {
        Authorization:
          `Bearer ${userAccessToken}`
      },
      cache: 'no-store'
    });

    const payload =
      await readJson<MetaAccountsResponse>(
        response
      );

    if (!response.ok || payload.error) {
      throw new MetaApiRequestError(
        getMetaErrorMessage(
          payload,
          'Unable to retrieve Facebook Pages.'
        ),
        payload.error?.code
      );
    }

    if (Array.isArray(payload.data)) {
      pages.push(...payload.data);
    }

    const nextCursor =
      payload.paging?.next
        ? payload.paging.cursors?.after
        : undefined;

    if (
      !nextCursor ||
      seenCursors.has(nextCursor)
    ) {
      break;
    }

    seenCursors.add(nextCursor);
    afterCursor = nextCursor;
  }

  return pages;
}

async function fetchPagePictureUrl(
  pageId: string,
  pageName: string,
  pageAccessToken: string
): Promise<string> {
  const fallbackUrl =
    `https://api.dicebear.com/7.x/identicon/svg?seed=${encodeURIComponent(
      pageName || pageId
    )}`;

  try {
    const url = new URL(
      `${GRAPH_API_BASE_URL}/${encodeURIComponent(
        pageId
      )}/picture`
    );

    url.searchParams.set('redirect', '0');
    url.searchParams.set('type', 'normal');

    const response = await fetch(url, {
      headers: {
        Authorization:
          `Bearer ${pageAccessToken}`
      },
      cache: 'no-store'
    });

    const payload =
      await readJson<MetaPictureResponse>(
        response
      );

    if (
      response.ok &&
      typeof payload.data?.url === 'string' &&
      payload.data.url.trim()
    ) {
      return payload.data.url;
    }
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    logWarn(
      `Facebook Page picture retrieval failed for page ${pageId}: ${message}`
    );
  }

  return fallbackUrl;
}

export async function POST(
  request: NextRequest
) {
  try {
    const user =
      await verifyAdminSession(request);

    if (!user) {
      return NextResponse.json(
        {
          error: 'Unauthorized'
        },
        {
          status: 401
        }
      );
    }

    const accountId =
      request.nextUrl.searchParams.get(
        'accountId'
      );

    const accounts =
      await getFacebookConnections(user.id);

    if (!accountId && accounts.length === 0) {
      return NextResponse.json(
        {
          error:
            'No Facebook accounts are connected to your user account.'
        },
        {
          status: 400
        }
      );
    }

    const targetAccount = accountId
      ? accounts.find(
          (account) =>
            account.id === accountId
        )
      : accounts[0];

    if (!targetAccount) {
      return NextResponse.json(
        {
          error:
            'The requested Facebook account was not found in your account.'
        },
        {
          status: 404
        }
      );
    }

    const syncContext = await resolveAccountSyncContext(user.id, targetAccount.id);

    if ('error' in syncContext) {
      return NextResponse.json(
        {
          error: syncContext.error
        },
        {
          status: syncContext.status
        }
      );
    }

    const { databaseAccount, liveMetaMode } = syncContext;

    if (!liveMetaMode) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 800);
      });

      return NextResponse.json({
        pages: targetAccount.pages ?? [],
        connectionState:
          targetAccount.connectionState
      });
    }

    const longUserToken = decryptToken(
      databaseAccount.encryptedAccessToken
    );

    let rawPages: MetaPageRecord[];

    try {
      rawPages =
        await fetchAllFacebookPages(
          longUserToken
        );
    } catch (error: unknown) {
      const isMetaError =
        error instanceof MetaApiRequestError;

      if (
        isMetaError &&
        error.code === 190
      ) {
        const expiredPages =
          targetAccount.pages.map((page) => ({
            id: page.id,
            tokenStatus: 'Expired' as const
          }));

        await updatePagesStatus(
          user.id,
          expiredPages,
          databaseAccount.id
        );
      }

      const message =
        error instanceof Error
          ? error.message
          : 'Facebook Page synchronization failed.';

      await createAuditLog(
        'FACEBOOK_PAGE_SYNC_FAILED',
        `Facebook Page synchronization failed for account ${databaseAccount.facebookUserId}: ${message}`,
        getRequestIp(request),
        user.id
      );

      return NextResponse.json(
        {
          error: `Meta API Error: ${message}`
        },
        {
          status: 400
        }
      );
    }

    const updatedPages: MockFacebookPage[] =
      [];

    for (const page of rawPages) {
      const pageId = page.id?.trim();
      const pageName = page.name?.trim();
      const pageAccessToken =
        page.access_token?.trim();

      if (
        !pageId ||
        !pageName ||
        !pageAccessToken
      ) {
        logWarn(
          'Skipped a Facebook Page during sync because its ID, name or access token was missing.'
        );

        continue;
      }

      const pictureUrl =
        await fetchPagePictureUrl(
          pageId,
          pageName,
          pageAccessToken
        );

      updatedPages.push({
        id: pageId,
        name: pageName,
        category:
          page.category?.trim() ||
          'Business Page',
        pictureUrl,
        tokenStatus: 'Valid',
        connectedAt:
          new Date().toISOString(),
        encryptedPageToken:
          encryptToken(pageAccessToken)
      });
    }

    const accountToSave: MockFacebookAccount =
      {
        id: databaseAccount.id,
        facebookUserId:
          databaseAccount.facebookUserId,
        name: databaseAccount.name,
        encryptedAccessToken:
          databaseAccount.encryptedAccessToken,
        tokenExpiresAt:
          databaseAccount.tokenExpiresAt.toISOString(),
        pages: updatedPages,
        userId: user.id
      };

    await saveFacebookAccount(
      user.id,
      accountToSave,
      updatedPages.length > 0
        ? 'Connected'
        : 'Permission Missing',
      databaseAccount.appConfigurationId
    );

    const synchronizedPageIds =
      updatedPages.map((page) => page.id);

    if (synchronizedPageIds.length > 0) {
      await prisma.facebookPage.updateMany({
        where: {
          userId: user.id,
          accountId:
            databaseAccount.id,
          facebookPageId: {
            notIn: synchronizedPageIds
          }
        },
        data: {
          isSynced: false
        }
      });
    } else {
      await prisma.facebookPage.updateMany({
        where: {
          userId: user.id,
          accountId:
            databaseAccount.id
        },
        data: {
          isSynced: false
        }
      });
    }

    const connectionState =
      updatedPages.length > 0
        ? 'Connected'
        : 'Permission Missing';

    await createAuditLog(
      'FACEBOOK_PAGE_SYNC',
      `Synchronized ${updatedPages.length} Facebook Pages for Facebook account ${databaseAccount.facebookUserId}.`,
      getRequestIp(request),
      user.id
    );

    return NextResponse.json({
      pages: updatedPages.map((page) => ({
        id: page.id,
        name: page.name,
        category: page.category,
        pictureUrl: page.pictureUrl,
        tokenStatus: page.tokenStatus,
        connectedAt: page.connectedAt
      })),
      connectionState
    });
  } catch {
    console.error('Facebook Pages Sync Error');

    return NextResponse.json(
      {
        error: 'Unable to synchronize Facebook Pages.'
      },
      {
        status: 500
      }
    );
  }
}