import { NextRequest, NextResponse } from 'next/server';
import { prisma as defaultPrisma } from '@/lib/prisma-client';
import { verifyAdminSession as defaultVerifyAdminSession } from '@/lib/auth';
import { setDefaultAppConfiguration as defaultSetDefaultAppConfiguration, createAuditLog as defaultCreateAuditLog } from '@/lib/db';

function getRequestIp(request: NextRequest): string | null {
  return (
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    null
  );
}

export async function handlePost(
  request: NextRequest,
  params: Promise<{ id: string }>,
  deps = {
    verifyAdminSession: defaultVerifyAdminSession,
    prisma: defaultPrisma,
    setDefaultAppConfiguration: defaultSetDefaultAppConfiguration,
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
      where: { id, userId: user.id }
    });

    if (!existing) {
      return NextResponse.json({ error: 'App configuration not found' }, { status: 404 });
    }

    if (!existing.isEnabled) {
      return NextResponse.json({ error: 'Cannot promote a disabled configuration to default' }, { status: 400 });
    }

    try {
      await deps.setDefaultAppConfiguration(user.id, id);

      const requestIp = getRequestIp(request);
      await deps.createAuditLog(
        'SET_DEFAULT_CONFIG',
        `Promoted Meta App configuration "${existing.configurationName}" to default.`,
        requestIp,
        user.id
      );

      // Fetch and return the updated sanitized configurations list
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
    } catch (dbErr: unknown) {
      const err = dbErr as { code?: string; message?: string };

      // Known Business Rule: Disabled configuration cannot become default
      if (err?.message?.includes('disabled configuration') || err?.message?.includes('cannot become default')) {
        return NextResponse.json(
          { error: 'Cannot promote a disabled configuration to default.' },
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
      console.error('Unexpected database promotion error');
      return NextResponse.json(
        { error: 'Unable to set the default Meta App configuration.' },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error('Error promoting Meta App configuration to default:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return handlePost(request, params);
}
