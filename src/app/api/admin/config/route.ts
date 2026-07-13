import { NextRequest, NextResponse } from 'next/server';
import { getAppConfiguration, saveAppConfiguration, createAuditLog } from '@/lib/db';
import { verifyAdminSession } from '@/lib/auth';
import { encryptToken } from '@/lib/crypto';

export async function GET(request: NextRequest) {
  try {
    const user = await verifyAdminSession(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const config = await getAppConfiguration();
    if (!config) {
      return NextResponse.json({
        publicAppUrl: '',
        facebookAppId: '',
        facebookAppSecret: '',
        liveMetaMode: false
      });
    }

    return NextResponse.json({
      publicAppUrl: config.publicAppUrl,
      facebookAppId: config.facebookAppId,
      facebookAppSecret: '••••••••••••',
      liveMetaMode: config.liveMetaMode
    });
  } catch (error) {
    console.error('Error fetching admin config:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await verifyAdminSession(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { publicAppUrl, facebookAppId, facebookAppSecret, liveMetaMode } = await request.json();

    // 1. Validation
    if (!publicAppUrl || typeof publicAppUrl !== 'string') {
      return NextResponse.json({ error: 'Public App URL is required' }, { status: 400 });
    }
    if (!facebookAppId || typeof facebookAppId !== 'string') {
      return NextResponse.json({ error: 'Facebook App ID is required' }, { status: 400 });
    }
    if (!facebookAppSecret || typeof facebookAppSecret !== 'string') {
      return NextResponse.json({ error: 'Facebook App Secret is required' }, { status: 400 });
    }

    // Sanitize URL: remove trailing slashes
    const sanitizedUrl = publicAppUrl.trim().replace(/\/+$/, '');

    // Validate HTTPS protocol for live mode
    if (liveMetaMode === true) {
      if (!sanitizedUrl.toLowerCase().startsWith('https://')) {
        return NextResponse.json({ error: 'Public App URL must use HTTPS in Live Meta Mode' }, { status: 400 });
      }
    }

    // Try parsing the URL to check validity and reject subpaths (such as /settings or /api)
    try {
      const parsedUrl = new URL(sanitizedUrl);
      const cleanPathname = parsedUrl.pathname.replace(/\/+$/, '');
      if (cleanPathname !== '' && cleanPathname !== '/') {
        return NextResponse.json({ 
          error: `Public App URL must be a base URL without subpaths (found subpath: ${parsedUrl.pathname})` 
        }, { status: 400 });
      }
    } catch {
      return NextResponse.json({ error: 'Invalid Public App URL format' }, { status: 400 });
    }

    // Retrieve current configuration
    const currentConfig = await getAppConfiguration();

    // Determine target encrypted app secret
    let encryptedSecret = '';
    const isSecretMaskedOrEmpty = facebookAppSecret === '••••••••••••' || facebookAppSecret.trim() === '';

    if (isSecretMaskedOrEmpty) {
      if (!currentConfig) {
        return NextResponse.json({ error: 'Facebook App Secret is required for initial configuration' }, { status: 400 });
      }
      encryptedSecret = currentConfig.encryptedAppSecret;
    } else {
      // Encrypt the new secret
      try {
        encryptedSecret = encryptToken(facebookAppSecret);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ error: `Encryption failed: ${errMsg}` }, { status: 500 });
      }
    }

    // Save configuration
    await saveAppConfiguration({
      publicAppUrl: sanitizedUrl,
      facebookAppId: facebookAppId.trim(),
      encryptedAppSecret: encryptedSecret,
      liveMetaMode: !!liveMetaMode
    });

    // Logging & audit entries
    const isNew = !currentConfig;
    const action = isNew ? 'CREATE_CONFIG' : 'UPDATE_CONFIG';
    const modeStr = liveMetaMode ? 'Live' : 'Mock';
    
    await createAuditLog(
      action,
      isNew 
        ? `Created secure Meta configuration (App ID: ${facebookAppId.trim()}, Mode: ${modeStr})`
        : `Updated secure Meta configuration (App ID: ${facebookAppId.trim()}, Mode: ${modeStr})`,
      request.headers.get('x-forwarded-for') || null,
      user.id
    );

    // If live mode changed, log it specifically
    if (currentConfig && currentConfig.liveMetaMode !== !!liveMetaMode) {
      await createAuditLog(
        'LIVE_MODE_CHANGE',
        `Live Meta Mode toggled from ${currentConfig.liveMetaMode} to ${!!liveMetaMode}`,
        request.headers.get('x-forwarded-for') || null,
        user.id
      );
    }

    return NextResponse.json({
      success: true,
      config: {
        publicAppUrl: sanitizedUrl,
        facebookAppId: facebookAppId.trim(),
        facebookAppSecret: '••••••••••••',
        liveMetaMode: !!liveMetaMode
      }
    });
  } catch (error) {
    console.error('Error saving admin config:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
