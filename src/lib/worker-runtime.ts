import { runQueueWorker } from './job-worker';
import { VideoValidationService } from './storage';
import { updateWorkerHeartbeat, sanitizeErrorMessage } from './worker-health';
import { prisma } from './prisma-client';

export interface WorkerController {
  shutdown: () => Promise<void>;
  completionPromise: Promise<void>;
}

export function parseIntegerEnv(
  value: string | undefined,
  defaultValue: number,
  min: number,
  max: number,
  name: string
): number {
  if (value === undefined || value.trim() === '') {
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || isNaN(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid configuration: ${name} must be an integer between ${min} and ${max}. Got: ${value}`);
  }
  return parsed;
}

export async function executeWorkerCycle(
  workerId: string,
  startedAt: Date = new Date(),
  options?: {
    updateFinalHeartbeat?: boolean;
    runQueueWorker?: (workerId: string) => Promise<string[]>;
    validateOneAsset?: () => Promise<{ assetId: string; success: boolean; status: string } | null>;
    updateWorkerHeartbeat?: (params: {
      workerId: string;
      startedAt: Date;
      currentStatus: string;
      success?: boolean;
      jobsProcessed?: number;
      nextPollEstimate?: Date | null;
      lastError?: string | null;
    }) => Promise<void>;
  }
): Promise<{ logs: string[]; processedCount: number }> {
  const logs: string[] = [];
  let processedCount = 0;

  const fnRunQueueWorker = options?.runQueueWorker ?? runQueueWorker;
  const fnValidateOneAsset = options?.validateOneAsset ?? (() => VideoValidationService.validateOneAsset());
  const fnUpdateWorkerHeartbeat = options?.updateWorkerHeartbeat ?? updateWorkerHeartbeat;

  try {
    // 1. Update heartbeat to RUNNING
    await fnUpdateWorkerHeartbeat({
      workerId,
      startedAt,
      currentStatus: 'RUNNING',
    });

    // 2. Process Video Jobs queue
    const workerLogs = await fnRunQueueWorker(workerId);
    logs.push(...workerLogs);
    processedCount += countProcessedJobs(workerLogs);

    // 3. Process video validations
    try {
      const validationResult = await fnValidateOneAsset();
      if (validationResult) {
        logs.push(`[Asset Validation] Processed asset ${validationResult.assetId}. Success: ${validationResult.success}, Status: ${validationResult.status}`);
        processedCount++;
      } else {
        logs.push(`[Asset Validation] No assets in VALIDATING state require validation.`);
      }
    } catch (validationError: unknown) {
      const msg = validationError instanceof Error ? validationError.message : String(validationError);
      const sanitizedMsg = sanitizeErrorMessage(msg) || '';
      logs.push(`[Asset Validation] [ERROR] Validation task failed: ${sanitizedMsg}`);
      throw new Error(`Asset validation failed: ${sanitizedMsg}`);
    }

    if (options?.updateFinalHeartbeat !== false) {
      // Update heartbeat to IDLE (Success)
      await fnUpdateWorkerHeartbeat({
        workerId,
        startedAt,
        currentStatus: 'IDLE',
        success: true,
        jobsProcessed: processedCount,
        nextPollEstimate: null,
      });
    }
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logs.push(`[Worker Error] Cycle failed: ${errorMsg}`);

    if (options?.updateFinalHeartbeat !== false) {
      // Update heartbeat to FAILED
      await fnUpdateWorkerHeartbeat({
        workerId,
        startedAt,
        currentStatus: 'FAILED',
        success: false,
        lastError: errorMsg,
        nextPollEstimate: null,
      });
    }
    throw error;
  }

  return { logs, processedCount };
}

function countProcessedJobs(logs: string[]): number {
  let count = 0;
  for (const log of logs) {
    if (log.includes('Claimed Job') || log.includes('Claimed META_PROCESSING')) {
      count++;
    }
  }
  return count;
}

let globalSignalHandlersRegistered = false;
const activeControllers: WorkerController[] = [];

export function startWorkerDaemon(params: {
  workerId: string;
  pollIntervalMs?: number;
  errorBackoffMs?: number;
  registerSignals?: boolean;
}): WorkerController {
  const pollInterval = params.pollIntervalMs ?? 10000;
  const errorBackoff = params.errorBackoffMs ?? 30000;

  console.log(`[Worker] Starting background worker daemon. Worker ID: ${params.workerId}`);
  console.log(`[Worker] Poll Interval: ${pollInterval}ms, Error Backoff: ${errorBackoff}ms`);

  let loopShutdownRequested = false;
  let loopIsProcessing = false;
  let loopTimeoutId: NodeJS.Timeout | null = null;
  let currentResolveSleep: (() => void) | null = null;
  let activeCyclePromise: Promise<unknown> | null = null;
  let prismaDisconnected = false;

  const shutdown = async () => {
    if (loopShutdownRequested) {
      return;
    }
    loopShutdownRequested = true;

    console.log('[Worker] Graceful shutdown requested. Writing STOPPING status...');
    try {
      await updateWorkerHeartbeat({
        workerId: params.workerId,
        startedAt: new Date(),
        currentStatus: 'STOPPING',
      });
    } catch (e) {
      console.error('[Worker] Failed to write STOPPING heartbeat status:', e);
    }

    if (loopTimeoutId) {
      clearTimeout(loopTimeoutId);
      loopTimeoutId = null;
    }

    if (currentResolveSleep) {
      currentResolveSleep();
      currentResolveSleep = null;
    }

    if (loopIsProcessing && activeCyclePromise) {
      console.log('[Worker] Active cycle in progress during shutdown. Awaiting completion...');
      await activeCyclePromise;
    }

    console.log('[Worker] Writing STOPPED status...');
    try {
      await updateWorkerHeartbeat({
        workerId: params.workerId,
        startedAt: new Date(),
        currentStatus: 'STOPPED',
      });
    } catch (e) {
      console.error('[Worker] Failed to write STOPPED heartbeat status:', e);
    }

    if (!prismaDisconnected) {
      prismaDisconnected = true;
      await prisma.$disconnect();
      console.log('[Worker] Prisma client disconnected.');
    }

    // Remove from active list
    const idx = activeControllers.indexOf(controller);
    if (idx !== -1) {
      activeControllers.splice(idx, 1);
    }
  };

  const completionPromise = (async () => {
    while (!loopShutdownRequested) {
      const cycleStart = new Date();
      loopIsProcessing = true;
      let hasError = false;

      let cycleErrorMsg: string | null = null;
      // Update heartbeat to RUNNING is handled by executeWorkerCycle
      activeCyclePromise = executeWorkerCycle(params.workerId, cycleStart, { updateFinalHeartbeat: false })
        .then((res) => {
          if (res.processedCount > 0) {
            console.log(`[Worker] Tick completed. Processed ${res.processedCount} items.`);
          }
        })
        .catch((err) => {
          console.error('[Worker] Cycle execution failed:', err);
          hasError = true;
          cycleErrorMsg = err instanceof Error ? err.message : String(err);
        });

      await activeCyclePromise;
      activeCyclePromise = null;
      loopIsProcessing = false;

      if (loopShutdownRequested) {
        break;
      }

      // Calculate next tick timing and write next status
      const nextDelay = hasError ? errorBackoff : pollInterval;
      const nextPollEstimate = new Date(Date.now() + nextDelay);
      const statusAfterCycle = hasError ? 'BACKING_OFF' : 'IDLE';

      await updateWorkerHeartbeat({
        workerId: params.workerId,
        startedAt: cycleStart,
        currentStatus: statusAfterCycle,
        success: !hasError,
        nextPollEstimate,
        lastError: hasError ? cycleErrorMsg : null,
      });

      // Sleep safely until next cycle or interrupted by shutdown
      await new Promise<void>((resolve) => {
        currentResolveSleep = resolve;
        loopTimeoutId = setTimeout(() => {
          currentResolveSleep = null;
          loopTimeoutId = null;
          resolve();
        }, nextDelay);
      });
    }

    console.log('[Worker] Worker loop terminated safely.');
    if (!prismaDisconnected) {
      prismaDisconnected = true;
      await prisma.$disconnect();
    }
  })();

  const controller: WorkerController = {
    shutdown,
    completionPromise,
  };

  activeControllers.push(controller);

  if (params.registerSignals && !globalSignalHandlersRegistered) {
    globalSignalHandlersRegistered = true;

    const handleSignal = async (signal: string) => {
      console.log(`[Worker] Intercepted ${signal}. Triggering shutdown for all active workers...`);
      const activeCopy = [...activeControllers];
      for (const ctrl of activeCopy) {
        await ctrl.shutdown();
      }
    };

    process.on('SIGINT', () => handleSignal('SIGINT'));
    process.on('SIGTERM', () => handleSignal('SIGTERM'));
  }

  return controller;
}

export async function runWorkerOnce(
  workerId: string,
  options?: {
    runQueueWorker?: (workerId: string) => Promise<string[]>;
    validateOneAsset?: () => Promise<{ assetId: string; success: boolean; status: string } | null>;
  }
): Promise<void> {
  const { prisma } = await import('./prisma-client');

  console.log(`[Worker] Running one-cycle diagnostic for worker ${workerId}...`);
  const start = new Date();
  try {
    const { logs, processedCount } = await executeWorkerCycle(workerId, start, {
      updateFinalHeartbeat: true,
      runQueueWorker: options?.runQueueWorker,
      validateOneAsset: options?.validateOneAsset,
    });
    console.log('[Worker] One-cycle execution finished successfully.');
    console.log(`[Worker] Processed Count: ${processedCount}`);
    console.log('[Worker] Logs:');
    console.log(logs.join('\n'));
  } catch (error) {
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}
