import { NextRequest, NextResponse } from 'next/server';
import { disconnectFacebook } from '@/lib/db';
import { verifyAdminSession } from '@/lib/auth';

export async function POST(request: NextRequest) {
  try {
    const user = await verifyAdminSession(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const searchParams = request.nextUrl.searchParams;
    const accountId = searchParams.get('accountId') || undefined;

    await disconnectFacebook(user.id, accountId);
    return NextResponse.json({ success: true, message: 'Facebook account disconnected successfully.' });
  } catch (error) {
    console.error('Error disconnecting facebook account:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
