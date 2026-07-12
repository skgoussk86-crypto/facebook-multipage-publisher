import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { encryptToken } from '@/lib/crypto';
import { saveFacebookAccount, MockFacebookAccount, MockFacebookPage } from '@/lib/db';

export async function GET(request: NextRequest) {
  const origin = request.nextUrl.origin;
  const cookieStore = await cookies();
  const savedState = cookieStore.get('fb_oauth_state')?.value;
  
  // Clear the cookie immediately
  cookieStore.delete('fb_oauth_state');

  const searchParams = request.nextUrl.searchParams;
  const state = searchParams.get('state');
  const code = searchParams.get('code');
  const error = searchParams.get('error');
  const permissionsGranted = searchParams.get('permissions_granted') || 'all';

  // 1. CSRF Verification
  if (!state || state !== savedState) {
    return NextResponse.redirect(`${origin}/?error=CSRF_validation_failed`);
  }

  // 2. Handle cancellation/errors from Facebook
  if (error) {
    return NextResponse.redirect(`${origin}/?error=${error}`);
  }

  if (!code) {
    return NextResponse.redirect(`${origin}/?error=no_authorization_code`);
  }

  const isLive = process.env.LIVE_META_MODE === 'true';
  const appId = process.env.FACEBOOK_APP_ID || '123456789012345';
  const appSecret = process.env.FACEBOOK_APP_SECRET || 'mock_facebook_app_secret_abc123';
  const redirectUri = `${origin}/api/auth/facebook/callback`;

  try {
    if (isLive) {
      // --- LIVE META GRAPH API INTERACTION ---
      
      // Step A: Exchange code for short-lived user access token
      const tokenExchangeUrl = `https://graph.facebook.com/v20.0/oauth/access_token?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&client_secret=${appSecret}&code=${code}`;
      const tokenRes = await fetch(tokenExchangeUrl);
      if (!tokenRes.ok) {
        const errData = await tokenRes.json();
        return NextResponse.redirect(`${origin}/?error=token_exchange_failed&details=${encodeURIComponent(errData.error?.message || '')}`);
      }
      const tokenData = await tokenRes.json();
      const shortUserToken = tokenData.access_token;

      // Step B: Exchange short-lived token for long-lived user access token (60 days)
      const longLivedUrl = `https://graph.facebook.com/v20.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${shortUserToken}`;
      const longLivedRes = await fetch(longLivedUrl);
      if (!longLivedRes.ok) {
        return NextResponse.redirect(`${origin}/?error=long_lived_token_failed`);
      }
      const longLivedData = await longLivedRes.json();
      const longUserToken = longLivedData.access_token;
      const expiresInSec = longLivedData.expires_in || 60 * 60 * 24 * 60; // 60 days fallback
      const tokenExpiresAt = new Date(Date.now() + expiresInSec * 1000).toISOString();

      // Step C: Fetch User Profile ID and Name
      const meRes = await fetch(`https://graph.facebook.com/v20.0/me?access_token=${longUserToken}`);
      if (!meRes.ok) {
        return NextResponse.redirect(`${origin}/?error=user_profile_fetch_failed`);
      }
      const meData = await meRes.json();
      const fbUserId = meData.id;
      const fbUserName = meData.name;

      // Step D: Fetch Pages managed by the User
      const pagesRes = await fetch(`https://graph.facebook.com/v20.0/me/accounts?access_token=${longUserToken}`);
      if (!pagesRes.ok) {
        return NextResponse.redirect(`${origin}/?error=pages_fetch_failed`);
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
        } catch (e) {
          console.warn(`Could not load profile picture for page ${page.name}:`, e);
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

      // Check if publishing scopes are missing (mock detection based on granted scopes if API provides it)
      // Standard Graph API doesn't return scope lists in token results directly without debug token query,
      // so in live mode we default to 'Connected' unless a token error occurs.
      const connectionState = 'Connected';

      const accountData: MockFacebookAccount = {
        id: crypto.randomUUID(),
        facebookUserId: fbUserId,
        name: fbUserName,
        encryptedAccessToken: encryptToken(longUserToken),
        tokenExpiresAt,
        pages: mappedPages
      };

      await saveFacebookAccount(accountData, connectionState);
      return NextResponse.redirect(`${origin}/?success=oauth_connected`);

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

      await saveFacebookAccount(simulatedAccount, connectionState);
      return NextResponse.redirect(`${origin}/?success=oauth_simulated`);
    }
  } catch (error: unknown) {
    console.error('OAuth Callback Error:', error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return NextResponse.redirect(`${origin}/?error=internal_oauth_error&message=${encodeURIComponent(errorMessage)}`);
  }
}
