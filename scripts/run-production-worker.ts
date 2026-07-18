import { loadEnvConfig } from '@next/env';

// Load environment variables before any other imports
loadEnvConfig(process.cwd());

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main() {
  // Check if worker is explicitly enabled
  const enabled = process.env.WORKER_ENABLED === 'true';
  if (!enabled) {
    console.log('Background worker is disabled (WORKER_ENABLED is not set to "true"). Exiting cleanly.');
    process.exit(0);
  }

  // Enforce stable valid WORKER_ID UUID in production
  const workerId = process.env.WORKER_ID || '';
  if (!workerId) {
    console.error('CRITICAL: WORKER_ID environment variable is missing.');
    console.error('Each installed worker instance must be configured with a stable, unique UUID to prevent heartbeat row accumulation.');
    process.exit(1);
  }

  if (!uuidRegex.test(workerId)) {
    console.error(`CRITICAL: WORKER_ID environment variable value is not a valid UUID: "${workerId}"`);
    console.error('Each installed worker instance must be configured with a stable, unique UUID to prevent heartbeat row accumulation.');
    process.exit(1);
  }

  // Import worker runtime dynamically after environment loading and validation
  const { startWorkerDaemon, parseIntegerEnv } = await import('../src/lib/worker-runtime');

  // Parse and validate loop intervals
  let pollIntervalMs: number;
  let errorBackoffMs: number;
  try {
    pollIntervalMs = parseIntegerEnv(process.env.WORKER_POLL_INTERVAL_MS, 10000, 1000, 3600000, 'WORKER_POLL_INTERVAL_MS');
    errorBackoffMs = parseIntegerEnv(process.env.WORKER_ERROR_BACKOFF_MS, 30000, 5000, 3600000, 'WORKER_ERROR_BACKOFF_MS');
  } catch (err: unknown) {
    const error = err as Error;
    console.error(`CRITICAL: Startup configuration error. ${error.message}`);
    process.exit(1);
  }

  try {
    const controller = startWorkerDaemon({
      workerId,
      pollIntervalMs,
      errorBackoffMs,
      registerSignals: true,
    });

    await controller.completionPromise;
    process.exit(0);
  } catch (err: unknown) {
    const error = err as Error;
    console.error(`CRITICAL: Background worker daemon terminated unexpectedly. ${error.message}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('CRITICAL: Unexpected fatal crash in worker launcher:', err);
  process.exit(1);
});
