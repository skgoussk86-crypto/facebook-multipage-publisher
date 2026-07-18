import { loadEnvConfig } from '@next/env';

// 1. Load environment variables before any other imports
loadEnvConfig(process.cwd());

const databaseUrl = process.env.DATABASE_URL;

// 2. Validate DATABASE_URL and database name
let databaseName = '';
if (databaseUrl) {
  try {
    const parsed = new URL(databaseUrl);
    databaseName = parsed.pathname.replace(/^\/+/, '');
  } catch {
    // Ignored, databaseName remains empty
  }
}

if (databaseName !== 'fb_publisher_test') {
  console.error(`Refusing test failure harness for database: ${databaseName}`);
  process.exitCode = 2;
} else {
  // 3. Only then dynamically import worker-runtime and execute
  import('crypto').then(async ({ randomUUID }) => {
    async function execute() {
      const workerId = process.env.WORKER_ID || randomUUID();

      // Dynamic imports of dependent modules
      const { runWorkerOnce } = await import('../src/lib/worker-runtime');

      await runWorkerOnce(workerId, {
        validateOneAsset: async () => {
          throw new Error('Forced asset validation failure with secret_key=bearer_12345');
        }
      });
    }

    execute().catch(err => {
      console.error('[Worker] One-cycle execution failed:', err);
      process.exitCode = 1;
    });
  });
}
