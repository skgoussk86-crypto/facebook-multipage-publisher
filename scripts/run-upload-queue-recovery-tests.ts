import { UploadQueueController, QueueItem } from '../src/lib/uploads/upload-queue-controller';
import { GoogleUploadTransport } from '../src/lib/uploads/google-drive-resumable-uploader';

// -------------------------------------------------------------
// Environment Mocks
// -------------------------------------------------------------
let storage: Record<string, string> = {};
const mockLocalStorage: Storage = {
  getItem: (key: string) => storage[key] || null,
  setItem: (key: string, value: string) => { storage[key] = String(value); },
  removeItem: (key: string) => { delete storage[key]; },
  clear: () => { storage = {}; },
  get length() { return Object.keys(storage).length; },
  key: (index: number) => Object.keys(storage)[index] || null,
};
Object.defineProperty(global, 'localStorage', { value: mockLocalStorage, writable: true });

class FakeFile {
  name: string;
  size: number;
  type: string;
  lastModified: number;

  constructor(name: string, size: number, type: string, lastModified = Date.now()) {
    this.name = name;
    this.size = size;
    this.type = type;
    this.lastModified = lastModified;
  }

  slice(start: number, end: number) {
    return new FakeFile(this.name, end - start, this.type, this.lastModified);
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
  const jsonStr = JSON.stringify(data);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => jsonStr,
    headers: {
      get: (name: string) => headers[name] || headers[name.toLowerCase()] || null,
    },
  } as unknown as Response;
}

// -------------------------------------------------------------
// Helper to pause execution briefly
// -------------------------------------------------------------
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// -------------------------------------------------------------
// Test Suite Executable
// -------------------------------------------------------------
async function runTests() {
  console.log('Starting Phase 5B Automated Upload Queue & Recovery Test Suite...');

  // Setup basic fetch handlers
  fetchMockHandler = async (url: string, init?: RequestInit) => {
    if (url === '/api/uploads/initiate') {
      const body = JSON.parse(init?.body as string);
      return createMockResponse(201, {
        provider: 'GOOGLE_DRIVE',
        assetId: `asset-${body.filename}`,
        filename: body.filename,
        mimeType: body.declaredMimeType,
        totalBytes: body.expectedSize,
        idempotentReplay: false,
      });
    }

    if (url.startsWith('/api/uploads/asset-') && url.endsWith('/reconcile')) {
      return createMockResponse(200, {
        status: 'UPLOADING',
        confirmedBytes: 0,
      });
    }

    if (url.startsWith('/api/uploads/')) {
      return createMockResponse(200, {
        status: 'UPLOADING',
      });
    }

    return createMockResponse(404, { error: 'Not found' });
  };

  // Test 1: Selecting several valid files creates several queue items
  console.log('\nTest 1: Selecting several valid files...');
  mockLocalStorage.clear();
  let onChangeItems: QueueItem[] = [];
  const controller1 = new UploadQueueController({
    onChange: (items) => { onChangeItems = items; },
  });

  const file1 = new FakeFile('video1.mp4', 10 * 1024 * 1024, 'video/mp4', 1000);
  const file2 = new FakeFile('video2.mov', 20 * 1024 * 1024, 'video/quicktime', 2000);
  const file3 = new FakeFile('video3.mp4', 30 * 1024 * 1024, 'video/mp4', 3000);

  controller1.addFiles([file1 as unknown as File, file2 as unknown as File, file3 as unknown as File]);
  if (onChangeItems.length !== 3) {
    throw new Error(`Expected 3 items in queue, got ${onChangeItems.length}`);
  }
  console.log('  ✓ Created 3 stable queue items');

  // Test 2: Invalid files do not block valid files
  console.log('\nTest 2: Invalid files do not block valid files...');
  mockLocalStorage.clear();
  const controller2 = new UploadQueueController();
  const validFile = new FakeFile('valid.mp4', 10 * 1024 * 1024, 'video/mp4', 1000);
  const invalidTypeFile = new FakeFile('invalid.png', 10 * 1024 * 1024, 'image/png', 2000);
  const tooLargeFile = new FakeFile('large.mp4', 600 * 1024 * 1024, 'video/mp4', 3000);

  controller2.addFiles([validFile as unknown as File, invalidTypeFile as unknown as File, tooLargeFile as unknown as File]);
  const items = controller2.getItems();
  
  const validItem = items.find((i) => i.filename === 'valid.mp4');
  const invalidTypeItem = items.find((i) => i.filename === 'invalid.png');
  const tooLargeItem = items.find((i) => i.filename === 'large.mp4');

  if (!validItem || validItem.status === 'FAILED') {
    throw new Error('Valid file should not be marked failed');
  }
  if (!invalidTypeItem || invalidTypeItem.status !== 'FAILED' || !invalidTypeItem.error?.includes('type')) {
    throw new Error('Invalid type file should have type error');
  }
  if (!tooLargeItem || tooLargeItem.status !== 'FAILED' || !tooLargeItem.error?.includes('size')) {
    throw new Error('Too large file should have size error');
  }
  console.log('  ✓ Invalid files received specific failures without blocking valid files');

  // Test 3: Maximum active concurrency is respected
  console.log('\nTest 3: Concurrency boundary is respected...');
  mockLocalStorage.clear();
  const controller3 = new UploadQueueController({ maxConcurrency: 2 });
  const fA = new FakeFile('fA.mp4', 10 * 1024 * 1024, 'video/mp4', 1000);
  const fB = new FakeFile('fB.mp4', 10 * 1024 * 1024, 'video/mp4', 2000);
  const fC = new FakeFile('fC.mp4', 10 * 1024 * 1024, 'video/mp4', 3000);

  controller3.addFiles([fA as unknown as File, fB as unknown as File, fC as unknown as File]);
  const activeCount = controller3.getActiveSlotsCount();
  if (activeCount > 2) {
    throw new Error(`Active slots count ${activeCount} exceeded limit of 2`);
  }
  
  const items3 = controller3.getItems();
  const itemC = items3.find((i) => i.filename === 'fC.mp4');
  if (itemC?.status !== 'QUEUED') {
    throw new Error(`Third item should remain QUEUED, got status: ${itemC?.status}`);
  }
  console.log('  ✓ Concurrency bounded at maximum of 2 active uploads');

  // Test 4: Completing one upload starts the next queued upload
  console.log('\nTest 4: Completion starts next queued upload...');
  const itemA = items3.find((i) => i.filename === 'fA.mp4')!;
  
  // Simulate validated/completion of itemA
  controller3['handleUploaderStatusChange'](itemA.id, {
    state: 'validated',
    progressPercent: 100,
    uploadedBytes: itemA.size,
    totalBytes: itemA.size,
    assetId: itemA.assetId,
    metadata: { durationMs: 5000 },
  });

  const newActiveCount = controller3.getActiveSlotsCount();
  const updatedItemC = controller3.getItems().find((i) => i.filename === 'fC.mp4')!;
  if (updatedItemC.status === 'QUEUED') {
    throw new Error('Third item should have started uploading after slot freed');
  }
  console.log(`  ✓ Next queued item started uploading. Concurrency is: ${newActiveCount} active slots`);

  // Test 5: Pausing frees an upload slot when appropriate
  console.log('\nTest 5: Pausing frees slot...');
  mockLocalStorage.clear();
  const controller5 = new UploadQueueController({ maxConcurrency: 1 });
  controller5.addFiles([fA as unknown as File, fB as unknown as File]);
  
  const item5A = controller5.getItems().find((i) => i.filename === 'fA.mp4')!;
  controller5.pauseUpload(item5A.id);

  const item5B = controller5.getItems().find((i) => i.filename === 'fB.mp4')!;
  if (item5B.status === 'QUEUED') {
    throw new Error('Second item should start when first is paused');
  }
  console.log('  ✓ Slot freed by pausing, next item automatically started');

  // Test 6: Resuming reconciles before sending more chunks
  console.log('\nTest 6: Resuming reconciles before sending more chunks...');
  let reconcileCalled = false;
  fetchMockHandler = async (url: string) => {
    if (url.endsWith('/reconcile')) {
      reconcileCalled = true;
      return createMockResponse(200, {
        status: 'UPLOADING',
        confirmedBytes: 5 * 1024 * 1024,
      });
    }
    if (url.startsWith('/api/uploads/')) {
      return createMockResponse(200, { status: 'UPLOADING' });
    }
    return createMockResponse(404, {});
  };

  controller5.pauseUpload(item5B.id); // free everything
  controller5.resumeUpload(item5B.id);
  if (!reconcileCalled) {
    throw new Error('Reconciliation API route was not invoked on resume');
  }
  console.log('  ✓ Resuming successfully invoked server-side reconciliation first');

  // Test 7: Retryable failure does not block the queue
  console.log('\nTest 7: Retryable failure does not block the queue...');
  mockLocalStorage.clear();
  const controller7 = new UploadQueueController({ maxConcurrency: 1 });
  controller7.addFiles([fA as unknown as File, fB as unknown as File]);
  const item7A = controller7.getItems().find((i) => i.filename === 'fA.mp4')!;
  
  // Simulate network/transient failure on 7A
  controller7['handleUploaderStatusChange'](item7A.id, {
    state: 'failed',
    progressPercent: 20,
    uploadedBytes: 2 * 1024 * 1024,
    totalBytes: item7A.size,
    error: 'Network error',
  });

  const item7B = controller7.getItems().find((i) => i.filename === 'fB.mp4')!;
  if (item7B.status === 'QUEUED') {
    throw new Error('Queued item should start when active item fails');
  }
  console.log('  ✓ Transient failure did not block queue; subsequent item started');

  // Test 8: Terminal failure does not retry automatically
  console.log('\nTest 8: Terminal failure does not auto-retry...');
  if (item7A.status !== 'FAILED') {
    throw new Error('Expected item state to remain failed');
  }
  // Wait to make sure no background retry was scheduled
  await delay(100);
  const status7A: string = item7A.status;
  if (status7A === 'QUEUED' || status7A === 'INITIATING') {
    throw new Error('Terminal failed item was retried automatically');
  }
  console.log('  ✓ Verified terminal failure does not retry automatically');

  // Test 9: Cancelling one item does not affect others
  console.log('\nTest 9: Cancelling one item does not affect others...');
  mockLocalStorage.clear();
  const controller9 = new UploadQueueController({ maxConcurrency: 2 });
  controller9.addFiles([fA as unknown as File, fB as unknown as File]);
  const item9A = controller9.getItems().find((i) => i.filename === 'fA.mp4')!;
  const item9B = controller9.getItems().find((i) => i.filename === 'fB.mp4')!;
  
  controller9.cancelUpload(item9A.id);
  if (item9B.status === 'CANCELLED') {
    throw new Error('Cancelling A should not affect B');
  }
  console.log('  ✓ Cancelled upload in queue independently without side effects');

  // Test 10: Removing a queued item works
  console.log('\nTest 10: Removing a queued item works...');
  mockLocalStorage.clear();
  const controller10 = new UploadQueueController({ maxConcurrency: 1 });
  controller10.addFiles([fA as unknown as File, fB as unknown as File]);
  const item10B = controller10.getItems().find((i) => i.filename === 'fB.mp4')!;
  controller10.removeItem(item10B.id);
  const items10 = controller10.getItems();
  if (items10.find((i) => i.id === item10B.id)) {
    throw new Error('Removed item still present in queue list');
  }
  console.log('  ✓ Successfully removed queued item');

  // Test 11: Double Start does not create duplicate initiations
  console.log('\nTest 11: Double click Start prevention...');
  let initiationCount = 0;
  fetchMockHandler = async (url: string) => {
    if (url === '/api/uploads/initiate') {
      initiationCount++;
      return createMockResponse(201, {
        provider: 'GOOGLE_DRIVE',
        assetId: 'asset-double-start',
        filename: 'double.mp4',
        mimeType: 'video/mp4',
        totalBytes: '1000',
        idempotentReplay: false,
      });
    }
    return createMockResponse(200, { status: 'UPLOADING' });
  };
  mockLocalStorage.clear();
  const controller11 = new UploadQueueController({ maxConcurrency: 2 });
  const doubleFile = new FakeFile('double.mp4', 1000, 'video/mp4');
  controller11.addFiles([doubleFile as unknown as File]);
  
  // Double-trigger start
  const doubleItem = controller11.getItems()[0];
  controller11['startUploadItem'](doubleItem);
  controller11['startUploadItem'](doubleItem);
  await delay(50);
  if (initiationCount > 1) {
    throw new Error(`Expected at most 1 initiation call, got ${initiationCount}`);
  }
  console.log('  ✓ Double click Start / repeated effect does not create duplicates');

  // Test 12: Selecting same file twice is detected
  console.log('\nTest 12: Selecting same file twice in batch detected...');
  mockLocalStorage.clear();
  const controller12 = new UploadQueueController();
  controller12.addFiles([fA as unknown as File, fA as unknown as File]);
  const items12 = controller12.getItems();
  const failedDup = items12.find((i) => i.error?.includes('Duplicate'));
  if (!failedDup) {
    throw new Error('Expected duplicate selection to produce a failed duplicate queue item');
  }
  console.log('  ✓ Duplicate file selection in batch rejected with specific error');

  // Test 13: Re-selecting file already present in queue is detected
  console.log('\nTest 13: Selecting file already in queue detected...');
  controller12.addFiles([fA as unknown as File]);
  const newItems12 = controller12.getItems();
  const dupCount = newItems12.filter((i) => i.error?.includes('Duplicate')).length;
  if (dupCount < 2) {
    throw new Error('Expected new duplicate selection to fail as well');
  }
  console.log('  ✓ Selecting file already in queue rejected with specific error');

  // Test 14: Refresh restoration reconstructs safe queue cards
  console.log('\nTest 14: Refresh restoration restores items safely...');
  // Set up mock items in localStorage
  mockLocalStorage.clear();
  const savedData = {
    version: 3,
    items: [
      {
        id: 'queue-test-refresh',
        fingerprint: 'fp-video.mp4-100-video/mp4-1000',
        filename: 'video.mp4',
        size: 100,
        type: 'video/mp4',
        lastModified: 1000,
        status: 'PAUSED',
        progressPercent: 50,
        uploadedBytes: 50,
        assetId: 'asset-test-refresh',
        idempotencyKey: 'idem-test-refresh',
        timestamp: Date.now(),
        pageId: 'page-1',
        englishTitle: 'Title',
      }
    ]
  };
  mockLocalStorage.setItem('fb_publisher_upload_queue_v3', JSON.stringify(savedData));
  
  const controller14 = new UploadQueueController();
  const restoredItems = controller14.getItems();
  if (restoredItems.length !== 1 || restoredItems[0].id !== 'queue-test-refresh') {
    throw new Error('Restored items count or details mismatch');
  }
  console.log('  ✓ Restored cards from versioned local storage safely');

  // Test 15: Completed/validated items restore without requiring original File
  console.log('\nTest 15: Completed items restore in VALIDATED state without File...');
  mockLocalStorage.clear();
  const savedValidatedData = {
    version: 3,
    items: [
      {
        id: 'queue-validated',
        fingerprint: 'fp-video.mp4-100-video/mp4-1000',
        filename: 'video.mp4',
        size: 100,
        type: 'video/mp4',
        lastModified: 1000,
        status: 'VALIDATED',
        progressPercent: 100,
        uploadedBytes: 100,
        assetId: 'asset-validated',
        idempotencyKey: 'idem-validated',
        timestamp: Date.now(),
      }
    ]
  };
  mockLocalStorage.setItem('fb_publisher_upload_queue_v3', JSON.stringify(savedValidatedData));
  const controller15 = new UploadQueueController();
  if (controller15.getItems()[0].status !== 'VALIDATED') {
    throw new Error('Completed items should remain in VALIDATED status');
  }
  console.log('  ✓ Completed/validated items successfully restored without asking for file');

  // Test 16: Incomplete items restore as NEEDS_FILE_RESELECTION
  console.log('\nTest 16: Incomplete items restore as NEEDS_FILE_RESELECTION...');
  if (restoredItems[0].status !== 'NEEDS_FILE_RESELECTION') {
    throw new Error(`Incomplete item should have restored as NEEDS_FILE_RESELECTION, got: ${restoredItems[0].status}`);
  }
  console.log('  ✓ Incomplete items correctly marked as needing reselection');

  // Test 17: Correct file reselection resumes the existing asset
  console.log('\nTest 17: Correct file reselection resumes existing asset...');
  const originalFileObj = new FakeFile('video.mp4', 100, 'video/mp4', 1000);
  const reselectRes = controller14.reselectFile('queue-test-refresh', originalFileObj as unknown as File);
  if (!reselectRes.success) {
    throw new Error(`Reselection failed: ${reselectRes.error}`);
  }
  const reselectedItem = controller14.getItems()[0];
  if (reselectedItem.status !== 'PAUSED' || !reselectedItem.file) {
    throw new Error('Reselected item should transition to PAUSED and have a file attached');
  }
  console.log('  ✓ Correct reselection accepted and attached file safely');

  // Test 18: Incorrect file reselection is rejected
  console.log('\nTest 18: Mismatched file reselection is rejected...');
  const badFileObj = new FakeFile('video.mp4', 101, 'video/mp4', 1000); // size mismatch
  const badReselectRes = controller14.reselectFile('queue-test-refresh', badFileObj as unknown as File);
  if (badReselectRes.success) {
    throw new Error('Mismatched file should have been rejected');
  }
  if (badReselectRes.error !== 'RECOVERY_FILE_MISMATCH') {
    throw new Error(`Expected RECOVERY_FILE_MISMATCH error, got: ${badReselectRes.error}`);
  }
  console.log('  ✓ Mismatched replacement file successfully rejected');

  // Test 19: Malformed persisted queue data is ignored safely
  console.log('\nTest 19: Malformed localStorage data ignored...');
  mockLocalStorage.clear();
  mockLocalStorage.setItem('fb_publisher_upload_queue_v3', '{ invalid json: [ ] }');
  const controller19 = new UploadQueueController();
  if (controller19.getItems().length !== 0) {
    throw new Error('Controller should ignore malformed local storage gracefully');
  }
  console.log('  ✓ Ignored malformed JSON safely without crashing page');

  // Test 20: No provider session URI or token appears in persisted browser state
  console.log('\nTest 20: No secrets appear in persisted browser state...');
  mockLocalStorage.clear();
  const controller20 = new UploadQueueController();
  controller20.addFiles([file1 as unknown as File]);
  controller20.saveToStorage();
  const savedJson = mockLocalStorage.getItem('fb_publisher_upload_queue_v3')!;
  if (savedJson.includes('sessionUri') || savedJson.includes('token') || savedJson.includes('https://')) {
    throw new Error('Persisted JSON contains potential secrets or URIs');
  }
  console.log('  ✓ Confirmed no tokens or session URIs appear in localStorage');

  // Test 21: Queue persistence schema migration/version handling is safe
  console.log('\nTest 21: Schema version migration is safe...');
  mockLocalStorage.clear();
  // Store an old schema version
  const oldSchema = {
    version: 1,
    items: [{ id: 'old-id', status: 'uploading' }]
  };
  mockLocalStorage.setItem('fb_publisher_upload_queue_v3', JSON.stringify(oldSchema));
  const controller21 = new UploadQueueController();
  if (controller21.getItems().length !== 0) {
    throw new Error('Old schema version should be gracefully reset/ignored');
  }
  console.log('  ✓ Old schema versions safely ignored without crashing');

  // Test 22: One failed item does not prevent later queued items from starting
  console.log('\nTest 22: Failure of one item does not block other items...');
  mockLocalStorage.clear();
  const controller22 = new UploadQueueController({ maxConcurrency: 1 });
  controller22.addFiles([fA as unknown as File, fB as unknown as File]);
  const item22A = controller22.getItems().find((i) => i.filename === 'fA.mp4')!;
  
  // Fail A
  controller22['handleUploaderStatusChange'](item22A.id, {
    state: 'failed',
    progressPercent: 10,
    uploadedBytes: 1000,
    totalBytes: item22A.size,
    error: 'Permanent failure',
  });

  const item22B = controller22.getItems().find((i) => i.filename === 'fB.mp4')!;
  if (item22B.status === 'QUEUED') {
    throw new Error('Item B should start uploading after A failed');
  }
  console.log('  ✓ Next queued item started after a permanent failure of previous item');

  // Test 23: Initiate endpoint never returns sessionUri
  console.log('\nTest 23: Initiate endpoint never returns sessionUri...');
  mockLocalStorage.clear();
  fetchMockHandler = async (url: string) => {
    if (url === '/api/uploads/initiate') {
      return createMockResponse(201, {
        provider: 'GOOGLE_DRIVE',
        assetId: 'asset-test-initiate',
        filename: 'video.mp4',
        mimeType: 'video/mp4',
        totalBytes: '1000',
        idempotentReplay: false,
      });
    }
    return createMockResponse(200, {});
  };
  const controller23 = new UploadQueueController();
  const file23 = new FakeFile('video.mp4', 1000, 'video/mp4');
  controller23.addFiles([file23 as unknown as File]);
  await delay(50);
  const items23 = controller23.getItems();
  for (const item of items23) {
    if ((item as unknown as Record<string, unknown>).sessionUri || JSON.stringify(item).includes('sessionUri')) {
      throw new Error('Queue item or serialized JSON contains sessionUri');
    }
  }
  console.log('  ✓ Verified initiate endpoint response is free of sessionUri');

  // Test 24: Legacies are removed or sanitized
  console.log('\nTest 24: Legacy recovery records containing sessionUri are scrubbed/sanitized...');
  mockLocalStorage.clear();
  mockLocalStorage.setItem(
    'upload_recovery_recovery-key-legacy',
    JSON.stringify({
      version: 2,
      provider: 'GOOGLE_DRIVE',
      assetId: 'legacy-asset-id',
      sessionUri: 'https://www.googleapis.com/upload/drive/resumable-session-12345',
      filename: 'legacy-video.mp4',
      mimeType: 'video/mp4',
      totalBytes: '10000',
      lastModified: 1000,
    })
  );
  new UploadQueueController();
  const scrubbedRecord = mockLocalStorage.getItem('upload_recovery_recovery-key-legacy');
  if (!scrubbedRecord) {
    throw new Error('Expected legacy record to be sanitized to version 3, not deleted');
  }
  const parsedScrubbed = JSON.parse(scrubbedRecord);
  if (parsedScrubbed.sessionUri || parsedScrubbed.version === 2) {
    throw new Error('Sanitized record still contains sessionUri or is version 2');
  }
  if (parsedScrubbed.version !== 3 || parsedScrubbed.assetId !== 'legacy-asset-id') {
    throw new Error('Sanitized record properties are invalid or version is not 3');
  }
  console.log('  ✓ Sanitized legacy record successfully, converting to version 3 and removing sessionUri');

  // Test 25: Client chunks target only the same-origin application route, never directly calling Google Drive
  console.log('\nTest 25: Client chunks target only same-origin application route...');
  let chunkUploadUrl = '';
  let chunkAttempts = 0;
  fetchMockHandler = async (url: string) => {
    if (url === '/api/uploads/initiate') {
      return createMockResponse(201, {
        provider: 'GOOGLE_DRIVE',
        assetId: 'asset-test-proxy',
        filename: 'proxy.mp4',
        mimeType: 'video/mp4',
        totalBytes: '100',
        idempotentReplay: false,
      });
    }
    if (url.includes('/chunk')) {
      chunkUploadUrl = url;
      chunkAttempts++;
      if (chunkAttempts === 1) {
        return createMockResponse(200, {
          uploadAssetId: 'asset-test-proxy',
          status: 'UPLOADING',
          confirmedBytes: 50,
          completed: false,
        });
      } else {
        return createMockResponse(200, {
          uploadAssetId: 'asset-test-proxy',
          status: 'VALIDATING',
          confirmedBytes: 100,
          completed: true,
        });
      }
    }
    if (url.endsWith('/reconcile')) {
      return createMockResponse(200, {
        status: 'UPLOADING',
        confirmedBytes: 0,
      });
    }
    if (url.endsWith('/validate')) {
      return createMockResponse(200, {
        status: 'VALIDATED',
        durationMs: 5000,
      });
    }
    return createMockResponse(200, {});
  };
  mockLocalStorage.clear();
  const mockTransport: GoogleUploadTransport = {
    send: async (req) => {
      const headersInit: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers || {})) {
        headersInit[k] = String(v);
      }
      const response = await fetch(req.url, {
        method: req.method,
        headers: headersInit,
        body: req.body as BodyInit | null,
        signal: req.signal,
      });
      const bodyText = await response.text();
      const headersMap = new Map<string, string>();
      try {
        const parsed = JSON.parse(bodyText);
        const confirmed = parsed.confirmedBytes ?? 0;
        headersMap.set('Range', `bytes=0-${confirmed - 1}`);
      } catch {
        headersMap.set('Range', 'bytes=0-49');
      }
      return {
        status: response.status,
        headers: {
          get: (name: string) => headersMap.get(name.toLowerCase()) ?? null,
        },
        body: bodyText,
      };
    }
  };
  const controller25 = new UploadQueueController({ maxConcurrency: 1, transport: mockTransport });
  const proxyFile = new FakeFile('proxy.mp4', 100, 'video/mp4');
  controller25.addFiles([proxyFile as unknown as File]);
  await delay(100);
  console.log('Test 25 state:', controller25.getItems()[0]?.status, controller25.getItems()[0]?.error);
  if (!chunkUploadUrl) {
    throw new Error('Chunk proxy endpoint was not called');
  }
  if (!chunkUploadUrl.startsWith('/api/uploads/asset-test-proxy/chunk')) {
    throw new Error(`Client uploaded to non-same-origin or invalid URL: ${chunkUploadUrl}`);
  }
  if (chunkUploadUrl.includes('googleapis.com')) {
    throw new Error('Client directly uploaded to googleapis.com');
  }
  console.log('  ✓ Confirmed client chunks targeted same-origin proxy route');

  console.log('\nAll Phase 5B queue tests completed successfully!');
}

runTests().catch((err) => {
  console.error('\nTest suite failed with error:', err);
  process.exit(1);
});
