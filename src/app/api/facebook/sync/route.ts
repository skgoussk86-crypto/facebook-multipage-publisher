import { NextResponse } from 'next/server';
import { getFacebookConnection, saveFacebookAccount, MockFacebookPage, MockFacebookAccount, updateConnectionState } from '@/lib/db';
import { encryptToken, decryptToken } from '@/lib/crypto';
import { prisma } from '@/lib/prisma-client';

export async function POST() {
  try {
    const { account, connectionState } = await getFacebookConnection();
    
    if (!account) {
      return NextResponse.json({ error: 'No Facebook account connected.' }, { status: 400 });
    }

    const isLive = process.env.LIVE_META_MODE === 'true';

    if (isLive) {
      // Fetch User Access Token from DB
      // We retrieve it via database connection (decrypt user access token)
      // Since getFacebookConnection didn't return the raw DB account to keep it safe from leaking,
      // let's fetch the account directly from prisma here
      const dbAccount = await prisma.facebookAccount.findFirst({
        where: { facebookUserId: account.facebookUserId }
      });

      if (!dbAccount) {
        return NextResponse.json({ error: 'Facebook account not found in database.' }, { status: 400 });
      }

      const longUserToken = decryptToken(dbAccount.encryptedAccessToken);

      // Fetch fresh accounts list from Facebook Graph API
      const pagesRes = await fetch(`https://graph.facebook.com/v20.0/me/accounts?access_token=${longUserToken}`);
      if (!pagesRes.ok) {
        const errData = await pagesRes.json();
        // If OAuth fails (e.g. revoked token), we update page status to Expired
        if (errData.error?.code === 190) {
          await updateConnectionState('Reconnection Required');
        }
        return NextResponse.json({ error: `Meta API Error: ${errData.error?.message || 'Sync failed'}` }, { status: 400 });
      }

      const pagesData = await pagesRes.json();
      const rawPages = pagesData.data || [];

      // Remap and update page pictures and encrypted tokens
      const updatedPages: MockFacebookPage[] = [];
      for (const page of rawPages) {
        let pictureUrl = `https://api.dicebear.com/7.x/identicon/svg?seed=${encodeURIComponent(page.name)}`;
        try {
          const picRes = await fetch(`https://graph.facebook.com/v20.0/${page.id}/picture?redirect=0&type=normal&access_token=${page.access_token}`);
          if (picRes.ok) {
            const picData = await picRes.json();
            if (picData?.data?.url) {
              pictureUrl = picData.data.url;
            }
          }
        } catch (e) {
          console.warn(`Pic load fail during sync for ${page.name}:`, e);
        }

        updatedPages.push({
          id: page.id,
          name: page.name,
          category: page.category || 'Business Page',
          pictureUrl,
          tokenStatus: 'Valid',
          connectedAt: new Date().toISOString(),
          encryptedPageToken: encryptToken(page.access_token)
        });
      }

      // Preserve long lived user token expires details
      const simulatedAccount: MockFacebookAccount = {
        id: dbAccount.id,
        facebookUserId: dbAccount.facebookUserId,
        name: dbAccount.name,
        encryptedAccessToken: dbAccount.encryptedAccessToken,
        tokenExpiresAt: dbAccount.tokenExpiresAt.toISOString(),
        pages: updatedPages
      };

      await saveFacebookAccount(simulatedAccount, connectionState);
      
      return NextResponse.json({
        pages: updatedPages.map(p => ({
          id: p.id,
          name: p.name,
          category: p.category,
          pictureUrl: p.pictureUrl,
          tokenStatus: p.tokenStatus,
          connectedAt: p.connectedAt
        })),
        connectionState: 'Connected'
      });

    } else {
      // SIMULATION SYNC FLOW
      // Simulate slow sync response
      await new Promise(resolve => setTimeout(resolve, 800));

      const { account: updatedAccount, connectionState: nextState } = await getFacebookConnection();
      if (!updatedAccount) {
        return NextResponse.json({ error: 'No account linked' }, { status: 400 });
      }

      return NextResponse.json({
        pages: updatedAccount.pages || [],
        connectionState: nextState
      });
    }
  } catch (error: unknown) {
    console.error('Pages Sync Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal Server Error';
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
