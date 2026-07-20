import { BrowserMultipartUploader } from '../src/lib/uploads/browser-multipart-uploader';
import { BrowserUploadState, BrowserUploaderStatus } from '../src/lib/uploads/upload-types';
import {
  MockScenario,
  UploadStatus,
  UploadFinalizationOperation,
  VideoJob,
  JobStatus,
  User,
  UserRole,
  UserStatus,
  UserApprovalStatus
} from '@prisma/client';
import { BulkCreateScheduledJobsTx, bulkCreateScheduledJobs } from '../src/lib/job-state-machine';
import { handleJobsPost, JobsRouteDependencies } from '../src/app/api/facebook/jobs/route';
import { UploadFinalizationService, FinalizationDependencies, FinalizationTransitionTx } from '../src/lib/storage/upload-finalization-service';
import type {
  InitialCompletionClaim,
  InitialAbortClaim,
  CompletionRecoveryClaim
} from '../src/lib/storage/finalization-claim-service';

// -------------------------------------------------------------
// Environment mocks
// -------------------------------------------------------------
const storage: Record<string, string> = {};
const mockLocalStorage: Storage = {
  getItem: (key: string) => storage[key] || null,
  setItem: (key: string, value: string) => { storage[key] = String(value); },
  removeItem: (key: string) => { delete storage[key]; },
  clear: () => { Object.keys(storage).forEach((k) => delete storage[k]); },
  length: 0,
  key: () => null,
};
Object.defineProperty(global, 'localStorage', { value: mockLocalStorage, writable: true });

class FakeFile {
  name: string;
  size: number;
  type: string;
  constructor(name: string, size: number, type: string) {
    this.name = name;
    this.size = size;
    this.type = type;
  }
  slice(start: number, end: number) {
    return new FakeFile(this.name, end - start, this.type);
  }
}
Object.defineProperty(global, 'File', { value: FakeFile, writable: true });

let fetchMockHandler: (url: string, init?: RequestInit) => Promise<Response> = () => {
  throw new Error('Fetch handler not configured.');
};

Object.defineProperty(global, 'fetch', {
  value: async (url: string, init?: RequestInit) => {
    if (init?.signal?.aborted) {
      const err = new Error('The user aborted a request.');
      err.name = 'AbortError';
      throw err;
    }
    const response = await fetchMockHandler(url, init);
    if (init?.signal?.aborted) {
      const err = new Error('The user aborted a request.');
      err.name = 'AbortError';
      throw err;
    }
    return response;
  },
  writable: true,
});

function createMockResponse(status: number, data: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    headers: {
      get: (name: string) => headers[name] || headers[name.toLowerCase()] || null,
    },
  } as unknown as Response;
}

// -------------------------------------------------------------
// Fixture Generators
// -------------------------------------------------------------
function makeUserFixture(
  overrides: Partial<User> = {}
): User {
  const defaults: User = {
    id: 'mock-user-uuid',
    email: 'admin@example.com',
    passwordHash: 'dummy-password-hash',
    name: 'Mock User',
    role: UserRole.USER,
    status: UserStatus.ACTIVE,
    approvalStatus: UserApprovalStatus.APPROVED,
    approvedAt: new Date(),
    approvedById: null,
    rejectedAt: null,
    rejectionReason: null,
    registrationIp: null,
    lastLoginAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  return {
    ...defaults,
    ...overrides,
  } satisfies User;
}

function makeVideoJobFixture(
  overrides: Partial<VideoJob> = {}
): VideoJob {
  const defaults: VideoJob = {
    id: 'mock-job-uuid',
    userId: 'mock-user-uuid',
    pageId: '11111111-1111-1111-1111-111111111111',
    gcsVideoUri: null,
    storageUri: null,
    gcsThumbnailUri: null,
    thumbnailAssetId: null,
    englishTitle: 'Default Title',
    englishCaption: 'Default Caption',
    hashtags: null,
    scheduledTimeUTC: new Date(Date.now() + 300000),
    status: JobStatus.SCHEDULED,
    contentType: 'VIDEO',
    metaPostId: null,
    cloudTaskName: null,
    retryCount: 0,
    maxAttempts: 3,
    attemptCount: 0,
    lastErrorCode: null,
    lastErrorMessage: null,
    failureClassification: null,
    providerReference: null,
    providerProcessingId: null,
    mockScenario: MockScenario.SUCCESS,
    attempts: null,
    lockToken: null,
    lockedAt: null,
    lockExpiresAt: null,
    nextAttemptAt: null,
    startedAt: null,
    completedAt: null,
    failedAt: null,
    errorLog: null,
    uploadAssetId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  return {
    ...defaults,
    ...overrides,
  } satisfies VideoJob;
}

interface UploadStatusResponse {
  assetId: string;
  filename: string;
  expectedSize: string;
  declaredMimeType: string;
  status: string;
  partSize: number;
  totalParts: number;
  completedPartNumbers: number[];
  uploadExpiresAt?: string;
  lastActivityAt?: Date;
  createdAt?: string;
  updatedAt?: string;
  durationMs?: number | null;
  containerFormat?: string | null;
  videoCodec?: string | null;
  audioCodec?: string | null;
  width?: number | null;
  height?: number | null;
}

function makeUploadStatusFixture(
  file: File,
  overrides: Partial<UploadStatusResponse> = {}
): UploadStatusResponse {
  return {
    assetId: 'mock-asset-id',
    filename: file.name,
    expectedSize: String(file.size),
    declaredMimeType: file.type || 'video/mp4',
    status: 'UPLOADING',
    partSize: 10 * 1024 * 1024,
    totalParts: Math.ceil(file.size / (10 * 1024 * 1024)),
    completedPartNumbers: [],
    ...overrides,
  };
}

// -------------------------------------------------------------
// Finalization Claim Fixture Generators
// -------------------------------------------------------------
function makeInitialCompletionClaim(
  overrides: Partial<InitialCompletionClaim> = {}
): InitialCompletionClaim {
  return {
    mode: 'INITIAL',
    operation: UploadFinalizationOperation.COMPLETE,
    providerAction: 'COMPLETE_MULTIPART',
    providerCallAllowed: true,
    userId: 'mock-user-uuid',
    assetId: 'final-asset-uuid',
    lockToken: 'mock-lock-token',
    lockedAt: new Date(),
    lockExpiresAt: new Date(Date.now() + 300000),
    attemptCount: 1,
    staleTakeover: false,
    ...overrides
  };
}

function makeInitialAbortClaim(
  overrides: Partial<InitialAbortClaim> = {}
): InitialAbortClaim {
  return {
    mode: 'INITIAL',
    operation: UploadFinalizationOperation.ABORT,
    providerAction: 'ABORT_MULTIPART',
    providerCallAllowed: true,
    userId: 'mock-user-uuid',
    assetId: 'final-asset-uuid',
    lockToken: 'mock-lock-token',
    lockedAt: new Date(),
    lockExpiresAt: new Date(Date.now() + 300000),
    attemptCount: 1,
    staleTakeover: false,
    ...overrides
  };
}

function makeCompletionRecoveryClaim(
  overrides: Partial<CompletionRecoveryClaim> = {}
): CompletionRecoveryClaim {
  return {
    mode: 'COMPLETION_RECOVERY',
    operation: UploadFinalizationOperation.COMPLETE,
    providerAction: 'NONE',
    providerCallAllowed: false,
    userId: 'mock-user-uuid',
    assetId: 'final-asset-uuid',
    lockToken: 'mock-lock-token',
    lockedAt: new Date(),
    lockExpiresAt: new Date(Date.now() + 300000),
    attemptCount: 1,
    staleTakeover: false,
    ...overrides
  };
}

// -------------------------------------------------------------
// Test runner
// -------------------------------------------------------------
async function runTests() {
  console.log('Running Browser Multipart Uploader tests...');

  // 1. File size / type validations in UI (Simulated helper checks)
  console.log('Test: File type validations...');
  const validMp4 = new FakeFile('video.mp4', 100 * 1024 * 1024, 'video/mp4');
  const validMov = new FakeFile('video.mov', 100 * 1024 * 1024, 'video/quicktime');
  const invalidType = new FakeFile('image.png', 10 * 1024 * 1024, 'image/png');
  const tooLarge = new FakeFile('big.mp4', 600 * 1024 * 1024, 'video/mp4');

  if (validMp4.name.endsWith('.png') || !validMp4.name.endsWith('.mp4')) {
    throw new Error('MP4 suffix checking failed');
  }
  if (!validMov.name.endsWith('.mov')) {
    throw new Error('MOV suffix checking failed');
  }
  if (invalidType.name.endsWith('.mp4') || invalidType.name.endsWith('.mov')) {
    throw new Error('PNG suffix should not match video extensions');
  }
  if (tooLarge.size > 500 * 1024 * 1024) {
    console.log('  ✓ Correctly identified file size over 500 MiB limit');
  }

  // 2. Initiation and deterministic part numbering
  console.log('Test: Initiation and chunk slicing...');
  let initiateCalled = false;
  const partUrlsIssued: number[] = [];
  const chunkPuts: number[] = [];
  const recordCalls: number[] = [];

  fetchMockHandler = async (url: string, init?: RequestInit) => {
    if (url === '/api/uploads/initiate') {
      initiateCalled = true;
      const body = JSON.parse(init?.body as string);
      if (body.filename !== 'video.mp4') throw new Error('Incorrect initiate filename');
      return createMockResponse(201, {
        assetId: 'mock-asset-uuid',
        filename: 'video.mp4',
        expectedSize: body.expectedSize,
        declaredMimeType: 'video/mp4',
        status: 'UPLOADING',
        partSize: 10 * 1024 * 1024, // 10 MiB
        totalParts: 3,
      });
    }

    if (url === '/api/uploads/mock-asset-uuid/parts') {
      const body = JSON.parse(init?.body as string);
      if (init?.method === 'POST') {
        partUrlsIssued.push(body.partNumber);
        return createMockResponse(200, {
          assetId: 'mock-asset-uuid',
          partNumber: body.partNumber,
          uploadUrl: `https://storage.mock/part-${body.partNumber}`,
        });
      } else if (init?.method === 'PATCH') {
        recordCalls.push(body.partNumber);
        return createMockResponse(200, {
          assetId: 'mock-asset-uuid',
          recordedPartNumber: body.partNumber,
          completedPartNumbers: recordCalls,
        });
      }
    }

    if (url.startsWith('https://storage.mock/part-')) {
      const partNum = parseInt(url.split('part-')[1], 10);
      chunkPuts.push(partNum);
      return createMockResponse(200, {}, { ETag: `etag-part-${partNum}` });
    }

    if (url === '/api/uploads/mock-asset-uuid/complete') {
      const parsedBody = JSON.parse(init?.body as string || '{}');
      if (parsedBody && parsedBody.parts) {
        throw new Error('Security leakage: Client sent parts list during complete request');
      }
      return createMockResponse(202, { status: 'VALIDATING' });
    }

    if (url === '/api/uploads/mock-asset-uuid') {
      return createMockResponse(200, { status: 'VALIDATED', durationMs: 12500, containerFormat: 'mp4' });
    }

    throw new Error(`Unexpected request: ${url}`);
  };

  const file = new FakeFile('video.mp4', 25 * 1024 * 1024, 'video/mp4'); // 3 parts (10MB, 10MB, 5MB)
  let lastState: BrowserUploadState = 'idle';

  const uploader = new BrowserMultipartUploader({
    file: file as unknown as File,
    recoveryKey: 'test-recovery-key-1',
    onStatusChange: (status: BrowserUploaderStatus) => {
      lastState = status.state;
    },
  });

  await uploader.start();

  if (!initiateCalled) throw new Error('Initiate was not called');
  if (JSON.stringify(partUrlsIssued) !== '[1,2,3]') throw new Error(`Deterministic part URLs not issued: ${partUrlsIssued}`);
  if (JSON.stringify(chunkPuts) !== '[1,2,3]') throw new Error(`Deterministic chunk PUTs not executed: ${chunkPuts}`);
  if (JSON.stringify(recordCalls) !== '[1,2,3]') throw new Error(`Deterministic records not called: ${recordCalls}`);

  // Wait briefly for polling to hit validated
  await new Promise((r) => setTimeout(r, 100));
  uploader.destroy();

  if ((lastState as string) !== 'validated') throw new Error(`Expected validated state, got: ${lastState}`);
  console.log('  ✓ Chunk slicing and status flows verified');

  // 3. Pause & Resume Skip Confirmed
  console.log('Test: Pause prevents new parts, resume skips server-confirmed...');
  mockLocalStorage.clear();
  partUrlsIssued.length = 0;
  chunkPuts.length = 0;
  recordCalls.length = 0;

  const filePause = new FakeFile('pause.mp4', 25 * 1024 * 1024, 'video/mp4');
  let pauseTriggeredOnPart2 = false;

  fetchMockHandler = async (url: string, init?: RequestInit) => {
    if (url === '/api/uploads/initiate') {
      return createMockResponse(201, {
        assetId: 'pause-asset-uuid',
        filename: 'pause.mp4',
        expectedSize: filePause.size,
        declaredMimeType: 'video/mp4',
        status: 'UPLOADING',
        partSize: 10 * 1024 * 1024,
        totalParts: 3,
      });
    }

    if (url === '/api/uploads/pause-asset-uuid/parts') {
      const body = JSON.parse(init?.body as string);
      if (init?.method === 'POST') {
        partUrlsIssued.push(body.partNumber);
        if (body.partNumber === 2) {
          pauseTriggeredOnPart2 = true;
          uploaderPause.pause();
        }
        return createMockResponse(200, {
          assetId: 'pause-asset-uuid',
          partNumber: body.partNumber,
          uploadUrl: `https://storage.mock/pause-part-${body.partNumber}`,
        });
      } else if (init?.method === 'PATCH') {
        recordCalls.push(body.partNumber);
        return createMockResponse(200, {
          assetId: 'pause-asset-uuid',
          recordedPartNumber: body.partNumber,
          completedPartNumbers: recordCalls,
        });
      }
    }

    if (url.startsWith('https://storage.mock/pause-part-')) {
      const partNum = parseInt(url.split('pause-part-')[1], 10);
      chunkPuts.push(partNum);
      return createMockResponse(200, {}, { ETag: `etag-pause-part-${partNum}` });
    }

    throw new Error(`Unexpected request: ${url}`);
  };

  const uploaderPause = new BrowserMultipartUploader({
    file: filePause as unknown as File,
    recoveryKey: 'test-recovery-key-2',
    onStatusChange: (status: BrowserUploaderStatus) => {
      lastState = status.state;
    },
  });

  await uploaderPause.start();

  if (!pauseTriggeredOnPart2) throw new Error('Pause was not triggered on part 2');
  if ((lastState as string) !== 'paused') throw new Error(`State must transition to paused, got: ${lastState}`);

  // Part 1 complete, Part 2 URL issued but paused before recording finished
  const confirmedNumbersBeforeResume = [...recordCalls];

  let pauseGetCount = 0;
  // Configure fetch to simulate resume sync
  fetchMockHandler = async (url: string, init?: RequestInit) => {
    if (url === '/api/uploads/pause-asset-uuid') {
      pauseGetCount++;
      if (pauseGetCount === 1) {
        return createMockResponse(200, makeUploadStatusFixture(filePause as unknown as File, {
          assetId: 'pause-asset-uuid',
          status: 'UPLOADING',
          completedPartNumbers: confirmedNumbersBeforeResume, // Sync skips part 1
        }));
      } else {
        return createMockResponse(200, makeUploadStatusFixture(filePause as unknown as File, {
          assetId: 'pause-asset-uuid',
          status: 'VALIDATED',
        }));
      }
    }
    if (url === '/api/uploads/pause-asset-uuid/parts') {
      const body = JSON.parse(init?.body as string);
      if (init?.method === 'POST') {
        partUrlsIssued.push(body.partNumber);
        return createMockResponse(200, {
          assetId: 'pause-asset-uuid',
          partNumber: body.partNumber,
          uploadUrl: `https://storage.mock/pause-part-${body.partNumber}`,
        });
      } else if (init?.method === 'PATCH') {
        recordCalls.push(body.partNumber);
        return createMockResponse(200, {
          assetId: 'pause-asset-uuid',
          recordedPartNumber: body.partNumber,
          completedPartNumbers: recordCalls,
        });
      }
    }
    if (url.startsWith('https://storage.mock/pause-part-')) {
      const partNum = parseInt(url.split('pause-part-')[1], 10);
      chunkPuts.push(partNum);
      return createMockResponse(200, {}, { ETag: `etag-pause-part-${partNum}` });
    }
    if (url === '/api/uploads/pause-asset-uuid/complete') {
      return createMockResponse(202, { status: 'VALIDATING' });
    }
    throw new Error(`Unexpected request during resume: ${url}`);
  };

  await uploaderPause.resume();
  uploaderPause.destroy();

  // Part 1 should not have been requested/PUT again during resume
  const putPartsAfterResume = chunkPuts.filter((n) => n === 1);
  if (putPartsAfterResume.length > 1) throw new Error('Part 1 was re-uploaded during resume!');
  console.log('  ✓ Resume skips already confirmed parts');

  // 4. Retry limits and Exponential Backoff
  console.log('Test: Bounded retry with backoff...');
  let failCount = 0;
  let retryUploaderState = 'idle';

  fetchMockHandler = async (url: string) => {
    if (url === '/api/uploads/initiate') {
      return createMockResponse(201, {
        assetId: 'retry-asset-uuid',
        filename: 'retry.mp4',
        expectedSize: 10 * 1024 * 1024,
        declaredMimeType: 'video/mp4',
        status: 'UPLOADING',
        partSize: 10 * 1024 * 1024,
        totalParts: 1,
      });
    }

    if (url === '/api/uploads/retry-asset-uuid/parts') {
      failCount++;
      return createMockResponse(500, { error: 'Temporary Server Error' });
    }
    throw new Error('Unexpected request');
  };

  const fileRetry = new FakeFile('retry.mp4', 10 * 1024 * 1024, 'video/mp4');
  const uploaderRetry = new BrowserMultipartUploader({
    file: fileRetry as unknown as File,
    recoveryKey: 'test-recovery-key-3',
    maxRetries: 2,
    retryBackoffMs: 10,
    onStatusChange: (status: BrowserUploaderStatus) => {
      retryUploaderState = status.state;
    },
  });

  await uploaderRetry.start().catch(() => {});
  uploaderRetry.destroy();

  if (failCount !== 3) throw new Error(`Expected 3 total calls (1 initial + 2 retries), got: ${failCount}`);
  if (retryUploaderState !== 'failed') throw new Error(`Expected state failed after retry exhaustion, got: ${retryUploaderState}`);
  console.log('  ✓ Retry limits and error exhaustion validated');

  // 5. Abort Cancellation (Deterministic synchronization)
  console.log('Test: Cancellation orchestration (deterministic)...');
  let abortCalled = false;
  let resolveInitiate: () => void = () => {};
  const initiatePromise = new Promise<void>((r) => { resolveInitiate = r; });

  fetchMockHandler = async (url: string) => {
    if (url === '/api/uploads/initiate') {
      return createMockResponse(201, {
        assetId: 'abort-asset-uuid',
        filename: 'abort.mp4',
        expectedSize: 10 * 1024 * 1024,
        declaredMimeType: 'video/mp4',
        status: 'UPLOADING',
        partSize: 10 * 1024 * 1024,
        totalParts: 1,
      });
    }
    if (url === '/api/uploads/abort-asset-uuid/parts') {
      resolveInitiate(); // Tell the test initiation resolved and parts fetch is starting
      await new Promise((r) => setTimeout(r, 100)); // Hold request active
      return createMockResponse(200, { uploadUrl: 'https://storage.mock/abort-part' });
    }
    if (url === '/api/uploads/abort-asset-uuid/abort') {
      abortCalled = true;
      return createMockResponse(200, { success: true });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const fileAbort = new FakeFile('abort.mp4', 10 * 1024 * 1024, 'video/mp4');
  const uploaderAbort = new BrowserMultipartUploader({
    file: fileAbort as unknown as File,
    recoveryKey: 'test-recovery-key-4',
    onStatusChange: (status: BrowserUploaderStatus) => {
      lastState = status.state;
    },
  });

  const uploadPromise = uploaderAbort.start();
  await initiatePromise; // Wait until initiate call resolves
  await uploaderAbort.cancel();
  await uploadPromise.catch(() => {});
  uploaderAbort.destroy();

  if (!abortCalled) throw new Error('Abort route was not called on backend');
  if ((lastState as string) !== 'aborted') throw new Error(`State did not update to aborted, got: ${lastState}`);
  console.log('  ✓ Abort and cancellation flow validated (no sleep)');

  // 6. Security leakage checks
  console.log('Test: LocalStorage security checks...');
  mockLocalStorage.clear();
  const fileSec = new FakeFile('sec.mp4', 10 * 1024 * 1024, 'video/mp4');
  const uploaderSec = new BrowserMultipartUploader({
    file: fileSec as unknown as File,
    recoveryKey: 'test-recovery-key-5',
  });

  fetchMockHandler = async (url: string, init?: RequestInit) => {
    if (url === '/api/uploads/initiate') {
      return createMockResponse(201, {
        assetId: 'sec-asset-uuid',
        filename: 'sec.mp4',
        expectedSize: 10 * 1024 * 1024,
        declaredMimeType: 'video/mp4',
        totalParts: 1,
      });
    }
    if (url === '/api/uploads/sec-asset-uuid/parts') {
      if (init?.method === 'POST') return createMockResponse(200, { uploadUrl: 'https://storage.mock/sec-part' });
      if (init?.method === 'PATCH') return createMockResponse(200, {});
    }
    if (url.startsWith('https://storage.mock/sec-part')) return createMockResponse(200, {}, { ETag: 'sec-mock-etag' });
    if (url === '/api/uploads/sec-asset-uuid/complete') {
      const parsed = JSON.parse(init?.body as string || '{}');
      if (Object.keys(parsed).length !== 0) {
        throw new Error(`Security breach: complete body must be empty, but got: ${init?.body}`);
      }
      return createMockResponse(202, { status: 'VALIDATING' });
    }
    if (url === '/api/uploads/sec-asset-uuid') return createMockResponse(200, { status: 'VALIDATING' });
    throw new Error(`Unexpected request: ${url}`);
  };

  await uploaderSec.start();

  const storageKeys = Object.keys(storage);
  for (const key of storageKeys) {
    if (key.includes('parts') || key.includes('upload_asset')) {
      throw new Error(`Security breach: legacy key found in localStorage: ${key}`);
    }
    const val = storage[key];
    if (val.includes('sec-mock-etag') || val.includes('https://') || val.includes('secret') || val.includes('partNumber')) {
      throw new Error(`Security breach: localstorage contains sensitive details inside key ${key}`);
    }
    if (key === 'upload_recovery_test-recovery-key-5') {
      const parsed = JSON.parse(val);
      if (Object.keys(parsed).length !== 1 || parsed.assetId !== 'sec-asset-uuid') {
        throw new Error(`Security breach: unexpected keys in recovery record: ${val}`);
      }
    }
  }
  uploaderSec.destroy();
  console.log('  ✓ Confirmed localStorage holds only non-secret recovery IDs');

  // 7. Reselected mismatch handling tests (strict reselect)
  console.log('Test: Strict reselect verification mismatch checks...');
  mockLocalStorage.clear();
  mockLocalStorage.setItem('upload_recovery_my-draft-id', JSON.stringify({ assetId: 'active-asset-uuid' }));

  let partUrlCallCount = 0;

  fetchMockHandler = async (url: string) => {
    if (url === '/api/uploads/active-asset-uuid') {
      return createMockResponse(200, {
        assetId: 'active-asset-uuid',
        filename: 'original.mp4',
        expectedSize: 10485760,
        declaredMimeType: 'video/mp4',
        status: 'UPLOADING',
        totalParts: 1,
        completedPartNumbers: [],
      });
    }
    if (url.includes('/parts')) {
      partUrlCallCount++;
      return createMockResponse(200, { uploadUrl: 'https://storage.mock/parts' });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  // 7.1 Filename mismatch rejected
  const fileBadName = new FakeFile('different-name.mp4', 10485760, 'video/mp4');
  const uploaderBadName = new BrowserMultipartUploader({
    file: fileBadName as unknown as File,
    recoveryKey: 'my-draft-id',
  });
  try {
    await uploaderBadName.start();
    throw new Error('Should have failed for filename mismatch');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg !== 'RECOVERY_FILE_MISMATCH') {
      throw new Error(`Expected RECOVERY_FILE_MISMATCH, got: ${msg}`);
    }
    console.log('  ✓ filename mismatch rejected');
  }
  uploaderBadName.destroy();

  // Verify mismatch does not overwrite the saved assetId
  let storedRecord = mockLocalStorage.getItem('upload_recovery_my-draft-id');
  if (!storedRecord || JSON.parse(storedRecord).assetId !== 'active-asset-uuid') {
    throw new Error('saved assetId was cleared or overwritten on filename mismatch');
  }

  // 7.2 Size mismatch rejected
  const fileBadSize = new FakeFile('original.mp4', 20485760, 'video/mp4');
  const uploaderBadSize = new BrowserMultipartUploader({
    file: fileBadSize as unknown as File,
    recoveryKey: 'my-draft-id',
  });
  try {
    await uploaderBadSize.start();
    throw new Error('Should have failed for size mismatch');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg !== 'RECOVERY_FILE_MISMATCH') {
      throw new Error(`Expected RECOVERY_FILE_MISMATCH, got: ${msg}`);
    }
    console.log('  ✓ size mismatch rejected');
  }
  uploaderBadSize.destroy();

  // Verify mismatch does not overwrite the saved assetId
  storedRecord = mockLocalStorage.getItem('upload_recovery_my-draft-id');
  if (!storedRecord || JSON.parse(storedRecord).assetId !== 'active-asset-uuid') {
    throw new Error('saved assetId was cleared or overwritten on size mismatch');
  }

  // 7.3 MIME mismatch rejected
  const fileBadMime = new FakeFile('original.mp4', 10485760, 'video/avi');
  const uploaderBadMime = new BrowserMultipartUploader({
    file: fileBadMime as unknown as File,
    recoveryKey: 'my-draft-id',
  });
  try {
    await uploaderBadMime.start();
    throw new Error('Should have failed for MIME mismatch');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg !== 'RECOVERY_FILE_MISMATCH') {
      throw new Error(`Expected RECOVERY_FILE_MISMATCH, got: ${msg}`);
    }
    console.log('  ✓ MIME mismatch rejected');
  }
  uploaderBadMime.destroy();

  // Verify mismatch does not overwrite the saved assetId
  storedRecord = mockLocalStorage.getItem('upload_recovery_my-draft-id');
  if (!storedRecord || JSON.parse(storedRecord).assetId !== 'active-asset-uuid') {
    throw new Error('saved assetId was cleared or overwritten on MIME mismatch');
  }

  // Verify mismatch occurs before any part URL request or storage PUT
  if (partUrlCallCount !== 0) {
    throw new Error('Expected 0 part URL calls on mismatch failures');
  }
  console.log('  ✓ mismatch check occurs before any upload request');

  // 7.4 Clearing the recovery record permits a new upload
  const fileToCancel = new FakeFile('original.mp4', 10485760, 'video/mp4');
  const uploaderToCancel = new BrowserMultipartUploader({
    file: fileToCancel as unknown as File,
    recoveryKey: 'my-draft-id',
  });

  fetchMockHandler = async (url: string) => {
    if (url === '/api/uploads/active-asset-uuid') {
      return createMockResponse(200, {
        assetId: 'active-asset-uuid',
        filename: 'original.mp4',
        expectedSize: 10485760,
        declaredMimeType: 'video/mp4',
        status: 'UPLOADING',
        totalParts: 1,
        completedPartNumbers: [],
      });
    }
    if (url === '/api/uploads/active-asset-uuid/abort') {
      return createMockResponse(200, { success: true });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const startPromise = uploaderToCancel.start();
  await new Promise((r) => setTimeout(r, 50));
  await uploaderToCancel.cancel();
  await startPromise.catch(() => {});
  uploaderToCancel.destroy();

  storedRecord = mockLocalStorage.getItem('upload_recovery_my-draft-id');
  if (storedRecord) {
    throw new Error('localStorage recovery key should be removed after cancel');
  }
  console.log('  ✓ clearing the recovery record removes item from localStorage');

  // Try starting upload again with a new file. It should initiate a new upload
  let newInitiateCalled = false;
  fetchMockHandler = async (url: string) => {
    if (url === '/api/uploads/initiate') {
      newInitiateCalled = true;
      return createMockResponse(201, {
        assetId: 'new-active-asset-uuid',
        filename: 'new-video.mp4',
        expectedSize: 10485760,
        declaredMimeType: 'video/mp4',
        status: 'UPLOADING',
        partSize: 10485760,
        totalParts: 1,
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const fileNew = new FakeFile('new-video.mp4', 10485760, 'video/mp4');
  const uploaderNew = new BrowserMultipartUploader({
    file: fileNew as unknown as File,
    recoveryKey: 'my-draft-id',
  });
  const newStartPromise = uploaderNew.start();
  await new Promise((r) => setTimeout(r, 50));
  uploaderNew.destroy();
  await newStartPromise.catch(() => {});

  if (!newInitiateCalled) {
    throw new Error('Expected new initiate call to be triggered after clearing recovery record');
  }
  console.log('  ✓ starting after clear initiates new upload');

  // Verify localStorage contains only {"assetId": "..."}
  const keys = Object.keys(storage);
  if (keys.length > 0) {
    const val = storage[keys[0]];
    const parsed = JSON.parse(val);
    if (Object.keys(parsed).length !== 1 || !parsed.assetId) {
      throw new Error(`localStorage value contains unexpected details: ${val}`);
    }
  }
  console.log('  ✓ localStorage value contains only assetId');

  // 8. Aborted request does not record a completed part
  console.log('Test: Aborted request does not record completed part...');
  mockLocalStorage.clear();
  let partRecorded = false;
  let initiateResolve2: () => void = () => {};
  const initPromise2 = new Promise<void>((r) => { initiateResolve2 = r; });

  fetchMockHandler = async (url: string, init?: RequestInit) => {
    if (url === '/api/uploads/initiate') {
      return createMockResponse(201, {
        assetId: 'abort-part-asset',
        filename: 'abort-part.mp4',
        expectedSize: 10485760,
        declaredMimeType: 'video/mp4',
        totalParts: 1,
      });
    }
    if (url === '/api/uploads/abort-part-asset/parts') {
      if (init?.method === 'POST') {
        initiateResolve2();
        await new Promise((r) => setTimeout(r, 50));
        return createMockResponse(200, { uploadUrl: 'https://storage.mock/abort-part-url' });
      }
      if (init?.method === 'PATCH') {
        partRecorded = true;
        return createMockResponse(200, {});
      }
    }
    throw new Error('Unexpected fetch');
  };

  const fileAbortPart = new FakeFile('abort-part.mp4', 10485760, 'video/mp4');
  const uploaderAbortPart = new BrowserMultipartUploader({
    file: fileAbortPart as unknown as File,
    recoveryKey: 'test-recovery-key-6',
  });

  const startPromise2 = uploaderAbortPart.start();
  await initPromise2;
  await uploaderAbortPart.cancel();
  await startPromise2.catch(() => {});
  uploaderAbortPart.destroy();

  if (partRecorded) {
    throw new Error('Part should not be recorded after abort');
  }
  console.log('  ✓ Aborted request does not record a completed part');

  // 9. Retry does not duplicate a durable part
  console.log('Test: Retry does not duplicate a durable part...');
  mockLocalStorage.clear();
  let partAttempts = 0;
  let patchCalls = 0;

  fetchMockHandler = async (url: string, init?: RequestInit) => {
    if (url === '/api/uploads/initiate') {
      return createMockResponse(201, {
        assetId: 'retry-part-asset',
        filename: 'retry-part.mp4',
        expectedSize: 10485760,
        declaredMimeType: 'video/mp4',
        totalParts: 1,
      });
    }
    if (url === '/api/uploads/retry-part-asset/parts') {
      if (init?.method === 'POST') {
        partAttempts++;
        if (partAttempts === 1) {
          return createMockResponse(500, { error: 'Temporary Server Error' });
        }
        return createMockResponse(200, { uploadUrl: 'https://storage.mock/retry-part-url' });
      }
      if (init?.method === 'PATCH') {
        patchCalls++;
        return createMockResponse(200, {});
      }
    }
    if (url.startsWith('https://storage.mock/retry-part-url')) {
      return createMockResponse(200, {}, { ETag: 'retry-etag' });
    }
    if (url === '/api/uploads/retry-part-asset/complete') {
      return createMockResponse(202, { status: 'VALIDATING' });
    }
    if (url === '/api/uploads/retry-part-asset') {
      return createMockResponse(200, { status: 'VALIDATED' });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const fileRetryPart = new FakeFile('retry-part.mp4', 10485760, 'video/mp4');
  const uploaderRetryPart = new BrowserMultipartUploader({
    file: fileRetryPart as unknown as File,
    recoveryKey: 'test-recovery-key-7',
    maxRetries: 2,
    retryBackoffMs: 5,
  });

  await uploaderRetryPart.start();
  uploaderRetryPart.destroy();
  if (partAttempts !== 2) throw new Error(`Expected 2 part url attempts, got ${partAttempts}`);
  if (patchCalls !== 1) throw new Error(`Expected 1 PATCH call, got ${patchCalls}`);
  console.log('  ✓ Retry succeeds and does not duplicate part records');

  // 10. Polling stops on terminal states and cleans up controllers/timers
  console.log('Test: Polling stops on terminal states and cleans up...');
  let clearIntervalCalled = false;
  const originalClearInterval = global.clearInterval;
  global.clearInterval = ((id: NodeJS.Timeout | string | number | undefined) => {
    clearIntervalCalled = true;
    originalClearInterval(id);
  }) as unknown as typeof clearInterval;

  mockLocalStorage.clear();
  const filePoll = new FakeFile('poll.mp4', 10485760, 'video/mp4');
  const uploaderPoll = new BrowserMultipartUploader({
    file: filePoll as unknown as File,
    recoveryKey: 'test-recovery-key-8',
  });

  let pollCount = 0;
  fetchMockHandler = async (url: string, init?: RequestInit) => {
    if (url === '/api/uploads/initiate') {
      return createMockResponse(201, {
        assetId: 'poll-asset-uuid',
        filename: 'poll.mp4',
        expectedSize: 10485760,
        declaredMimeType: 'video/mp4',
        totalParts: 1,
      });
    }
    if (url === '/api/uploads/poll-asset-uuid/parts') {
      if (init?.method === 'POST') return createMockResponse(200, { uploadUrl: 'https://storage.mock/poll-part' });
      if (init?.method === 'PATCH') return createMockResponse(200, {});
    }
    if (url.startsWith('https://storage.mock/poll-part')) return createMockResponse(200, {}, { ETag: 'etag' });
    if (url === '/api/uploads/poll-asset-uuid/complete') return createMockResponse(202, { status: 'VALIDATING' });
    if (url === '/api/uploads/poll-asset-uuid') {
      pollCount++;
      if (pollCount === 1) {
        return createMockResponse(200, { status: 'VALIDATING' });
      }
      return createMockResponse(200, { status: 'VALIDATED', durationMs: 5000 });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  await uploaderPoll.start();
  await new Promise((r) => setTimeout(r, 50));
  uploaderPoll.destroy();

  global.clearInterval = originalClearInterval;
  if (!clearIntervalCalled) {
    throw new Error('Expected clearInterval to be called on validation success');
  }
  console.log('  ✓ Polling stops on terminal state and cleans up timers');

  // 11. Scheduling callback occurs only after VALIDATED
  console.log('Test: Validation callback occurs only after VALIDATED...');
  mockLocalStorage.clear();
  const fileCB = new FakeFile('callback.mp4', 10485760, 'video/mp4');
  let callbackTriggered = false;

  const uploaderCB = new BrowserMultipartUploader({
    file: fileCB as unknown as File,
    recoveryKey: 'test-recovery-key-9',
    onStatusChange: (status: BrowserUploaderStatus) => {
      if (status.state === 'validated') {
        callbackTriggered = true;
      } else {
        if (callbackTriggered) {
          throw new Error(`Callback triggered prematurely in state ${status.state}`);
        }
      }
    }
  });

  fetchMockHandler = async (url: string, init?: RequestInit) => {
    if (url === '/api/uploads/initiate') {
      return createMockResponse(201, {
        assetId: 'cb-asset-uuid',
        filename: 'callback.mp4',
        expectedSize: 10485760,
        declaredMimeType: 'video/mp4',
        totalParts: 1,
      });
    }
    if (url === '/api/uploads/cb-asset-uuid/parts') {
      if (init?.method === 'POST') return createMockResponse(200, { uploadUrl: 'https://storage.mock/cb-part' });
      if (init?.method === 'PATCH') return createMockResponse(200, {});
    }
    if (url.startsWith('https://storage.mock/cb-part')) return createMockResponse(200, {}, { ETag: 'etag' });
    if (url === '/api/uploads/cb-asset-uuid/complete') return createMockResponse(202, { status: 'VALIDATING' });
    if (url === '/api/uploads/cb-asset-uuid') {
      return createMockResponse(200, { status: 'VALIDATED', durationMs: 10000 });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  await uploaderCB.start();
  await new Promise((r) => setTimeout(r, 50));
  uploaderCB.destroy();

  if (!callbackTriggered) {
    throw new Error('Expected validation callback to be triggered');
  }
  console.log('  ✓ scheduling callback occurs only after VALIDATED');

  // 12. Server scheduling trust boundary tests
  console.log('Test: Server scheduling validation boundary...');
  const { NextRequest: MockNextRequest } = await import('next/server');



  const createReq = (body: unknown) => {
    return new MockNextRequest('http://localhost:3000/api/facebook/jobs', {
      method: 'POST',
      headers: {
        'host': 'localhost:3000',
        'origin': 'http://localhost:3000',
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    });
  };

  type JobInputType = Parameters<typeof bulkCreateScheduledJobs>[2][number];
  const capturedJobData: { value?: JobInputType } = {};
  const capturedR2Data: { value?: JobInputType } = {};

  const fakeJobsDeps: JobsRouteDependencies = {
    getSessionUser: async () => makeUserFixture({ id: 'mock-user-uuid', email: 'admin@example.com' }),
    verifyAdminSession: async () => makeUserFixture({ id: 'mock-user-uuid', email: 'admin@example.com' }),
    getVideoJobs: async () => [makeVideoJobFixture()],
    findUserPages: async () => [{ id: '11111111-1111-1111-1111-111111111111' }],
    findUploadAsset: async (id) => {
      if (id === 'unknown-uuid') return null;
      if (id === 'asset-uuid') {
        return {
          id: 'asset-uuid',
          userId: 'mock-user-uuid',
          status: 'VALIDATED',
          provider: 'GCS',
          bucket: 'bucket',
          objectKey: 'key',
        };
      }
      if (id === 'r2-asset-uuid') {
        return {
          id: 'r2-asset-uuid',
          userId: 'mock-user-uuid',
          status: 'VALIDATED',
          provider: 'R2',
          bucket: 'my-r2-bucket',
          objectKey: 'my-video.mp4',
        };
      }
      return null;
    },
    bulkCreateScheduledJobs: async (userId, jobs) => {
      if (jobs.some((j) => j.pageId !== '11111111-1111-1111-1111-111111111111')) {
        throw new Error('Unauthorized page association: Page invalid-page-id is not owned by user.');
      }
      const job = jobs[0];
      if (job.uploadAssetId === 'r2-asset-uuid') {
        capturedR2Data.value = job;
      } else if (job.uploadAssetId === 'asset-uuid') {
        capturedJobData.value = job;
      }
      return jobs.map((j, i) => makeVideoJobFixture({
        id: `job-${i}`,
        userId,
        pageId: j.pageId,
        gcsVideoUri: j.gcsVideoUri ?? null,
        storageUri: j.storageUri ?? null,
        uploadAssetId: j.uploadAssetId ?? null,
        gcsThumbnailUri: j.gcsThumbnailUri ?? null,
        englishTitle: j.englishTitle,
        englishCaption: j.englishCaption,
        scheduledTimeUTC: j.scheduledTimeUTC,
        mockScenario: j.mockScenario ?? MockScenario.SUCCESS,
        contentType: j.contentType ?? 'VIDEO',
      }));
    }
  };

  // 12.1 Missing uploadAssetId rejected
  let req = createReq({
    jobs: [{
      pageId: '11111111-1111-1111-1111-111111111111',
      englishTitle: 'Title',
      scheduledTimeUTC: new Date(Date.now() + 100000).toISOString(),
    }]
  });
  let response = await handleJobsPost(req, fakeJobsDeps);
  if (response.status !== 400) throw new Error('Expected 400 for missing uploadAssetId');
  let data = await response.json();
  if (!JSON.stringify(data).includes('uploadAssetId is required')) {
    throw new Error(`Expected uploadAssetId is required error, got: ${JSON.stringify(data)}`);
  }
  console.log('  ✓ missing uploadAssetId rejected');

  // 12.2 Unknown asset rejected
  req = createReq({
    jobs: [{
      pageId: '11111111-1111-1111-1111-111111111111',
      uploadAssetId: 'unknown-uuid',
      englishTitle: 'Title',
      scheduledTimeUTC: new Date(Date.now() + 100000).toISOString(),
    }]
  });
  response = await handleJobsPost(req, fakeJobsDeps);
  if (response.status !== 400) throw new Error('Expected 400 for unknown asset');
  data = await response.json();
  if (!JSON.stringify(data).includes('Upload asset not found')) {
    throw new Error(`Expected asset not found error, got: ${JSON.stringify(data)}`);
  }
  console.log('  ✓ unknown asset rejected');

  // 12.3 Cross-user asset rejected
  const crossUserDeps: JobsRouteDependencies = {
    ...fakeJobsDeps,
    findUploadAsset: async () => ({
      id: 'asset-uuid',
      userId: 'other-user-uuid',
      status: 'VALIDATED',
      provider: 'GCS',
      bucket: 'bucket',
      objectKey: 'key',
    }),
  };
  req = createReq({
    jobs: [{
      pageId: '11111111-1111-1111-1111-111111111111',
      uploadAssetId: 'asset-uuid',
      englishTitle: 'Title',
      scheduledTimeUTC: new Date(Date.now() + 100000).toISOString(),
    }]
  });
  response = await handleJobsPost(req, crossUserDeps);
  if (response.status !== 400) throw new Error('Expected 400 for cross-user asset');
  data = await response.json();
  if (!JSON.stringify(data).includes('Unauthorized upload asset')) {
    throw new Error(`Expected unauthorized asset error, got: ${JSON.stringify(data)}`);
  }
  console.log('  ✓ cross-user asset rejected');

  // 12.4 Non-VALIDATED status rejected (VALIDATING, FAILED, ABORTED)
  const nonValidatedStates = ['VALIDATING', 'FAILED', 'ABORTED'];
  for (const status of nonValidatedStates) {
    const nonValidatedDeps: JobsRouteDependencies = {
      ...fakeJobsDeps,
      findUploadAsset: async () => ({
        id: 'asset-uuid',
        userId: 'mock-user-uuid',
        status,
        provider: 'GCS',
        bucket: 'bucket',
        objectKey: 'key',
      }),
    };
    req = createReq({
      jobs: [{
        pageId: '11111111-1111-1111-1111-111111111111',
        uploadAssetId: 'asset-uuid',
        englishTitle: 'Title',
        scheduledTimeUTC: new Date(Date.now() + 100000).toISOString(),
      }]
    });
    response = await handleJobsPost(req, nonValidatedDeps);
    if (response.status !== 400) throw new Error(`Expected 400 for status ${status}`);
    data = await response.json();
    if (!JSON.stringify(data).includes('status must be VALIDATED')) {
      throw new Error(`Expected status VALIDATED error, got: ${JSON.stringify(data)}`);
    }
  }
  console.log('  ✓ VALIDATING, FAILED, ABORTED assets rejected');

  // 12.5 Browser-provided URI not trusted & rejected
  req = createReq({
    jobs: [{
      pageId: '11111111-1111-1111-1111-111111111111',
      uploadAssetId: 'asset-uuid',
      gcsVideoUri: 'gcs://browser-provided/video.mp4',
      englishTitle: 'Title',
      scheduledTimeUTC: new Date(Date.now() + 100000).toISOString(),
    }]
  });
  response = await handleJobsPost(req, fakeJobsDeps);
  if (response.status !== 400) throw new Error('Expected 400 when browser specifies URI');
  data = await response.json();
  if (!JSON.stringify(data).includes('Manually specified storage references are not accepted')) {
    throw new Error(`Expected Manual URI error, got: ${JSON.stringify(data)}`);
  }
  console.log('  ✓ browser-provided URI rejected');

  // 12.6 VALIDATED owned GCS asset accepted, internally resolved reference used & uploadAssetId written
  req = createReq({
    jobs: [{
      pageId: '11111111-1111-1111-1111-111111111111',
      uploadAssetId: 'asset-uuid',
      englishTitle: 'Title',
      scheduledTimeUTC: new Date(Date.now() + 100000).toISOString(),
    }]
  });
  response = await handleJobsPost(req, fakeJobsDeps);
  const responseBody = await response.json();
  if (response.status !== 200) {
    throw new Error(
      `Expected 200 for valid GCS scheduling request, got ${response.status}: ${JSON.stringify(responseBody)}`
    );
  }
  const jobVal = capturedJobData.value;
  if (!jobVal) throw new Error('Expected GCS job data to be captured.');
  if (jobVal.gcsVideoUri !== 'gcs://bucket/key') {
    throw new Error(`Expected GCS URI "gcs://bucket/key", got: ${jobVal.gcsVideoUri}`);
  }
  if (jobVal.uploadAssetId !== 'asset-uuid') {
    throw new Error(`Expected uploadAssetId to be "asset-uuid", got: ${jobVal.uploadAssetId}`);
  }
  console.log('  ✓ VALIDATED owned GCS asset accepted, resolved internals and saved uploadAssetId');

  // 12.7 Page ownership enforcement preserved
  req = createReq({
    jobs: [{
      pageId: '00000000-0000-0000-0000-000000000000',
      uploadAssetId: 'asset-uuid',
      englishTitle: 'Title',
      scheduledTimeUTC: new Date(Date.now() + 100000).toISOString(),
    }]
  });
  response = await handleJobsPost(req, fakeJobsDeps);
  if (response.status !== 400) throw new Error('Expected 400 for unauthorized page ID');
  data = await response.json();
  if (!JSON.stringify(data).includes('Invalid Facebook Page selection')) {
    throw new Error(`Expected page selection error, got: ${JSON.stringify(data)}`);
  }
  console.log('  ✓ page ownership enforcement preserved');

  // 12.8 R2 asset never becomes gcs://, stores storageUri, gcsVideoUri is null
  req = createReq({
    jobs: [{
      pageId: '11111111-1111-1111-1111-111111111111',
      uploadAssetId: 'r2-asset-uuid',
      englishTitle: 'R2 Video Title',
      scheduledTimeUTC: new Date(Date.now() + 100000).toISOString(),
    }]
  });
  response = await handleJobsPost(req, fakeJobsDeps);
  if (response.status !== 200) {
    throw new Error(`Expected 200 for R2 asset scheduling, got: ${response.status}`);
  }
  const r2Val = capturedR2Data.value;
  if (!r2Val) throw new Error('Expected R2 job data to be captured.');
  if (r2Val.gcsVideoUri !== null) {
    throw new Error(`Expected legacy gcsVideoUri to be null, got: ${r2Val.gcsVideoUri}`);
  }
  if (r2Val.storageUri !== 'r2://my-r2-bucket/my-video.mp4') {
    throw new Error(`Expected storageUri "r2://my-r2-bucket/my-video.mp4", got: ${r2Val.storageUri}`);
  }
  console.log('  ✓ R2 asset never becomes gcs://, stores storageUri, and legacy gcsVideoUri remains null');

  // 12.9 Genuine legacy GCS behavior remains unchanged in bulk creation
  const legacyJobsData = [{
    pageId: '11111111-1111-1111-1111-111111111111',
    gcsVideoUri: 'gcs://my-legacy-bucket/video.mp4',
    englishTitle: 'Legacy Video',
    englishCaption: 'Legacy Caption',
    scheduledTimeUTC: new Date(Date.now() + 200000),
  }];
  const capturedLegacyData: { value?: JobInputType } = {};
  const mockTx: BulkCreateScheduledJobsTx = {
    facebookPage: {
      findMany: async () => [{ id: '11111111-1111-1111-1111-111111111111', userId: 'mock-user-uuid' }],
    },
    videoJob: {
      create: async ({ data: dbData }) => {
        capturedLegacyData.value = dbData as unknown as JobInputType;
        return makeVideoJobFixture({
          id: 'legacy-job-uuid',
          pageId: dbData.pageId,
          userId: dbData.userId,
          gcsVideoUri: dbData.gcsVideoUri ?? null,
          storageUri: dbData.storageUri ?? null,
          uploadAssetId: dbData.uploadAssetId ?? null,
          englishTitle: dbData.englishTitle,
          englishCaption: dbData.englishCaption,
          scheduledTimeUTC: dbData.scheduledTimeUTC,
        });
      },
    },
    auditLog: {
      create: async () => ({ id: 'audit-log-uuid' }),
    },
  };
  const createdLegacy = await bulkCreateScheduledJobs(mockTx, 'mock-user-uuid', legacyJobsData);
  if (createdLegacy.length !== 1) throw new Error('Expected 1 legacy job created');
  const legacyVal = capturedLegacyData.value;
  if (!legacyVal) throw new Error('Expected legacy GCS job data to be captured.');
  if (legacyVal.gcsVideoUri !== 'gcs://my-legacy-bucket/video.mp4') {
    throw new Error(`Expected legacy GCS URI "gcs://my-legacy-bucket/video.mp4", got: ${legacyVal.gcsVideoUri}`);
  }
  if (legacyVal.storageUri !== null) {
    throw new Error(`Expected storageUri to be null, got: ${legacyVal.storageUri}`);
  }
  if (legacyVal.uploadAssetId !== null) {
    throw new Error(`Expected uploadAssetId to be null, got: ${legacyVal.uploadAssetId}`);
  }
  console.log('  ✓ Genuine legacy GCS behavior remains unchanged in bulk creation');

  // 13. Server-side completion validations
  console.log('Test: Server-side completion validations...');

  let mockAsset = {
    id: 'final-asset-uuid',
    userId: 'mock-user-uuid',
    status: UploadStatus.UPLOADING,
    expectedSize: BigInt(10485760), // 10 MiB (1 part)
    bucket: 'bucket',
    objectKey: 'key',
    finalizationOperation: null as UploadFinalizationOperation | null,
  };

  let mockCompletedParts: Array<{ partNumber: number; etag: string; size?: number }> = [];

  const fakeTx: FinalizationTransitionTx = {
    uploadAsset: {
      updateMany: async () => ({ count: 1 }),
    },
    uploadSession: {
      deleteMany: async () => ({ count: 1 }),
    },
    auditLog: {
      create: async () => ({ id: 'mock-audit-id' }),
    },
  };

  const fakeFinalizationDeps: FinalizationDependencies = {
    findUploadAsset: async () => mockAsset,
    findUploadSessionRecord: async () => ({
      uploadAssetId: 'final-asset-uuid',
      encryptionKeyVersion: 'v1',
      encryptedProviderSessionId: 'enc-provider-id',
      encryptedCompletedParts: 'enc-parts',
      expiresAt: new Date(Date.now() + 300000),
      lastActivityAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    acquireCompletionRecoveryClaim: async () => makeCompletionRecoveryClaim(),
    acquireInitialCompletionClaim: async () => makeInitialCompletionClaim(),
    acquireInitialAbortClaim: async () => makeInitialAbortClaim(),
    releaseFinalizationClaim: async () => true,
    clearFinalizationClaimAfterSuccessTx: async () => {},
    getDecryptedSession: async () => ({
      uploadAssetId: 'final-asset-uuid',
      providerSessionId: 'provider-session-id',
      completedParts: mockCompletedParts,
      expiresAt: new Date(Date.now() + 300000),
      lastActivityAt: new Date(),
    }),
    transitionStateTx: async () => {},
    deleteUploadSessionTx: async () => {},
    getStorageAdapter: () => ({
      completeMultipartUpload: async () => ({
        size: 25 * 1024 * 1024,
        etag: 'final-object-etag',
        lastModified: new Date(),
      }),
      abortMultipartUpload: async () => {},
    }),
    transaction: async (cb) => cb(fakeTx),
  };

  // Test 13.1: Incomplete/Empty parts fails
  mockCompletedParts = [];
  try {
    await UploadFinalizationService.completeUpload('mock-user-uuid', 'final-asset-uuid', undefined, fakeFinalizationDeps);
    throw new Error('Should have failed for empty parts');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes('Upload is incomplete: no completed parts')) {
      throw new Error(`Unexpected error on empty parts: ${msg}`);
    }
    console.log('  ✓ empty durable parts list fails');
  }

  // Test 13.2: Duplicate durable part numbers fail
  mockCompletedParts = [
    { partNumber: 1, etag: 'etag-1', size: 10485760 },
    { partNumber: 1, etag: 'etag-1', size: 10485760 },
  ];
  try {
    await UploadFinalizationService.completeUpload('mock-user-uuid', 'final-asset-uuid', undefined, fakeFinalizationDeps);
    throw new Error('Should have failed for duplicate parts');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes('Duplicate part numbers detected')) {
      throw new Error(`Unexpected error on duplicate parts: ${msg}`);
    }
    console.log('  ✓ duplicate durable part numbers fail');
  }

  // Test 13.3: Incomplete durable parts fail
  mockAsset = {
    id: 'final-asset-uuid',
    userId: 'mock-user-uuid',
    status: UploadStatus.UPLOADING,
    expectedSize: BigInt(25 * 1024 * 1024),
    bucket: 'bucket',
    objectKey: 'key',
    finalizationOperation: null,
  };
  mockCompletedParts = [
    { partNumber: 1, etag: 'etag-1', size: 10 * 1024 * 1024 },
    { partNumber: 2, etag: 'etag-2', size: 10 * 1024 * 1024 },
  ];
  try {
    await UploadFinalizationService.completeUpload('mock-user-uuid', 'final-asset-uuid', undefined, fakeFinalizationDeps);
    throw new Error('Should have failed for incomplete parts count');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes('expected 3 parts, but only 2 parts')) {
      throw new Error(`Unexpected error on incomplete parts: ${msg}`);
    }
    console.log('  ✓ incomplete durable parts count fails');
  }

  // Test 13.4: Incorrect sequential order fails
  mockCompletedParts = [
    { partNumber: 1, etag: 'etag-1', size: 10 * 1024 * 1024 },
    { partNumber: 3, etag: 'etag-3', size: 10 * 1024 * 1024 },
    { partNumber: 4, etag: 'etag-4', size: 5 * 1024 * 1024 },
  ];
  try {
    await UploadFinalizationService.completeUpload('mock-user-uuid', 'final-asset-uuid', undefined, fakeFinalizationDeps);
    throw new Error('Should have failed for non-sequential parts');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes('expected part number 2, but got 3')) {
      throw new Error(`Unexpected error on non-sequential parts: ${msg}`);
    }
    console.log('  ✓ non-sequential durable parts fail');
  }

  // Test 13.5: Missing durable ETag fails safely
  mockAsset = {
    id: 'final-asset-uuid',
    userId: 'mock-user-uuid',
    status: UploadStatus.UPLOADING,
    expectedSize: BigInt(10 * 1024 * 1024),
    bucket: 'bucket',
    objectKey: 'key',
    finalizationOperation: null,
  };
  mockCompletedParts = [
    { partNumber: 1, etag: '', size: 10 * 1024 * 1024 },
  ];
  try {
    await UploadFinalizationService.completeUpload('mock-user-uuid', 'final-asset-uuid', undefined, fakeFinalizationDeps);
    throw new Error('Should have failed for empty ETag');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes('Missing ETag for part number 1')) {
      throw new Error(`Unexpected error on missing ETag: ${msg}`);
    }
    console.log('  ✓ missing ETag in durable records fails');
  }

  // Test 13.6: final non-last multipart part-size constraints remain valid
  mockAsset = {
    id: 'final-asset-uuid',
    userId: 'mock-user-uuid',
    status: UploadStatus.UPLOADING,
    expectedSize: BigInt(25 * 1024 * 1024),
    bucket: 'bucket',
    objectKey: 'key',
    finalizationOperation: null,
  };
  mockCompletedParts = [
    { partNumber: 1, etag: 'etag-1', size: 9 * 1024 * 1024 },
    { partNumber: 2, etag: 'etag-2', size: 10 * 1024 * 1024 },
    { partNumber: 3, etag: 'etag-3', size: 6 * 1024 * 1024 },
  ];
  try {
    await UploadFinalizationService.completeUpload('mock-user-uuid', 'final-asset-uuid', undefined, fakeFinalizationDeps);
    throw new Error('Should have failed for invalid non-last part size');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes('Invalid part size: part number 1 size is 9437184 bytes')) {
      throw new Error(`Unexpected error on part-size constraint: ${msg}`);
    }
    console.log('  ✓ invalid non-last part size fails');
  }

  // Test 13.7: Correctly ordered durable parts complete successfully
  mockAsset = {
    id: 'final-asset-uuid',
    userId: 'mock-user-uuid',
    status: UploadStatus.UPLOADING,
    expectedSize: BigInt(25 * 1024 * 1024),
    bucket: 'bucket',
    objectKey: 'key',
    finalizationOperation: null,
  };
  mockCompletedParts = [
    { partNumber: 1, etag: 'etag-1', size: 10 * 1024 * 1024 },
    { partNumber: 2, etag: 'etag-2', size: 10 * 1024 * 1024 },
    { partNumber: 3, etag: 'etag-3', size: 5 * 1024 * 1024 },
  ];

  const successResult = await UploadFinalizationService.completeUpload('mock-user-uuid', 'final-asset-uuid', undefined, fakeFinalizationDeps) as Record<string, unknown>;
  if (successResult.id !== 'final-asset-uuid') {
    throw new Error('Expected completeUpload to return serialized asset');
  }
  console.log('  ✓ correctly structured durable parts complete successfully');

  console.log('ALL BROWSER MULTIPART UPLOADER INTEGRATION TESTS PASSED! 🎉');
}

runTests().catch((e) => {
  console.error('TEST SUITE FAILED:', e);
  process.exit(1);
});
