import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminSession, getSessionUser } from '@/lib/auth';
import { getVideoJobs } from '@/lib/db';
import { validateJobInput } from '@/lib/validation';
import { MockScenario } from '@prisma/client';
import { prisma } from '@/lib/prisma-client';
import { bulkCreateScheduledJobs } from '@/lib/job-state-machine';

export async function GET() {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const jobs = await getVideoJobs(user.id);
    return NextResponse.json({ jobs });
  } catch (error) {
    console.error('Error fetching jobs:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await verifyAdminSession(request);

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { jobs } = body;

    if (!Array.isArray(jobs) || jobs.length === 0) {
      return NextResponse.json({ error: 'No video jobs provided.' }, { status: 400 });
    }

    const validationErrors: string[] = [];
    
    // Validate each job schema
    jobs.forEach((job, index) => {
      const errors = validateJobInput({
        englishTitle: job.englishTitle,
        englishCaption: job.englishCaption || '',
        hashtags: job.hashtags || '',
        scheduledTimeUTC: job.scheduledTimeUTC,
        pageId: job.pageId
      });

      const gcsUri = job.gcsVideoUri;
      if (!gcsUri || typeof gcsUri !== 'string' || gcsUri.trim() === '') {
        errors.push("Media upload URI is missing.");
      } else if (!/^gcs:\/\/([^\/]+)\/(.+)$/.test(gcsUri)) {
        errors.push("Invalid media upload URI format. Must start with 'gcs://' followed by a bucket name and object path (e.g. 'gcs://bucket-name/path/video.mp4').");
      }

      if (errors.length > 0) {
        validationErrors.push(`Job ${index + 1} ("${job.englishTitle || 'Untitled'}") errors: ${errors.join(', ')}`);
      }
    });

    if (validationErrors.length > 0) {
      return NextResponse.json({ error: 'Validation failed', details: validationErrors }, { status: 400 });
    }

    // Map fields for db insertion (excluding status)
    const jobsToCreate = jobs.map((job) => ({
      pageId: job.pageId,
      gcsVideoUri: job.gcsVideoUri,
      gcsThumbnailUri: job.gcsThumbnailUri || null,
      englishTitle: job.englishTitle,
      englishCaption: job.englishCaption || '',
      hashtags: job.hashtags || null,
      scheduledTimeUTC: new Date(job.scheduledTimeUTC),
      mockScenario: (job.mockScenario || 'SUCCESS') as MockScenario,
      contentType: job.contentType
    }));

    // Route scheduling creation transactionally through the state machine
    const created = await prisma.$transaction(async (tx) => {
      return await bulkCreateScheduledJobs(tx, user.id, jobsToCreate);
    });

    return NextResponse.json({ success: true, count: created.length, jobs: created });
  } catch (error) {
    console.error('Error creating video jobs:', error);
    const msg = error instanceof Error ? error.message : '';
    if (msg.includes('Unauthorized page association') || msg.includes('Page selection')) {
      return NextResponse.json(
        { error: 'Invalid Facebook Page selection.' },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}
