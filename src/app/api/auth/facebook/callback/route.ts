import { NextRequest, NextResponse } from 'next/server';
import { cookies as defaultCookies } from 'next/headers';
import crypto from 'crypto';
import { encryptToken, decryptToken } from '@/lib/crypto';
import { saveFacebookAccount as defaultSaveFacebookAccount, MockFacebookAccount, MockFacebookPage } from '@/lib/db';
import { getSessionUser as defaultGetSessionUser } from '@/lib/auth';
import { prisma as defaultPrisma } from '@/lib/prisma-client';

function timingSafeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export async function handleGet(
  request: NextRequest,
  deps = {
    getSessionUser: defaultGetSessionUser,
    prisma: defaultPrisma,
    saveFacebookAccount: defaultSaveFacebookAccount,
    cookies: defaultCookies
  }
) {
  const user = await deps.getSessionUser();
  if (!user) {
    const fallbackBaseUrl = request.nextUrl.origin;
    return NextResponse.redirect(`${fallbackBaseUrl}/login`);
  }

  const cookieStore = await deps.cookies();
  const contextCookie = cookieStore.get('fb_oauth_context')?.value;

  // Clear the cookies immediately
  cookieStore.delete('fb_oauth_context');
  cookieStore.delete('fb_oauth_state');

  let parsedContext: { state?: string; configurationId?: string } = {};
  try {
    if (contextCookie) {
      parsedContext = JSON.parse(contextCookie);
    }
  } catch (err) {
    console.error('Failed to parse OAuth context cookie:', err);
  }

  const searchParams = request.nextUrl.searchParams;
  const state = searchParams.get('state');
  const code = searchParams.get('code');
  const error = searchParams.get('error');
  const permissionsGranted = searchParams.get('permissions_granted') || 'all';

  const savedState = parsedContext.state;
  const configurationId = parsedContext.configurationId;

  // 1. CSRF Verification
  const stateMatches = state && savedState && timingSafeEqual(state, savedState);
  if (!stateMatches) {
    return NextResponse.redirect(
      `${request.nextUrl.origin}/settings/meta-configuration?error=CSRF_validation_failed`
    );
  }

  if (!configurationId) {
    return NextResponse.redirect(
      `${request.nextUrl.origin}/settings/meta-configuration?error=missing_configuration_context`
    );
  }

  // Load and verify configuration
  const config = await deps.prisma.appConfiguration.findFirst({
    where: {
      id: configurationId,
      userId: user.id
    }
  });

  if (!config) {
    return NextResponse.redirect(
      `${request.nextUrl.origin}/settings/meta-configuration?error=configuration_not_found`
    );
  }

  const baseUrl = config.publicAppUrl;

  if (!config.isEnabled) {
    return NextResponse.redirect(
      `${baseUrl}/settings/meta-configuration?error=configuration_disabled&configurationId=${encodeURIComponent(config.id)}`
    );
  }

  const appId = config.facebookAppId;
  const isLive = config.liveMetaMode;

  let appSecret = '';
  if (isLive) {
    try {
      appSecret = decryptToken(config.encryptedAppSecret);
    } catch {
      console.error('Decryption of Facebook App Secret failed during OAuth callback');
      return NextResponse.redirect(
        `${baseUrl}/settings/meta-configuration?error=decryption_failed&configurationId=${encodeURIComponent(config.id)}`
      );
    }
  }

  // 2. Handle cancellation/errors from Facebook
  if (error) {
    // Treat the Facebook error parameter code as a fixed safe code, sanitizing the internal value.
    const safeErrorParam = error === 'access_denied' ? 'access_denied' : 'oauth_cancelled';
    return NextResponse.redirect(
      `${baseUrl}/settings/meta-configuration?error=${safeErrorParam}&configurationId=${encodeURIComponent(config.id)}`
    );
  }

  if (!code) {
    return NextResponse.redirect(
      `${baseUrl}/settings/meta-configuration?error=no_authorization_code&configurationId=${encodeURIComponent(config.id)}`
    );
  }

  const redirectUri = `${baseUrl}/api/auth/facebook/callback`;

  try {
    if (isLive) {
      // --- LIVE META GRAPH API INTERACTION ---
      
      // Step A: Exchange code for short-lived user access token
      const tokenExchangeUrl = `https://graph.facebook.com/v20.0/oauth/access_token?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&client_secret=${appSecret}&code=${code}`;
      const tokenRes = await fetch(tokenExchangeUrl);
      if (!tokenRes.ok) {
        console.error('Exchange for user access token failed');
        return NextResponse.redirect(
          `${baseUrl}/settings/meta-configuration?error=token_exchange_failed&configurationId=${encodeURIComponent(config.id)}`
        );
      }
      const tokenData = await tokenRes.json();
      const shortUserToken = tokenData.access_token;

      // Step B: Exchange short-lived token for long-lived user access token (60 days)
      const longLivedUrl = `https://graph.facebook.com/v20.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${shortUserToken}`;
      const longLivedRes = await fetch(longLivedUrl);
      if (!longLivedRes.ok) {
        console.error('Exchange for long-lived access token failed');
        return NextResponse.redirect(
          `${baseUrl}/settings/meta-configuration?error=long_lived_token_failed&configurationId=${encodeURIComponent(config.id)}`
        );
      }
      const longLivedData = await longLivedRes.json();
      const longUserToken = longLivedData.access_token;
      const expiresInSec = longLivedData.expires_in || 60 * 60 * 24 * 60; // 60 days fallback
      const tokenExpiresAt = new Date(Date.now() + expiresInSec * 1000).toISOString();

      // Step C: Fetch User Profile ID and Name
      const meRes = await fetch(`https://graph.facebook.com/v20.0/me?access_token=${longUserToken}`);
      if (!meRes.ok) {
        console.error('Fetching profile user ID failed');
        return NextResponse.redirect(
          `${baseUrl}/settings/meta-configuration?error=user_profile_fetch_failed&configurationId=${encodeURIComponent(config.id)}`
        );
      }
      const meData = await meRes.json();
      const fbUserId = meData.id;
      const fbUserName = meData.name;

      // Step D: Fetch Pages managed by the User
      const pagesRes = await fetch(`https://graph.facebook.com/v20.0/me/accounts?access_token=${longUserToken}`);
      if (!pagesRes.ok) {
        console.error('Fetching user managed pages failed');
        return NextResponse.redirect(
          `${baseUrl}/settings/meta-configuration?error=pages_fetch_failed&configurationId=${encodeURIComponent(config.id)}`
        );
      }
      const pagesData = await pagesRes.json();
      const rawPages = pagesData.data || [];

      // Step E: Map and fetch page pictures
      const mappedPages: MockFacebookPage[] = [];
      for (const page of rawPages) {
        let pictureUrl = `https://api.dicebear.com/7.x/identicon/svg?seed=${encodeURIComponent(page.name)}`;
        try {
          const picRes = await fetch(`https://graph.facebook.com/v20.0/${page.id}/picture?redirect=0&type=normal&access_token=${page.access_token}`);
          if (picRes.ok) {
            const picData = await picRes.ok ? await picRes.json() : null;
            if (picData?.data?.url) {
              pictureUrl = picData.data.url;
            }
          }
        } catch {
          console.warn(`Could not load profile picture for page ${page.name}`);
        }

        mappedPages.push({
          id: page.id,
          name: page.name,
          category: page.category || 'Business Page',
          pictureUrl,
          tokenStatus: 'Valid',
          connectedAt: new Date().toISOString(),
          encryptedPageToken: encryptToken(page.access_token)
        });
      }

      const connectionState = 'Connected';

      const accountData: MockFacebookAccount = {
        id: crypto.randomUUID(),
        facebookUserId: fbUserId,
        name: fbUserName,
        encryptedAccessToken: encryptToken(longUserToken),
        tokenExpiresAt,
        pages: mappedPages
      };

      await deps.saveFacebookAccount(user.id, accountData, connectionState, config.id);
      return NextResponse.redirect(
        `${baseUrl}/settings/meta-configuration?success=oauth_connected&configurationId=${encodeURIComponent(config.id)}`
      );

    } else {
      // --- LOCAL DEVELOPMENT SIMULATION FLOW ---
      
      const isPermissionsMissing = permissionsGranted === 'missing';
      const connectionState = isPermissionsMissing ? 'Permission Missing' : 'Connected';

      // Load static mock pages
      const mockPages: MockFacebookPage[] = [
        {
          id: "1029384756",
          name: "Tech Reviews Daily",
          category: "Media/News Company",
          pictureUrl: "https://api.dicebear.com/7.x/identicon/svg?seed=tech",
          tokenStatus: 'Valid',
          connectedAt: new Date().toISOString(),
          encryptedPageToken: encryptToken('mock_page_token_tech_1234')
        },
        {
          id: "5647382910",
          name: "Gaming Zone Live",
          category: "Gaming Creator",
          pictureUrl: "https://api.dicebear.com/7.x/identicon/svg?seed=gaming",
          tokenStatus: 'Valid',
          connectedAt: new Date().toISOString(),
          encryptedPageToken: encryptToken('mock_page_token_gaming_5678')
        },
        {
          id: "9876543210",
          name: "Travel & Culinary Guides",
          category: "Travel & Leisure",
          pictureUrl: "https://api.dicebear.com/7.x/identicon/svg?seed=travel",
          tokenStatus: 'Valid',
          connectedAt: new Date().toISOString(),
          encryptedPageToken: encryptToken('mock_page_token_travel_9012')
        }
      ];

      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 60); // 60 days expiration simulation

      const simulatedAccount: MockFacebookAccount = {
        id: crypto.randomUUID(),
        facebookUserId: 'mock_fb_user_88888',
        name: 'Simulated Meta Administrator',
        encryptedAccessToken: encryptToken('mock_long_lived_user_token_xyz987'),
        tokenExpiresAt: expiresAt.toISOString(),
        pages: mockPages
      };

      await deps.saveFacebookAccount(user.id, simulatedAccount, connectionState, config.id);
      return NextResponse.redirect(
        `${baseUrl}/settings/meta-configuration?success=oauth_simulated&configurationId=${encodeURIComponent(config.id)}`
      );
    }
  } catch {
    console.error('OAuth Callback Error');
    const errUrl = config?.publicAppUrl || request.nextUrl.origin;
    return NextResponse.redirect(
      `${errUrl}/settings/meta-configuration?error=internal_oauth_error&configurationId=${encodeURIComponent(configurationId || '')}`
    );
  }
}

export async function GET(request: NextRequest) {
  return handleGet(request);
}
