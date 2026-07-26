import { NextRequest, NextResponse } from 'next/server';
import { prisma as defaultPrisma } from '@/lib/prisma-client';
import { verifyAdminSession as defaultVerifyAdminSession } from '@/lib/auth';
import { encryptToken as defaultEncryptToken } from '@/lib/crypto';
import { createAppConfiguration as defaultCreateAppConfiguration, createAuditLog as defaultCreateAuditLog } from '@/lib/db';

function getRequestIp(request: NextRequest): string | null {
  return (
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    null
  );
}

export async function handleGet(
  request: NextRequest,
  deps = { verifyAdminSession: defaultVerifyAdminSession, prisma: defaultPrisma }
) {
  try {
    const user = await deps.verifyAdminSession(request);

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const configurations = await deps.prisma.appConfiguration.findMany({
      where: { userId: user.id },
      include: {
        facebookAccounts: {
          include: {
            pages: true
          }
        }
      },
      orderBy: [
        { isDefault: 'desc' },
        { createdAt: 'asc' }
      ]
    });

    const sanitized = configurations.map((config) => ({
      id: config.id,
      configurationName: config.configurationName,
      publicAppUrl: config.publicAppUrl,
      facebookAppId: config.facebookAppId,
      liveMetaMode: config.liveMetaMode,
      isDefault: config.isDefault,
      isEnabled: config.isEnabled,
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
      secretConfigured: !!config.encryptedAppSecret,
      accountCount: config.facebookAccounts.length,
      pageCount: config.facebookAccounts.reduce((sum, acc) => sum + acc.pages.length, 0)
    }));

    return NextResponse.json(sanitized);
  } catch (error) {
    console.error('Error fetching configurations list:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function handlePost(
  request: NextRequest,
  deps = {
    verifyAdminSession: defaultVerifyAdminSession,
    prisma: defaultPrisma,
    encryptToken: defaultEncryptToken,
    createAppConfiguration: defaultCreateAppConfiguration,
    createAuditLog: defaultCreateAuditLog
  }
) {
  try {
    const user = await deps.verifyAdminSession(request);

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();

    // Reject non-boolean values when supplied
    if (body?.liveMetaMode !== undefined && typeof body.liveMetaMode !== 'boolean') {
      return NextResponse.json({ error: 'liveMetaMode must be a boolean' }, { status: 400 });
    }
    if (body?.isDefault !== undefined && typeof body.isDefault !== 'boolean') {
      return NextResponse.json({ error: 'isDefault must be a boolean' }, { status: 400 });
    }
    if (body?.isEnabled !== undefined && typeof body.isEnabled !== 'boolean') {
      return NextResponse.json({ error: 'isEnabled must be a boolean' }, { status: 400 });
    }

    const configurationName =
      typeof body?.configurationName === 'string'
        ? body.configurationName.trim()
        : '';

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
    const isDefault = body?.isDefault === true;
    const isEnabled = body?.isEnabled !== false;

    // Validation
    if (!configurationName) {
      return NextResponse.json({ error: 'Configuration Name is required' }, { status: 400 });
    }

    if (configurationName.length > 100) {
      return NextResponse.json(
        { error: 'Configuration Name must not exceed 100 characters' },
        { status: 400 }
      );
    }

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

    if (liveMetaMode && parsedUrl.protocol !== 'https:') {
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

    if (!facebookAppId) {
      return NextResponse.json({ error: 'Facebook App ID is required' }, { status: 400 });
    }

    if (facebookAppId.length > 255) {
      return NextResponse.json({ error: 'Facebook App ID must not exceed 255 characters' }, { status: 400 });
    }

    const trimmedSecret = typeof facebookAppSecret === 'string' ? facebookAppSecret.trim() : '';
    if (!trimmedSecret) {
      return NextResponse.json({ error: 'Facebook App Secret is required' }, { status: 400 });
    }

    if (trimmedSecret.length > 1000) {
      return NextResponse.json({ error: 'Facebook App Secret must not exceed 1000 characters' }, { status: 400 });
    }

    if (isDefault && !isEnabled) {
      return NextResponse.json({ error: 'A default configuration must always be enabled' }, { status: 400 });
    }

    const sanitizedUrl = parsedUrl.origin;

    // Check duplicate App ID for the same user
    const duplicate = await deps.prisma.appConfiguration.findFirst({
      where: {
        userId: user.id,
        facebookAppId
      }
    });

    if (duplicate) {
      return NextResponse.json(
        { error: 'A Meta App configuration with this App ID already exists for your account.' },
        { status: 409 }
      );
    }

    let encryptedAppSecret: string;
    try {
      encryptedAppSecret = deps.encryptToken(trimmedSecret);
    } catch (err: unknown) {
      console.error('App secret encryption failed:', err);
      return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }

    try {
      const config = await deps.createAppConfiguration(user.id, {
        configurationName,
        publicAppUrl: sanitizedUrl,
        facebookAppId,
        encryptedAppSecret,
        liveMetaMode,
        isDefault,
        isEnabled
      });

      // Re-read configuration from database to ensure isDefault reflects automatic promotions
      const reReadConfig = await deps.prisma.appConfiguration.findFirst({
        where: { id: config.id, userId: user.id }
      });
      const finalConfig = reReadConfig || config;

      const requestIp = getRequestIp(request);
      await deps.createAuditLog(
        'CREATE_CONFIG',
        `Created Meta App configuration: ${configurationName} (App ID: ${facebookAppId}, Mode: ${liveMetaMode ? 'Live' : 'Mock'})`,
        requestIp,
        user.id
      );

      return NextResponse.json({
        success: true,
        config: {
          id: finalConfig.id,
          configurationName: finalConfig.configurationName,
          publicAppUrl: finalConfig.publicAppUrl,
          facebookAppId: finalConfig.facebookAppId,
          liveMetaMode: finalConfig.liveMetaMode,
          isDefault: finalConfig.isDefault,
          isEnabled: finalConfig.isEnabled,
          secretConfigured: !!finalConfig.encryptedAppSecret
        }
      });
    } catch (dbErr: unknown) {
      const err = dbErr as { code?: string; message?: string };
      // Map Prisma unique-constraint races to HTTP 409
      if (err?.code === 'P2002' || err?.message?.includes('Unique constraint')) {
        return NextResponse.json(
          { error: 'A Meta App configuration with this App ID already exists for your account.' },
          { status: 409 }
        );
      }
      throw dbErr;
    }
  } catch (error) {
    console.error('Error creating Meta App configuration:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  return handleGet(request);
}

export async function POST(request: NextRequest) {
  return handlePost(request);
}
