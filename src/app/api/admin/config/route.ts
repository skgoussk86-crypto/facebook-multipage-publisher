import { NextRequest, NextResponse } from 'next/server';
import {
  createAuditLog,
  getAppConfiguration,
  saveAppConfiguration
} from '@/lib/db';
import { verifyAdminSession } from '@/lib/auth';
import { encryptToken } from '@/lib/crypto';

const FACEBOOK_SECRET_MASK = '************';

function getRequestIp(request: NextRequest): string | null {
  return (
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    null
  );
}

export async function GET(request: NextRequest) {
  try {
    const user = await verifyAdminSession(request);

    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const configuration = await getAppConfiguration(user.id);

    if (!configuration) {
      return NextResponse.json({
        publicAppUrl: '',
        facebookAppId: '',
        facebookAppSecret: '',
        liveMetaMode: false
      });
    }

    return NextResponse.json({
      publicAppUrl: configuration.publicAppUrl,
      facebookAppId: configuration.facebookAppId,
      facebookAppSecret: FACEBOOK_SECRET_MASK,
      liveMetaMode: configuration.liveMetaMode
    });
  } catch (error) {
    console.error('Error fetching Meta configuration:', error);

    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await verifyAdminSession(request);

    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const body = await request.json();

    const publicAppUrl =
      typeof body?.publicAppUrl === 'string'
        ? body.publicAppUrl.trim()
        : '';

    const facebookAppId =
      typeof body?.facebookAppId === 'string'
        ? body.facebookAppId.trim()
        : '';

    const facebookAppSecret =
      typeof body?.facebookAppSecret === 'string'
        ? body.facebookAppSecret
        : '';

    const liveMetaMode = body?.liveMetaMode === true;

    if (!publicAppUrl) {
      return NextResponse.json(
        { error: 'Public App URL is required' },
        { status: 400 }
      );
    }

    if (!facebookAppId) {
      return NextResponse.json(
        { error: 'Facebook App ID is required' },
        { status: 400 }
      );
    }

    if (facebookAppId.length > 255) {
      return NextResponse.json(
        {
          error:
            'Facebook App ID must not exceed 255 characters'
        },
        { status: 400 }
      );
    }

    let parsedUrl: URL;

    try {
      parsedUrl = new URL(publicAppUrl);
    } catch {
      return NextResponse.json(
        { error: 'Invalid Public App URL format' },
        { status: 400 }
      );
    }

    if (
      parsedUrl.protocol !== 'http:' &&
      parsedUrl.protocol !== 'https:'
    ) {
      return NextResponse.json(
        {
          error:
            'Public App URL must use http:// or https://'
        },
        { status: 400 }
      );
    }

    if (liveMetaMode && parsedUrl.protocol !== 'https:') {
      return NextResponse.json(
        {
          error:
            'Public App URL must use HTTPS in Live Meta Mode'
        },
        { status: 400 }
      );
    }

    if (parsedUrl.username || parsedUrl.password) {
      return NextResponse.json(
        {
          error:
            'Public App URL must not contain embedded credentials'
        },
        { status: 400 }
      );
    }

    const cleanPathname =
      parsedUrl.pathname.replace(/\/+$/, '');

    if (cleanPathname !== '') {
      return NextResponse.json(
        {
          error: `Public App URL must be a base URL without subpaths (found subpath: ${parsedUrl.pathname})`
        },
        { status: 400 }
      );
    }

    if (parsedUrl.search || parsedUrl.hash) {
      return NextResponse.json(
        {
          error:
            'Public App URL must not contain query parameters or fragments'
        },
        { status: 400 }
      );
    }

    const sanitizedUrl = parsedUrl.origin;
    const currentConfiguration =
      await getAppConfiguration(user.id);

    let encryptedSecret: string;

    if (facebookAppSecret === FACEBOOK_SECRET_MASK) {
      if (!currentConfiguration) {
        return NextResponse.json(
          {
            error:
              'Facebook App Secret is required for initial configuration'
          },
          { status: 400 }
        );
      }

      encryptedSecret =
        currentConfiguration.encryptedAppSecret;
    } else {
      const cleanSecret = facebookAppSecret.trim();

      if (!cleanSecret) {
        return NextResponse.json(
          { error: 'Facebook App Secret is required' },
          { status: 400 }
        );
      }

      if (cleanSecret.length > 1000) {
        return NextResponse.json(
          {
            error:
              'Facebook App Secret must not exceed 1000 characters'
          },
          { status: 400 }
        );
      }

      try {
        encryptedSecret = encryptToken(cleanSecret);
      } catch (error: unknown) {
        const message =
          error instanceof Error
            ? error.message
            : String(error);

        return NextResponse.json(
          {
            error: `Encryption failed: ${message}`
          },
          { status: 500 }
        );
      }
    }

    await saveAppConfiguration(user.id, {
      publicAppUrl: sanitizedUrl,
      facebookAppId,
      encryptedAppSecret: encryptedSecret,
      liveMetaMode
    });

    const isNewConfiguration = !currentConfiguration;
    const action = isNewConfiguration
      ? 'CREATE_CONFIG'
      : 'UPDATE_CONFIG';

    const modeLabel = liveMetaMode ? 'Live' : 'Mock';
    const requestIp = getRequestIp(request);

    await createAuditLog(
      action,
      isNewConfiguration
        ? `Created personal Meta configuration (App ID: ${facebookAppId}, Mode: ${modeLabel})`
        : `Updated personal Meta configuration (App ID: ${facebookAppId}, Mode: ${modeLabel})`,
      requestIp,
      user.id
    );

    if (
      currentConfiguration &&
      currentConfiguration.liveMetaMode !== liveMetaMode
    ) {
      await createAuditLog(
        'LIVE_MODE_CHANGE',
        `Live Meta Mode changed from ${currentConfiguration.liveMetaMode} to ${liveMetaMode}`,
        requestIp,
        user.id
      );
    }

    return NextResponse.json({
      success: true,
      config: {
        publicAppUrl: sanitizedUrl,
        facebookAppId,
        facebookAppSecret: FACEBOOK_SECRET_MASK,
        liveMetaMode
      }
    });
  } catch (error) {
    console.error('Error saving Meta configuration:', error);

    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}