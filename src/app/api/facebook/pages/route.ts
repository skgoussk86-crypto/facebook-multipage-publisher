import {
  NextRequest,
  NextResponse
} from 'next/server';
import {
  getAppConfiguration,
  getFacebookConnections
} from '@/lib/db';
import { verifyAdminSession } from '@/lib/auth';

export async function GET(request: NextRequest) {
  try {
    const user = await verifyAdminSession(request);

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

    const configuration =
      await getAppConfiguration(user.id);

    if (!configuration) {
      return NextResponse.json({
        isConfigured: false,
        publicAppUrl: null,
        facebookAppId: null,
        liveMetaMode: false,
        accounts: [],
        pages: [],
        connectionState: 'Not Connected',
        facebookUserId: null,
        name: null
      });
    }

    const accounts =
      await getFacebookConnections(user.id);

    const primaryAccount = accounts[0] ?? null;

    return NextResponse.json({
      isConfigured: true,
      publicAppUrl:
        configuration.publicAppUrl,
      facebookAppId:
        configuration.facebookAppId,
      liveMetaMode:
        configuration.liveMetaMode,
      accounts,
      pages: primaryAccount?.pages ?? [],
      connectionState:
        primaryAccount?.connectionState ??
        'Not Connected',
      facebookUserId:
        primaryAccount?.facebookUserId ?? null,
      name: primaryAccount?.name ?? null
    });
  } catch (error) {
    console.error(
      'Error fetching Facebook pages:',
      error
    );

    return NextResponse.json(
      {
        error: 'Internal Server Error'
      },
      {
        status: 500
      }
    );
  }
}