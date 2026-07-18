import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminSession, verifyAdminRole } from '@/lib/auth';
import { prisma } from '@/lib/prisma-client';
import { sanitizeErrorMessage } from '@/lib/worker-health';

export type HealthRouteDependencies = {
  verifyAdminSession: typeof verifyAdminSession;
  verifyAdminRole: typeof verifyAdminRole;
};

const defaultDependencies: HealthRouteDependencies = {
  verifyAdminSession,
  verifyAdminRole,
};

export async function handleHealthGet(
  request: NextRequest,
  dependencies: HealthRouteDependencies = defaultDependencies
): Promise<NextResponse> {
  try {
    const user = await dependencies.verifyAdminSession(request);

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!dependencies.verifyAdminRole(user)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Limit returned records to the 50 most recent heartbeat updates
    // Explicitly select columns to avoid loading any internal metadata
    const heartbeats = await prisma.workerHeartbeat.findMany({
      orderBy: { updatedAt: 'desc' },
      take: 50,
      select: {
        id: true,
        workerId: true,
        startedAt: true,
        lastPingAt: true,
        currentStatus: true,
        lastSuccessAt: true,
        lastFailureAt: true,
        lastError: true,
        jobsProcessedLastCycle: true,
        nextPollEstimate: true,
        createdAt: true,
        updatedAt: true,
      }
    });

    const safeHeartbeats = heartbeats.map((hb) => ({
      ...hb,
      lastError: hb.lastError ? sanitizeErrorMessage(hb.lastError) : null,
    }));

    return NextResponse.json({ success: true, heartbeats: safeHeartbeats });
  } catch (error) {
    console.error('Error fetching worker health:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  return handleHealthGet(request, defaultDependencies);
}
