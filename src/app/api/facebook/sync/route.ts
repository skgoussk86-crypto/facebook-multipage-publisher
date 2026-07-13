import { NextRequest, NextResponse } from 'next/server';
import { getFacebookConnections, saveFacebookAccount, MockFacebookPage, MockFacebookAccount, updatePagesStatus } from '@/lib/db';
import { verifyAdminSession } from '@/lib/auth';
import { encryptToken, decryptToken } from '@/lib/crypto';
import { prisma } from '@/lib/prisma-client';

export async function POST(request: NextRequest) {
  try {
    const user = await verifyAdminSession(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const searchParams = request.nextUrl.searchParams;
    const accountId = searchParams.get('accountId');

    const accounts = await getFacebookConnections(user.id) || [];
    
    if (accounts.length === 0) {
      return NextResponse.json({ error: 'No Facebook accounts connected.' }, { status: 400 });
    }

    // Find the target account to sync.
    let targetAccount = accounts[0];
    if (accountId) {
      const match = accounts.find(acc => acc.id === accountId);
      if (match) {
        targetAccount = match;
      } else {
        return NextResponse.json({ error: `Facebook account with ID ${accountId} not found.` }, { status: 400 });
      }
    }

    const isLive = process.env.LIVE_META_MODE === 'true';

    if (isLive) {
      // Fetch User Access Token from DB specifically for the target account
      const dbAccount = await prisma.facebookAccount.findUnique({
        where: { id: targetAccount.id }
      });

      if (!dbAccount) {
        return NextResponse.json({ error: 'Facebook account not found in database.' }, { status: 400 });
      }

      if (dbAccount.userId !== user.id) {
        return NextResponse.json({ error: 'Forbidden: You do not own this Facebook account.' }, { status: 403 });
      }

      const longUserToken = decryptToken(dbAccount.encryptedAccessToken);

      // Fetch fresh accounts list from Facebook Graph API
      const pagesRes = await fetch(`https://graph.facebook.com/v20.0/me/accounts?access_token=${longUserToken}`);
      if (!pagesRes.ok) {
        const errData = await pagesRes.json();
        // If OAuth fails (e.g. revoked token), we update page status to Expired
        if (errData.error?.code === 190) {
          const expiredPages = targetAccount.pages.map(p => ({
            id: p.id,
            tokenStatus: 'Expired' as const
          }));
          await updatePagesStatus(user.id, expiredPages);
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

      const connectionState = targetAccount.connectionState;

      const simulatedAccount: MockFacebookAccount = {
        id: dbAccount.id,
        facebookUserId: dbAccount.facebookUserId,
        name: dbAccount.name,
        encryptedAccessToken: dbAccount.encryptedAccessToken,
        tokenExpiresAt: dbAccount.tokenExpiresAt.toISOString(),
        pages: updatedPages
      };

      await saveFacebookAccount(user.id, simulatedAccount, connectionState);
      
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

      return NextResponse.json({
        pages: targetAccount.pages || [],
        connectionState: targetAccount.connectionState
      });
    }
  } catch (error: unknown) {
    console.error('Pages Sync Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal Server Error';
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
