import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminSession, getSessionUser } from '@/lib/auth';
import { getVideoJobs } from '@/lib/db';
import { validateJobInput } from '@/lib/validation';
import { MockScenario } from '@prisma/client';
import { prisma } from '@/lib/prisma-client';
import { bulkCreateScheduledJobs } from '@/lib/job-state-machine';
import { resolveStorageReference } from '@/lib/storage';

export interface JobsRouteDependencies {
  getSessionUser: typeof getSessionUser;
  verifyAdminSession: typeof verifyAdminSession;
  getVideoJobs: typeof getVideoJobs;
  findUploadAsset: (id: string) => Promise<{
    id: string;
    userId: string;
    status: string;
    provider: string;
    bucket: string;
    objectKey: string;
  } | null>;
  bulkCreateScheduledJobs: (
    userId: string,
    jobs: Array<Parameters<typeof bulkCreateScheduledJobs>[2][number]>
  ) => Promise<unknown[]>;
}

export const defaultJobsRouteDependencies: JobsRouteDependencies = {
  getSessionUser: () => getSessionUser(),
  verifyAdminSession: (request) => verifyAdminSession(request),
  getVideoJobs: (userId) => getVideoJobs(userId),
  findUploadAsset: async (id) => {
    return await prisma.uploadAsset.findUnique({ where: { id } });
  },
  bulkCreateScheduledJobs: async (userId, jobs) => {
    return await prisma.$transaction(async (tx) => {
      return await bulkCreateScheduledJobs(tx, userId, jobs);
    });
  }
};

export async function handleJobsGet(
  request: NextRequest,
  dependencies: JobsRouteDependencies = defaultJobsRouteDependencies
): Promise<NextResponse> {
  try {
    const user = await dependencies.getSessionUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const jobs = await dependencies.getVideoJobs(user.id);
    const safeJobs = jobs.map((job) => {
      const uri = job.storageUri ?? job.gcsVideoUri;
      const fileName = uri?.split("/").pop() || "video.mp4";
      return {
        id: job.id,
        pageId: job.pageId,
        englishTitle: job.englishTitle,
        englishCaption: job.englishCaption,
        hashtags: job.hashtags,
        scheduledTimeUTC: job.scheduledTimeUTC,
        status: job.status,
        mockScenario: job.mockScenario ?? MockScenario.SUCCESS,
        contentType: job.contentType,
        uploadAssetId: job.uploadAssetId,
        fileName,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      };
    });

    return NextResponse.json(safeJobs);
  } catch (error) {
    console.error('Error fetching video jobs:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function handleJobsPost(
  request: NextRequest,
  dependencies: JobsRouteDependencies = defaultJobsRouteDependencies
): Promise<NextResponse> {
  try {
    const user = await dependencies.verifyAdminSession(request);

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { jobs } = body;

    if (!Array.isArray(jobs) || jobs.length === 0) {
      return NextResponse.json({ error: 'No video jobs provided.' }, { status: 400 });
    }

    const validationErrors: string[] = [];
    type ScheduledJobInput = Parameters<typeof bulkCreateScheduledJobs>[2][number];
    const jobsToCreate: ScheduledJobInput[] = [];

    // Validate each job schema and load UploadAsset
    for (let index = 0; index < jobs.length; index++) {
      const job = jobs[index];
      const errors = validateJobInput({
        englishTitle: job.englishTitle,
        englishCaption: job.englishCaption || '',
        hashtags: job.hashtags || '',
        scheduledTimeUTC: job.scheduledTimeUTC,
        pageId: job.pageId
      });

      const assetId = job.uploadAssetId;
      if (!assetId || typeof assetId !== 'string' || assetId.trim() === '') {
        errors.push("uploadAssetId is required.");
        validationErrors.push(`Job ${index + 1} ("${job.englishTitle || 'Untitled'}") errors: ${errors.join(', ')}`);
        continue;
      }

      // Check for browser-supplied URIs and reject them
      if (job.gcsVideoUri || job.storageUri) {
        errors.push("Manually specified storage references are not accepted.");
      }

      // Fetch UploadAsset using uploadAssetId
      const asset = await dependencies.findUploadAsset(assetId);

      if (!asset) {
        errors.push("Upload asset not found.");
      } else {
        if (asset.userId !== user.id) {
          errors.push("Unauthorized upload asset.");
        }
        if (asset.status !== 'VALIDATED') {
          errors.push(`Upload asset status must be VALIDATED (current status: ${asset.status}).`);
        }
      }

      if (errors.length > 0) {
        validationErrors.push(`Job ${index + 1} ("${job.englishTitle || 'Untitled'}") errors: ${errors.join(', ')}`);
        continue;
      }

      if (asset) {
        // Resolve internal storage references securely using the centralized helper
        const { gcsVideoUri, storageUri } = resolveStorageReference(asset);

        jobsToCreate.push({
          pageId: job.pageId,
          uploadAssetId: asset.id,
          gcsVideoUri: gcsVideoUri ?? null,
          storageUri: storageUri ?? null,
          gcsThumbnailUri: job.gcsThumbnailUri ?? null,
          englishTitle: job.englishTitle,
          englishCaption: job.englishCaption ?? '',
          hashtags: job.hashtags ?? null,
          scheduledTimeUTC: new Date(job.scheduledTimeUTC),
          mockScenario: job.mockScenario ?? MockScenario.SUCCESS,
          contentType: job.contentType ?? 'VIDEO'
        });
      }
    }

    if (validationErrors.length > 0) {
      return NextResponse.json({ error: 'Validation failed', details: validationErrors }, { status: 400 });
    }

    // Route scheduling creation transactionally through the state machine
    const created = await dependencies.bulkCreateScheduledJobs(user.id, jobsToCreate);

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

export async function GET(request: NextRequest) {
  return handleJobsGet(request);
}

export async function POST(request: NextRequest) {
  return handleJobsPost(request);
}
