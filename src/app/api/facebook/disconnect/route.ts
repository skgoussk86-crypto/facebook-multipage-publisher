import { NextRequest, NextResponse } from 'next/server';
import { disconnectFacebook } from '@/lib/db';

export async function POST(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const accountId = searchParams.get('accountId') || undefined;

    await disconnectFacebook(accountId);
    return NextResponse.json({ success: true, message: 'Facebook account disconnected successfully.' });
  } catch (error) {
    console.error('Error disconnecting facebook account:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
