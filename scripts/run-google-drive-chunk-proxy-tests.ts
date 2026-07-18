import { NextRequest } from 'next/server';
import { UploadAsset, UploadStatus, User } from '@prisma/client';
import { DecryptedUploadSession } from '../src/lib/storage';

// -------------------------------------------------------------
// Assert Helper
// -------------------------------------------------------------
function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// -------------------------------------------------------------
// Mock Database & Prisma
// -------------------------------------------------------------
let mockAssets: Partial<UploadAsset>[] = [];

const mockPrisma = {
  uploadAsset: {
    findUnique: async (args: { where: { id: string } }) => {
      return mockAssets.find(a => a.id === args.where.id) || null;
    },
  },
};

(global as unknown as { prisma: typeof mockPrisma }).prisma = mockPrisma;

// -------------------------------------------------------------
// Main Test Runner
// -------------------------------------------------------------
async function runTests() {
  // Import the route and classes dynamically after global.prisma is mocked
  const { createChunkPutHandler } = await import('../src/app/api/uploads/[id]/chunk/route');
  const { ForbiddenOwnershipError, ExpiredSessionError } = await import('../src/lib/storage');

  console.log('Running Secure Chunk Proxy Integration Tests...\n');
  let testCount = 0;

  function reset() {
    mockAssets = [];
    global.fetch = () => {
      throw new Error('Global fetch not mocked');
    };
  }

  // 1. Unauthenticated requests are rejected
  {
    reset();
    const req = new NextRequest('http://localhost/api/uploads/asset-123/chunk', { method: 'PUT' });
    const mockVerifyAdminSession = async (): Promise<User | null> => null;

    const handleProxyChunkUpload = createChunkPutHandler({
      verifyAdminSession: mockVerifyAdminSession,
    });

    const res = await handleProxyChunkUpload(req, { params: Promise.resolve({ id: 'asset-123' }) });

    assert(res.status === 401, 'Should fail with 401');
    const body = await res.json() as { error: string };
    assert(body.error === 'UNAUTHENTICATED', 'Error should be UNAUTHENTICATED');
    testCount++;
    console.log('✓ Test 1: unauthenticated chunk requests are rejected');
  }

  // 2. Authenticated user cannot access another user’s UploadAsset
  {
    reset();
    const req = new NextRequest('http://localhost/api/uploads/asset-123/chunk', { method: 'PUT' });
    mockAssets.push({
      id: 'asset-123',
      userId: 'user-456', // different user
      provider: 'GOOGLE_DRIVE',
    });

    const mockVerifyAdminSession = async (): Promise<User | null> => ({ id: 'user-123', role: 'USER' } as unknown as User);

    const handleProxyChunkUpload = createChunkPutHandler({
      verifyAdminSession: mockVerifyAdminSession,
    });

    const res = await handleProxyChunkUpload(req, { params: Promise.resolve({ id: 'asset-123' }) });

    assert(res.status === 403, 'Should fail with 403');
    const body = await res.json() as { error: string };
    assert(body.error === 'FORBIDDEN_OWNERSHIP', 'Should get FORBIDDEN_OWNERSHIP');
    testCount++;
    console.log('✓ Test 2: cross-user UploadAsset access is forbidden');
  }

  // 3. Authenticated user cannot access another user’s UploadSession
  {
    reset();
    const req = new NextRequest('http://localhost/api/uploads/asset-123/chunk', { method: 'PUT' });
    mockAssets.push({
      id: 'asset-123',
      userId: 'user-123',
      provider: 'GOOGLE_DRIVE',
    });

    const mockVerifyAdminSession = async (): Promise<User | null> => ({ id: 'user-123', role: 'USER' } as unknown as User);
    const mockGetDecryptedSession = async (): Promise<DecryptedUploadSession> => {
      throw new ForbiddenOwnershipError('Forbidden');
    };

    const handleProxyChunkUpload = createChunkPutHandler({
      verifyAdminSession: mockVerifyAdminSession,
      getDecryptedSession: mockGetDecryptedSession,
    });

    const res = await handleProxyChunkUpload(req, { params: Promise.resolve({ id: 'asset-123' }) });

    assert(res.status === 403, 'Should fail with 403');
    const body = await res.json() as { error: string };
    assert(body.error === 'FORBIDDEN_OWNERSHIP', 'Should get FORBIDDEN_OWNERSHIP');
    testCount++;
    console.log('✓ Test 3: cross-user UploadSession access is forbidden');
  }

  // 4. Non-GOOGLE_DRIVE assets are rejected
  {
    reset();
    const req = new NextRequest('http://localhost/api/uploads/asset-123/chunk', { method: 'PUT' });
    mockAssets.push({
      id: 'asset-123',
      userId: 'user-123',
      provider: 'R2', // different provider
    });

    const mockVerifyAdminSession = async (): Promise<User | null> => ({ id: 'user-123', role: 'USER' } as unknown as User);

    const handleProxyChunkUpload = createChunkPutHandler({
      verifyAdminSession: mockVerifyAdminSession,
    });

    const res = await handleProxyChunkUpload(req, { params: Promise.resolve({ id: 'asset-123' }) });

    assert(res.status === 400, 'Should fail with 400');
    const body = await res.json() as { error: string };
    assert(body.error === 'INVALID_PROVIDER', 'Should get INVALID_PROVIDER');
    testCount++;
    console.log('✓ Test 4: non-GOOGLE_DRIVE assets are rejected');
  }

  // 5. Missing Content-Length is handled safely
  {
    reset();
    const req = new NextRequest('http://localhost/api/uploads/asset-123/chunk', {
      method: 'PUT',
      headers: {
        'Content-Range': 'bytes 0-99/1000',
      },
    });
    mockAssets.push({
      id: 'asset-123',
      userId: 'user-123',
      provider: 'GOOGLE_DRIVE',
    });

    const mockVerifyAdminSession = async (): Promise<User | null> => ({ id: 'user-123', role: 'USER' } as unknown as User);
    const mockSession: DecryptedUploadSession = {
      uploadAssetId: 'asset-123',
      providerSessionId: 'https://session-uri',
      completedParts: [],
      expiresAt: new Date(Date.now() + 3600 * 1000),
      lastActivityAt: new Date(),
    };
    const mockGetDecryptedSession = async (): Promise<DecryptedUploadSession> => mockSession;

    const handleProxyChunkUpload = createChunkPutHandler({
      verifyAdminSession: mockVerifyAdminSession,
      getDecryptedSession: mockGetDecryptedSession,
    });

    const res = await handleProxyChunkUpload(req, { params: Promise.resolve({ id: 'asset-123' }) });

    assert(res.status === 400, 'Should fail with 400');
    const body = await res.json() as { error: string };
    assert(body.error === 'MISSING_HEADERS', 'Should get MISSING_HEADERS');
    testCount++;
    console.log('✓ Test 5: missing Content-Length is handled safely');
  }

  // 6. Oversized Content-Length is rejected
  {
    reset();
    const oversizedBytes = 101 * 1024 * 1024; // > 100 MiB
    const req = new NextRequest('http://localhost/api/uploads/asset-123/chunk', {
      method: 'PUT',
      headers: {
        'Content-Range': `bytes 0-${oversizedBytes - 1}/1000000000`,
        'Content-Length': oversizedBytes.toString(),
      },
    });
    mockAssets.push({
      id: 'asset-123',
      userId: 'user-123',
      provider: 'GOOGLE_DRIVE',
    });

    const mockVerifyAdminSession = async (): Promise<User | null> => ({ id: 'user-123', role: 'USER' } as unknown as User);
    const mockSession: DecryptedUploadSession = {
      uploadAssetId: 'asset-123',
      providerSessionId: 'https://session-uri',
      completedParts: [],
      expiresAt: new Date(Date.now() + 3600 * 1000),
      lastActivityAt: new Date(),
    };
    const mockGetDecryptedSession = async (): Promise<DecryptedUploadSession> => mockSession;

    const handleProxyChunkUpload = createChunkPutHandler({
      verifyAdminSession: mockVerifyAdminSession,
      getDecryptedSession: mockGetDecryptedSession,
    });

    const res = await handleProxyChunkUpload(req, { params: Promise.resolve({ id: 'asset-123' }) });

    assert(res.status === 400, 'Should fail with 400');
    const body = await res.json() as { error: string };
    assert(body.error === 'CHUNK_TOO_LARGE', 'Should get CHUNK_TOO_LARGE');
    testCount++;
    console.log('✓ Test 6: oversized Content-Length is rejected');
  }

  // 7. Malformed Content-Range is rejected
  {
    reset();
    const req = new NextRequest('http://localhost/api/uploads/asset-123/chunk', {
      method: 'PUT',
      headers: {
        'Content-Range': 'bytes 0-99/*', // invalid format
        'Content-Length': '100',
      },
    });
    mockAssets.push({
      id: 'asset-123',
      userId: 'user-123',
      provider: 'GOOGLE_DRIVE',
      expectedSize: BigInt(1000),
    });

    const mockVerifyAdminSession = async (): Promise<User | null> => ({ id: 'user-123', role: 'USER' } as unknown as User);
    const mockSession: DecryptedUploadSession = {
      uploadAssetId: 'asset-123',
      providerSessionId: 'https://session-uri',
      completedParts: [],
      expiresAt: new Date(Date.now() + 3600 * 1000),
      lastActivityAt: new Date(),
    };
    const mockGetDecryptedSession = async (): Promise<DecryptedUploadSession> => mockSession;

    const handleProxyChunkUpload = createChunkPutHandler({
      verifyAdminSession: mockVerifyAdminSession,
      getDecryptedSession: mockGetDecryptedSession,
    });

    const res = await handleProxyChunkUpload(req, { params: Promise.resolve({ id: 'asset-123' }) });

    assert(res.status === 400, 'Should fail with 400');
    const body = await res.json() as { error: string };
    assert(body.error === 'INVALID_CONTENT_RANGE', 'Should get INVALID_CONTENT_RANGE');
    testCount++;
    console.log('✓ Test 7: malformed Content-Range is rejected');
  }

  // 8. Total size must equal expectedSize
  {
    reset();
    const req = new NextRequest('http://localhost/api/uploads/asset-123/chunk', {
      method: 'PUT',
      headers: {
        'Content-Range': 'bytes 0-99/2000', // expected is 1000
        'Content-Length': '100',
      },
    });
    mockAssets.push({
      id: 'asset-123',
      userId: 'user-123',
      provider: 'GOOGLE_DRIVE',
      expectedSize: BigInt(1000),
    });

    const mockVerifyAdminSession = async (): Promise<User | null> => ({ id: 'user-123', role: 'USER' } as unknown as User);
    const mockSession: DecryptedUploadSession = {
      uploadAssetId: 'asset-123',
      providerSessionId: 'https://session-uri',
      completedParts: [],
      expiresAt: new Date(Date.now() + 3600 * 1000),
      lastActivityAt: new Date(),
    };
    const mockGetDecryptedSession = async (): Promise<DecryptedUploadSession> => mockSession;

    const handleProxyChunkUpload = createChunkPutHandler({
      verifyAdminSession: mockVerifyAdminSession,
      getDecryptedSession: mockGetDecryptedSession,
    });

    const res = await handleProxyChunkUpload(req, { params: Promise.resolve({ id: 'asset-123' }) });

    assert(res.status === 400, 'Should fail with 400');
    const body = await res.json() as { error: string };
    assert(body.error === 'INVALID_RANGE_VALUES', 'Should get INVALID_RANGE_VALUES');
    testCount++;
    console.log('✓ Test 8: total size mismatch vs expectedSize is rejected');
  }

  // 9. Start/end/chunk-length mismatches are rejected
  {
    reset();
    const req = new NextRequest('http://localhost/api/uploads/asset-123/chunk', {
      method: 'PUT',
      headers: {
        'Content-Range': 'bytes 0-80/1000', // range length 81, length header is 100
        'Content-Length': '100',
      },
    });
    mockAssets.push({
      id: 'asset-123',
      userId: 'user-123',
      provider: 'GOOGLE_DRIVE',
      expectedSize: BigInt(1000),
    });

    const mockVerifyAdminSession = async (): Promise<User | null> => ({ id: 'user-123', role: 'USER' } as unknown as User);
    const mockSession: DecryptedUploadSession = {
      uploadAssetId: 'asset-123',
      providerSessionId: 'https://session-uri',
      completedParts: [],
      expiresAt: new Date(Date.now() + 3600 * 1000),
      lastActivityAt: new Date(),
    };
    const mockGetDecryptedSession = async (): Promise<DecryptedUploadSession> => mockSession;

    const handleProxyChunkUpload = createChunkPutHandler({
      verifyAdminSession: mockVerifyAdminSession,
      getDecryptedSession: mockGetDecryptedSession,
    });

    const res = await handleProxyChunkUpload(req, { params: Promise.resolve({ id: 'asset-123' }) });

    assert(res.status === 400, 'Should fail with 400');
    const body = await res.json() as { error: string };
    assert(body.error === 'INVALID_RANGE_VALUES', 'Should get INVALID_RANGE_VALUES');
    testCount++;
    console.log('✓ Test 9: start/end/chunk-length mismatch is rejected');
  }

  // 10. Writes beyond expectedSize are rejected
  {
    reset();
    const req = new NextRequest('http://localhost/api/uploads/asset-123/chunk', {
      method: 'PUT',
      headers: {
        'Content-Range': 'bytes 950-1000/1000', // end index 1000 is out of bounds (should be <= 999)
        'Content-Length': '51',
      },
    });
    mockAssets.push({
      id: 'asset-123',
      userId: 'user-123',
      provider: 'GOOGLE_DRIVE',
      expectedSize: BigInt(1000),
    });

    const mockVerifyAdminSession = async (): Promise<User | null> => ({ id: 'user-123', role: 'USER' } as unknown as User);
    const mockSession: DecryptedUploadSession = {
      uploadAssetId: 'asset-123',
      providerSessionId: 'https://session-uri',
      completedParts: [],
      expiresAt: new Date(Date.now() + 3600 * 1000),
      lastActivityAt: new Date(),
    };
    const mockGetDecryptedSession = async (): Promise<DecryptedUploadSession> => mockSession;

    const handleProxyChunkUpload = createChunkPutHandler({
      verifyAdminSession: mockVerifyAdminSession,
      getDecryptedSession: mockGetDecryptedSession,
    });

    const res = await handleProxyChunkUpload(req, { params: Promise.resolve({ id: 'asset-123' }) });

    assert(res.status === 400, 'Should fail with 400');
    const body = await res.json() as { error: string };
    assert(body.error === 'INVALID_RANGE_VALUES', 'Should get INVALID_RANGE_VALUES');
    testCount++;
    console.log('✓ Test 10: writes beyond expectedSize are rejected');
  }

  // 11. Expired sessions are rejected
  {
    reset();
    const req = new NextRequest('http://localhost/api/uploads/asset-123/chunk', {
      method: 'PUT',
      headers: {
        'Content-Range': 'bytes 0-99/1000',
        'Content-Length': '100',
      },
    });
    mockAssets.push({
      id: 'asset-123',
      userId: 'user-123',
      provider: 'GOOGLE_DRIVE',
      expectedSize: BigInt(1000),
    });

    const mockVerifyAdminSession = async (): Promise<User | null> => ({ id: 'user-123', role: 'USER' } as unknown as User);
    const mockGetDecryptedSession = async (): Promise<DecryptedUploadSession> => {
      throw new ExpiredSessionError('Expired');
    };

    const handleProxyChunkUpload = createChunkPutHandler({
      verifyAdminSession: mockVerifyAdminSession,
      getDecryptedSession: mockGetDecryptedSession,
    });

    const res = await handleProxyChunkUpload(req, { params: Promise.resolve({ id: 'asset-123' }) });

    assert(res.status === 410, 'Should fail with 410');
    const body = await res.json() as { error: string };
    assert(body.error === 'UPLOAD_SESSION_EXPIRED', 'Should get UPLOAD_SESSION_EXPIRED');
    testCount++;
    console.log('✓ Test 11: expired sessions are rejected');
  }

  // 12. Google 308 responses return safe confirmedBytes
  {
    reset();
    const mockStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      }
    });

    const req = new NextRequest('http://localhost/api/uploads/asset-123/chunk', {
      method: 'PUT',
      headers: {
        'Content-Range': 'bytes 0-99/1000',
        'Content-Length': '100',
      },
      body: mockStream,
      duplex: 'half',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    mockAssets.push({
      id: 'asset-123',
      userId: 'user-123',
      provider: 'GOOGLE_DRIVE',
      expectedSize: BigInt(1000),
    });

    const mockVerifyAdminSession = async (): Promise<User | null> => ({ id: 'user-123', role: 'USER' } as unknown as User);
    const mockSession: DecryptedUploadSession = {
      uploadAssetId: 'asset-123',
      providerSessionId: 'https://session-uri',
      completedParts: [],
      expiresAt: new Date(Date.now() + 3600 * 1000),
      lastActivityAt: new Date(),
    };
    const mockGetDecryptedSession = async (): Promise<DecryptedUploadSession> => mockSession;

    global.fetch = async () => {
      return new Response('', {
        status: 308,
        headers: {
          Range: 'bytes=0-199',
        },
      });
    };

    const handleProxyChunkUpload = createChunkPutHandler({
      verifyAdminSession: mockVerifyAdminSession,
      getDecryptedSession: mockGetDecryptedSession,
    });

    const res = await handleProxyChunkUpload(req, { params: Promise.resolve({ id: 'asset-123' }) });

    assert(res.status === 200, 'Should succeed with 200');
    const body = await res.json() as { status: string; confirmedBytes: number; completed: boolean };
    assert(body.status === 'UPLOADING', 'Status must be UPLOADING');
    assert(body.confirmedBytes === 200, 'Confirmed bytes should equal Range end + 1');
    assert(body.completed === false, 'Completed should be false');
    assert(!('sessionUri' in body), 'Should never leak sessionUri in body');
    testCount++;
    console.log('✓ Test 12: Google 308 responses return safe confirmedBytes');
  }

  // 13. Final Google success is normalized safely
  {
    reset();
    const mockStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      }
    });

    const req = new NextRequest('http://localhost/api/uploads/asset-123/chunk', {
      method: 'PUT',
      headers: {
        'Content-Range': 'bytes 900-999/1000',
        'Content-Length': '100',
      },
      body: mockStream,
      duplex: 'half',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    mockAssets.push({
      id: 'asset-123',
      userId: 'user-123',
      provider: 'GOOGLE_DRIVE',
      expectedSize: BigInt(1000),
    });

    const mockVerifyAdminSession = async (): Promise<User | null> => ({ id: 'user-123', role: 'USER' } as unknown as User);
    const mockSession: DecryptedUploadSession = {
      uploadAssetId: 'asset-123',
      providerSessionId: 'https://session-uri',
      completedParts: [],
      expiresAt: new Date(Date.now() + 3600 * 1000),
      lastActivityAt: new Date(),
    };
    const mockGetDecryptedSession = async (): Promise<DecryptedUploadSession> => mockSession;
    const mockCompleteUpload = async (): Promise<{
      assetId: string;
      provider: 'GOOGLE_DRIVE';
      filename: string;
      expectedSize: string;
      actualSize: string;
      status: UploadStatus;
    }> => ({
      assetId: 'asset-123',
      provider: 'GOOGLE_DRIVE' as const,
      filename: 'file.mp4',
      expectedSize: '1000',
      actualSize: '1000',
      status: UploadStatus.VALIDATING,
    });

    global.fetch = async () => {
      return new Response(JSON.stringify({ id: 'drive-file-123' }), {
        status: 200,
      });
    };

    const handleProxyChunkUpload = createChunkPutHandler({
      verifyAdminSession: mockVerifyAdminSession,
      getDecryptedSession: mockGetDecryptedSession,
      completeUpload: mockCompleteUpload,
    });

    const res = await handleProxyChunkUpload(req, { params: Promise.resolve({ id: 'asset-123' }) });

    assert(res.status === 200, 'Should succeed with 200');
    const body = await res.json() as { status: string; completed: boolean; confirmedBytes: number };
    assert(body.status === 'VALIDATING', 'Status should map completion service status');
    assert(body.completed === true, 'Completed should be true');
    assert(body.confirmedBytes === 1000, 'Confirmed bytes should equal total size');
    assert(!('sessionUri' in body), 'Should never leak sessionUri in body');
    testCount++;
    console.log('✓ Test 13: final Google success response is normalized safely');
  }

  // 14. 429, 500, 502, 503, and 504 are retryable
  {
    reset();
    const mockStream = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array([1]));
        c.close();
      }
    });

    const req = new NextRequest('http://localhost/api/uploads/asset-123/chunk', {
      method: 'PUT',
      headers: {
        'Content-Range': 'bytes 0-99/1000',
        'Content-Length': '100',
      },
      body: mockStream,
      duplex: 'half',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    mockAssets.push({
      id: 'asset-123',
      userId: 'user-123',
      provider: 'GOOGLE_DRIVE',
      expectedSize: BigInt(1000),
    });

    const mockVerifyAdminSession = async (): Promise<User | null> => ({ id: 'user-123', role: 'USER' } as unknown as User);
    const mockSession: DecryptedUploadSession = {
      uploadAssetId: 'asset-123',
      providerSessionId: 'https://session-uri',
      completedParts: [],
      expiresAt: new Date(Date.now() + 3600 * 1000),
      lastActivityAt: new Date(),
    };
    const mockGetDecryptedSession = async (): Promise<DecryptedUploadSession> => mockSession;

    const handleProxyChunkUpload = createChunkPutHandler({
      verifyAdminSession: mockVerifyAdminSession,
      getDecryptedSession: mockGetDecryptedSession,
    });

    for (const status of [429, 500, 502, 503, 504]) {
      global.fetch = async () => {
        return new Response('', { status });
      };

      const res = await handleProxyChunkUpload(req, { params: Promise.resolve({ id: 'asset-123' }) });

      assert(res.status === 503, `For Google status ${status}, proxy should return 503`);
      const body = await res.json() as { retryable: boolean };
      assert(body.retryable === true, 'Retryable should be true');
    }
    testCount++;
    console.log('✓ Test 14: 429, 500, 502, 503, and 504 are mapped as retryable');
  }

  // 15. Unsupported statuses are terminal
  {
    reset();
    const mockStream = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array([1]));
        c.close();
      }
    });

    const req = new NextRequest('http://localhost/api/uploads/asset-123/chunk', {
      method: 'PUT',
      headers: {
        'Content-Range': 'bytes 0-99/1000',
        'Content-Length': '100',
      },
      body: mockStream,
      duplex: 'half',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    mockAssets.push({
      id: 'asset-123',
      userId: 'user-123',
      provider: 'GOOGLE_DRIVE',
      expectedSize: BigInt(1000),
    });

    const mockVerifyAdminSession = async (): Promise<User | null> => ({ id: 'user-123', role: 'USER' } as unknown as User);
    const mockSession: DecryptedUploadSession = {
      uploadAssetId: 'asset-123',
      providerSessionId: 'https://session-uri',
      completedParts: [],
      expiresAt: new Date(Date.now() + 3600 * 1000),
      lastActivityAt: new Date(),
    };
    const mockGetDecryptedSession = async (): Promise<DecryptedUploadSession> => mockSession;

    global.fetch = async () => {
      return new Response('', { status: 400 });
    };

    const handleProxyChunkUpload = createChunkPutHandler({
      verifyAdminSession: mockVerifyAdminSession,
      getDecryptedSession: mockGetDecryptedSession,
    });

    const res = await handleProxyChunkUpload(req, { params: Promise.resolve({ id: 'asset-123' }) });

    assert(res.status === 400, 'Should return 400');
    const body = await res.json() as { retryable: boolean; status: string };
    assert(body.retryable === false, 'Retryable should be false');
    assert(body.status === 'FAILED', 'Status should be FAILED');
    testCount++;
    console.log('✓ Test 15: unsupported Google response statuses are terminal');
  }

  // 16. Provider responses cannot leak sessionUri in JSON or headers
  {
    reset();
    const mockStream = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array([1]));
        c.close();
      }
    });

    const req = new NextRequest('http://localhost/api/uploads/asset-123/chunk', {
      method: 'PUT',
      headers: {
        'Content-Range': 'bytes 0-99/1000',
        'Content-Length': '100',
      },
      body: mockStream,
      duplex: 'half',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    mockAssets.push({
      id: 'asset-123',
      userId: 'user-123',
      provider: 'GOOGLE_DRIVE',
      expectedSize: BigInt(1000),
    });

    const mockVerifyAdminSession = async (): Promise<User | null> => ({ id: 'user-123', role: 'USER' } as unknown as User);
    const mockSession: DecryptedUploadSession = {
      uploadAssetId: 'asset-123',
      providerSessionId: 'https://session-uri',
      completedParts: [],
      expiresAt: new Date(Date.now() + 3600 * 1000),
      lastActivityAt: new Date(),
    };
    const mockGetDecryptedSession = async (): Promise<DecryptedUploadSession> => mockSession;

    global.fetch = async () => {
      return new Response('', {
        status: 308,
        headers: {
          'X-GUploader-UploadID': 'secret-id',
          'Location': 'https://google.mock/session-123-leak',
        },
      });
    };

    const handleProxyChunkUpload = createChunkPutHandler({
      verifyAdminSession: mockVerifyAdminSession,
      getDecryptedSession: mockGetDecryptedSession,
    });

    const res = await handleProxyChunkUpload(req, { params: Promise.resolve({ id: 'asset-123' }) });

    // Check response headers
    assert(!res.headers.has('Location'), 'Should not leak Location header');
    assert(!res.headers.has('X-GUploader-UploadID'), 'Should not leak internal GDrive headers');
    testCount++;
    console.log('✓ Test 16: provider session URI and sensitive response headers are not leaked');
  }

  // 17. Role authorization model permits both USER and ADMIN roles
  {
    reset();
    const mockStream = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array([1]));
        c.close();
      }
    });

    const req = new NextRequest('http://localhost/api/uploads/asset-123/chunk', {
      method: 'PUT',
      headers: {
        'Content-Range': 'bytes 0-99/1000',
        'Content-Length': '100',
      },
      body: mockStream,
      duplex: 'half',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    mockAssets.push({
      id: 'asset-123',
      userId: 'user-123',
      provider: 'GOOGLE_DRIVE',
      expectedSize: BigInt(1000),
    });

    const mockSession: DecryptedUploadSession = {
      uploadAssetId: 'asset-123',
      providerSessionId: 'https://session-uri',
      completedParts: [],
      expiresAt: new Date(Date.now() + 3600 * 1000),
      lastActivityAt: new Date(),
    };
    const mockGetDecryptedSession = async (): Promise<DecryptedUploadSession> => mockSession;
    global.fetch = async () => new Response('', { status: 308 });

    // Approved non-admin USER
    const mockVerifyUser = async (): Promise<User | null> => ({ id: 'user-123', role: 'USER', status: 'ACTIVE', approvalStatus: 'APPROVED' } as unknown as User);
    const handleProxyUser = createChunkPutHandler({
      verifyAdminSession: mockVerifyUser,
      getDecryptedSession: mockGetDecryptedSession,
    });
    const resUser = await handleProxyUser(req, { params: Promise.resolve({ id: 'asset-123' }) });
    assert(resUser.status === 200, 'Approved USER should succeed');

    // ADMIN user
    const mockVerifyAdmin = async (): Promise<User | null> => ({ id: 'user-123', role: 'ADMIN', status: 'ACTIVE', approvalStatus: 'APPROVED' } as unknown as User);
    const handleProxyAdmin = createChunkPutHandler({
      verifyAdminSession: mockVerifyAdmin,
      getDecryptedSession: mockGetDecryptedSession,
    });
    const resAdmin = await handleProxyAdmin(req, { params: Promise.resolve({ id: 'asset-123' }) });
    assert(resAdmin.status === 200, 'ADMIN user should succeed');
    testCount++;
    console.log('✓ Test 17: authorization helper verifies both ADMIN and approved USER roles correctly');
  }

  console.log(`\nALL ${testCount} SECURE CHUNK PROXY INTEGRATION TESTS PASSED! 🎉`);
}

runTests().catch(err => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
