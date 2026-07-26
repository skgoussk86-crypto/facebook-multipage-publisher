import { NextRequest, NextResponse } from 'next/server';
import { cookies as defaultCookies } from 'next/headers';
import crypto from 'crypto';
import { getAppConfiguration as defaultGetAppConfiguration } from '@/lib/db';
import { getSessionUser as defaultGetSessionUser } from '@/lib/auth';

export async function handleGet(
  request: NextRequest,
  deps = {
    getSessionUser: defaultGetSessionUser,
    getAppConfiguration: defaultGetAppConfiguration,
    cookies: defaultCookies
  }
) {
  try {
    const user = await deps.getSessionUser();
    if (!user) {
      return NextResponse.redirect(`${request.nextUrl.origin}/login`);
    }

    const configIdParam = request.nextUrl.searchParams.get('configurationId');
    let config;

    if (configIdParam) {
      config = await deps.getAppConfiguration(user.id, configIdParam);
      if (!config || !config.isEnabled) {
        return NextResponse.redirect(
          `${request.nextUrl.origin}/settings/meta-configuration?error=invalid_configuration`
        );
      }
    } else {
      config = await deps.getAppConfiguration(user.id);
      if (!config) {
        return NextResponse.redirect(
          `${request.nextUrl.origin}/settings/meta-configuration?error=not_configured`
        );
      }
    }

    // Generate secure state for CSRF validation
    const state = crypto.randomBytes(16).toString('hex');

    // Save state and configuration ID in HTTP-only context cookie
    const cookieStore = await deps.cookies();

    const contextValue = JSON.stringify({
      state,
      configurationId: config.id
    });

    cookieStore.set('fb_oauth_context', contextValue, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 10 // 10 minutes validation window
    });

    // Also clean up legacy cookie if present
    cookieStore.delete('fb_oauth_state');

    const appId = config.facebookAppId;
    const isLive = config.liveMetaMode;
    const publicAppUrl = config.publicAppUrl;
    
    // Redirect URI generated exactly as required
    const redirectUri = `${publicAppUrl}/api/auth/facebook/callback`;

    if (isLive) {
      // Official Meta OAuth URL with specific scopes
      const scopes = 'pages_show_list,pages_read_engagement,pages_manage_posts';
      const facebookAuthUrl = `https://www.facebook.com/v20.0/dialog/oauth?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&scope=${encodeURIComponent(scopes)}`;
      return NextResponse.redirect(facebookAuthUrl);
    } else {
      // Local development simulation page
      const mockLoginUrl = `${publicAppUrl}/mock-facebook-login?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`;
      return NextResponse.redirect(mockLoginUrl);
    }
  } catch (error) {
    console.error('Error initiating Facebook auth:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  return handleGet(request);
}
