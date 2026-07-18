import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminSession, verifyAdminRole } from '@/lib/auth';
import { generateWorkerToken } from '@/lib/job-worker';
import { executeWorkerCycle } from '@/lib/worker-runtime';

export type WorkerRouteDependencies = {
  verifyAdminSession: typeof verifyAdminSession;
  verifyAdminRole: typeof verifyAdminRole;
  executeWorkerCycle?: typeof executeWorkerCycle;
  runQueueWorker?: typeof import('@/lib/job-worker').runQueueWorker;
  validateOneAsset?: typeof import('@/lib/storage').VideoValidationService.validateOneAsset;
};

const defaultWorkerRouteDependencies: WorkerRouteDependencies = {
  verifyAdminSession,
  verifyAdminRole,
  executeWorkerCycle
};

export async function handleWorkerPost(
  request: NextRequest,
  dependencies: WorkerRouteDependencies = defaultWorkerRouteDependencies
): Promise<NextResponse> {
  try {
    const user = await dependencies.verifyAdminSession(request);

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!dependencies.verifyAdminRole(user)) {
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
    let logs: string[] = [];

    if (dependencies.executeWorkerCycle) {
      const res = await dependencies.executeWorkerCycle(workerToken);
      logs = res.logs;
    } else if (dependencies.runQueueWorker && dependencies.validateOneAsset) {
      logs = await dependencies.runQueueWorker(workerToken);
      try {
        const valRes = await dependencies.validateOneAsset();
        if (valRes) {
          logs.push(`[Asset Validation] Processed asset ${valRes.assetId}. Success: ${valRes.success}, Status: ${valRes.status}`);
        } else {
          logs.push(`[Asset Validation] No assets in VALIDATING state require validation.`);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logs.push(`[Asset Validation] [ERROR] Validation task failed: ${msg}`);
      }
    }

    return NextResponse.json({ success: true, logs });
  } catch (error) {
    console.error('Error in worker route:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  return handleWorkerPost(request, defaultWorkerRouteDependencies);
}
