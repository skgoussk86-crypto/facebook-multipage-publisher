import { loadEnvConfig } from '@next/env';
import { randomUUID } from 'crypto';

// Load environment variables before any other imports
loadEnvConfig(process.cwd());

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main() {
  let workerId = process.env.WORKER_ID || '';
  if (workerId) {
    if (!uuidRegex.test(workerId)) {
      console.error(`CRITICAL: The supplied WORKER_ID is not a valid UUID: "${workerId}"`);
      process.exitCode = 1;
      return;
    }
  } else {
    workerId = randomUUID();
  }

  // Import worker runtime and prisma client dynamically after validations
  const { executeWorkerCycle } = await import('../src/lib/worker-runtime');
  const { prisma } = await import('../src/lib/prisma-client');

  console.log(`[Worker] Running one-cycle diagnostic for worker ${workerId}...`);
  const start = new Date();
  try {
    const { logs, processedCount } = await executeWorkerCycle(workerId, start);
    console.log('[Worker] One-cycle execution finished successfully.');
    console.log(`[Worker] Processed Count: ${processedCount}`);
    console.log('[Worker] Logs:');
    console.log(logs.join('\n'));
  } catch (error) {
    console.error('[Worker] One-cycle execution failed:', error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(err => {
  console.error('CRITICAL: Unexpected error in run-worker-once:', err);
  process.exitCode = 1;
});
