import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminSession } from '@/lib/auth';
import { manualTriggerJob } from '@/lib/job-state-machine';
import { runQueueWorker, generateWorkerToken } from '@/lib/job-worker';
import { prisma } from '@/lib/prisma-client';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const user = await verifyAdminSession(request);

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const workerToken = generateWorkerToken();

    // Claim the job and transition status to PREPARING atomically
    const triggeredJob = await prisma.$transaction(async (tx) => {
      return await manualTriggerJob(tx, id, user.id, workerToken);
    });

    // Execute the mock worker processing run on this specific job synchronously
    const executionLogs = await runQueueWorker(workerToken, id);

    // Reload job to return updated final status
    const finalJob = await prisma.videoJob.findUnique({
      where: { id }
    });

    return NextResponse.json({
      success: true,
      job: finalJob || triggeredJob,
      logs: executionLogs
    });
  } catch (error) {
    console.error('Error triggering job:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal Server Error' },
      { status: error instanceof Error && error.message.includes('Permission') ? 403 : 400 }
    );
  }
}
