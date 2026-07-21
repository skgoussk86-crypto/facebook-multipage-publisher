import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { FacebookPublishingService } from '../src/lib/facebook/facebook-publishing-service';
import { runQueueWorker } from '../src/lib/job-worker';
import { Readable } from 'stream';

const dbUrl = process.env.DATABASE_URL || '';
let dbName = '';
try {
  const parsedUrl = new URL(dbUrl);
  dbName = decodeURIComponent(parsedUrl.pathname.slice(1));
} catch {
  console.error('REFUSED: Invalid DATABASE_URL format.');
  process.exit(1);
}

if (dbName !== 'fb_publisher_test') {
  console.error('REFUSED: Refusing to run tests against database ' + JSON.stringify(dbName) + '.');
  console.error('Database name must equal exactly "fb_publisher_test".');
  process.exit(1);
}

const prisma = new PrismaClient();

function mockStreamOfSize(size: number): Readable {
  let bytesSent = 0;
  return new Readable({
    read(chunkSize) {
      if (bytesSent >= size) {
        this.push(null);
        return;
      }
      const toSend = Math.min(chunkSize, size - bytesSent);
      this.push(Buffer.alloc(toSend));
      bytesSent += toSend;
    }
  });
}

function assert(cond: boolean, msg: string) {
  if (!cond) {
    throw new Error('Test Assertion Failed: ' + msg);
  }
}

async function runTests() {
  console.log('Running Focused Phase 6L: Meta Resumable Upload Offset & Diagnostics Tests...\n');

  const testUserId = randomUUID();
  const testPageId = randomUUID();
  const testAccountId = randomUUID();

  // Create mock user
  await prisma.user.create({
    data: {
      id: testUserId,
      email: `test-6l-${testUserId.slice(0, 8)}@example.com`,
      passwordHash: 'dummy',
      role: 'USER',
      status: 'ACTIVE',
      approvalStatus: 'APPROVED'
    }
  });

  // Create facebook account & page
  await prisma.facebookAccount.create({
    data: {
      id: testAccountId,
      userId: testUserId,
      facebookUserId: 'fb-user-6l',
      name: 'Test Account 6L',
      encryptedAccessToken: 'dummy',
      tokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
    }
  });

  const { encryptToken } = await import('../src/lib/crypto');
  const encryptedPageToken = encryptToken('secret_token_12345'); // Page token to ensure it isn't logged

  await prisma.facebookPage.create({
    data: {
      id: testPageId,
      userId: testUserId,
      accountId: testAccountId,
      facebookPageId: 'page-6l',
      pageName: 'My Test Page 6L',
      encryptedPageToken: encryptedPageToken,
      pageCategory: 'Mock',
      pagePictureUrl: 'url',
      isSynced: true
    }
  });

  // Set AppConfig liveMode
  await prisma.appConfiguration.upsert({
    where: { id: 'default' },
    update: { liveMetaMode: true },
    create: {
      id: 'default',
      liveMetaMode: true,
      publicAppUrl: 'http://localhost:3000',
      facebookAppId: 'app-6l',
      encryptedAppSecret: 'secret_app_secret_abc'
    }
  });

  let testCount = 0;

  // Helper to create asset
  async function createTestAsset(sizeBytes: number) {
    const assetId = randomUUID();
    return await prisma.uploadAsset.create({
      data: {
        id: assetId,
        userId: testUserId,
        provider: 'GOOGLE_DRIVE',
        bucket: 'test-bucket',
        objectKey: `key-${assetId}`,
        originalName: 'test-video.mp4',
        expectedSize: BigInt(sizeBytes),
        declaredMimeType: 'video/mp4',
        status: 'VALIDATED',
        idempotencyKey: `idem-${assetId}`,
        requestFingerprint: `finger-${assetId}`,
        uploadExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
      }
    });
  }

  // 1. Start response with valid start_offset/end_offset
  {
    global.fetch = async () => {
      return new Response(JSON.stringify({
        upload_session_id: 'session-1',
        video_id: 'video-1',
        start_offset: '0',
        end_offset: 1000
      }), { status: 200 });
    };

    const res = await FacebookPublishingService.startUploadSession('page-1', 'token-1', 5000);
    assert(res.uploadSessionId === 'session-1', 'Should return correct uploadSessionId');
    assert(res.videoId === 'video-1', 'Should return correct videoId');
    assert(res.startOffset === 0, 'Should return correct startOffset');
    assert(res.endOffset === 1000, 'Should return correct endOffset');
    testCount++;
    console.log('✓ Test 1: Start response with valid offsets parsed successfully.');
  }

  // 2. Start response with malformed offsets
  {
    const malformedPayloads = [
      { start_offset: -1, end_offset: 1000 },
      { start_offset: 'abc', end_offset: 1000 },
      { start_offset: 0, end_offset: NaN },
      { start_offset: 100, end_offset: 50 }, // decreasing
      { start_offset: 0, end_offset: 6000 }  // exceeds fileSize (5000)
    ];

    for (const payload of malformedPayloads) {
      global.fetch = async () => new Response(JSON.stringify({
        upload_session_id: 'session-1',
        video_id: 'video-1',
        ...payload
      }), { status: 200 });

      let threw = false;
      try {
        await FacebookPublishingService.startUploadSession('page-1', 'token-1', 5000);
      } catch (error: unknown) {
        const err = error as Error;
        threw = true;
        assert(
          err.message.includes('META_OFFSET_INVALID') || err.message.includes('META_OFFSET_MISSING'),
          `Should throw META_OFFSET_INVALID or META_OFFSET_MISSING, got: ${err.message}`
        );
      }
      assert(threw, 'Should have thrown for malformed payload: ' + JSON.stringify(payload));
    }
    testCount++;
    console.log('✓ Test 2: Start response with malformed offsets is rejected strictly.');
  }

  // 3. Transfer response returns the next authoritative offsets
  {
    global.fetch = async () => new Response(JSON.stringify({
      start_offset: '1000',
      end_offset: '2000'
    }), { status: 200 });

    const res = await FacebookPublishingService.uploadChunk('page-1', 'token-1', 'sess-1', 0, Buffer.alloc(1000));
    assert(res.startOffset === 1000, 'Should return next start offset');
    assert(res.endOffset === 2000, 'Should return next end offset');
    testCount++;
    console.log('✓ Test 3: Transfer response parses next authoritative offsets.');
  }

  // 4. Worker follows provider offsets rather than local chunk length + stream boundaries
  // 5. Meta requests chunk sizes different from Google Drive stream boundaries
  // 6. Partial stream chunks are accumulated correctly
  // 7. Remaining accumulator bytes are preserved for next provider range
  {
    const fileSize = 15; // Small file size for deterministic boundary check
    const asset = await createTestAsset(fileSize);

    // Simulate stream emitting chunks in size 2, 3, 4, 6 (total size = 15)
    const mockChunks = [
      Buffer.from([0x01, 0x02]),
      Buffer.from([0x03, 0x04, 0x05]),
      Buffer.from([0x06, 0x07, 0x08, 0x09]),
      Buffer.from([0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f])
    ];

    const { GoogleDriveMediaReader } = await import('../src/lib/google-drive/google-drive-media-reader');
    GoogleDriveMediaReader.getDownloadStream = async () => {
      return Readable.from(mockChunks);
    };

    // Meta will request offsets: 0->5, 5->12, 12->15
    const requestedRanges: { start: number; length: number }[] = [];
    let startCalls = 0;
    let transferCalls = 0;
    let finishCalls = 0;

    global.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes('/videos') && init?.method === 'POST') {
        const body = init.body ? (typeof init.body === 'string' ? JSON.parse(init.body) : init.body) : {};

        if (body.upload_phase === 'start') {
          startCalls++;
          return new Response(JSON.stringify({
            upload_session_id: 'session-4',
            video_id: 'video-4',
            start_offset: 0,
            end_offset: 5 // Meta requests first 5 bytes
          }), { status: 200 });
        }

        const headers = init?.headers as Record<string, string> | undefined;
        if (headers && headers['Content-Type']?.includes('multipart/form-data')) {
          transferCalls++;
          // Parse start_offset from multipart fields in body buffer
          const bodyBuffer = init.body as Buffer;
          const startOffsetMatch = bodyBuffer.toString('utf8').match(/name="start_offset"\r\n\r\n(\d+)\r\n/);
          const currentStartOffset = startOffsetMatch ? parseInt(startOffsetMatch[1], 10) : -1;

          // Find the chunk buffer itself to verify size
          const startBoundaryIndex = bodyBuffer.indexOf('Content-Type: application/octet-stream\r\n\r\n');
          const chunkDataStart = startBoundaryIndex + 'Content-Type: application/octet-stream\r\n\r\n'.length;

          const contentType = headers['Content-Type'];
          const boundaryMatch = contentType.match(/boundary=(.+)/);
          const boundary = boundaryMatch ? boundaryMatch[1] : '';
          const footerBoundary = `\r\n--${boundary}`;

          const chunkDataEnd = bodyBuffer.indexOf(Buffer.from(footerBoundary), chunkDataStart);
          const chunkBytes = bodyBuffer.subarray(chunkDataStart, chunkDataEnd);

          requestedRanges.push({ start: currentStartOffset, length: chunkBytes.length });

          if (currentStartOffset === 0) {
            assert(chunkBytes.length === 5, 'First chunk should be exactly 5 bytes');
            return new Response(JSON.stringify({
              start_offset: 5,
              end_offset: 12 // Meta requests next 7 bytes (5 to 12)
            }), { status: 200 });
          } else if (currentStartOffset === 5) {
            assert(chunkBytes.length === 7, 'Second chunk should be exactly 7 bytes');
            return new Response(JSON.stringify({
              start_offset: 12,
              end_offset: 15 // Meta requests last 3 bytes (12 to 15)
            }), { status: 200 });
          } else if (currentStartOffset === 12) {
            assert(chunkBytes.length === 3, 'Third chunk should be exactly 3 bytes');
            return new Response(JSON.stringify({
              start_offset: 15,
              end_offset: 15 // Upload complete
            }), { status: 200 });
          }
        }

        if (body.upload_phase === 'finish') {
          finishCalls++;
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }
      }
      return new Response(JSON.stringify({}), { status: 404 });
    };

    const job = await prisma.videoJob.create({
      data: {
        userId: testUserId,
        pageId: testPageId,
        uploadAssetId: asset.id,
        englishTitle: 'Stream Accumulator Job',
        englishCaption: 'capt',
        scheduledTimeUTC: new Date(Date.now() - 5000),
        status: 'SCHEDULED'
      }
    });

    await runQueueWorker(randomUUID(), job.id);

    assert(startCalls === 1, 'Should call start session once');
    assert(transferCalls === 3, 'Should call transfer exactly 3 times');
    assert(finishCalls === 1, 'Should call finish once');

    // Confirm that the chunk boundaries sent to Meta match what was requested, not what the Google Drive stream yielded!
    assert(requestedRanges[0].start === 0 && requestedRanges[0].length === 5, 'First range mismatch');
    assert(requestedRanges[1].start === 5 && requestedRanges[1].length === 7, 'Second range mismatch');
    assert(requestedRanges[2].start === 12 && requestedRanges[2].length === 3, 'Third range mismatch');

    testCount++;
    console.log('✓ Tests 4-7: Stream accumulator correctly matches provider-authoritative offsets across stream chunk boundaries.');
  }

  // 8. Offset moves backward validation
  {
    const asset = await createTestAsset(1000);
    const { GoogleDriveMediaReader } = await import('../src/lib/google-drive/google-drive-media-reader');
    GoogleDriveMediaReader.getDownloadStream = async () => {
      return mockStreamOfSize(1000);
    };

    let callCount = 0;
    global.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes('/videos')) {
        const body = init?.body ? (typeof init.body === 'string' ? JSON.parse(init.body) : init.body) : {};
        if (body.upload_phase === 'start') {
          return new Response(JSON.stringify({
            upload_session_id: 'session-8',
            video_id: 'video-8',
            start_offset: 0,
            end_offset: 500
          }), { status: 200 });
        }
        const headers = init?.headers as Record<string, string> | undefined;
        if (headers && headers['Content-Type']?.includes('multipart/form-data')) {
          callCount++;
          if (callCount === 1) {
            return new Response(JSON.stringify({
              start_offset: 600,
              end_offset: 800
            }), { status: 200 });
          } else {
            return new Response(JSON.stringify({
              start_offset: 400, // backward from prevStartOffset 600!
              end_offset: 700
            }), { status: 200 });
          }
        }
      }
      return new Response('', { status: 404 });
    };

    const job = await prisma.videoJob.create({
      data: {
        userId: testUserId,
        pageId: testPageId,
        uploadAssetId: asset.id,
        englishTitle: 'Backward Offset Job',
        englishCaption: 'capt',
        scheduledTimeUTC: new Date(Date.now() - 5000),
        status: 'SCHEDULED'
      }
    });

    await runQueueWorker(randomUUID(), job.id);
    const updatedJob = await prisma.videoJob.findUnique({ where: { id: job.id } });
    assert(updatedJob?.status === 'SCHEDULED', 'Should revert to SCHEDULED for retry');
    assert(updatedJob?.lastErrorCode === 'META_UPLOAD_FAILED', 'Should map code to META_UPLOAD_FAILED');
    assert(updatedJob?.lastErrorMessage?.includes('META_UPLOAD_BACKWARD_OFFSET') === true, 'Should include backward offset description');

    testCount++;
    console.log('✓ Test 8: Offset moving backward triggers immediate error and marks job retry.');
  }

  // 9. Offset makes no progress validation
  {
    const asset = await createTestAsset(1000);
    const { GoogleDriveMediaReader } = await import('../src/lib/google-drive/google-drive-media-reader');
    GoogleDriveMediaReader.getDownloadStream = async () => {
      return mockStreamOfSize(1000);
    };

    global.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes('/videos')) {
        const body = init?.body ? (typeof init.body === 'string' ? JSON.parse(init.body) : init.body) : {};
        if (body.upload_phase === 'start') {
          return new Response(JSON.stringify({
            upload_session_id: 'session-9',
            video_id: 'video-9',
            start_offset: 0,
            end_offset: 500
          }), { status: 200 });
        }
        const headers = init?.headers as Record<string, string> | undefined;
        if (headers && headers['Content-Type']?.includes('multipart/form-data')) {
          return new Response(JSON.stringify({
            start_offset: 0, // no progress!
            end_offset: 500
          }), { status: 200 });
        }
      }
      return new Response('', { status: 404 });
    };

    const job = await prisma.videoJob.create({
      data: {
        userId: testUserId,
        pageId: testPageId,
        uploadAssetId: asset.id,
        englishTitle: 'No Progress Job',
        englishCaption: 'capt',
        scheduledTimeUTC: new Date(Date.now() - 5000),
        status: 'SCHEDULED'
      }
    });

    await runQueueWorker(randomUUID(), job.id);
    const updatedJob = await prisma.videoJob.findUnique({ where: { id: job.id } });
    assert(updatedJob?.lastErrorMessage?.includes('META_UPLOAD_NO_PROGRESS') === true, 'Should include no progress description');

    testCount++;
    console.log('✓ Test 9: Zero-progress loops are detected and rejected.');
  }

  // 10. Offset exceeds known file size validation
  {
    const asset = await createTestAsset(1000);
    const { GoogleDriveMediaReader } = await import('../src/lib/google-drive/google-drive-media-reader');
    GoogleDriveMediaReader.getDownloadStream = async () => {
      return mockStreamOfSize(1000);
    };

    global.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes('/videos')) {
        const body = init?.body ? (typeof init.body === 'string' ? JSON.parse(init.body) : init.body) : {};
        if (body.upload_phase === 'start') {
          return new Response(JSON.stringify({
            upload_session_id: 'session-10',
            video_id: 'video-10',
            start_offset: 0,
            end_offset: 500
          }), { status: 200 });
        }
        const headers = init?.headers as Record<string, string> | undefined;
        if (headers && headers['Content-Type']?.includes('multipart/form-data')) {
          return new Response(JSON.stringify({
            start_offset: 1200, // exceeds file size 1000!
            end_offset: 1500
          }), { status: 200 });
        }
      }
      return new Response('', { status: 404 });
    };

    const job = await prisma.videoJob.create({
      data: {
        userId: testUserId,
        pageId: testPageId,
        uploadAssetId: asset.id,
        englishTitle: 'Exceeds File Size Job',
        englishCaption: 'capt',
        scheduledTimeUTC: new Date(Date.now() - 5000),
        status: 'SCHEDULED'
      }
    });

    await runQueueWorker(randomUUID(), job.id);
    const updatedJob = await prisma.videoJob.findUnique({ where: { id: job.id } });
    assert(updatedJob?.lastErrorMessage?.includes('META_UPLOAD_EXCEEDS_FILE_SIZE') === true, 'Should include exceeds file size description');

    testCount++;
    console.log('✓ Test 10: Offsets exceeding known file size are strictly rejected.');
  }

  // 11. Final provider offset does not equal file size validation
  // 12. Finish is not called after an incomplete upload
  {
    const asset = await createTestAsset(1000);
    const { GoogleDriveMediaReader } = await import('../src/lib/google-drive/google-drive-media-reader');
    GoogleDriveMediaReader.getDownloadStream = async () => {
      return mockStreamOfSize(1000);
    };

    let finishCalled = false;

    global.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes('/videos')) {
        const body = init?.body ? (typeof init.body === 'string' ? JSON.parse(init.body) : init.body) : {};
        if (body.upload_phase === 'start') {
          return new Response(JSON.stringify({
            upload_session_id: 'session-11',
            video_id: 'video-11',
            start_offset: 0,
            end_offset: 500
          }), { status: 200 });
        }
        const headers = init?.headers as Record<string, string> | undefined;
        if (headers && headers['Content-Type']?.includes('multipart/form-data')) {
          // Meta signals completion using equal offsets (800->800) but it is less than file size (1000)!
          return new Response(JSON.stringify({
            start_offset: 800,
            end_offset: 800
          }), { status: 200 });
        }
        if (body.upload_phase === 'finish') {
          finishCalled = true;
          return new Response(JSON.stringify({ success: true }));
        }
      }
      return new Response('', { status: 404 });
    };

    const job = await prisma.videoJob.create({
      data: {
        userId: testUserId,
        pageId: testPageId,
        uploadAssetId: asset.id,
        englishTitle: 'Incomplete Completion Job',
        englishCaption: 'capt',
        scheduledTimeUTC: new Date(Date.now() - 5000),
        status: 'SCHEDULED'
      }
    });

    await runQueueWorker(randomUUID(), job.id);
    assert(!finishCalled, 'Finish must NOT be called on incomplete upload');
    const updatedJob = await prisma.videoJob.findUnique({ where: { id: job.id } });
    assert(updatedJob?.lastErrorMessage?.includes('META_UPLOAD_INCOMPLETE') === true, 'Should throw META_UPLOAD_INCOMPLETE');

    testCount++;
    console.log('✓ Tests 11-12: Incomplete final offset fails validation and prevents finish session call.');
  }

  // 13. Finish is called once after verified full upload
  {
    const asset = await createTestAsset(1000);
    const { GoogleDriveMediaReader } = await import('../src/lib/google-drive/google-drive-media-reader');
    GoogleDriveMediaReader.getDownloadStream = async () => {
      return mockStreamOfSize(1000);
    };

    let finishCalls = 0;

    global.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes('/videos')) {
        const body = init?.body ? (typeof init.body === 'string' ? JSON.parse(init.body) : init.body) : {};
        if (body.upload_phase === 'start') {
          return new Response(JSON.stringify({
            upload_session_id: 'session-13',
            video_id: 'video-13',
            start_offset: 0,
            end_offset: 1000
          }), { status: 200 });
        }
        const headers = init?.headers as Record<string, string> | undefined;
        if (headers && headers['Content-Type']?.includes('multipart/form-data')) {
          return new Response(JSON.stringify({
            start_offset: 1000,
            end_offset: 1000
          }), { status: 200 });
        }
        if (body.upload_phase === 'finish') {
          finishCalls++;
          return new Response(JSON.stringify({ success: true }));
        }
      }
      return new Response('', { status: 404 });
    };

    const job = await prisma.videoJob.create({
      data: {
        userId: testUserId,
        pageId: testPageId,
        uploadAssetId: asset.id,
        englishTitle: 'Successful Completing Job',
        englishCaption: 'capt',
        scheduledTimeUTC: new Date(Date.now() - 5000),
        status: 'SCHEDULED'
      }
    });

    await runQueueWorker(randomUUID(), job.id);
    assert(finishCalls === 1, 'Finish should be called exactly once');

    testCount++;
    console.log('✓ Test 13: Finish session called exactly once upon verified full file upload completion.');
  }

  // 14. Uploading-phase error extraction
  {
    global.fetch = async () => new Response(JSON.stringify({
      status: {
        video_status: 'error',
        uploading_phase: {
          status: 'error',
          errors: [{ code: 1363030, error_subcode: 123, message: 'Upload session expired' }]
        }
      }
    }), { status: 200 });

    const check = await FacebookPublishingService.checkVideoStatus('video-14', 'token');
    assert(check.status === 'error', 'Status must be error');
    assert(check.errorDetails?.phase === 'uploading', 'Phase must be uploading');
    assert(check.errorDetails?.code === 1363030, 'Should parse code');
    assert(check.errorDetails?.subcode === 123, 'Should parse subcode');
    assert(check.errorMsg?.includes('Upload session expired') === true, 'Should include message');

    testCount++;
    console.log('✓ Test 14: Uploading phase error code, subcode, phase, and message extracted correctly.');
  }

  // 15. Processing-phase error extraction & INVALID_MEDIA mapping
  {
    const asset = await createTestAsset(1000);
    global.fetch = async () => new Response(JSON.stringify({
      status: {
        video_status: 'error',
        processing_phase: {
          status: 'error',
          errors: [{ code: 3912005, error_subcode: 456, message: 'Transcoding failed due to format' }]
        }
      }
    }), { status: 200 });

    const check = await FacebookPublishingService.checkVideoStatus('video-15', 'token');
    assert(check.status === 'error', 'Status must be error');
    assert(check.errorDetails?.phase === 'processing', 'Phase must be processing');

    // Simulate worker parsing and transition
    const job = await prisma.videoJob.create({
      data: {
        userId: testUserId,
        pageId: testPageId,
        uploadAssetId: asset.id,
        englishTitle: 'Transcode Fail Job',
        englishCaption: 'capt',
        scheduledTimeUTC: new Date(Date.now() - 5000),
        status: 'META_PROCESSING',
        providerProcessingId: 'video-15',
        nextAttemptAt: new Date(Date.now() - 5000)
      }
    });

    await runQueueWorker(randomUUID(), job.id);
    const updatedJob = await prisma.videoJob.findUnique({ where: { id: job.id } });
    assert(updatedJob?.status === 'FAILED_PERMANENT', 'Should fail permanently');
    assert(updatedJob?.lastErrorCode === 'META_TRANSCODE_FAILED', 'Should record transcode failure code');
    assert(updatedJob?.failureClassification === 'INVALID_MEDIA', 'Should classify as INVALID_MEDIA');

    testCount++;
    console.log('✓ Test 15: Processing phase error parsed and mapped to INVALID_MEDIA classification.');
  }

  // 16. Publishing-phase error extraction
  {
    global.fetch = async () => new Response(JSON.stringify({
      status: {
        video_status: 'error',
        publishing_phase: {
          status: 'error',
          errors: [{ code: 10, error_subcode: 789, message: 'Insufficient publishing permissions' }]
        }
      }
    }), { status: 200 });

    const check = await FacebookPublishingService.checkVideoStatus('video-16', 'token');
    assert(check.status === 'error', 'Status must be error');
    assert(check.errorDetails?.phase === 'publishing', 'Phase must be publishing');
    assert(check.errorDetails?.code === 10, 'Should parse code');
    assert(check.errorMsg?.includes('Insufficient publishing permissions') === true, 'Should include message');

    testCount++;
    console.log('✓ Test 16: Publishing phase error extracted correctly.');
  }

  // 17. video_status=error with no error array produces phase summary message and UNKNOWN_ERROR classification
  {
    const asset = await createTestAsset(1000);
    global.fetch = async () => new Response(JSON.stringify({
      status: {
        video_status: 'error',
        uploading_phase: { status: 'complete' },
        processing_phase: { status: 'complete' },
        publishing_phase: { status: 'not_started' }
      }
    }), { status: 200 });

    const check = await FacebookPublishingService.checkVideoStatus('video-17', 'token');
    assert(check.status === 'error', 'Status must be error');
    assert(check.errorMsg?.includes('uploading_phase=complete; processing_phase=complete; publishing_phase=not_started; Meta returned no phase error details.') === true, 'Fallback msg mismatch');

    const job = await prisma.videoJob.create({
      data: {
        userId: testUserId,
        pageId: testPageId,
        uploadAssetId: asset.id,
        englishTitle: 'No Error Details Job',
        englishCaption: 'capt',
        scheduledTimeUTC: new Date(Date.now() - 5000),
        status: 'META_PROCESSING',
        providerProcessingId: 'video-17',
        nextAttemptAt: new Date(Date.now() - 5000)
      }
    });

    await runQueueWorker(randomUUID(), job.id);
    const updatedJob = await prisma.videoJob.findUnique({ where: { id: job.id } });
    assert(updatedJob?.status === 'FAILED_PERMANENT', 'Should fail permanently');
    assert(updatedJob?.lastErrorCode === 'META_TRANSCODE_FAILED', 'Should record transcode failure code');
    assert(updatedJob?.failureClassification === 'UNKNOWN_ERROR', 'Should map to UNKNOWN_ERROR since there is no media-specific error details');

    testCount++;
    console.log('✓ Test 17: Fallback message constructed and mapped to UNKNOWN_ERROR when no phase error array exists.');
  }

  // 18. Security validation: logs must not contain secrets or access tokens
  {
    const asset = await createTestAsset(1000);
    const { GoogleDriveMediaReader } = await import('../src/lib/google-drive/google-drive-media-reader');
    GoogleDriveMediaReader.getDownloadStream = async () => {
      return mockStreamOfSize(1000);
    };

    global.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes('/videos')) {
        const body = init?.body ? (typeof init.body === 'string' ? JSON.parse(init.body) : init.body) : {};
        if (body.upload_phase === 'start') {
          return new Response(JSON.stringify({
            upload_session_id: 'session-18',
            video_id: 'video-18',
            start_offset: 0,
            end_offset: 1000
          }), { status: 200 });
        }
        const headers = init?.headers as Record<string, string> | undefined;
        if (headers && headers['Content-Type']?.includes('multipart/form-data')) {
          return new Response(JSON.stringify({
            start_offset: 1000,
            end_offset: 1000
          }), { status: 200 });
        }
        if (body.upload_phase === 'finish') {
          return new Response(JSON.stringify({ success: true }));
        }
      }
      return new Response('', { status: 404 });
    };

    const job = await prisma.videoJob.create({
      data: {
        userId: testUserId,
        pageId: testPageId,
        uploadAssetId: asset.id,
        englishTitle: 'Security Log Job',
        englishCaption: 'capt',
        scheduledTimeUTC: new Date(Date.now() - 5000),
        status: 'SCHEDULED'
      }
    });

    const logs = await runQueueWorker(randomUUID(), job.id);
    const logDump = logs.join('\n');

    // Asserts that no sensitive items appear in the worker execution logs
    assert(!logDump.includes('secret_token_12345'), 'Log must NOT contain the page access token');
    assert(!logDump.includes('secret_app_secret_abc'), 'Log must NOT contain the app secret');
    assert(!logDump.includes('dummy_page_token'), 'Log must NOT contain dummy page token');

    testCount++;
    console.log('✓ Test 18: Security audit verified. Access tokens and configuration secrets never logged.');
  }

  console.log(`\nAll ${testCount} focused Phase 6L test scenarios completed successfully.`);
}

runTests()
  .then(() => {
    console.log('SUCCESS: Phase 6L validation script complete.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('FAILURE: Phase 6L validation script failed with error:', err);
    process.exit(1);
  });
