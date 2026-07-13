import { NextRequest, NextResponse } from 'next/server';
import { getFacebookConnections, getFacebookConnection, getAppConfiguration } from '@/lib/db';
import { verifyAdminSession } from '@/lib/auth';

export async function GET(request: NextRequest) {
  try {
    const user = await verifyAdminSession(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const config = await getAppConfiguration(user.id);
    if (!config) {
      return NextResponse.json({ isConfigured: false });
    }

    const accounts = await getFacebookConnections(user.id) || [];
    const { account, connectionState } = await getFacebookConnection(user.id);
    
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

