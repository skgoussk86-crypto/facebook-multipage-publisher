import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import crypto from 'crypto';
import { getAppConfiguration } from '@/lib/db';

export async function GET(request: NextRequest) {
  try {
    // Generate secure state for CSRF validation
    const state = crypto.randomBytes(16).toString('hex');
    
    // Save state in HTTP-only cookie
    const cookieStore = await cookies();
    cookieStore.set('fb_oauth_state', state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 10, // 10 minutes validation window
    });

    const config = await getAppConfiguration();
    
    // When no secure configuration exists, redirect to first-run setup page instead of failing
    if (!config) {
      const fallbackBaseUrl = request.nextUrl.origin;
      return NextResponse.redirect(`${fallbackBaseUrl}/settings/meta-configuration?error=not_configured`);
    }

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

