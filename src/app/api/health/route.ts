import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma-client';
import { getAppConfiguration } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  let databaseStatus = 'disconnected';
  let isConfigured = false;
  let liveMode = false;
  let isHealthy = true;

  try {
    // 1. Verify database connectivity by running a simple query
    await prisma.$queryRaw`SELECT 1`;
    databaseStatus = 'connected';
  } catch (err) {
    console.error('Healthcheck DB error:', err);
    databaseStatus = 'error';
    isHealthy = false;
  }

  try {
    // 2. Check Meta configuration and live mode
    const config = await getAppConfiguration();
    if (config) {
      isConfigured = true;
      liveMode = config.liveMetaMode;
    }
  } catch (err) {
    console.error('Healthcheck config error:', err);
    isHealthy = false;
  }

  return NextResponse.json({
    status: isHealthy ? 'healthy' : 'unhealthy',
    database: databaseStatus,
    metaConfiguration: isConfigured ? 'configured' : 'incomplete',
    liveMode: liveMode
  }, {
    status: isHealthy ? 200 : 500
  });
}
