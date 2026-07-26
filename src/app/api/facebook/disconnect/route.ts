import {
  NextRequest,
  NextResponse
} from 'next/server';
import {
  createAuditLog,
  disconnectFacebook
} from '@/lib/db';
import { verifyAdminSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma-client';

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

    const rawAccountId =
      request.nextUrl.searchParams.get(
        'accountId'
      );

    const accountId =
      rawAccountId?.trim() || undefined;

    if (
      accountId &&
      accountId.length > 255
    ) {
      return NextResponse.json(
        {
          error:
            'Invalid Facebook account identifier.'
        },
        {
          status: 400
        }
      );
    }

    if (accountId) {
      const exists = await prisma.facebookAccount.findFirst({
        where: {
          id: accountId,
          userId: user.id
        }
      });
      if (!exists) {
        return NextResponse.json(
          { error: 'Facebook account not found.' },
          { status: 404 }
        );
      }
    }

    const disconnected =
      await disconnectFacebook(
        user.id,
        accountId
      );

    if (!disconnected) {
      return NextResponse.json(
        {
          error:
            'Unable to disconnect the Facebook account.'
        },
        {
          status: 500
        }
      );
    }

    await createAuditLog(
      'FACEBOOK_ACCOUNT_DISCONNECT',
      accountId
        ? `Disconnected Facebook account ${accountId} from the current user account.`
        : 'Disconnected all Facebook accounts from the current user account.',
      getRequestIp(request),
      user.id
    );

    return NextResponse.json({
      success: true,
      message: accountId
        ? 'Facebook account disconnected successfully.'
        : 'All Facebook accounts disconnected successfully.'
    });
  } catch {
    console.error('Error disconnecting Facebook account');

    return NextResponse.json(
      {
        error: 'Unable to disconnect the Facebook account.'
      },
      {
        status: 500
      }
    );
  }
}