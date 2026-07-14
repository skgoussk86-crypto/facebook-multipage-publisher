import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminSession, verifyAdminRole } from '@/lib/auth';
import { runQueueWorker, generateWorkerToken } from '@/lib/job-worker';

export async function POST(request: NextRequest) {
  try {
    const user = await verifyAdminSession(request);

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!verifyAdminRole(user)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Disable in production unless explicitly overridden via env flag
    if (process.env.NODE_ENV === 'production' && process.env.ENABLE_PRODUCTION_WORKER_ROUTE !== 'true') {
      return NextResponse.json(
        { error: 'Forbidden: Background worker endpoint is disabled in production.' },
        { status: 403 }
      );
    }

    const workerToken = generateWorkerToken();
    const logs = await runQueueWorker(workerToken);

    return NextResponse.json({ success: true, logs });
  } catch (error) {
    console.error('Error in worker route:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
