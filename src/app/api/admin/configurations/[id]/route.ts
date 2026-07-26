import { NextRequest, NextResponse } from 'next/server';
import { prisma as defaultPrisma } from '@/lib/prisma-client';
import { verifyAdminSession as defaultVerifyAdminSession } from '@/lib/auth';
import { encryptToken as defaultEncryptToken } from '@/lib/crypto';
import { updateAppConfiguration as defaultUpdateAppConfiguration, createAuditLog as defaultCreateAuditLog } from '@/lib/db';

const FACEBOOK_SECRET_MASK = '************';
const REAL_BULLET_CHARACTER = '\u2022';
const LEGACY_BROKEN_BULLET = '\u00e2\u20ac\u00a2';

function getRequestIp(request: NextRequest): string | null {
  return (
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    null
  );
}

function isRepeatedMask(value: string, maskCharacter: string): boolean {
  if (!value || !maskCharacter) {
    return false;
  }
  return value.split(maskCharacter).join('') === '';
}

function isMaskedSecret(value: string): boolean {
  const trimmedValue = value.trim();
  if (trimmedValue === FACEBOOK_SECRET_MASK) {
    return true;
  }
  if (isRepeatedMask(trimmedValue, REAL_BULLET_CHARACTER)) {
    return true;
  }
  return isRepeatedMask(trimmedValue, LEGACY_BROKEN_BULLET);
}

export async function handlePatch(
  request: NextRequest,
  params: Promise<{ id: string }>,
  deps = {
    verifyAdminSession: defaultVerifyAdminSession,
    prisma: defaultPrisma,
    encryptToken: defaultEncryptToken,
    updateAppConfiguration: defaultUpdateAppConfiguration,
    createAuditLog: defaultCreateAuditLog
  }
) {
  try {
    const { id } = await params;
    const user = await deps.verifyAdminSession(request);

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const existing = await deps.prisma.appConfiguration.findFirst({
      where: { id, userId: user.id },
      include: {
        facebookAccounts: true
      }
    });

    if (!existing) {
      return NextResponse.json({ error: 'App configuration not found' }, { status: 404 });
    }

    const body = await request.json();

    // Reject non-boolean values when supplied
    if (body?.liveMetaMode !== undefined && typeof body.liveMetaMode !== 'boolean') {
      return NextResponse.json({ error: 'liveMetaMode must be a boolean' }, { status: 400 });
    }
    if (body?.isEnabled !== undefined && typeof body.isEnabled !== 'boolean') {
      return NextResponse.json({ error: 'isEnabled must be a boolean' }, { status: 400 });
    }

    const configurationName =
      typeof body?.configurationName === 'string'
        ? body.configurationName.trim()
        : undefined;

    const publicAppUrl =
      typeof body?.publicAppUrl === 'string'
        ? body.publicAppUrl.trim()
        : undefined;

    const facebookAppId =
      typeof body?.facebookAppId === 'string'
        ? body.facebookAppId.trim()
        : undefined;

    const facebookAppSecret =
      typeof body?.facebookAppSecret === 'string'
        ? body.facebookAppSecret
        : undefined;

    const liveMetaMode = body?.liveMetaMode !== undefined ? body.liveMetaMode === true : undefined;
    const isEnabled = body?.isEnabled !== undefined ? body.isEnabled === true : undefined;

    const proposedLiveMode = liveMetaMode !== undefined ? liveMetaMode : existing.liveMetaMode;

    // Validation
    if (configurationName !== undefined) {
      if (!configurationName) {
        return NextResponse.json({ error: 'Configuration Name is required' }, { status: 400 });
      }
      if (configurationName.length > 100) {
        return NextResponse.json({ error: 'Configuration Name must not exceed 100 characters' }, { status: 400 });
      }
    }

    if (publicAppUrl !== undefined) {
      if (!publicAppUrl) {
        return NextResponse.json({ error: 'Public App URL is required' }, { status: 400 });
      }
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(publicAppUrl);
      } catch {
        return NextResponse.json({ error: 'Invalid Public App URL format' }, { status: 400 });
      }
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        return NextResponse.json({ error: 'Public App URL must use http:// or https://' }, { status: 400 });
      }
      if (proposedLiveMode && parsedUrl.protocol !== 'https:') {
        return NextResponse.json({ error: 'Public App URL must use HTTPS in Live Meta Mode' }, { status: 400 });
      }
      if (parsedUrl.username || parsedUrl.password) {
        return NextResponse.json({ error: 'Public App URL must not contain embedded credentials' }, { status: 400 });
      }
      const cleanPathname = parsedUrl.pathname.replace(/\/+$/, '');
      if (cleanPathname !== '') {
        return NextResponse.json(
          { error: `Public App URL must be a base URL without subpaths (found subpath: ${parsedUrl.pathname})` },
          { status: 400 }
        );
      }
      if (parsedUrl.search || parsedUrl.hash) {
        return NextResponse.json({ error: 'Public App URL must not contain query parameters or fragments' }, { status: 400 });
      }
    } else if (proposedLiveMode && !existing.publicAppUrl.startsWith('https:')) {
      return NextResponse.json({ error: 'Public App URL must use HTTPS in Live Meta Mode' }, { status: 400 });
    }

    if (facebookAppId !== undefined) {
      if (!facebookAppId) {
        return NextResponse.json({ error: 'Facebook App ID is required' }, { status: 400 });
      }
      if (facebookAppId.length > 255) {
        return NextResponse.json({ error: 'Facebook App ID must not exceed 255 characters' }, { status: 400 });
      }
    }

    // Safety checks for changing App ID
    if (facebookAppId !== undefined && facebookAppId !== existing.facebookAppId) {
      if (existing.facebookAccounts.length > 0) {
        return NextResponse.json(
          { error: 'Cannot change App ID when there are connected Facebook accounts. Please disconnect all accounts under this configuration first.' },
          { status: 409 }
        );
      }

      // Check duplicates
      const duplicate = await deps.prisma.appConfiguration.findFirst({
        where: {
          userId: user.id,
          facebookAppId
        }
      });
      if (duplicate) {
        return NextResponse.json(
          { error: 'Another Meta App configuration with this App ID already exists.' },
          { status: 409 }
        );
      }
    }

    let encryptedAppSecret: string | undefined;
    if (facebookAppSecret !== undefined) {
      if (facebookAppSecret === '' || isMaskedSecret(facebookAppSecret)) {
        // Keep existing secret
        encryptedAppSecret = undefined;
      } else {
        const trimmedSecret = facebookAppSecret.trim();
        if (!trimmedSecret) {
          return NextResponse.json({ error: 'Facebook App Secret is required' }, { status: 400 });
        }
        if (trimmedSecret.length > 1000) {
          return NextResponse.json({ error: 'Facebook App Secret must not exceed 1000 characters' }, { status: 400 });
        }
        try {
          encryptedAppSecret = deps.encryptToken(trimmedSecret);
        } catch (err: unknown) {
          console.error('App secret encryption failed:', err);
          return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
        }
      }
    }

    try {
      const updated = await deps.updateAppConfiguration(user.id, id, {
        configurationName,
        publicAppUrl: publicAppUrl ? new URL(publicAppUrl).origin : undefined,
        facebookAppId,
        encryptedAppSecret,
        liveMetaMode,
        isEnabled
      });

      const requestIp = getRequestIp(request);
      await deps.createAuditLog(
        'UPDATE_CONFIG',
        `Updated Meta App configuration: ${configurationName || existing.configurationName} (App ID: ${facebookAppId || existing.facebookAppId}, Mode: ${proposedLiveMode ? 'Live' : 'Mock'})`,
        requestIp,
        user.id
      );

      return NextResponse.json({
        success: true,
        config: {
          id: updated.id,
          configurationName: updated.configurationName,
          publicAppUrl: updated.publicAppUrl,
          facebookAppId: updated.facebookAppId,
          liveMetaMode: updated.liveMetaMode,
          isDefault: updated.isDefault,
          isEnabled: updated.isEnabled,
          secretConfigured: !!updated.encryptedAppSecret
        }
      });
    } catch (dbErr: unknown) {
      const err = dbErr as { code?: string; message?: string };

      // Known Business Rule: Duplicate App ID / Prisma P2002 Unique Constraint
      if (err?.code === 'P2002' || err?.message?.includes('Unique constraint') || err?.message?.includes('already exists')) {
        return NextResponse.json(
          { error: 'Another Meta App configuration with this App ID already exists.' },
          { status: 409 }
        );
      }

      // Known Business Rule: Default configuration must be enabled
      if (err?.message?.includes('always be enabled') || err?.message?.includes('default configuration') || err?.message?.includes('cannot be disabled')) {
        return NextResponse.json(
          { error: 'A default configuration cannot be disabled.' },
          { status: 400 }
        );
      }

      // Known Business Rule: Configuration not found
      if (err?.message?.includes('not found') || err?.message?.includes('Record to update not found')) {
        return NextResponse.json(
          { error: 'App configuration not found.' },
          { status: 404 }
        );
      }

      // Unexpected database error
      console.error('Unexpected database update error');
      return NextResponse.json(
        { error: 'Unable to update the Meta App configuration.' },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error('Error updating Meta App configuration:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return handlePatch(request, params);
}
