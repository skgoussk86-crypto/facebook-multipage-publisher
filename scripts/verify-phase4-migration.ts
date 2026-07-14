import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

interface Baseline {
  userCount: number;
  accountCount: number;
  pageCount: number;
  jobCount: number;
  jobs: Array<{
    id: string;
    gcsVideoUri: string | null;
  }>;
}

async function runVerification() {
  const args = process.argv.slice(2);
  const mode = args[0];
  const baselinePath = args[1];

  if (!mode || !baselinePath || (mode !== '--capture' && mode !== '--verify')) {
    console.error('Usage: tsx scripts/verify-phase4-migration.ts [--capture|--verify] <baseline-path>');
    process.exit(1);
  }

  const resolvedPath = path.resolve(baselinePath);

  if (mode === '--capture') {
    console.log('Running CAPTURE mode...');

    // Queries that work before new columns and tables exist
    const userCount = await prisma.user.count();
    const accountCount = await prisma.facebookAccount.count();
    const pageCount = await prisma.facebookPage.count();
    const jobCount = await prisma.videoJob.count();

    // Query only existing columns
    const rawJobs = await prisma.videoJob.findMany({
      select: {
        id: true,
        gcsVideoUri: true,
      },
    });

    const baseline: Baseline = {
      userCount,
      accountCount,
      pageCount,
      jobCount,
      jobs: rawJobs,
    };

    fs.writeFileSync(resolvedPath, JSON.stringify(baseline, null, 2), 'utf-8');
    console.log(`Baseline successfully written to ${resolvedPath}`);
  } else if (mode === '--verify') {
    console.log('Running VERIFY mode...');

    if (!fs.existsSync(resolvedPath)) {
      console.error(`Baseline file not found at ${resolvedPath}`);
      process.exit(1);
    }

    const baseline: Baseline = JSON.parse(fs.readFileSync(resolvedPath, 'utf-8'));

    // Check counts
    const userCount = await prisma.user.count();
    const accountCount = await prisma.facebookAccount.count();
    const pageCount = await prisma.facebookPage.count();
    const jobCount = await prisma.videoJob.count();

    if (userCount !== baseline.userCount) {
      throw new Error(`Count mismatch: User count ${userCount} does not match baseline ${baseline.userCount}`);
    }
    if (accountCount !== baseline.accountCount) {
      throw new Error(`Count mismatch: FacebookAccount count ${accountCount} does not match baseline ${baseline.accountCount}`);
    }
    if (pageCount !== baseline.pageCount) {
      throw new Error(`Count mismatch: FacebookPage count ${pageCount} does not match baseline ${baseline.pageCount}`);
    }
    if (jobCount !== baseline.jobCount) {
      throw new Error(`Count mismatch: VideoJob count ${jobCount} does not match baseline ${baseline.jobCount}`);
    }

    // Check UploadAsset table availability
    try {
      const assetCount = await prisma.uploadAsset.count();
      console.log(`UploadAsset table verified. Current assets: ${assetCount}`);
    } catch (err) {
      console.error('UploadAsset table is not available or query failed:', err);
      throw err;
    }

    // Check existing VideoJob rows integrity including new columns
    const jobs = await prisma.videoJob.findMany({
      select: {
        id: true,
        gcsVideoUri: true,
        storageUri: true,
        uploadAssetId: true,
      },
    });

    const jobMap = new Map(jobs.map(j => [j.id, j]));

    for (const baselineJob of baseline.jobs) {
      const currentJob = jobMap.get(baselineJob.id);
      if (!currentJob) {
        throw new Error(`Integrity error: Baseline VideoJob ${baselineJob.id} is missing from the database`);
      }
      if (currentJob.gcsVideoUri !== baselineJob.gcsVideoUri) {
        throw new Error(`Integrity error: VideoJob ${baselineJob.id} gcsVideoUri "${currentJob.gcsVideoUri}" does not match baseline "${baselineJob.gcsVideoUri}"`);
      }
      if (currentJob.storageUri !== null) {
        throw new Error(`Integrity error: VideoJob ${baselineJob.id} has non-null storageUri`);
      }
      if (currentJob.uploadAssetId !== null) {
        throw new Error(`Integrity error: VideoJob ${baselineJob.id} has non-null uploadAssetId`);
      }
    }

    console.log('Verification checks completed successfully! All data is intact.');
  }
}

runVerification()
  .catch((err: unknown) => {
    console.error('Verification failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
