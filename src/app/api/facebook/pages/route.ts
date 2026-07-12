import { NextResponse } from 'next/server';
import { getFacebookConnection } from '@/lib/db';

export async function GET() {
  try {
    const { account, connectionState } = await getFacebookConnection();
    
    if (!account) {
      return NextResponse.json({
        pages: [],
        connectionState: 'Not Connected',
        facebookUserId: null,
        name: null
      });
    }

    // Explicitly do not return the encrypted user access token or page tokens
    return NextResponse.json({
      pages: account.pages || [],
      connectionState,
      facebookUserId: account.facebookUserId,
      name: account.name
    });
  } catch (error) {
    console.error('Error fetching facebook pages:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
