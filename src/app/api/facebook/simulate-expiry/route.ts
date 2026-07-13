import { NextRequest, NextResponse } from 'next/server';
import { updatePagesStatus, getFacebookConnections } from '@/lib/db';
import { verifyAdminSession } from '@/lib/auth';

export async function POST(request: NextRequest) {
  try {
    const user = await verifyAdminSession(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const shouldExpire = body.expire === true;
    const accountId = body.accountId;

    const accounts = await getFacebookConnections(user.id) || [];
    if (accounts.length === 0) {
      return NextResponse.json({ error: 'No connected accounts to simulate expiry on.' }, { status: 400 });
    }

    let targetAccounts = accounts;
    if (accountId) {
      const match = accounts.find(acc => acc.id === accountId);
      if (match) {
        targetAccounts = [match];
      } else {
        return NextResponse.json({ error: `Facebook account with ID ${accountId} not found.` }, { status: 400 });
      }
    }

    let allPagesStatus: { id: string, tokenStatus: 'Valid' | 'Expired' }[] = [];
    for (const acc of targetAccounts) {
      const pagesStatus = acc.pages.map(p => ({
        id: p.id,
        tokenStatus: shouldExpire ? ('Expired' as const) : ('Valid' as const)
      }));
      allPagesStatus = [...allPagesStatus, ...pagesStatus];
    }

    await updatePagesStatus(user.id, allPagesStatus);

    return NextResponse.json({ success: true, expired: shouldExpire });
  } catch (error: unknown) {
    console.error('Error simulating token expiry:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal Server Error';
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
