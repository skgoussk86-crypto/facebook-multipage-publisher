import { NextRequest, NextResponse } from 'next/server';
import { updatePagesStatus, getFacebookConnection } from '@/lib/db';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const shouldExpire = body.expire === true;

    const { account } = await getFacebookConnection();
    if (!account) {
      return NextResponse.json({ error: 'No connected account to simulate expiry on.' }, { status: 400 });
    }

    const pagesStatus = account.pages.map(p => ({
      id: p.id,
      tokenStatus: shouldExpire ? ('Expired' as const) : ('Valid' as const)
    }));

    await updatePagesStatus(pagesStatus);

    return NextResponse.json({ success: true, expired: shouldExpire });
  } catch (error: unknown) {
    console.error('Error simulating token expiry:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal Server Error';
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
