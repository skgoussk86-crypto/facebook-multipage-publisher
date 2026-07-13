import { NextResponse } from 'next/server';
import { getFacebookConnections, getFacebookConnection, getAppConfiguration } from '@/lib/db';

export async function GET() {
  try {
    const config = await getAppConfiguration();
    if (!config) {
      return NextResponse.json({ isConfigured: false });
    }

    const accounts = await getFacebookConnections() || [];
    const { account, connectionState } = await getFacebookConnection();
    
    return NextResponse.json({
      isConfigured: true,
      publicAppUrl: config.publicAppUrl,
      facebookAppId: config.facebookAppId,
      liveMetaMode: config.liveMetaMode,
      accounts,
      pages: account?.pages || [],
      connectionState: connectionState || 'Not Connected',
      facebookUserId: account?.facebookUserId || null,
      name: account?.name || null
    });
  } catch (error) {
    console.error('Error fetching facebook pages:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

