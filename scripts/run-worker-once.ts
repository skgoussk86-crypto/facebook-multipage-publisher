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

  // Import worker runtime dynamically after validations
  const { runWorkerOnce } = await import('../src/lib/worker-runtime');

  await runWorkerOnce(workerId);
}

main().catch(err => {
  console.error('CRITICAL: Unexpected error in run-worker-once:', err);
  process.exitCode = 1;
});
