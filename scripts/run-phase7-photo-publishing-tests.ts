import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';

import { JobStatus } from '@prisma/client';
import { NextRequest } from 'next/server';

import { AiService, AiVideoAnalysisError } from '../src/lib/ai';
import { OllamaClient } from '../src/lib/ai/ollama/ollama-client';
import { OllamaImageReader } from '../src/lib/ai/ollama/ollama-image-reader';
import { FacebookPublishingService } from '../src/lib/facebook/facebook-publishing-service';
import { canTransition, recoverExpiredLease } from '../src/lib/job-state-machine';
import {
  handleJobsGet,
  handleJobsPost,
  type JobsRouteDependencies,
} from '../src/app/api/facebook/jobs/route';
import { normalizeDashboardJobs } from '../src/lib/validation';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const PAGE_ID = '22222222-2222-4222-8222-222222222222';
const PHOTO_ASSET_ID = '33333333-3333-4333-8333-333333333333';
const VIDEO_ASSET_ID = '44444444-4444-4444-8444-444444444444';
const THUMBNAIL_ID = '55555555-5555-4555-8555-555555555555';
const META_PAGE_ID = '123456789012345';
const PAGE_TOKEN = 'EAAB-secret-page-token';

function createJobsRequest(job: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/facebook/jobs', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      host: 'localhost:3000',
      origin: 'http://localhost:3000',
    },
    body: JSON.stringify({ jobs: [job] }),
  });
}

function createJobInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pageId: PAGE_ID,
    uploadAssetId: PHOTO_ASSET_ID,
    englishTitle: 'A New Photo Update',
    englishCaption: 'A clear and accurate caption for this photo post.',
    hashtags: '#Photo #Update #Community #Moment #NewPost',
    scheduledTimeUTC: new Date(Date.now() + 60_000).toISOString(),
    contentType: 'PHOTO',
    ...overrides,
  };
}

function createJobsDependencies(capture: { jobs?: unknown[] }): JobsRouteDependencies {
  return {
    getSessionUser: async () => ({ id: USER_ID } as never),
    verifyAdminSession: async () => ({ id: USER_ID } as never),
    getVideoJobs: async () => [],
    findUserPages: async () => [{ id: PAGE_ID }],
    findUploadAsset: async (id) => {
      if (id === PHOTO_ASSET_ID) {
        return {
          id,
          userId: USER_ID,
          status: 'VALIDATED',
          provider: 'GOOGLE_DRIVE',
          bucket: 'drive-folder-id',
          objectKey: 'drive-photo-file-id',
          originalName: 'photo.webp',
          declaredMimeType: 'image/webp',
          detectedMimeType: 'image/webp',
          objectDeletedAt: null,
        };
      }

      if (id === VIDEO_ASSET_ID) {
        return {
          id,
          userId: USER_ID,
          status: 'VALIDATED',
          provider: 'GOOGLE_DRIVE',
          bucket: 'drive-folder-id',
          objectKey: 'drive-video-file-id',
          originalName: 'video.mp4',
          declaredMimeType: 'video/mp4',
          detectedMimeType: 'video/mp4',
          objectDeletedAt: null,
        };
      }

      return null;
    },
    findThumbnailAsset: async (id) => id === THUMBNAIL_ID
      ? {
          id,
          userId: USER_ID,
          sourceUploadAssetId: PHOTO_ASSET_ID,
          provider: 'GOOGLE_DRIVE',
          storageUri: 'gdrive://thumbnail-id',
          deletedAt: null,
        }
      : null,
    bulkCreateScheduledJobs: async (userId, jobs) => {
      capture.jobs = jobs;
      return jobs.map((job, index) => ({
        id: `job-${index}`,
        userId,
        ...job,
        status: 'SCHEDULED',
        createdAt: new Date(),
        updatedAt: new Date(),
      })) as never;
    },
  };
}

async function readRequestBody(init: RequestInit): Promise<Buffer> {
  return Buffer.from(await new Response(init.body).arrayBuffer());
}

async function testFacebookPhotoPublishing(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const photoBytes = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x01, 0x02, 0x03, 0x04]);
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  let capturedBody: Buffer = Buffer.alloc(0);

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedInit = init;
    capturedBody = await readRequestBody(init || {});
    return new Response(JSON.stringify({
      id: 'photo-object-123',
      post_id: 'page-post-456',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const result = await FacebookPublishingService.publishPhoto({
      pageId: META_PAGE_ID,
      pageToken: PAGE_TOKEN,
      title: 'Photo title',
      caption: 'Photo caption that accurately describes the image.',
      hashtags: '#One #Two #Three #Four #Five',
      fileName: 'photo.webp',
      mimeType: 'image/webp',
      fileSize: photoBytes.length,
      stream: Readable.from(photoBytes),
    });

    assert.deepEqual(result, {
      photoId: 'photo-object-123',
      postId: 'page-post-456',
    });
    assert.match(capturedUrl, new RegExp(`/${META_PAGE_ID}/photos$`));
    assert.equal(capturedUrl.includes(PAGE_TOKEN), false);
    assert.equal(capturedInit?.method, 'POST');
    assert.match(String(new Headers(capturedInit?.headers).get('content-type')), /^multipart\/form-data; boundary=/);
    assert.equal(Number(new Headers(capturedInit?.headers).get('content-length')), capturedBody.length);
    assert.notEqual(capturedBody.indexOf(photoBytes), -1);

    const bodyText = capturedBody.toString('latin1');
    assert.match(bodyText, /name="access_token"/);
    assert.match(bodyText, new RegExp(PAGE_TOKEN));
    assert.match(bodyText, /name="published"[\s\S]*true/);
    assert.match(bodyText, /name="message"[\s\S]*Photo title[\s\S]*Photo caption/);
    assert.match(bodyText, /name="source"; filename="photo\.webp"/);
    assert.match(bodyText, /Content-Type: image\/webp/);
  } finally {
    globalThis.fetch = originalFetch;
  }

  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response('{}', { status: 200 });
  }) as typeof fetch;

  try {
    await assert.rejects(
      FacebookPublishingService.publishPhoto({
        pageId: META_PAGE_ID,
        pageToken: PAGE_TOKEN,
        title: 'Invalid',
        caption: 'Invalid GIF image upload.',
        hashtags: null,
        fileName: 'photo.gif',
        mimeType: 'image/gif' as never,
        fileSize: 3,
        stream: Readable.from(Buffer.from('gif')),
      }),
      /META_PHOTO_INVALID_INPUT/,
    );
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = (async (_input, init) => {
    await readRequestBody(init || {});
    return new Response('{}', { status: 200 });
  }) as typeof fetch;

  try {
    await assert.rejects(
      FacebookPublishingService.publishPhoto({
        pageId: META_PAGE_ID,
        pageToken: PAGE_TOKEN,
        title: 'Mismatch',
        caption: 'The validated size does not match the stream.',
        hashtags: null,
        fileName: 'photo.jpg',
        mimeType: 'image/jpeg',
        fileSize: 10,
        stream: Readable.from(Buffer.from('short')),
      }),
      /META_PHOTO_SIZE_MISMATCH/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = (async (_input, init) => {
    await readRequestBody(init || {});
    return new Response(JSON.stringify({
      error: {
        code: 200,
        message: `Permission rejected for ${PAGE_TOKEN}`,
      },
    }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    await assert.rejects(
      async () => {
        try {
          await FacebookPublishingService.publishPhoto({
            pageId: META_PAGE_ID,
            pageToken: PAGE_TOKEN,
            title: 'Permission',
            caption: 'Permission error test caption.',
            hashtags: null,
            fileName: 'photo.png',
            mimeType: 'image/png',
            fileSize: 3,
            stream: Readable.from(Buffer.from('png')),
          });
        } catch (error) {
          assert.match((error as Error).message, /^META_PERMISSION_ERROR:/);
          assert.equal((error as Error).message.includes(PAGE_TOKEN), false);
          throw error;
        }
      },
      /META_PERMISSION_ERROR/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}



async function testOllamaImageReader(): Promise<void> {
  const bytes = Buffer.from('image-bytes');
  const baseAsset = {
    id: PHOTO_ASSET_ID,
    userId: USER_ID,
    provider: 'GOOGLE_DRIVE',
    objectKey: 'drive-photo-file-id',
    originalName: 'photo.jpg',
    expectedSize: BigInt(bytes.length),
    actualSize: BigInt(bytes.length),
    declaredMimeType: 'image/jpeg',
    detectedMimeType: 'image/jpeg',
  };

  const result = await OllamaImageReader.readImage({
    userId: USER_ID,
    asset: baseAsset,
    dependencies: {
      getDownloadStream: async () => Readable.from(bytes),
    },
  });
  assert.equal(result.mimeType, 'image/jpeg');
  assert.deepEqual(Buffer.from(result.base64Image, 'base64'), bytes);

  await assert.rejects(
    OllamaImageReader.readImage({
      userId: USER_ID,
      asset: {
        ...baseAsset,
        actualSize: BigInt(bytes.length + 1),
      },
      dependencies: {
        getDownloadStream: async () => Readable.from(bytes),
      },
    }),
    (error: unknown) => error instanceof AiVideoAnalysisError && error.code === 'IMAGE_DOWNLOAD_FAILED',
  );
}

async function testOllamaImageMetadata(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const requestCapture: { body?: Record<string, unknown> } = {};

  globalThis.fetch = (async (_input, init) => {
    requestCapture.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      message: {
        content: JSON.stringify({
          title: 'Five Details in One Image',
          caption: 'A concise and accurate description of the uploaded still image.',
          hashtags: ['#Photo', '#Details', '#Visual', '#Moment', '#Update'],
          thumbnailTimestampSeconds: 0,
        }),
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const client = new OllamaClient({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'test-vision-model',
      timeoutMs: 5_000,
    });
    const result = await client.generateImageMetadata({
      mimeType: 'image/png',
      base64Image: Buffer.from('png-bytes').toString('base64'),
    });

    assert.equal(result.hashtags.length, 5);
    assert.equal(result.thumbnailTimestampSeconds, 0);
    const requestBody = requestCapture.body;
    assert.ok(requestBody);
    assert.equal(requestBody.model, 'test-vision-model');
    const messages = requestBody.messages as Array<{ images?: string[]; content?: string }>;
    assert.equal(messages[1]?.images?.length, 1);
    assert.match(messages[1]?.content || '', /exactly one JSON object/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testImageAiOrchestration(): Promise<void> {
  const originalProvider = process.env.AI_PROVIDER;
  process.env.AI_PROVIDER = 'OLLAMA';

  let framesCalled = false;
  let readerCalled = false;
  let generatorCalled = false;

  try {
    const result = await AiService.analyzeValidatedAsset(
      USER_ID,
      PHOTO_ASSET_ID,
      {
        findAsset: async () => ({
          id: PHOTO_ASSET_ID,
          userId: USER_ID,
          provider: 'GOOGLE_DRIVE',
          objectKey: 'drive-photo-file-id',
          status: 'VALIDATED',
          originalName: 'photo.jpg',
          expectedSize: BigInt(4),
          actualSize: BigInt(4),
          declaredMimeType: 'image/jpeg',
          detectedMimeType: 'image/jpeg',
          durationMs: null,
          objectDeletedAt: null,
        }),
        extractFrames: async () => {
          framesCalled = true;
          return { timestamps: [], base64Frames: [] };
        },
        readImage: async () => {
          readerCalled = true;
          return {
            mimeType: 'image/jpeg',
            base64Image: Buffer.from('test').toString('base64'),
          };
        },
        generateOllamaImageMetadata: async ({ mimeType, base64Image }) => {
          generatorCalled = true;
          assert.equal(mimeType, 'image/jpeg');
          assert.equal(Buffer.from(base64Image, 'base64').toString(), 'test');
          return {
            title: 'AI Photo Title',
            caption: 'An accurate AI-generated caption for the uploaded photo.',
            hashtags: ['#Photo', '#Update', '#Moment', '#Image', '#Social'],
            thumbnailTimestampSeconds: 0,
          };
        },
      },
    );

    assert.equal(readerCalled, true);
    assert.equal(generatorCalled, true);
    assert.equal(framesCalled, false);
    assert.equal(result.hashtags.length, 5);
    assert.equal(result.thumbnailTimestampSeconds, 0);

    await assert.rejects(
      AiService.analyzeValidatedAsset(USER_ID, PHOTO_ASSET_ID, {
        findAsset: async () => ({
          id: PHOTO_ASSET_ID,
          userId: USER_ID,
          provider: 'GOOGLE_DRIVE',
          objectKey: 'drive-gif-file-id',
          status: 'VALIDATED',
          originalName: 'photo.gif',
          expectedSize: BigInt(4),
          actualSize: BigInt(4),
          declaredMimeType: 'image/gif',
          detectedMimeType: 'image/gif',
          durationMs: null,
          objectDeletedAt: null,
        }),
      }),
      (error: unknown) => error instanceof AiVideoAnalysisError && error.code === 'INVALID_IMAGE_METADATA',
    );
  } finally {
    if (originalProvider === undefined) {
      delete process.env.AI_PROVIDER;
    } else {
      process.env.AI_PROVIDER = originalProvider;
    }
  }
}

async function testPhotoSchedulingBoundary(): Promise<void> {
  const capture: { jobs?: unknown[] } = {};
  const dependencies = createJobsDependencies(capture);

  let response = await handleJobsPost(
    createJobsRequest(createJobInput()),
    dependencies,
  );
  assert.equal(response.status, 200);
  const successPayload = await response.json();
  assert.equal(successPayload.results[0].status, 'SUCCESS');
  assert.equal((capture.jobs?.[0] as { contentType?: string }).contentType, 'PHOTO');
  assert.equal((capture.jobs?.[0] as { thumbnailAssetId?: string | null }).thumbnailAssetId, null);

  response = await handleJobsPost(
    createJobsRequest(createJobInput({
      uploadAssetId: VIDEO_ASSET_ID,
    })),
    dependencies,
  );
  assert.equal(response.status, 400);
  assert.match(JSON.stringify(await response.json()), /PHOTO jobs require a validated JPEG, PNG, or WebP image asset/);

  response = await handleJobsPost(
    createJobsRequest(createJobInput({
      contentType: 'VIDEO',
    })),
    dependencies,
  );
  assert.equal(response.status, 400);
  assert.match(JSON.stringify(await response.json()), /VIDEO and REEL jobs require a validated MP4 or MOV video asset/);

  response = await handleJobsPost(
    createJobsRequest(createJobInput({
      thumbnailAssetId: THUMBNAIL_ID,
    })),
    dependencies,
  );
  assert.equal(response.status, 400);
  assert.match(JSON.stringify(await response.json()), /PHOTO jobs do not accept a separate thumbnail asset/);

  const getResponse = await handleJobsGet(
    new NextRequest('http://localhost:3000/api/facebook/jobs'),
    {
      ...dependencies,
      getVideoJobs: async () => [{
        id: 'photo-job',
        pageId: PAGE_ID,
        userId: USER_ID,
        storageUri: 'gdrive://opaque-photo-file-id',
        gcsVideoUri: null,
        englishTitle: 'Saved photo',
        englishCaption: 'Saved photo caption.',
        hashtags: '#One #Two #Three #Four #Five',
        scheduledTimeUTC: new Date(Date.now() + 60_000),
        status: JobStatus.SCHEDULED,
        mockScenario: null,
        contentType: 'PHOTO',
        uploadAssetId: PHOTO_ASSET_ID,
        thumbnailAssetId: null,
        attemptCount: 0,
        lastErrorMessage: null,
        attempts: null,
        metaPostId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        uploadAsset: { originalName: 'photo.webp' },
        facebookPage: { pageName: 'Photo Page' },
      } as never],
    },
  );
  assert.equal(getResponse.status, 200);
  const returnedJobs = await getResponse.json();
  assert.equal(returnedJobs[0]?.fileName, 'photo.webp');
}


async function testPhotoLeaseRecovery(): Promise<void> {
  const updateCapture: { data?: Record<string, unknown> } = {};
  let auditAction = '';
  const now = new Date();

  const tx = {
    videoJob: {
      findUnique: async () => ({
        id: 'photo-job-id',
        userId: USER_ID,
        status: JobStatus.UPLOADING_TO_META,
        contentType: 'PHOTO',
        providerProcessingId: 'meta-photo-123',
        metaPostId: null,
        completedAt: null,
        lockExpiresAt: new Date(now.getTime() - 60_000),
        lockedAt: new Date(now.getTime() - 120_000),
        attemptCount: 1,
        maxAttempts: 3,
        attempts: [],
      }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updateCapture.data = data;
        return {};
      },
    },
    auditLog: {
      create: async ({ data }: { data: { action: string } }) => {
        auditAction = data.action;
        return {};
      },
    },
  };

  await recoverExpiredLease(tx as never, 'photo-job-id');
  const updateData = updateCapture.data;
  assert.ok(updateData);
  assert.equal(updateData.status, JobStatus.PUBLISHED);
  assert.equal(updateData.metaPostId, 'meta-photo-123');
  assert.equal(updateData.lockToken, null);
  assert.equal(auditAction, 'JOB_PHOTO_LEASE_RECONCILED');
}

function testDashboardAndWorkerIntegration(): void {
  assert.equal(
    canTransition(JobStatus.UPLOADING_TO_META, JobStatus.PUBLISHED),
    true,
  );

  const normalized = normalizeDashboardJobs([{
    id: 'job-photo',
    pageId: PAGE_ID,
    englishTitle: 'Saved photo',
    contentType: 'PHOTO',
    scheduledTimeUTC: new Date(Date.now() + 60_000).toISOString(),
  }]);
  assert.equal(normalized[0]?.contentType, 'PHOTO');
  assert.equal(normalized[0]?.fileName, 'image.jpg');

  const dashboard = readFileSync('src/app/DashboardClient.tsx', 'utf8');
  const worker = readFileSync('src/lib/job-worker.ts', 'utf8');
  const route = readFileSync('src/app/api/facebook/jobs/route.ts', 'utf8');
  const aiService = readFileSync('src/lib/ai/ai-service.ts', 'utf8');

  assert.match(dashboard, /const isPhoto = job\.contentType === "PHOTO"/);
  assert.match(dashboard, /AI generated title, caption, and five hashtags/);
  assert.match(dashboard, /Facebook Photo/);
  assert.match(dashboard, /isPhoto \? "PHOTO" : isReel \? "REEL" : "VIDEO"/);
  assert.match(worker, /FacebookPublishingService\.publishPhoto/);
  assert.match(worker, /PHOTO_RESULT_PERSISTENCE_CONFLICT/);
  assert.match(worker, /JobStatus\.FACEBOOK_RECONNECT_REQUIRED/);
  assert.match(route, /PHOTO jobs require a validated JPEG, PNG, or WebP image asset/);
  assert.match(route, /job\.uploadAsset\?\.originalName/);
  assert.match(aiService, /OllamaImageReader/);
  assert.match(aiService, /generateOllamaImageMetadata/);
}

async function main(): Promise<void> {
  console.log('Running Phase 7B2 photo AI and publishing tests...');
  await testFacebookPhotoPublishing();
  console.log('✓ Meta Page photo multipart publishing and error sanitization');
  await testOllamaImageReader();
  console.log('✓ Bounded Google Drive image reader and exact-size enforcement');
  await testOllamaImageMetadata();
  console.log('✓ Ollama image metadata schema and image payload');
  await testImageAiOrchestration();
  console.log('✓ Image AI orchestration without video frame extraction');
  await testPhotoSchedulingBoundary();
  console.log('✓ PHOTO scheduling trust boundary and MIME matching');
  await testPhotoLeaseRecovery();
  console.log('✓ Expired PHOTO lease finalizes from persisted Meta ID without re-upload');
  testDashboardAndWorkerIntegration();
  console.log('✓ Dashboard, state machine, and worker integration assertions');
  console.log('PHASE7_PHOTO_PUBLISHING_TESTS=PASSED');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
