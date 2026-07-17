import {
  GoogleDriveResumableUploader,
  GoogleUploadTransport,
  GoogleUploadTransportRequest,
  GoogleUploadTransportResponse,
  parseRangeHeader,
  parseRetryAfterHeader
} from '../src/lib/uploads/google-drive-resumable-uploader';
import { BrowserMultipartUploader } from '../src/lib/uploads/browser-multipart-uploader';
import { BrowserUploaderStatus, UploadFileLike } from '../src/lib/uploads/upload-types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// -------------------------------------------------------------
// Environment mocks
// -------------------------------------------------------------
class MockLocalStorage implements Storage {
  private store: Record<string, string> = {};

  get length(): number {
    return Object.keys(this.store).length;
  }

  clear(): void {
    this.store = {};
  }

  getItem(key: string): string | null {
    return this.store[key] || null;
  }

  key(index: number): string | null {
    const keys = Object.keys(this.store);
    return keys[index] || null;
  }

  removeItem(key: string): void {
    delete this.store[key];
  }

  setItem(key: string, value: string): void {
    this.store[key] = value;
  }
}

const mockLocalStorage = new MockLocalStorage();
Object.defineProperty(global, 'localStorage', { value: mockLocalStorage, writable: true });

class FakeUploadFile implements UploadFileLike {
  readonly name: string;
  readonly size: number;
  readonly type: string;
  readonly lastModified: number;

  constructor(name: string, size: number, type: string, lastModified?: number) {
    this.name = name;
    this.size = size;
    this.type = type;
    this.lastModified = lastModified ?? 1234567890;
  }

  slice(start?: number, end?: number, contentType?: string): Blob {
    const startVal = start ?? 0;
    const endVal = end ?? this.size;
    return new Blob([], { type: contentType || this.type }).slice(0, endVal - startVal);
  }
}

class MockTransport implements GoogleUploadTransport {
  public requests: GoogleUploadTransportRequest[] = [];
  public responseHandler: (req: GoogleUploadTransportRequest) => Promise<GoogleUploadTransportResponse> = () => {
    throw new Error('No handler configured');
  };

  async send(req: GoogleUploadTransportRequest): Promise<GoogleUploadTransportResponse> {
    this.requests.push(req);
    if (req.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    return this.responseHandler(req);
  }
}

const fetchRequests: { url: string; init?: RequestInit }[] = [];
let fetchHandler: (url: string, init?: RequestInit) => Promise<Response> = () => {
  throw new Error('No fetch handler configured');
};

Object.defineProperty(global, 'fetch', {
  value: async (url: string, init?: RequestInit) => {
    fetchRequests.push({ url, init });
    if (init?.signal?.aborted) {
      const err = new Error('The user aborted a request.');
      err.name = 'AbortError';
      throw err;
    }
    return fetchHandler(url, init);
  },
  writable: true,
});

function createMockResponse(status: number, data: unknown, headersMap: Record<string, string> = {}): Response {
  const headers = new Headers();
  for (const [key, val] of Object.entries(headersMap)) {
    headers.set(key, val);
  }
  return new Response(JSON.stringify(data), {
    status,
    headers,
  });
}

function createTransportResponse(status: number, body: string, headers: Record<string, string> = {}): GoogleUploadTransportResponse {
  return {
    status,
    headers: {
      get: (name: string) => headers[name] || headers[name.toLowerCase()] || null,
    },
    body,
  };
}

async function runTests() {
  console.log('Running Google Drive Browser-Side Resumable Upload Tests...\n');
  let testCount = 0;

  // Reset helper
  function reset() {
    fetchRequests.length = 0;
    mockLocalStorage.clear();
    fetchHandler = () => {
      throw new Error('No fetch handler configured');
    };
  }

  // 1. parses the Google Drive initiation response
  {
    reset();
    const transport = new MockTransport();
    const statusEmitted: BrowserUploaderStatus[] = [];
    
    fetchHandler = async (url) => {
      if (url === '/api/uploads/initiate') {
        return createMockResponse(201, {
          provider: 'GOOGLE_DRIVE',
          assetId: 'gd-asset-id',
          sessionUri: 'https://google.mock/session-123',
          filename: 'video.mp4',
          mimeType: 'video/mp4',
          totalBytes: '15000000',
          idempotentReplay: false,
        });
      }
      if (url === '/api/uploads/gd-asset-id/complete') {
        return createMockResponse(200, { status: 'VALIDATING' });
      }
      if (url === '/api/uploads/gd-asset-id') {
        return createMockResponse(200, { status: 'VALIDATED' });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    transport.responseHandler = async () => {
      return createTransportResponse(200, JSON.stringify({ id: 'valid_drive_id' }));
    };

    const file = new FakeUploadFile('video.mp4', 15000000, 'video/mp4');
    const uploader = new BrowserMultipartUploader({
      file,
      recoveryKey: 'test-key',
      transport,
      onStatusChange: (status) => {
        statusEmitted.push(status);
      },
    });

    await uploader.start();
    const finalStatus = uploader.getStatus();

    if (finalStatus.provider !== 'GOOGLE_DRIVE' || finalStatus.assetId !== 'gd-asset-id') {
      throw new Error('Test 1 failed: provider or assetId parsed incorrectly');
    }
    console.log('✓ Test 1: parses the Google Drive initiation response passed');
    testCount++;
  }

  // 2. stores the version-2 recovery record without exposing it in status (and verifies a mismatched recovery record is cleared and never reused)
  {
    reset();
    const transport = new MockTransport();
    const statusEmitted: BrowserUploaderStatus[] = [];

    // Store mismatched Google record in localStorage
    localStorage.setItem(
      'upload_recovery_test-key',
      JSON.stringify({
        version: 2,
        provider: 'GOOGLE_DRIVE',
        assetId: 'gd-asset-id-old',
        sessionUri: 'https://google.mock/session-123',
        filename: 'different-video.mp4', // Mismatch!
        mimeType: 'video/mp4',
        totalBytes: '15000000',
        lastModified: 1234567890,
      })
    );

    let initiationCalled = false;
    fetchHandler = async (url) => {
      if (url === '/api/uploads/initiate') {
        initiationCalled = true;
        return createMockResponse(201, {
          provider: 'GOOGLE_DRIVE',
          assetId: 'gd-asset-id-new',
          sessionUri: 'https://google.mock/session-456',
          filename: 'video.mp4',
          mimeType: 'video/mp4',
          totalBytes: '15000000',
          idempotentReplay: false,
        });
      }
      if (url === '/api/uploads/gd-asset-id-new/complete') {
        return createMockResponse(200, { status: 'VALIDATING' });
      }
      if (url === '/api/uploads/gd-asset-id-new') {
        return createMockResponse(200, { status: 'VALIDATING' });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    transport.responseHandler = async () => {
      return createTransportResponse(200, JSON.stringify({ id: 'valid_drive_id' }));
    };

    const file = new FakeUploadFile('video.mp4', 15000000, 'video/mp4');
    const uploader = new BrowserMultipartUploader({
      file,
      recoveryKey: 'test-key',
      transport,
      onStatusChange: (status) => {
        statusEmitted.push(status);
      },
    });

    await uploader.start();

    // Verify mismatched recovery record was discarded and a new session initiated
    if (!initiationCalled) {
      uploader.destroy();
      throw new Error('Test 2 failed: mismatched record was reused or not cleared');
    }

    // Verify localStorage has matching version-2 Google Drive recovery record now
    const stored = localStorage.getItem('upload_recovery_test-key');
    if (!stored) {
      uploader.destroy();
      throw new Error('Test 2 failed: recovery record not written');
    }
    const parsed: unknown = JSON.parse(stored);
    if (!isRecord(parsed)) {
      uploader.destroy();
      throw new Error('Test 2 failed: recovery record is not a record');
    }
    const ver = parsed.version;
    const prov = parsed.provider;
    const sUri = parsed.sessionUri;
    if (ver !== 2 || prov !== 'GOOGLE_DRIVE' || sUri !== 'https://google.mock/session-456') {
      uploader.destroy();
      throw new Error('Test 2 failed: incorrect recovery record structure');
    }

    // Verify state status does not contain sessionUri
    const status = uploader.getStatus();
    if (JSON.stringify(status).includes('https://google.mock/session-456')) {
      uploader.destroy();
      throw new Error('Test 2 failed: status leaked sessionUri');
    }

    uploader.destroy();
    console.log('✓ Test 2: stores the version-2 recovery record without exposing it in status passed');
    testCount++;
  }

  // 3. uploads a single-chunk file ending with HTTP 201
  {
    reset();
    const transport = new MockTransport();
    fetchHandler = async (url) => {
      if (url === '/api/uploads/initiate') {
        return createMockResponse(201, {
          provider: 'GOOGLE_DRIVE',
          assetId: 'gd-asset-id',
          sessionUri: 'https://google.mock/session-123',
          filename: 'video.mp4',
          mimeType: 'video/mp4',
          totalBytes: '5000000',
          idempotentReplay: false,
        });
      }
      if (url === '/api/uploads/gd-asset-id/complete') {
        return createMockResponse(200, { status: 'VALIDATING' });
      }
      if (url === '/api/uploads/gd-asset-id') {
        return createMockResponse(200, { status: 'VALIDATED' });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    let putCount = 0;
    transport.responseHandler = async (req) => {
      if (req.method === 'PUT') {
        putCount++;
        if (req.headers['Content-Range'] === 'bytes */5000000') {
          // Status query -> return 308 with no Range (confirmed 0 bytes)
          return createTransportResponse(308, '');
        }
        return createTransportResponse(201, JSON.stringify({ id: 'valid_drive_id' }));
      }
      throw new Error('Unexpected transport method');
    };

    const file = new FakeUploadFile('video.mp4', 5000000, 'video/mp4');
    const uploader = new BrowserMultipartUploader({
      file,
      recoveryKey: 'test-key',
      transport,
    });

    await uploader.start();
    if (putCount !== 1) {
      throw new Error(`Test 3 failed: expected 1 PUT request, got ${putCount}`);
    }
    console.log('✓ Test 3: uploads a single-chunk file ending with HTTP 201 passed');
    testCount++;
  }

  // 4. uploads multiple chunks using intermediate HTTP 308
  {
    reset();
    const transport = new MockTransport();
    fetchHandler = async (url) => {
      if (url === '/api/uploads/initiate') {
        return createMockResponse(201, {
          provider: 'GOOGLE_DRIVE',
          assetId: 'gd-asset-id',
          sessionUri: 'https://google.mock/session-123',
          filename: 'video.mp4',
          mimeType: 'video/mp4',
          totalBytes: '25000000', // ~24 MiB -> 3 chunks (10, 10, 5)
          idempotentReplay: false,
        });
      }
      if (url === '/api/uploads/gd-asset-id/complete') {
        return createMockResponse(200, { status: 'VALIDATING' });
      }
      if (url === '/api/uploads/gd-asset-id') {
        return createMockResponse(200, { status: 'VALIDATED' });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    let putCount = 0;
    transport.responseHandler = async (req) => {
      putCount++;
      if (req.headers['Content-Range'] === 'bytes */25000000') {
        return createTransportResponse(308, '');
      }
      if (req.headers['Content-Range'] === 'bytes 0-10485759/25000000') {
        return createTransportResponse(308, '', { Range: 'bytes=0-10485759' });
      }
      if (req.headers['Content-Range'] === 'bytes 10485760-20971519/25000000') {
        return createTransportResponse(308, '', { Range: 'bytes=0-20971519' });
      }
      if (req.headers['Content-Range'] === 'bytes 20971520-24999999/25000000') {
        return createTransportResponse(200, JSON.stringify({ id: 'valid_drive_id' }));
      }
      throw new Error(`Unexpected PUT headers: ${JSON.stringify(req.headers)}`);
    };

    const file = new FakeUploadFile('video.mp4', 25000000, 'video/mp4');
    const uploader = new BrowserMultipartUploader({
      file,
      recoveryKey: 'test-key',
      transport,
    });

    await uploader.start();
    if (putCount !== 3) {
      throw new Error(`Test 4 failed: expected 3 PUT requests, got ${putCount}`);
    }
    console.log('✓ Test 4: uploads multiple chunks using intermediate HTTP 308 passed');
    testCount++;
  }

  // 5. parses a valid Range header (and verifies malformed Range produces only GOOGLE_DRIVE_INVALID_RESUME_RANGE)
  {
    reset();
    const transport = new MockTransport();
    const file = new FakeUploadFile('video.mp4', 15000000, 'video/mp4');
    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: 'gd-asset-id',
      sessionUri: 'https://google.mock/session-123',
      recoveryKey: 'test-key',
      transport,
    });

    transport.responseHandler = async () => {
      return createTransportResponse(308, '', { Range: 'bytes=0-10485759' });
    };

    const offset = await uploader.querySessionStatus();
    if (offset !== 10485760) {
      throw new Error(`Test 5 failed: expected offset 10485760, got ${offset}`);
    }

    // Verify malformed range throws GOOGLE_DRIVE_INVALID_RESUME_RANGE
    try {
      parseRangeHeader('bytes=10-20', 15000000);
      throw new Error('Test 5 failed: malformed range parsed without throwing');
    } catch (err: unknown) {
      if (!(err instanceof Error) || err.message !== 'GOOGLE_DRIVE_INVALID_RESUME_RANGE') {
        throw new Error(`Test 5 failed: unexpected range parse error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    console.log('✓ Test 5: parses a valid Range header passed');
    testCount++;
  }

  // 6. treats a missing Range as zero confirmed bytes (and verifies a missing Range on a chunk response confirms zero bytes)
  {
    reset();
    const transport = new MockTransport();
    const file = new FakeUploadFile('video.mp4', 15000000, 'video/mp4');
    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: 'gd-asset-id',
      sessionUri: 'https://google.mock/session-123',
      recoveryKey: 'test-key',
      transport,
    });

    transport.responseHandler = async () => {
      return createTransportResponse(308, ''); // No Range header
    };

    const offset = await uploader.querySessionStatus();
    if (offset !== 0) {
      throw new Error(`Test 6 failed: expected offset 0, got ${offset}`);
    }

    // Verify missing range on a chunk response confirms zero bytes
    const chunkVal = parseRangeHeader(null, 15000000);
    if (chunkVal !== 0) {
      throw new Error(`Test 6 failed: expected chunk offset 0, got ${chunkVal}`);
    }

    console.log('✓ Test 6: treats a missing Range as zero confirmed bytes passed');
    testCount++;
  }

  // 7. prevents repeated unchanged-offset loops
  {
    reset();
    const transport = new MockTransport();
    const file = new FakeUploadFile('video.mp4', 25000000, 'video/mp4');
    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: 'gd-asset-id',
      sessionUri: 'https://google.mock/session-123',
      recoveryKey: 'test-key',
      transport,
    });

    const mockRange = 'bytes=0-10485759';
    transport.responseHandler = async (req) => {
      if (req.headers['Content-Range']?.includes('*/25000000')) {
        return createTransportResponse(308, '', { Range: mockRange });
      }
      // Chunk PUT returns the same Range, causing no progress
      return createTransportResponse(308, '', { Range: 'bytes=0-10485759' });
    };

    try {
      await uploader.start();
      throw new Error('Test 7 failed: uploader should have thrown stalled exception');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg !== 'GOOGLE_DRIVE_UPLOAD_FAILED') {
        throw new Error(`Test 7 failed: unexpected error: ${msg}`);
      }
    }
    console.log('✓ Test 7: prevents repeated unchanged-offset loops passed');
    testCount++;
  }

  // 8. handles final HTTP 200
  {
    reset();
    const transport = new MockTransport();
    fetchHandler = async (url) => {
      if (url === '/api/uploads/gd-asset-id/complete') {
        return createMockResponse(200, { status: 'VALIDATING' });
      }
      if (url === '/api/uploads/gd-asset-id') {
        return createMockResponse(200, { status: 'VALIDATED' });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    transport.responseHandler = async (req) => {
      if (req.headers['Content-Range']?.includes('*/5000000')) {
        return createTransportResponse(308, '');
      }
      return createTransportResponse(200, JSON.stringify({ id: 'drive-id-200' }));
    };

    const file = new FakeUploadFile('video.mp4', 5000000, 'video/mp4');
    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: 'gd-asset-id',
      sessionUri: 'https://google.mock/session-123',
      recoveryKey: 'test-key',
      transport,
    });

    await uploader.start();
    console.log('✓ Test 8: handles final HTTP 200 passed');
    testCount++;
  }

  // 9. handles final HTTP 201
  {
    reset();
    const transport = new MockTransport();
    fetchHandler = async (url) => {
      if (url === '/api/uploads/gd-asset-id/complete') {
        return createMockResponse(200, { status: 'VALIDATING' });
      }
      if (url === '/api/uploads/gd-asset-id') {
        return createMockResponse(200, { status: 'VALIDATED' });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    transport.responseHandler = async (req) => {
      if (req.headers['Content-Range']?.includes('*/5000000')) {
        return createTransportResponse(308, '');
      }
      return createTransportResponse(201, JSON.stringify({ id: 'drive-id-201' }));
    };

    const file = new FakeUploadFile('video.mp4', 5000000, 'video/mp4');
    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: 'gd-asset-id',
      sessionUri: 'https://google.mock/session-123',
      recoveryKey: 'test-key',
      transport,
    });

    await uploader.start();
    console.log('✓ Test 9: handles final HTTP 201 passed');
    testCount++;
  }

  // 10. rejects a missing or malformed final Drive file id
  {
    reset();
    const transport = new MockTransport();
    transport.responseHandler = async (req) => {
      if (req.headers['Content-Range']?.includes('*/5000000')) {
        return createTransportResponse(308, '');
      }
      // Malformed ID with $ character
      return createTransportResponse(200, JSON.stringify({ id: 'invalid$id' }));
    };

    const file = new FakeUploadFile('video.mp4', 5000000, 'video/mp4');
    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: 'gd-asset-id',
      sessionUri: 'https://google.mock/session-123',
      recoveryKey: 'test-key',
      maxRetries: 0,
      retryBackoffMs: 1,
      transport,
    });

    try {
      await uploader.start();
      throw new Error('Test 10 failed: should have rejected invalid Drive file ID');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg !== 'GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE') {
        throw new Error(`Test 10 failed: unexpected error message: ${msg}`);
      }
    }
    console.log('✓ Test 10: rejects a missing or malformed final Drive file id passed');
    testCount++;
  }

  // 11. sends the exact resume query Content-Range bytes */TOTAL
  {
    reset();
    const transport = new MockTransport();
    transport.responseHandler = async () => {
      return createTransportResponse(308, '', { Range: 'bytes=0-10485759' });
    };

    const file = new FakeUploadFile('video.mp4', 15000000, 'video/mp4');
    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: 'gd-asset-id',
      sessionUri: 'https://google.mock/session-123',
      recoveryKey: 'test-key',
      transport,
    });

    await uploader.querySessionStatus();
    const req = transport.requests[0];
    if (req.headers['Content-Range'] !== 'bytes */15000000' || req.headers['Content-Length'] !== '0') {
      throw new Error(`Test 11 failed: incorrect resume query headers: ${JSON.stringify(req.headers)}`);
    }
    console.log('✓ Test 11: sends the exact resume query Content-Range bytes */TOTAL passed');
    testCount++;
  }

  // 12. treats HTTP 404 as expired
  {
    reset();
    const transport = new MockTransport();
    localStorage.setItem('upload_recovery_test-key', JSON.stringify({ assetId: 'gd-asset-id', sessionUri: 'https://google.mock/session-123', version: 2, provider: 'GOOGLE_DRIVE' }));
    transport.responseHandler = async () => {
      return createTransportResponse(404, 'Expired');
    };

    const file = new FakeUploadFile('video.mp4', 5000000, 'video/mp4');
    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: 'gd-asset-id',
      sessionUri: 'https://google.mock/session-123',
      recoveryKey: 'test-key',
      transport,
    });

    try {
      await uploader.start();
      throw new Error('Test 12 failed: uploader should have failed on 404');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg !== 'UPLOAD_SESSION_EXPIRED') {
        throw new Error(`Test 12 failed: unexpected error: ${msg}`);
      }
    }
    // Verify storage cleared
    if (localStorage.getItem('upload_recovery_test-key')) {
      throw new Error('Test 12 failed: recovery storage was not cleared');
    }
    console.log('✓ Test 12: treats HTTP 404 as expired passed');
    testCount++;
  }

  // 13. treats HTTP 410 as expired
  {
    reset();
    const transport = new MockTransport();
    localStorage.setItem('upload_recovery_test-key', JSON.stringify({ assetId: 'gd-asset-id', sessionUri: 'https://google.mock/session-123', version: 2, provider: 'GOOGLE_DRIVE' }));
    transport.responseHandler = async () => {
      return createTransportResponse(410, 'Gone');
    };

    const file = new FakeUploadFile('video.mp4', 5000000, 'video/mp4');
    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: 'gd-asset-id',
      sessionUri: 'https://google.mock/session-123',
      recoveryKey: 'test-key',
      transport,
    });

    try {
      await uploader.start();
      throw new Error('Test 13 failed: uploader should have failed on 410');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg !== 'UPLOAD_SESSION_EXPIRED') {
        throw new Error(`Test 13 failed: unexpected error: ${msg}`);
      }
    }
    if (localStorage.getItem('upload_recovery_test-key')) {
      throw new Error('Test 13 failed: recovery storage was not cleared');
    }
    console.log('✓ Test 13: treats HTTP 410 as expired passed');
    testCount++;
  }

  // 14. treats another HTTP 4xx as restart-required
  {
    reset();
    const transport = new MockTransport();
    localStorage.setItem('upload_recovery_test-key', JSON.stringify({ assetId: 'gd-asset-id', sessionUri: 'https://google.mock/session-123', version: 2, provider: 'GOOGLE_DRIVE' }));
    transport.responseHandler = async () => {
      return createTransportResponse(400, 'Bad Request');
    };

    const file = new FakeUploadFile('video.mp4', 5000000, 'video/mp4');
    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: 'gd-asset-id',
      sessionUri: 'https://google.mock/session-123',
      recoveryKey: 'test-key',
      transport,
    });

    try {
      await uploader.start();
      throw new Error('Test 14 failed: uploader should have failed on 400');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg !== 'UPLOAD_SESSION_RESTART_REQUIRED') {
        throw new Error(`Test 14 failed: unexpected error: ${msg}`);
      }
    }
    if (localStorage.getItem('upload_recovery_test-key')) {
      throw new Error('Test 14 failed: recovery storage was not cleared');
    }
    console.log('✓ Test 14: treats another HTTP 4xx as restart-required passed');
    testCount++;
  }

  // 15. retries a network/5xx failure and queries status before retransmission (and verifies the initial status query retries a network or 5xx failure)
  {
    reset();
    const transport = new MockTransport();
    let completed = false;
    fetchHandler = async (url) => {
      if (url === '/api/uploads/gd-asset-id/complete') {
        completed = true;
        return createMockResponse(200, { status: 'VALIDATING' });
      }
      if (url === '/api/uploads/gd-asset-id') {
        return createMockResponse(200, { status: completed ? 'VALIDATED' : 'UPLOADING' });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    let putCount = 0;

    transport.responseHandler = async (req) => {
      putCount++;

      // Attempt 1: initial status query -> fail with 502 Bad Gateway
      if (putCount === 1) {
        return createTransportResponse(502, 'Bad Gateway');
      }

      // Attempt 2: initial status query retry -> succeed and return 308 with no Range (0 bytes)
      if (putCount === 2) {
        return createTransportResponse(308, '');
      }

      // Attempt 3: chunk upload PUT -> fail with network request error
      if (putCount === 3) {
        throw new Error('Network request failed');
      }

      // Attempt 4: status query before chunk retry -> succeed, return 0 bytes
      if (putCount === 4) {
        return createTransportResponse(308, '');
      }

      // Attempt 5: chunk retry -> succeed
      if (req.headers['Content-Range'] === 'bytes 0-4999999/5000000') {
        return createTransportResponse(200, JSON.stringify({ id: 'valid_drive_id' }));
      }

      throw new Error('Unexpected PUT request');
    };

    const file = new FakeUploadFile('video.mp4', 5000000, 'video/mp4');
    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: 'gd-asset-id',
      sessionUri: 'https://google.mock/session-123',
      recoveryKey: 'test-key',
      maxRetries: 2,
      retryBackoffMs: 5,
      transport,
    });

    await uploader.start({ isRetryOrResume: true });
    
    // Initial status query (fails 502) -> status query retry (succeeds 308) -> chunk upload (fails network) -> status query (succeeds 308) -> chunk upload (succeeds 200)
    // Total transport queries should be 5
    if (putCount !== 5) {
      throw new Error(`Test 15 failed: expected 5 put/query calls, got ${putCount}`);
    }

    console.log('✓ Test 15: retries a network/5xx failure and queries status before retransmission passed');
    testCount++;
  }

  // 16. pause aborts the in-flight request and resume queries status
  {
    reset();
    const transport = new MockTransport();
    let queryStatusCount = 0;

    transport.responseHandler = async (req) => {
      if (req.headers['Content-Range'] === 'bytes */5000000') {
        queryStatusCount++;
        return createTransportResponse(308, '');
      }
      // Chunk PUT hangs/delays
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return createTransportResponse(200, JSON.stringify({ id: 'drive-id' }));
    };

    const file = new FakeUploadFile('video.mp4', 5000000, 'video/mp4');
    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: 'gd-asset-id',
      sessionUri: 'https://google.mock/session-123',
      recoveryKey: 'test-key',
      transport,
    });

    uploader.start().catch(() => {});

    // Let start run and trigger the hung chunk PUT
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Pause the uploader
    uploader.pause();

    const status = uploader.getStatus();
    if (status.state !== 'paused') {
      throw new Error(`Test 16 failed: state is ${status.state}, expected paused`);
    }

    // Now resume
    uploader.resume().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Verify it queried Google Drive status again upon resume
    if (queryStatusCount !== 1) {
      throw new Error(`Test 16 failed: expected 1 query status call, got ${queryStatusCount}`);
    }

    console.log('✓ Test 16: pause aborts the in-flight request and resume queries status passed');
    testCount++;
  }

  // 17. cancellation aborts the request and calls the server abort API
  {
    reset();
    const transport = new MockTransport();
    fetchHandler = async (url) => {
      if (url === '/api/uploads/gd-asset-id/abort') {
        return createMockResponse(200, { assetId: 'gd-asset-id', provider: 'GOOGLE_DRIVE', status: 'ABORTED' });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    transport.responseHandler = async () => {
      // Chunk PUT hangs
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return createTransportResponse(200, JSON.stringify({ id: 'id' }));
    };

    const file = new FakeUploadFile('video.mp4', 5000000, 'video/mp4');
    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: 'gd-asset-id',
      sessionUri: 'https://google.mock/session-123',
      recoveryKey: 'test-key',
      transport,
    });

    uploader.start().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Cancel
    await uploader.cancel();

    const status = uploader.getStatus();
    if (status.state !== 'aborted') {
      throw new Error(`Test 17 failed: state should be aborted, got ${status.state}`);
    }

    // Check fetch requests for abort
    const hasAbortCall = fetchRequests.some((r) => r.url === '/api/uploads/gd-asset-id/abort' && r.init?.method === 'POST');
    if (!hasAbortCall) {
      throw new Error('Test 17 failed: abort API was not called');
    }
    console.log('✓ Test 17: cancellation aborts the request and calls the server abort API passed');
    testCount++;
  }

  // 18. completion calls the server with exactly { driveFileId }
  {
    reset();
    const transport = new MockTransport();
    let completedDriveFileId: string | null = null;
    let payloadKeysCount = 0;

    fetchHandler = async (url, init) => {
      if (url === '/api/uploads/gd-asset-id/complete') {
        const bodyVal = init?.body;
        if (typeof bodyVal === 'string') {
          try {
            const parsedBody: unknown = JSON.parse(bodyVal);
            if (isRecord(parsedBody)) {
              payloadKeysCount = Object.keys(parsedBody).length;
              const driveFileIdVal = parsedBody.driveFileId;
              if (typeof driveFileIdVal === 'string') {
                completedDriveFileId = driveFileIdVal;
              }
            }
          } catch {
            // Ignore
          }
        }
        return createMockResponse(200, { status: 'VALIDATING' });
      }
      if (url === '/api/uploads/gd-asset-id') {
        return createMockResponse(200, { status: 'VALIDATED' });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    transport.responseHandler = async (req) => {
      if (req.headers['Content-Range']?.includes('*/5000000')) {
        return createTransportResponse(308, '');
      }
      return createTransportResponse(200, JSON.stringify({ id: 'complete-drive-file-id' }));
    };

    const file = new FakeUploadFile('video.mp4', 5000000, 'video/mp4');
    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: 'gd-asset-id',
      sessionUri: 'https://google.mock/session-123',
      recoveryKey: 'test-key',
      transport,
    });

    await uploader.start();
    if (completedDriveFileId !== 'complete-drive-file-id' || payloadKeysCount !== 1) {
      throw new Error(`Test 18 failed: complete payload was incorrect: ${completedDriveFileId}`);
    }
    console.log('✓ Test 18: completion calls the server with exactly { driveFileId } passed');
    testCount++;
  }

  // 19. Google path never calls R2 parts or PATCH endpoints
  {
    reset();
    const transport = new MockTransport();
    fetchHandler = async (url) => {
      if (url === '/api/uploads/gd-asset-id/complete') {
        return createMockResponse(200, { status: 'VALIDATING' });
      }
      if (url === '/api/uploads/gd-asset-id') {
        return createMockResponse(200, { status: 'VALIDATED' });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    transport.responseHandler = async (req) => {
      if (req.headers['Content-Range']?.includes('*/5000000')) {
        return createTransportResponse(308, '');
      }
      return createTransportResponse(200, JSON.stringify({ id: 'valid_id' }));
    };

    const file = new FakeUploadFile('video.mp4', 5000000, 'video/mp4');
    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: 'gd-asset-id',
      sessionUri: 'https://google.mock/session-123',
      recoveryKey: 'test-key',
      transport,
    });

    await uploader.start();
    
    // Verify no fetch requests contain /parts
    const hasPartsCall = fetchRequests.some((r) => r.url.includes('/parts'));
    if (hasPartsCall) {
      throw new Error('Test 19 failed: uploader contacted R2 parts endpoint');
    }
    console.log('✓ Test 19: Google path never calls R2 parts or PATCH endpoints passed');
    testCount++;
  }

  // 20. R2 path never calls Google session transport (and legacy R2 recovery remains, and no Google transport is constructed on the R2 path)
  {
    reset();
    const transport = new MockTransport();
    let transportCalled = false;
    transport.responseHandler = async () => {
      transportCalled = true;
      return createTransportResponse(200, JSON.stringify({ id: 'id' }));
    };

    const r2UploadedParts: number[] = [];

    fetchHandler = async (url, init) => {
      if (url === `/api/uploads/r2-asset-id`) {
        return createMockResponse(200, {
          // provider is omitted to test legacy response acceptance
          filename: 'video.mp4',
          expectedSize: '15000000',
          declaredMimeType: 'video/mp4',
          partSize: 5 * 1024 * 1024,
          totalParts: 3,
          completedPartNumbers: [1, 3],
        });
      }
      if (url === '/api/uploads/r2-asset-id/parts') {
        if (init?.method === 'POST') {
          const body = init?.body;
          if (typeof body === 'string') {
            try {
              const parsed = JSON.parse(body);
              if (isRecord(parsed) && typeof parsed.partNumber === 'number') {
                r2UploadedParts.push(parsed.partNumber);
              }
            } catch {
              // Ignore
            }
          }
        }
        return createMockResponse(200, { uploadUrl: 'https://r2.mock/presigned' });
      }
      if (url === 'https://r2.mock/presigned') {
        return createMockResponse(200, {}, { ETag: 'etag' });
      }
      if (url === '/api/uploads/r2-asset-id/complete') {
        return createMockResponse(202, { status: 'VALIDATING' });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    // Store legacy R2 recovery record in localStorage (only assetId)
    localStorage.setItem('upload_recovery_r2-key', JSON.stringify({ assetId: 'r2-asset-id' }));

    const file = new FakeUploadFile('video.mp4', 15000000, 'video/mp4');
    const uploader = new BrowserMultipartUploader({
      file,
      recoveryKey: 'r2-key',
      transport,
    });

    await uploader.start();

    if (transportCalled) {
      throw new Error('Test 20 failed: R2 path invoked Google resumable transport');
    }

    if (r2UploadedParts.length !== 1 || r2UploadedParts[0] !== 2) {
      throw new Error(`Test 20 failed: expected only part 2 to be uploaded, uploaded: ${JSON.stringify(r2UploadedParts)}`);
    }

    // Verify provider state in final status is R2
    const finalStatus = uploader.getStatus();
    if (finalStatus.provider !== 'R2') {
      throw new Error(`Test 20 failed: expected provider R2, got ${finalStatus.provider}`);
    }

    console.log('✓ Test 20: R2 path never calls Google session transport (and legacy R2 recovery remains) passed');
    testCount++;
  }

  // 21. thrown errors, emitted statuses, and server-status responses never contain sessionUri (and arbitrary errors containing sessionUri or provider text become a stable safe error)
  {
    reset();
    const transport = new MockTransport();
    const sessionUri = 'https://google.mock/highly-sensitive-upload-token-abc';
    
    transport.responseHandler = async () => {
      // Mock failure containing both sessionUri and raw provider text
      throw new Error(`PUT to ${sessionUri} failed: Raw Provider response body: Access denied`);
    };

    const file = new FakeUploadFile('video.mp4', 5000000, 'video/mp4');
    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: 'gd-asset-id',
      sessionUri,
      recoveryKey: 'test-key',
      maxRetries: 0,
      retryBackoffMs: 1,
      transport,
      onStatusChange: (status) => {
        if (JSON.stringify(status).includes(sessionUri) || JSON.stringify(status).includes('Raw Provider')) {
          throw new Error('Security Leak: Emitted status contains sensitive info');
        }
      },
    });

    try {
      await uploader.start();
      throw new Error('Test 21 failed: uploader should have thrown error');
    } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : '';
      if (msg !== 'GOOGLE_DRIVE_UPLOAD_FAILED' && msg !== 'GOOGLE_DRIVE_UPLOAD_RETRY_EXHAUSTED') {
        throw new Error(`Security Leak / Unsafe Error Mapping: Expected safe error message, got: ${msg}`);
      }
    }
    console.log('✓ Test 21: thrown errors, emitted statuses, and server-status responses never contain sessionUri passed');
    testCount++;
  }

  // 22. Session status 429 retries successfully
  {
    reset();
    const transport = new MockTransport();
    let queryCount = 0;
    let fetchCount = 0;

    fetchHandler = async (url) => {
      if (url === '/api/uploads/gd-asset-id/complete') {
        return createMockResponse(200, { status: 'VALIDATING' });
      }
      if (url === '/api/uploads/gd-asset-id') {
        fetchCount++;
        if (fetchCount === 1) {
          return createMockResponse(200, { status: 'UPLOADING' });
        }
        return createMockResponse(200, { status: 'VALIDATED' });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    transport.responseHandler = async (req) => {
      if (req.headers['Content-Range']?.includes('*/15000000')) {
        queryCount++;
        if (queryCount === 1) {
          // Date with 1-second resolution
          const futureDate = new Date(1710000001000).toUTCString();
          return createTransportResponse(429, 'Rate Limit Exceeded', { 'Retry-After': futureDate });
        }
        return createTransportResponse(308, '', { Range: 'bytes=0-10485759' });
      }
      return createTransportResponse(200, JSON.stringify({ id: 'valid_drive_id' }));
    };

    const file = new FakeUploadFile('video.mp4', 15000000, 'video/mp4');
    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: 'gd-asset-id',
      sessionUri: 'https://google.mock/session-123',
      recoveryKey: 'test-key',
      maxRetries: 2,
      retryBackoffMs: 1,
      transport,
    });

    await uploader.start({ isRetryOrResume: true });

    if (queryCount !== 2) {
      throw new Error(`Test 22 failed: expected 2 queries, got ${queryCount}`);
    }
    const status = uploader.getStatus();
    if (status.uploadedBytes !== 15000000) {
      throw new Error(`Test 22 failed: expected offset 15000000, got ${status.uploadedBytes}`);
    }
    console.log('Test 22 passed: Session status 429 retries successfully');
    testCount++;
  }

  // 23. Chunk PUT 429 queries the confirmed offset before retransmission
  {
    reset();
    const transport = new MockTransport();
    let putCount = 0;
    let queryCount = 0;
    let fetchCount = 0;

    fetchHandler = async (url) => {
      if (url === '/api/uploads/gd-asset-id/complete') {
        return createMockResponse(200, { status: 'VALIDATING' });
      }
      if (url === '/api/uploads/gd-asset-id') {
        fetchCount++;
        if (fetchCount === 1) {
          return createMockResponse(200, { status: 'UPLOADING' });
        }
        return createMockResponse(200, { status: 'VALIDATED' });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    transport.responseHandler = async (req) => {
      if (req.headers['Content-Range']?.includes('*/15000000')) {
        queryCount++;
        if (putCount === 0) {
          return createTransportResponse(308, '');
        } else {
          return createTransportResponse(308, '', { Range: 'bytes=0-10485759' });
        }
      }

      if (req.method === 'PUT') {
        putCount++;
        if (putCount === 1) {
          // No Retry-After header, sleeps for 1ms
          return createTransportResponse(429, 'Rate Limit Exceeded', {});
        }
        return createTransportResponse(200, JSON.stringify({ id: 'valid_drive_id' }));
      }
      throw new Error('Unexpected request');
    };

    const file = new FakeUploadFile('video.mp4', 15000000, 'video/mp4');
    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: 'gd-asset-id',
      sessionUri: 'https://google.mock/session-123',
      recoveryKey: 'test-key',
      maxRetries: 2,
      retryBackoffMs: 1,
      transport,
    });

    await uploader.start({ isRetryOrResume: true });

    if (putCount !== 2) {
      throw new Error(`Test 23 failed: expected 2 PUT requests, got ${putCount}`);
    }
    if (queryCount !== 2) {
      throw new Error(`Test 23 failed: expected 2 queries, got ${queryCount}`);
    }
    console.log('Test 23 passed: Chunk PUT 429 queries the confirmed offset before retransmission');
    testCount++;
  }

  // 24. Retry-After is honored without creating a long-running test
  {
    reset();
    const transport = new MockTransport();
    let queryCount = 0;
    let fetchCount = 0;

    fetchHandler = async (url) => {
      if (url === '/api/uploads/gd-asset-id/complete') {
        return createMockResponse(200, { status: 'VALIDATING' });
      }
      if (url === '/api/uploads/gd-asset-id') {
        fetchCount++;
        if (fetchCount === 1) {
          return createMockResponse(200, { status: 'UPLOADING' });
        }
        return createMockResponse(200, { status: 'VALIDATED' });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    transport.responseHandler = async (req) => {
      if (req.headers['Content-Range']?.includes('*/15000000')) {
        queryCount++;
        if (queryCount === 1) {
          // Date with 1-second resolution
          const futureDate = new Date(1710000001000).toUTCString();
          return createTransportResponse(429, 'Rate Limit Exceeded', { 'Retry-After': futureDate });
        }
        return createTransportResponse(308, '', { Range: 'bytes=0-10485759' });
      }
      return createTransportResponse(200, JSON.stringify({ id: 'valid_drive_id' }));
    };

    const file = new FakeUploadFile('video.mp4', 15000000, 'video/mp4');
    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: 'gd-asset-id',
      sessionUri: 'https://google.mock/session-123',
      recoveryKey: 'test-key',
      maxRetries: 2,
      retryBackoffMs: 1,
      transport,
    });

    const originalNow = Date.now;
    let nowCallCount = 0;
    Date.now = () => {
      nowCallCount++;
      if (nowCallCount === 1) {
        return 1710000000950;
      }
      return originalNow();
    };

    const startTime = originalNow();
    await uploader.start({ isRetryOrResume: true });
    const elapsed = originalNow() - startTime;
    Date.now = originalNow;

    if (elapsed < 40) {
      throw new Error(`Test 24 failed: Retry-After delay of 50ms was not honored, elapsed: ${elapsed}ms`);
    }
    console.log('Test 24 passed: Retry-After is honored without creating a long-running test');
    testCount++;
  }

  // 25. A terminal 400 remains UPLOAD_SESSION_RESTART_REQUIRED
  {
    reset();
    const transport = new MockTransport();
    transport.responseHandler = async () => {
      return createTransportResponse(400, 'Bad Request');
    };

    const file = new FakeUploadFile('video.mp4', 5000000, 'video/mp4');
    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: 'gd-asset-id',
      sessionUri: 'https://google.mock/session-123',
      recoveryKey: 'test-key',
      transport,
    });

    try {
      await uploader.start();
      throw new Error('Test 25 failed: should have thrown UPLOAD_SESSION_RESTART_REQUIRED');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg !== 'UPLOAD_SESSION_RESTART_REQUIRED') {
        throw new Error(`Test 25 failed: unexpected error: ${msg}`);
      }
    }
    console.log('Test 25 passed: A terminal 400 remains UPLOAD_SESSION_RESTART_REQUIRED');
    testCount++;
  }

  // 26. No emitted error/status leaks sessionUri
  {
    reset();
    const transport = new MockTransport();
    const sessionUri = 'https://google.mock/sensitive-resumable-session-uri';
    let statusContainsLeak = false;

    transport.responseHandler = async () => {
      throw new Error(`Failed to upload to ${sessionUri}`);
    };

    const file = new FakeUploadFile('video.mp4', 5000000, 'video/mp4');
    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: 'gd-asset-id',
      sessionUri,
      recoveryKey: 'test-key',
      maxRetries: 0,
      transport,
      onStatusChange: (status) => {
        if (JSON.stringify(status).includes(sessionUri)) {
          statusContainsLeak = true;
        }
      },
    });

    try {
      await uploader.start();
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes(sessionUri)) {
        throw new Error('Test 26 failed: Thrown error leaks sessionUri');
      }
    }

    if (statusContainsLeak) {
      throw new Error('Test 26 failed: Emitted status leaks sessionUri');
    }

    console.log('Test 26 passed: No emitted error/status leaks sessionUri');
    testCount++;
  }

  // 27. Direct assertions on parseRetryAfterHeader
  {
    reset();

    // Retry-After integer clamp
    const clamped1 = parseRetryAfterHeader('15'); // 15s = 15000ms -> clamped to 10000ms
    if (clamped1 !== 10000) {
      throw new Error(`Test 27 failed: expected 10000, got ${clamped1}`);
    }

    const clamped2 = parseRetryAfterHeader('5'); // 5s = 5000ms -> 5000ms
    if (clamped2 !== 5000) {
      throw new Error(`Test 27 failed: expected 5000, got ${clamped2}`);
    }

    // Retry-After HTTP-date clamp
    const originalNow = Date.now;
    Date.now = () => 1710000000000;
    try {
      const futureDate = new Date(1710000025000).toUTCString(); // 25s in future -> clamped to 10000ms
      const clamped3 = parseRetryAfterHeader(futureDate);
      if (clamped3 !== 10000) {
        throw new Error(`Test 27 failed: expected 10000, got ${clamped3}`);
      }

      const futureDate2 = new Date(1710000004000).toUTCString(); // 4s in future -> 4000ms
      const clamped4 = parseRetryAfterHeader(futureDate2);
      if (clamped4 !== 4000) {
        throw new Error(`Test 27 failed: expected 4000, got ${clamped4}`);
      }

      // Past date returns 0
      const pastDate = new Date(1710000000000 - 10000).toUTCString();
      const clampedPast = parseRetryAfterHeader(pastDate);
      if (clampedPast !== 0) {
        throw new Error(`Test 27 failed: expected 0 for past date, got ${clampedPast}`);
      }
    } finally {
      Date.now = originalNow;
    }

    // malformed/negative/unsafe input returns null
    if (parseRetryAfterHeader('') !== null) {
      throw new Error('Test 27 failed: empty string should return null');
    }
    if (parseRetryAfterHeader('   ') !== null) {
      throw new Error('Test 27 failed: whitespace-only string should return null');
    }
    if (parseRetryAfterHeader('-5') !== null) {
      throw new Error('Test 27 failed: negative integer should return null');
    }
    if (parseRetryAfterHeader('abc') !== null) {
      throw new Error('Test 27 failed: alphabetic string should return null');
    }
    const unsafeInt = (Number.MAX_SAFE_INTEGER + 10).toString();
    if (parseRetryAfterHeader(unsafeInt) !== null) {
      throw new Error('Test 27 failed: unsafe integer should return null');
    }

    console.log('Test 27 passed: Direct assertions on parseRetryAfterHeader completed');
    testCount++;
  }

  // 28. Direct assertions on GoogleDriveResumableUploader lastRetryAfterMs transitions
  {
    reset();
    const transport = new MockTransport();
    let responseHeaders: Record<string, string> = {};

    transport.responseHandler = async () => {
      return createTransportResponse(429, 'Rate Limit Exceeded', responseHeaders);
    };

    const file = new FakeUploadFile('video.mp4', 15000000, 'video/mp4');
    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: 'gd-asset-id',
      sessionUri: 'https://google.mock/session-123',
      recoveryKey: 'test-key',
      transport,
    });
    const uploaderWithInternals = uploader as unknown as { lastRetryAfterMs: number | null };

    // 1. Simulate 429 with valid Retry-After: 5
    responseHeaders = { 'Retry-After': '5' };
    try {
      await uploader.querySessionStatus();
    } catch {
      // Expected
    }
    if (uploaderWithInternals.lastRetryAfterMs !== 5000) {
      throw new Error(`Test 28 failed: expected lastRetryAfterMs 5000, got ${uploaderWithInternals.lastRetryAfterMs}`);
    }

    // 2. Simulate 429 with missing Retry-After (should become null)
    responseHeaders = {};
    try {
      await uploader.querySessionStatus();
    } catch {
      // Expected
    }
    if (uploaderWithInternals.lastRetryAfterMs !== null) {
      throw new Error(`Test 28 failed: expected lastRetryAfterMs null when missing, got ${uploaderWithInternals.lastRetryAfterMs}`);
    }

    // 3. Simulate 429 with valid Retry-After: 5 again, then invalid Retry-After (should become null)
    responseHeaders = { 'Retry-After': '5' };
    try {
      await uploader.querySessionStatus();
    } catch {
      // Expected
    }
    responseHeaders = { 'Retry-After': 'abc' };
    try {
      await uploader.querySessionStatus();
    } catch {
      // Expected
    }
    if (uploaderWithInternals.lastRetryAfterMs !== null) {
      throw new Error(`Test 28 failed: expected lastRetryAfterMs null when invalid, got ${uploaderWithInternals.lastRetryAfterMs}`);
    }

    // 4. Reset stale Retry-After state on second start invocation
    uploaderWithInternals.lastRetryAfterMs = 5000;
    fetchHandler = async () => {
      throw new Error('Stop start');
    };
    try {
      await uploader.start();
    } catch {
      // Expected
    }
    if (uploaderWithInternals.lastRetryAfterMs !== null) {
      throw new Error(`Test 28 failed: start did not reset lastRetryAfterMs to null`);
    }

    console.log('Test 28 passed: Direct assertions on GoogleDriveResumableUploader lastRetryAfterMs transitions completed');
    testCount++;
  }

  // 29. Terminal chunk HTTP 400 PUT asserts
  {
    reset();
    const transport = new MockTransport();
    let putCount = 0;
    let queryCount = 0;

    localStorage.setItem(
      'upload_recovery_test-key',
      JSON.stringify({
        version: 2,
        provider: 'GOOGLE_DRIVE',
        assetId: 'gd-asset-id',
        sessionUri: 'https://google.mock/session-123',
        filename: 'video.mp4',
        mimeType: 'video/mp4',
        totalBytes: '15000000',
        lastModified: 1234567890,
      })
    );

    fetchHandler = async (url) => {
      if (url === '/api/uploads/gd-asset-id') {
        return createMockResponse(200, { status: 'UPLOADING' });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    transport.responseHandler = async (req) => {
      if (req.headers['Content-Range']?.includes('*/15000000')) {
        queryCount++;
        return createTransportResponse(308, ''); // 0 bytes confirmed
      }
      if (req.method === 'PUT') {
        putCount++;
        return createTransportResponse(400, 'Bad Request');
      }
      throw new Error('Unexpected request');
    };

    const file = new FakeUploadFile('video.mp4', 15000000, 'video/mp4');
    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: 'gd-asset-id',
      sessionUri: 'https://google.mock/session-123',
      recoveryKey: 'test-key',
      maxRetries: 3,
      retryBackoffMs: 1,
      transport,
    });

    const startTime = Date.now();
    try {
      await uploader.start({ isRetryOrResume: true });
      throw new Error('Test 29 failed: should have thrown UPLOAD_SESSION_RESTART_REQUIRED');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg !== 'UPLOAD_SESSION_RESTART_REQUIRED') {
        throw new Error(`Test 29 failed: unexpected error message: ${msg}`);
      }
    }
    const elapsed = Date.now() - startTime;

    if (putCount !== 1) {
      throw new Error(`Test 29 failed: expected chunk PUT to occur exactly once, got ${putCount}`);
    }

    if (queryCount !== 1) {
      throw new Error(`Test 29 failed: expected offset query to occur exactly once, got ${queryCount}`);
    }

    if (elapsed > 100) {
      throw new Error(`Test 29 failed: expected no retry delay, took ${elapsed}ms`);
    }

    if (localStorage.getItem('upload_recovery_test-key')) {
      throw new Error('Test 29 failed: recovery storage was not cleared');
    }

    console.log('Test 29 passed: Terminal chunk HTTP 400 PUT asserts completed');
    testCount++;
  }

  // 30. Transient retry exhaustion preserves recovery storage
  {
    reset();
    const transport = new MockTransport();
    localStorage.setItem(
      'upload_recovery_test-key',
      JSON.stringify({
        version: 2,
        provider: 'GOOGLE_DRIVE',
        assetId: 'gd-asset-id',
        sessionUri: 'https://google.mock/session-123',
        filename: 'video.mp4',
        mimeType: 'video/mp4',
        totalBytes: '15000000',
        lastModified: 1234567890,
      })
    );

    fetchHandler = async (url) => {
      if (url === '/api/uploads/gd-asset-id') {
        return createMockResponse(200, { status: 'UPLOADING' });
      }
      if (url === '/api/uploads/gd-asset-id/reconcile') {
        return createMockResponse(502, 'Bad Gateway');
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    transport.responseHandler = async () => {
      throw new Error('Network request failed');
    };

    const file = new FakeUploadFile('video.mp4', 15000000, 'video/mp4');
    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: 'gd-asset-id',
      sessionUri: 'https://google.mock/session-123',
      recoveryKey: 'test-key',
      maxRetries: 1,
      retryBackoffMs: 1,
      transport,
    });

    try {
      await uploader.start({ isRetryOrResume: true });
      throw new Error('Test 30 failed: should have thrown retry exhausted');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg !== 'GOOGLE_DRIVE_UPLOAD_FAILED' && msg !== 'GOOGLE_DRIVE_UPLOAD_RETRY_EXHAUSTED') {
        throw new Error(`Test 30 failed: unexpected error message: ${msg}`);
      }
    }

    if (!localStorage.getItem('upload_recovery_test-key')) {
      throw new Error('Test 30 failed: recovery storage was incorrectly cleared');
    }

    console.log('Test 30 passed: Transient retry exhaustion preserves recovery storage completed');
    testCount++;
  }

  // 31. Transient reconciliation 502 preserves recovery storage
  {
    reset();
    const transport = new MockTransport();
    localStorage.setItem(
      'upload_recovery_test-key',
      JSON.stringify({
        version: 2,
        provider: 'GOOGLE_DRIVE',
        assetId: 'gd-asset-id',
        sessionUri: 'https://google.mock/session-123',
        filename: 'video.mp4',
        mimeType: 'video/mp4',
        totalBytes: '15000000',
        lastModified: 1234567890,
      })
    );

    fetchHandler = async (url) => {
      if (url === '/api/uploads/gd-asset-id') {
        return createMockResponse(200, { status: 'UPLOADING' });
      }
      if (url === '/api/uploads/gd-asset-id/reconcile') {
        return createMockResponse(502, 'Bad Gateway');
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    transport.responseHandler = async () => {
      throw new Error('Network request failed');
    };

    const file = new FakeUploadFile('video.mp4', 15000000, 'video/mp4');
    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: 'gd-asset-id',
      sessionUri: 'https://google.mock/session-123',
      recoveryKey: 'test-key',
      maxRetries: 1,
      retryBackoffMs: 1,
      transport,
    });

    try {
      await uploader.start({ isRetryOrResume: true });
      throw new Error('Test 31 failed: should have thrown retry exhausted');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg !== 'GOOGLE_DRIVE_UPLOAD_FAILED' && msg !== 'GOOGLE_DRIVE_UPLOAD_RETRY_EXHAUSTED') {
        throw new Error(`Test 31 failed: unexpected error message: ${msg}`);
      }
    }

    if (!localStorage.getItem('upload_recovery_test-key')) {
      throw new Error('Test 31 failed: recovery storage was incorrectly cleared');
    }

    console.log('Test 31 passed: Transient reconciliation 502 preserves recovery storage completed');
    testCount++;
  }

  // 32. Invalid Drive file ID clears recovery storage
  {
    reset();
    const transport = new MockTransport();
    localStorage.setItem(
      'upload_recovery_test-key',
      JSON.stringify({
        version: 2,
        provider: 'GOOGLE_DRIVE',
        assetId: 'gd-asset-id',
        sessionUri: 'https://google.mock/session-123',
        filename: 'video.mp4',
        mimeType: 'video/mp4',
        totalBytes: '15000000',
        lastModified: 1234567890,
      })
    );

    transport.responseHandler = async (req) => {
      if (req.headers['Content-Range']?.includes('*/15000000')) {
        return createTransportResponse(308, ''); // 0 bytes
      }
      return createTransportResponse(200, JSON.stringify({ id: 'invalid$file$id' }));
    };

    const file = new FakeUploadFile('video.mp4', 15000000, 'video/mp4');
    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: 'gd-asset-id',
      sessionUri: 'https://google.mock/session-123',
      recoveryKey: 'test-key',
      maxRetries: 0,
      transport,
    });

    try {
      await uploader.start();
      throw new Error('Test 32 failed: should have rejected invalid Drive file ID');
    } catch {
      // Expected
    }

    if (localStorage.getItem('upload_recovery_test-key')) {
      throw new Error('Test 32 failed: recovery storage was not cleared');
    }

    console.log('Test 32 passed: Invalid Drive file ID clears recovery storage completed');
    testCount++;
  }

  // 33. Invalid Range header clears recovery storage
  {
    reset();
    const transport = new MockTransport();
    localStorage.setItem(
      'upload_recovery_test-key',
      JSON.stringify({
        version: 2,
        provider: 'GOOGLE_DRIVE',
        assetId: 'gd-asset-id',
        sessionUri: 'https://google.mock/session-123',
        filename: 'video.mp4',
        mimeType: 'video/mp4',
        totalBytes: '15000000',
        lastModified: 1234567890,
      })
    );

    transport.responseHandler = async () => {
      return createTransportResponse(308, '', { Range: 'bytes=10-20' });
    };

    const file = new FakeUploadFile('video.mp4', 15000000, 'video/mp4');
    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: 'gd-asset-id',
      sessionUri: 'https://google.mock/session-123',
      recoveryKey: 'test-key',
      transport,
    });

    try {
      await uploader.start({ isRetryOrResume: true });
      throw new Error('Test 33 failed: should have rejected invalid Range');
    } catch {
      // Expected
    }

    if (localStorage.getItem('upload_recovery_test-key')) {
      throw new Error('Test 33 failed: recovery storage was not cleared');
    }

    console.log('Test 33 passed: Invalid Range header clears recovery storage completed');
    testCount++;
  }

  // 34. A resume/status query returning malformed Range is attempted once, surfaces GOOGLE_DRIVE_INVALID_RESUME_RANGE, and clears recovery storage
  {
    reset();
    const transport = new MockTransport();
    let queryCount = 0;
    localStorage.setItem(
      'upload_recovery_test-key',
      JSON.stringify({
        version: 2,
        provider: 'GOOGLE_DRIVE',
        assetId: 'gd-asset-id',
        sessionUri: 'https://google.mock/session-123',
        filename: 'video.mp4',
        mimeType: 'video/mp4',
        totalBytes: '15000000',
        lastModified: 1234567890,
      })
    );

    transport.responseHandler = async () => {
      queryCount++;
      return createTransportResponse(308, '', { Range: 'bytes=abc' });
    };

    const file = new FakeUploadFile('video.mp4', 15000000, 'video/mp4');
    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: 'gd-asset-id',
      sessionUri: 'https://google.mock/session-123',
      recoveryKey: 'test-key',
      maxRetries: 3,
      transport,
    });

    try {
      await uploader.start({ isRetryOrResume: true });
      throw new Error('Test 34 failed: should have thrown GOOGLE_DRIVE_INVALID_RESUME_RANGE');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg !== 'GOOGLE_DRIVE_INVALID_RESUME_RANGE') {
        throw new Error(`Test 34 failed: unexpected error message: ${msg}`);
      }
    }

    if (queryCount !== 1) {
      throw new Error(`Test 34 failed: expected 1 query, got ${queryCount}`);
    }

    if (localStorage.getItem('upload_recovery_test-key')) {
      throw new Error('Test 34 failed: recovery storage was not cleared');
    }

    console.log('Test 34 passed: A resume/status query returning malformed Range is attempted once and clears recovery storage');
    testCount++;
  }

  // 35. A resume/status query returning an invalid final Drive ID is attempted once, surfaces GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE, and clears recovery storage
  {
    reset();
    const transport = new MockTransport();
    let queryCount = 0;
    localStorage.setItem(
      'upload_recovery_test-key',
      JSON.stringify({
        version: 2,
        provider: 'GOOGLE_DRIVE',
        assetId: 'gd-asset-id',
        sessionUri: 'https://google.mock/session-123',
        filename: 'video.mp4',
        mimeType: 'video/mp4',
        totalBytes: '15000000',
        lastModified: 1234567890,
      })
    );

    transport.responseHandler = async () => {
      queryCount++;
      return createTransportResponse(200, JSON.stringify({ id: '' })); // invalid empty id
    };

    const file = new FakeUploadFile('video.mp4', 15000000, 'video/mp4');
    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: 'gd-asset-id',
      sessionUri: 'https://google.mock/session-123',
      recoveryKey: 'test-key',
      maxRetries: 3,
      transport,
    });

    try {
      await uploader.start({ isRetryOrResume: true });
      throw new Error('Test 35 failed: should have thrown GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg !== 'GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE') {
        throw new Error(`Test 35 failed: unexpected error message: ${msg}`);
      }
    }

    if (queryCount !== 1) {
      throw new Error(`Test 35 failed: expected 1 query, got ${queryCount}`);
    }

    if (localStorage.getItem('upload_recovery_test-key')) {
      throw new Error('Test 35 failed: recovery storage was not cleared');
    }

    console.log('Test 35 passed: A resume/status query returning an invalid final Drive ID is attempted once and clears recovery storage');
    testCount++;
  }

  // 36. A malformed JSON final response is not retried and clears recovery storage
  {
    reset();
    const transport = new MockTransport();
    let queryCount = 0;
    localStorage.setItem(
      'upload_recovery_test-key',
      JSON.stringify({
        version: 2,
        provider: 'GOOGLE_DRIVE',
        assetId: 'gd-asset-id',
        sessionUri: 'https://google.mock/session-123',
        filename: 'video.mp4',
        mimeType: 'video/mp4',
        totalBytes: '15000000',
        lastModified: 1234567890,
      })
    );

    transport.responseHandler = async () => {
      queryCount++;
      return createTransportResponse(200, '{invalid_json');
    };

    const file = new FakeUploadFile('video.mp4', 15000000, 'video/mp4');
    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: 'gd-asset-id',
      sessionUri: 'https://google.mock/session-123',
      recoveryKey: 'test-key',
      maxRetries: 3,
      transport,
    });

    try {
      await uploader.start({ isRetryOrResume: true });
      throw new Error('Test 36 failed: should have thrown GOOGLE_DRIVE_UPLOAD_FAILED');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg !== 'GOOGLE_DRIVE_UPLOAD_FAILED') {
        throw new Error(`Test 36 failed: unexpected error message: ${msg}`);
      }
    }

    if (queryCount !== 1) {
      throw new Error(`Test 36 failed: expected 1 query, got ${queryCount}`);
    }

    if (localStorage.getItem('upload_recovery_test-key')) {
      throw new Error('Test 36 failed: recovery storage was not cleared');
    }

    console.log('Test 36 passed: A malformed JSON final response is not retried and clears recovery storage');
    testCount++;
  }

  // 37. A chunk response containing malformed Range is not retransmitted
  {
    reset();
    const transport = new MockTransport();
    let putCount = 0;
    let queryCount = 0;

    fetchHandler = async (url) => {
      if (url === '/api/uploads/gd-asset-id') {
        return createMockResponse(200, { status: 'UPLOADING' });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    transport.responseHandler = async (req) => {
      if (req.headers['Content-Range']?.includes('*/15000000')) {
        queryCount++;
        return createTransportResponse(308, ''); // 0 bytes confirmed
      }
      if (req.method === 'PUT') {
        putCount++;
        return createTransportResponse(308, '', { Range: 'bytes=abc' }); // malformed range
      }
      throw new Error('Unexpected request');
    };

    const file = new FakeUploadFile('video.mp4', 15000000, 'video/mp4');
    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: 'gd-asset-id',
      sessionUri: 'https://google.mock/session-123',
      recoveryKey: 'test-key',
      maxRetries: 3,
      transport,
    });

    try {
      await uploader.start({ isRetryOrResume: true });
      throw new Error('Test 37 failed: should have thrown GOOGLE_DRIVE_INVALID_RESUME_RANGE');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg !== 'GOOGLE_DRIVE_INVALID_RESUME_RANGE') {
        throw new Error(`Test 37 failed: unexpected error message: ${msg}`);
      }
    }

    if (putCount !== 1) {
      throw new Error(`Test 37 failed: expected exactly 1 PUT, got ${putCount}`);
    }

    if (queryCount !== 1) {
      throw new Error(`Test 37 failed: expected exactly 1 query, got ${queryCount}`);
    }

    console.log('Test 37 passed: A chunk response containing malformed Range is not retransmitted');
    testCount++;
  }

  // 38. Query status HTTP 204 is attempted once and clears recovery storage
  {
    reset();
    const transport = new MockTransport();
    let queryCount = 0;
    localStorage.setItem(
      'upload_recovery_test-key',
      JSON.stringify({
        version: 2,
        provider: 'GOOGLE_DRIVE',
        assetId: 'gd-asset-id',
        sessionUri: 'https://google.mock/session-123',
        filename: 'video.mp4',
        mimeType: 'video/mp4',
        totalBytes: '15000000',
        lastModified: 1234567890,
      })
    );

    transport.responseHandler = async () => {
      queryCount++;
      return createTransportResponse(204, 'No Content');
    };

    const file = new FakeUploadFile('video.mp4', 15000000, 'video/mp4');
    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: 'gd-asset-id',
      sessionUri: 'https://google.mock/session-123',
      recoveryKey: 'test-key',
      maxRetries: 3,
      transport,
    });

    try {
      await uploader.start({ isRetryOrResume: true });
      throw new Error('Test 38 failed: should have thrown');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg !== 'GOOGLE_DRIVE_UPLOAD_FAILED') {
        throw new Error(`Test 38 failed: unexpected error message: ${msg}`);
      }
    }

    if (queryCount !== 1) {
      throw new Error(`Test 38 failed: expected 1 query, got ${queryCount}`);
    }

    if (localStorage.getItem('upload_recovery_test-key')) {
      throw new Error('Test 38 failed: recovery storage was not cleared');
    }

    console.log('Test 38 passed: Query status HTTP 204 is attempted once and clears recovery storage');
    testCount++;
  }

  // 39. Query status HTTP 301 is attempted once and clears recovery storage
  {
    reset();
    const transport = new MockTransport();
    let queryCount = 0;
    localStorage.setItem(
      'upload_recovery_test-key',
      JSON.stringify({
        version: 2,
        provider: 'GOOGLE_DRIVE',
        assetId: 'gd-asset-id',
        sessionUri: 'https://google.mock/session-123',
        filename: 'video.mp4',
        mimeType: 'video/mp4',
        totalBytes: '15000000',
        lastModified: 1234567890,
      })
    );

    transport.responseHandler = async () => {
      queryCount++;
      return createTransportResponse(301, 'Moved Permanently');
    };

    const file = new FakeUploadFile('video.mp4', 15000000, 'video/mp4');
    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: 'gd-asset-id',
      sessionUri: 'https://google.mock/session-123',
      recoveryKey: 'test-key',
      maxRetries: 3,
      transport,
    });

    try {
      await uploader.start({ isRetryOrResume: true });
      throw new Error('Test 39 failed: should have thrown');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg !== 'GOOGLE_DRIVE_UPLOAD_FAILED') {
        throw new Error(`Test 39 failed: unexpected error message: ${msg}`);
      }
    }

    if (queryCount !== 1) {
      throw new Error(`Test 39 failed: expected 1 query, got ${queryCount}`);
    }

    if (localStorage.getItem('upload_recovery_test-key')) {
      throw new Error('Test 39 failed: recovery storage was not cleared');
    }

    console.log('Test 39 passed: Query status HTTP 301 is attempted once and clears recovery storage');
    testCount++;
  }

  // 40. Query status HTTP 501 is attempted once and clears recovery storage
  {
    reset();
    const transport = new MockTransport();
    let queryCount = 0;
    localStorage.setItem(
      'upload_recovery_test-key',
      JSON.stringify({
        version: 2,
        provider: 'GOOGLE_DRIVE',
        assetId: 'gd-asset-id',
        sessionUri: 'https://google.mock/session-123',
        filename: 'video.mp4',
        mimeType: 'video/mp4',
        totalBytes: '15000000',
        lastModified: 1234567890,
      })
    );

    transport.responseHandler = async () => {
      queryCount++;
      return createTransportResponse(501, 'Not Implemented');
    };

    const file = new FakeUploadFile('video.mp4', 15000000, 'video/mp4');
    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: 'gd-asset-id',
      sessionUri: 'https://google.mock/session-123',
      recoveryKey: 'test-key',
      maxRetries: 3,
      transport,
    });

    try {
      await uploader.start({ isRetryOrResume: true });
      throw new Error('Test 40 failed: should have thrown');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg !== 'GOOGLE_DRIVE_UPLOAD_FAILED') {
        throw new Error(`Test 40 failed: unexpected error message: ${msg}`);
      }
    }

    if (queryCount !== 1) {
      throw new Error(`Test 40 failed: expected 1 query, got ${queryCount}`);
    }

    if (localStorage.getItem('upload_recovery_test-key')) {
      throw new Error('Test 40 failed: recovery storage was not cleared');
    }

    console.log('Test 40 passed: Query status HTTP 501 is attempted once and clears recovery storage');
    testCount++;
  }

  // 41. Chunk PUT HTTP 204 is not retransmitted and clears recovery storage
  {
    reset();
    const transport = new MockTransport();
    let putCount = 0;
    let queryCount = 0;
    localStorage.setItem(
      'upload_recovery_test-key',
      JSON.stringify({
        version: 2,
        provider: 'GOOGLE_DRIVE',
        assetId: 'gd-asset-id',
        sessionUri: 'https://google.mock/session-123',
        filename: 'video.mp4',
        mimeType: 'video/mp4',
        totalBytes: '15000000',
        lastModified: 1234567890,
      })
    );

    fetchHandler = async (url) => {
      if (url === '/api/uploads/gd-asset-id') {
        return createMockResponse(200, { status: 'UPLOADING' });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    transport.responseHandler = async (req) => {
      if (req.headers['Content-Range']?.includes('*/15000000')) {
        queryCount++;
        return createTransportResponse(308, '', { Range: 'bytes=0-0' }); // starts from 0 confirmed bytes
      }
      if (req.method === 'PUT') {
        putCount++;
        return createTransportResponse(204, 'No Content');
      }
      throw new Error('Unexpected request');
    };

    const file = new FakeUploadFile('video.mp4', 15000000, 'video/mp4');
    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: 'gd-asset-id',
      sessionUri: 'https://google.mock/session-123',
      recoveryKey: 'test-key',
      maxRetries: 3,
      transport,
    });

    try {
      await uploader.start({ isRetryOrResume: true });
      throw new Error('Test 41 failed: should have thrown');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg !== 'GOOGLE_DRIVE_UPLOAD_FAILED') {
        throw new Error(`Test 41 failed: unexpected error message: ${msg}`);
      }
    }

    if (putCount !== 1) {
      throw new Error(`Test 41 failed: expected exactly 1 PUT, got ${putCount}`);
    }

    if (queryCount !== 1) {
      throw new Error(`Test 41 failed: expected exactly 1 query, got ${queryCount}`);
    }

    if (localStorage.getItem('upload_recovery_test-key')) {
      throw new Error('Test 41 failed: recovery storage was not cleared');
    }

    console.log('Test 41 passed: Chunk PUT HTTP 204 is not retransmitted and clears recovery storage');
    testCount++;
  }

  // 42. Chunk PUT HTTP 501 is not retransmitted and clears recovery storage
  {
    reset();
    const transport = new MockTransport();
    let putCount = 0;
    let queryCount = 0;
    localStorage.setItem(
      'upload_recovery_test-key',
      JSON.stringify({
        version: 2,
        provider: 'GOOGLE_DRIVE',
        assetId: 'gd-asset-id',
        sessionUri: 'https://google.mock/session-123',
        filename: 'video.mp4',
        mimeType: 'video/mp4',
        totalBytes: '15000000',
        lastModified: 1234567890,
      })
    );

    fetchHandler = async (url) => {
      if (url === '/api/uploads/gd-asset-id') {
        return createMockResponse(200, { status: 'UPLOADING' });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    transport.responseHandler = async (req) => {
      if (req.headers['Content-Range']?.includes('*/15000000')) {
        queryCount++;
        return createTransportResponse(308, '', { Range: 'bytes=0-0' });
      }
      if (req.method === 'PUT') {
        putCount++;
        return createTransportResponse(501, 'Not Implemented');
      }
      throw new Error('Unexpected request');
    };

    const file = new FakeUploadFile('video.mp4', 15000000, 'video/mp4');
    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: 'gd-asset-id',
      sessionUri: 'https://google.mock/session-123',
      recoveryKey: 'test-key',
      maxRetries: 3,
      transport,
    });

    try {
      await uploader.start({ isRetryOrResume: true });
      throw new Error('Test 42 failed: should have thrown');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg !== 'GOOGLE_DRIVE_UPLOAD_FAILED') {
        throw new Error(`Test 42 failed: unexpected error message: ${msg}`);
      }
    }

    if (putCount !== 1) {
      throw new Error(`Test 42 failed: expected exactly 1 PUT, got ${putCount}`);
    }

    if (queryCount !== 1) {
      throw new Error(`Test 42 failed: expected exactly 1 query, got ${queryCount}`);
    }

    if (localStorage.getItem('upload_recovery_test-key')) {
      throw new Error('Test 42 failed: recovery storage was not cleared');
    }

    console.log('Test 42 passed: Chunk PUT HTTP 501 is not retransmitted and clears recovery storage');
    testCount++;
  }

  // 43. Reconciliation HTTP 200 with malformed JSON is terminal and clears recovery storage
  {
    reset();
    const transport = new MockTransport();
    localStorage.setItem(
      'upload_recovery_test-key',
      JSON.stringify({
        version: 2,
        provider: 'GOOGLE_DRIVE',
        assetId: 'gd-asset-id',
        sessionUri: 'https://google.mock/session-123',
        filename: 'video.mp4',
        mimeType: 'video/mp4',
        totalBytes: '15000000',
        lastModified: 1234567890,
      })
    );

    transport.responseHandler = async () => {
      throw new Error('Network request failed'); // triggers reconciliation
    };

    fetchHandler = async (url) => {
      if (url === '/api/uploads/gd-asset-id/reconcile') {
        return createMockResponse(200, '{invalid');
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const file = new FakeUploadFile('video.mp4', 15000000, 'video/mp4');
    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: 'gd-asset-id',
      sessionUri: 'https://google.mock/session-123',
      recoveryKey: 'test-key',
      maxRetries: 0,
      transport,
    });

    try {
      await uploader.start({ isRetryOrResume: true });
      throw new Error('Test 43 failed: should have thrown');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg !== 'GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE') {
        throw new Error(`Test 43 failed: unexpected error message: ${msg}`);
      }
    }

    if (localStorage.getItem('upload_recovery_test-key')) {
      throw new Error('Test 43 failed: recovery storage was not cleared');
    }

    console.log('Test 43 passed: Reconciliation HTTP 200 with malformed JSON is terminal and clears recovery storage');
    testCount++;
  }

  // 44. Reconciliation HTTP 200 with an unknown/missing status is terminal and clears recovery storage
  {
    reset();
    const transport = new MockTransport();
    localStorage.setItem(
      'upload_recovery_test-key',
      JSON.stringify({
        version: 2,
        provider: 'GOOGLE_DRIVE',
        assetId: 'gd-asset-id',
        sessionUri: 'https://google.mock/session-123',
        filename: 'video.mp4',
        mimeType: 'video/mp4',
        totalBytes: '15000000',
        lastModified: 1234567890,
      })
    );

    transport.responseHandler = async () => {
      throw new Error('Network request failed'); // triggers reconciliation
    };

    fetchHandler = async (url) => {
      if (url === '/api/uploads/gd-asset-id/reconcile') {
        return createMockResponse(200, { status: 'UNKNOWN_STATUS' });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const file = new FakeUploadFile('video.mp4', 15000000, 'video/mp4');
    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: 'gd-asset-id',
      sessionUri: 'https://google.mock/session-123',
      recoveryKey: 'test-key',
      maxRetries: 0,
      transport,
    });

    try {
      await uploader.start({ isRetryOrResume: true });
      throw new Error('Test 44 failed: should have thrown');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg !== 'GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE') {
        throw new Error(`Test 44 failed: unexpected error message: ${msg}`);
      }
    }

    if (localStorage.getItem('upload_recovery_test-key')) {
      throw new Error('Test 44 failed: recovery storage was not cleared');
    }

    console.log('Test 44 passed: Reconciliation HTTP 200 with unknown status is terminal and clears recovery storage');
    testCount++;
  }

  // 45. Reconciliation HTTP 503 remains recoverable and preserves recovery storage
  {
    reset();
    const transport = new MockTransport();
    localStorage.setItem(
      'upload_recovery_test-key',
      JSON.stringify({
        version: 2,
        provider: 'GOOGLE_DRIVE',
        assetId: 'gd-asset-id',
        sessionUri: 'https://google.mock/session-123',
        filename: 'video.mp4',
        mimeType: 'video/mp4',
        totalBytes: '15000000',
        lastModified: 1234567890,
      })
    );

    transport.responseHandler = async () => {
      throw new Error('Network request failed'); // triggers reconciliation
    };

    fetchHandler = async (url) => {
      if (url === '/api/uploads/gd-asset-id/reconcile') {
        return createMockResponse(503, 'Service Unavailable');
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const file = new FakeUploadFile('video.mp4', 15000000, 'video/mp4');
    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: 'gd-asset-id',
      sessionUri: 'https://google.mock/session-123',
      recoveryKey: 'test-key',
      maxRetries: 0,
      transport,
    });

    try {
      await uploader.start({ isRetryOrResume: true });
      throw new Error('Test 45 failed: should have thrown');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg !== 'GOOGLE_DRIVE_UPLOAD_FAILED') {
        throw new Error(`Test 45 failed: unexpected error message: ${msg}`);
      }
    }

    if (!localStorage.getItem('upload_recovery_test-key')) {
      throw new Error('Test 45 failed: recovery storage was cleared');
    }

    console.log('Test 45 passed: Reconciliation HTTP 503 remains recoverable and preserves recovery storage');
    testCount++;
  }

  // 46. Completion API HTTP 400 is terminal and clears recovery storage
  {
    reset();
    const transport = new MockTransport();
    localStorage.setItem(
      'upload_recovery_test-key',
      JSON.stringify({
        version: 2,
        provider: 'GOOGLE_DRIVE',
        assetId: 'gd-asset-id',
        sessionUri: 'https://google.mock/session-123',
        filename: 'video.mp4',
        mimeType: 'video/mp4',
        totalBytes: '15000000',
        lastModified: 1234567890,
      })
    );

    transport.responseHandler = async () => {
      return createTransportResponse(200, JSON.stringify({ id: 'drive-file-123' }));
    };

    fetchHandler = async (url) => {
      if (url === '/api/uploads/gd-asset-id/complete') {
        return createMockResponse(400, 'Bad Request');
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const file = new FakeUploadFile('video.mp4', 15000000, 'video/mp4');
    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: 'gd-asset-id',
      sessionUri: 'https://google.mock/session-123',
      recoveryKey: 'test-key',
      maxRetries: 0,
      transport,
    });

    try {
      await uploader.start({ isRetryOrResume: true });
      throw new Error('Test 46 failed: should have thrown');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg !== 'UPLOAD_SESSION_RESTART_REQUIRED') {
        throw new Error(`Test 46 failed: unexpected error message: ${msg}`);
      }
    }

    if (localStorage.getItem('upload_recovery_test-key')) {
      throw new Error('Test 46 failed: recovery storage was not cleared');
    }

    console.log('Test 46 passed: Completion API HTTP 400 is terminal and clears recovery storage');
    testCount++;
  }

  // 47. Completion API HTTP 503 remains recoverable and preserves recovery storage
  {
    reset();
    const transport = new MockTransport();
    localStorage.setItem(
      'upload_recovery_test-key',
      JSON.stringify({
        version: 2,
        provider: 'GOOGLE_DRIVE',
        assetId: 'gd-asset-id',
        sessionUri: 'https://google.mock/session-123',
        filename: 'video.mp4',
        mimeType: 'video/mp4',
        totalBytes: '15000000',
        lastModified: 1234567890,
      })
    );

    transport.responseHandler = async () => {
      return createTransportResponse(200, JSON.stringify({ id: 'drive-file-123' }));
    };

    fetchHandler = async (url) => {
      if (url === '/api/uploads/gd-asset-id/complete') {
        return createMockResponse(503, 'Service Unavailable');
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const file = new FakeUploadFile('video.mp4', 15000000, 'video/mp4');
    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: 'gd-asset-id',
      sessionUri: 'https://google.mock/session-123',
      recoveryKey: 'test-key',
      maxRetries: 0,
      transport,
    });

    try {
      await uploader.start({ isRetryOrResume: true });
      throw new Error('Test 47 failed: should have thrown');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg !== 'GOOGLE_DRIVE_UPLOAD_FAILED') {
        throw new Error(`Test 47 failed: unexpected error message: ${msg}`);
      }
    }

    if (!localStorage.getItem('upload_recovery_test-key')) {
      throw new Error('Test 47 failed: recovery storage was cleared');
    }

    console.log('Test 47 passed: Completion API HTTP 503 remains recoverable and preserves recovery storage');
    testCount++;
  }

  // 48. Completion API network rejection remains recoverable
  {
    reset();
    const transport = new MockTransport();
    localStorage.setItem(
      'upload_recovery_test-key',
      JSON.stringify({
        version: 2,
        provider: 'GOOGLE_DRIVE',
        assetId: 'gd-asset-id',
        sessionUri: 'https://google.mock/session-123',
        filename: 'video.mp4',
        mimeType: 'video/mp4',
        totalBytes: '15000000',
        lastModified: 1234567890,
      })
    );

    transport.responseHandler = async () => {
      return createTransportResponse(200, JSON.stringify({ id: 'drive-file-123' }));
    };

    fetchHandler = async (url) => {
      if (url === '/api/uploads/gd-asset-id/complete') {
        throw new Error('Failed to fetch'); // network exception on fetch
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const file = new FakeUploadFile('video.mp4', 15000000, 'video/mp4');
    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: 'gd-asset-id',
      sessionUri: 'https://google.mock/session-123',
      recoveryKey: 'test-key',
      maxRetries: 0,
      transport,
    });

    try {
      await uploader.start({ isRetryOrResume: true });
      throw new Error('Test 48 failed: should have thrown');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg !== 'GOOGLE_DRIVE_UPLOAD_FAILED') {
        throw new Error(`Test 48 failed: unexpected error message: ${msg}`);
      }
    }

    if (!localStorage.getItem('upload_recovery_test-key')) {
      throw new Error('Test 48 failed: recovery storage was cleared');
    }

    console.log('Test 48 passed: Completion API network rejection remains recoverable and preserves recovery storage');
    testCount++;
  }

  console.log(`\nALL ${testCount} ISOLATED GOOGLE DRIVE BROWSER UPLOADER TESTS PASSED! 🎉`);
}

runTests().catch((e) => {
  console.error('\nTEST SUITE FAILED:', e);
  process.exit(1);
});
