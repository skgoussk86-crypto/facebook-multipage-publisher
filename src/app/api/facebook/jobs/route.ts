import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminSession, getSessionUser } from '@/lib/auth';
import { getVideoJobs } from '@/lib/db';
import { validateJobInput, normalizeMockScenario } from '@/lib/validation';
import { MockScenario } from '@prisma/client';
import { prisma } from '@/lib/prisma-client';
import { bulkCreateScheduledJobs } from '@/lib/job-state-machine';
import { resolveStorageReference } from '@/lib/storage';

interface SchedulableThumbnailAsset {
  id: string;
  userId: string;
  sourceUploadAssetId: string;
  provider: string;
  storageUri: string;
  deletedAt: Date | null;
}

const FORBIDDEN_BROWSER_THUMBNAIL_FIELDS = [
  'gcsThumbnailUri',
  'thumbnailStorageUri',
  'thumbnailUri',
  'thumbnailProvider',
  'thumbnailBucket',
  'thumbnailObjectKey',
  'thumbnailUserId',
] as const;

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function sanitizeCreatedJob(job: unknown): Record<string, unknown> {
  if (!job || typeof job !== 'object') {
    return {};
  }

  const record = job as Record<string, unknown>;
  return {
    id: record.id,
    pageId: record.pageId,
    uploadAssetId: record.uploadAssetId ?? null,
    thumbnailAssetId: record.thumbnailAssetId ?? null,
    englishTitle: record.englishTitle,
    englishCaption: record.englishCaption,
    hashtags: record.hashtags ?? null,
    scheduledTimeUTC: record.scheduledTimeUTC,
    status: record.status,
    mockScenario: record.mockScenario ?? MockScenario.SUCCESS,
    contentType: record.contentType ?? 'VIDEO',
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    isReused: record.isReused === true,
  };
}

export interface JobsRouteDependencies {
  getSessionUser: typeof getSessionUser;
  verifyAdminSession: typeof verifyAdminSession;
  getVideoJobs: (
    userId: string
  ) => Promise<Array<import('@prisma/client').VideoJob & { facebookPage?: import('@prisma/client').FacebookPage | null }>>;
  findUploadAsset: (id: string) => Promise<{
    id: string;
    userId: string;
    status: string;
    provider: string;
    bucket: string;
    objectKey: string;
    objectDeletedAt?: Date | null;
  } | null>;
  findThumbnailAsset?: (id: string) => Promise<SchedulableThumbnailAsset | null>;
  findUserPages: (userId: string) => Promise<Array<{ id: string }>>;
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
  findThumbnailAsset: async (id) => {
    return await prisma.thumbnailAsset.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        sourceUploadAssetId: true,
        provider: true,
        storageUri: true,
        deletedAt: true,
      },
    });
  },
  findUserPages: async (userId) => {
    return await prisma.facebookPage.findMany({
      where: { userId },
      select: { id: true }
    });
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
      const pageName = job.facebookPage?.pageName || null;
      return {
        id: job.id,
        pageId: job.pageId,
        pageName,
        englishTitle: job.englishTitle,
        englishCaption: job.englishCaption,
        hashtags: job.hashtags,
        scheduledTimeUTC: job.scheduledTimeUTC,
        status: job.status,
        mockScenario: job.mockScenario ?? MockScenario.SUCCESS,
        contentType: job.contentType,
        uploadAssetId: job.uploadAssetId,
        thumbnailAssetId: job.thumbnailAssetId,
        fileName,
        attemptCount: job.attemptCount,
        lastErrorMessage: job.lastErrorMessage,
        attempts: job.attempts,
        metaPostId: job.metaPostId,
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

    // Pre-verify page ownership via dependencies
    const userPages = await dependencies.findUserPages(user.id);
    const pageIds = new Set(userPages.map(p => p.id));

    const results: Array<{
      index: number;
      status: 'SUCCESS' | 'DUPLICATE' | 'FAILED';
      job?: unknown;
      error?: string;
    }> = new Array(jobs.length);

    type ScheduledJobInput = Parameters<typeof bulkCreateScheduledJobs>[2][number];
    const jobsToCreate: Array<ScheduledJobInput & { originalIndex: number }> = [];

    // Validate each job schema and load UploadAsset
    for (let index = 0; index < jobs.length; index++) {
      const job = jobs[index];

      if (!job || typeof job !== 'object' || Array.isArray(job)) {
        results[index] = { index, status: 'FAILED', error: 'Each video job must be an object.' };
        continue;
      }

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
        results[index] = { index, status: 'FAILED', error: errors.join(', ') };
        continue;
      }

      // Check for browser-supplied URIs and reject them, including null placeholders.
      if (
        Object.prototype.hasOwnProperty.call(job, 'gcsVideoUri') ||
        Object.prototype.hasOwnProperty.call(job, 'storageUri')
      ) {
        errors.push("Manually specified storage references are not accepted.");
      }

      // Pre-confirm page ownership
      if (!pageIds.has(job.pageId)) {
        errors.push("Unauthorized page association.");
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
        if (asset.objectDeletedAt) {
          errors.push("Upload asset is deleted.");
        }
        if (asset.provider !== 'GOOGLE_DRIVE' && asset.provider !== 'R2' && asset.provider !== 'GCS') {
          errors.push(`Unsupported storage provider "${asset.provider}".`);
        }
      }

      for (const field of FORBIDDEN_BROWSER_THUMBNAIL_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(job, field)) {
          errors.push('Manually specified thumbnail storage references are not accepted.');
          break;
        }
      }

      let thumbnailAssetId: string | null = null;
      const requestedThumbnailAssetId = job.thumbnailAssetId;

      if (requestedThumbnailAssetId !== undefined && requestedThumbnailAssetId !== null) {
        if (typeof requestedThumbnailAssetId !== 'string' || !isUuid(requestedThumbnailAssetId.trim())) {
          errors.push('thumbnailAssetId must be a valid UUID.');
        } else if (!asset) {
          errors.push('Thumbnail asset cannot be validated without its source upload asset.');
        } else {
          const thumbnail = await (dependencies.findThumbnailAsset ?? defaultJobsRouteDependencies.findThumbnailAsset!)(requestedThumbnailAssetId.trim());

          if (!thumbnail) {
            errors.push('Thumbnail asset not found.');
          } else {
            if (thumbnail.userId !== user.id) {
              errors.push('Unauthorized thumbnail asset.');
            }
            if (thumbnail.sourceUploadAssetId !== asset.id) {
              errors.push('Thumbnail asset does not belong to the selected upload asset.');
            }
            if (thumbnail.deletedAt) {
              errors.push('Thumbnail asset is deleted.');
            }
            if (thumbnail.provider !== 'GOOGLE_DRIVE' || !thumbnail.storageUri.startsWith('gdrive://')) {
              errors.push('Thumbnail asset storage provider is invalid.');
            }

            if (errors.length === 0) {
              thumbnailAssetId = thumbnail.id;
            }
          }
        }
      }

      let mockScenarioVal: MockScenario = MockScenario.SUCCESS;
      try {
        mockScenarioVal = normalizeMockScenario(job.mockScenario);
      } catch {
        errors.push("Invalid mockScenario value.");
      }

      if (errors.length > 0) {
        results[index] = { index, status: 'FAILED', error: errors.join(', ') };
        continue;
      }

      if (asset) {
        // Resolve internal storage references securely using the centralized helper
        const { gcsVideoUri, storageUri } = resolveStorageReference(asset);

        jobsToCreate.push({
          originalIndex: index,
          pageId: job.pageId,
          uploadAssetId: asset.id,
          gcsVideoUri: gcsVideoUri ?? null,
          storageUri: storageUri ?? null,
          gcsThumbnailUri: null,
          thumbnailAssetId,
          englishTitle: job.englishTitle,
          englishCaption: job.englishCaption ?? '',
          hashtags: job.hashtags ?? null,
          scheduledTimeUTC: new Date(job.scheduledTimeUTC),
          mockScenario: mockScenarioVal,
          contentType: job.contentType ?? 'VIDEO'
        });
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let created: any[] = [];
    if (jobsToCreate.length > 0) {
      const strippedJobs = jobsToCreate.map((j) => ({
        pageId: j.pageId,
        uploadAssetId: j.uploadAssetId,
        gcsVideoUri: j.gcsVideoUri,
        storageUri: j.storageUri,
        gcsThumbnailUri: null,
        thumbnailAssetId: j.thumbnailAssetId,
        englishTitle: j.englishTitle,
        englishCaption: j.englishCaption,
        hashtags: j.hashtags,
        scheduledTimeUTC: j.scheduledTimeUTC,
        mockScenario: j.mockScenario,
        contentType: j.contentType
      }));
      created = await dependencies.bulkCreateScheduledJobs(user.id, strippedJobs);

      for (let i = 0; i < jobsToCreate.length; i++) {
        const originalIndex = jobsToCreate[i].originalIndex;
        const job = created[i];

        const isDuplicate = !!job.isReused;
        const safeJob = sanitizeCreatedJob(job);

        results[originalIndex] = {
          index: originalIndex,
          status: isDuplicate ? 'DUPLICATE' : 'SUCCESS',
          job: safeJob
        };
      }
    }

    const hasSuccess = results.some(r => r && (r.status === 'SUCCESS' || r.status === 'DUPLICATE'));
    if (!hasSuccess) {
      const allErrors = results.map(r => r ? r.error : 'Unknown error').filter(Boolean) as string[];
      if (allErrors.some(err => err.includes('page association') || err.includes('Page selection') || err.includes('page selection') || err.includes('Page association'))) {
        return NextResponse.json(
          { error: 'Invalid Facebook Page selection.', details: allErrors },
          { status: 400 }
        );
      }
      return NextResponse.json({ error: 'Validation failed', details: allErrors }, { status: 400 });
    }

    const safeCreated = created.map((job) => sanitizeCreatedJob(job));
    return NextResponse.json({ success: true, count: safeCreated.length, jobs: safeCreated, results });
  } catch (error) {
    console.error('Error creating video jobs:', error);
    const msg = error instanceof Error ? error.message : '';
    if (msg.includes('Unauthorized page association') || msg.includes('Page selection')) {
      return NextResponse.json(
        { error: 'Invalid Facebook Page selection.' },
        { status: 400 }
      );
    }
    if (msg.includes('different thumbnail')) {
      return NextResponse.json(
        { error: 'A matching scheduled job already exists with a different thumbnail.' },
        { status: 409 }
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
