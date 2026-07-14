import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminSession } from '@/lib/auth';
import { retryJob } from '@/lib/job-state-machine';
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

    const retriedJob = await prisma.$transaction(async (tx) => {
      return await retryJob(tx, id, user.id);
    });

    return NextResponse.json({ success: true, job: retriedJob });
  } catch (error) {
    console.error('Error retrying job:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal Server Error' },
      { status: error instanceof Error && error.message.includes('Permission') ? 403 : 400 }
    );
  }
}
