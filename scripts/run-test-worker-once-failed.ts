import { loadEnvConfig } from '@next/env';
import { randomUUID } from 'crypto';

// Load environment variables before any other imports
loadEnvConfig(process.cwd());

const databaseUrl = process.env.DATABASE_URL;

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main() {
  if (!databaseUrl) {
    console.error('DATABASE_URL is missing.');
    process.exitCode = 2;
    return;
  }

  let databaseName = '';
  try {
    const parsed = new URL(databaseUrl);
    databaseName = parsed.pathname.replace(/^\/+/, '');
  } catch {
    console.error('Invalid DATABASE_URL format.');
    process.exitCode = 2;
    return;
  }

  if (databaseName !== 'fb_publisher_test') {
    console.error(`Refusing test failure harness for database: ${databaseName}`);
    process.exitCode = 2;
    return;
  }

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

  // Import worker runtime dynamically after validations using standard relative path
  const { runWorkerOnce } = await import('../src/lib/worker-runtime');
  const { prisma } = await import('../src/lib/prisma-client');

  try {
    // Inject a failure dependency that throws a credential-leaking mock error
    await runWorkerOnce(workerId, {
      runQueueWorker: async () => {
        throw new Error('Forced mocked cycle failure with bearer token_secret_xyz');
      }
    });
  } catch (err) {
    // Re-throw so main catch handler handles it and sets exit code 1
    throw err;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(err => {
  console.error('[Worker] One-cycle execution failed:', err);
  process.exitCode = 1;
});
