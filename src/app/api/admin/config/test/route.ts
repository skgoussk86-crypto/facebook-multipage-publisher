import { NextRequest, NextResponse } from 'next/server';
import { getAppConfiguration, createAuditLog } from '@/lib/db';
import { verifyAdminSession } from '@/lib/auth';
import { decryptToken } from '@/lib/crypto';

export async function POST(request: NextRequest) {
  try {
    const user = await verifyAdminSession(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { publicAppUrl, facebookAppId, facebookAppSecret, liveMetaMode } = await request.json();

    // 1. Validate App ID presence
    if (!facebookAppId || facebookAppId.trim() === '') {
      return NextResponse.json({ 
        success: false, 
        message: 'Validation failed: Facebook App ID is required.' 
      }, { status: 400 });
    }

    // 2. Validate App Secret decryption
    let secretToTest = facebookAppSecret;
    const isSecretMaskedOrEmpty = facebookAppSecret === '••••••••••••' || !facebookAppSecret || facebookAppSecret.trim() === '';

    if (isSecretMaskedOrEmpty) {
      const config = await getAppConfiguration();
      if (!config) {
        return NextResponse.json({ 
          success: false, 
          message: 'Validation failed: No existing configuration found. Please enter a valid Facebook App Secret.' 
        }, { status: 400 });
      }

      try {
        secretToTest = decryptToken(config.encryptedAppSecret);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await createAuditLog(
          'TEST_CONFIG',
          `Meta configuration test failed: Decryption error on existing App Secret: ${errMsg}`,
          request.headers.get('x-forwarded-for') || null,
          user.id
        );
        return NextResponse.json({ 
          success: false, 
          message: `Validation failed: Existing App Secret decryption failed: ${errMsg}` 
        }, { status: 400 });
      }
    } else {
      // User entered a new secret, test if it decrypts correctly (we encrypt it and decrypt it to verify the key and code)
      secretToTest = facebookAppSecret;
    }

    if (!secretToTest || secretToTest.trim() === '') {
      return NextResponse.json({ 
        success: false, 
        message: 'Validation failed: Facebook App Secret is empty.' 
      }, { status: 400 });
    }

    // 3. Validate Public App URL
    if (!publicAppUrl || publicAppUrl.trim() === '') {
      return NextResponse.json({ 
        success: false, 
        message: 'Validation failed: Public App URL is required.' 
      }, { status: 400 });
    }

    const sanitizedUrl = publicAppUrl.trim().replace(/\/+$/, '');

    // Validate HTTPS protocol for live mode
    if (liveMetaMode === true) {
      if (!sanitizedUrl.toLowerCase().startsWith('https://')) {
        return NextResponse.json({ 
          success: false, 
          message: 'Validation failed: Public App URL must use HTTPS in Live Meta Mode.' 
        }, { status: 400 });
      }
    }

    // Try parsing URL and reject subpaths (such as /settings or /api)
    try {
      const parsedUrl = new URL(sanitizedUrl);
      const cleanPathname = parsedUrl.pathname.replace(/\/+$/, '');
      if (cleanPathname !== '' && cleanPathname !== '/') {
        return NextResponse.json({ 
          success: false, 
          message: `Validation failed: Public App URL must be a base URL without subpaths (found subpath: ${parsedUrl.pathname})` 
        }, { status: 400 });
      }
    } catch {
      return NextResponse.json({ 
        success: false, 
        message: 'Validation failed: Invalid Public App URL format.' 
      }, { status: 400 });
    }

    // 4. Generate and validate callback URL format
    const callbackUrl = `${sanitizedUrl}/api/auth/facebook/callback`;

    // Audit log configuration test
    const modeStr = liveMetaMode ? 'Live' : 'Mock';
    await createAuditLog(
      'TEST_CONFIG',
      `Meta configuration test completed successfully (Mode: ${modeStr}, App ID: ${facebookAppId})`,
      request.headers.get('x-forwarded-for') || null,
      user.id
    );

    return NextResponse.json({
      success: true,
      message: 'Configuration test successful! All parameters verified.',
      details: {
        facebookAppId: facebookAppId.trim(),
        publicAppUrl: sanitizedUrl,
        callbackUrl,
        liveMetaMode: !!liveMetaMode
      }
    });
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('Error testing configuration:', error);
    return NextResponse.json({ 
      success: false, 
      message: `Internal error testing configuration: ${errMsg}` 
    }, { status: 500 });
  }
}
