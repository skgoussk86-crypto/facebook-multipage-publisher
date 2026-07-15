import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminSession, verifyAdminRole } from '@/lib/auth';
import { runQueueWorker, generateWorkerToken } from '@/lib/job-worker';
import { VideoValidationService } from '@/lib/storage';

export type WorkerRouteDependencies = {
  verifyAdminSession: typeof verifyAdminSession;
  verifyAdminRole: typeof verifyAdminRole;
  runQueueWorker: typeof runQueueWorker;
  validateOneAsset: typeof VideoValidationService.validateOneAsset;
};

const defaultWorkerRouteDependencies: WorkerRouteDependencies = {
  verifyAdminSession,
  verifyAdminRole,
  runQueueWorker,
  validateOneAsset: VideoValidationService.validateOneAsset
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
    const logs = await dependencies.runQueueWorker(workerToken);

    // Call provider-neutral uploaded-video validation task
    try {
      const validationResult = await dependencies.validateOneAsset();
      if (validationResult) {
        logs.push(`[Asset Validation] Processed asset ${validationResult.assetId}. Success: ${validationResult.success}, Status: ${validationResult.status}`);
      } else {
        logs.push(`[Asset Validation] No assets in VALIDATING state require validation.`);
      }
    } catch (validationError: unknown) {
      const msg = validationError instanceof Error ? validationError.message : String(validationError);
      logs.push(`[Asset Validation] [ERROR] Validation task failed: ${msg}`);
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
