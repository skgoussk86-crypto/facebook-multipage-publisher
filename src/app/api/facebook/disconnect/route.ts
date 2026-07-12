import { NextResponse } from 'next/server';
import { disconnectFacebook } from '@/lib/db';

export async function POST() {
  try {
    await disconnectFacebook();
    return NextResponse.json({ success: true, message: 'Facebook account disconnected successfully.' });
  } catch (error) {
    console.error('Error disconnecting facebook account:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
