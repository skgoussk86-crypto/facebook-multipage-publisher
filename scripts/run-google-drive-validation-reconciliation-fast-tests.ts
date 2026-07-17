import { UploadAsset, UploadStatus } from "@prisma/client";
import { NextRequest } from "next/server";
import { Readable } from "stream";
import type { VideoValidationService as VideoValidationServiceClass } from "../src/lib/storage/video-validation-service";
import type { handleValidateUploadRequest as handleValidateUploadRequestFn } from "../src/app/api/uploads/[id]/validate/route";
import type { verifyAdminSession as verifyAdminSessionFn } from "../src/lib/auth";
import type { prepareValidationSource as prepareValidationSourceFn } from "../src/lib/storage/validation-source-resolver";

// Set environment variables for the test before imports
process.env.GOOGLE_DRIVE_CLIENT_ID = "client-id-mock";
process.env.GOOGLE_DRIVE_CLIENT_SECRET = "client-secret-mock";
process.env.GOOGLE_DRIVE_REDIRECT_URI = "https://redirect.uri";
process.env.GOOGLE_DRIVE_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.GOOGLE_DRIVE_OWNER_USER_ID = "user-123";

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
let mockConnections: Record<string, unknown>[] = [];
let mockAuditLogs: Record<string, unknown>[] = [];

function resetMockDb() {
  mockAssets = [];
  mockConnections = [];
  mockAuditLogs = [];
}

const mockPrisma = {
  uploadAsset: {
    findUnique: async (args: { where: { id: string } }) => {
      return mockAssets.find(a => a.id === args.where.id) || null;
    },
    updateMany: async (args: {
      where: { id: string; status?: UploadStatus; userId?: string; validationLockToken?: string | null };
      data: Partial<UploadAsset>;
    }) => {
      const { where, data } = args;
      let count = 0;
      mockAssets = mockAssets.map(a => {
        if (a.id === where.id) {
          if (where.status && a.status !== where.status) return a;
          if (where.userId && a.userId !== where.userId) return a;
          if (where.validationLockToken && a.validationLockToken !== where.validationLockToken) return a;
          
          const nowTime = new Date();
          const isLockHolder = where.validationLockToken && a.validationLockToken === where.validationLockToken;
          const hasActiveLock = !isLockHolder &&
            a.validationLockToken !== undefined && a.validationLockToken !== null &&
            a.validationLockExpiresAt !== undefined && a.validationLockExpiresAt !== null &&
            a.validationLockExpiresAt >= nowTime;
          if (hasActiveLock) {
            return a;
          }

          count++;
          const updated = { ...a, ...data };
          if (data.validationAttemptCount && typeof data.validationAttemptCount === 'object') {
            updated.validationAttemptCount = (a.validationAttemptCount || 0) + 1;
          }
          return updated;
        }
        return a;
      });
      return { count };
    },
    findMany: async () => {
      return mockAssets;
    },
  },
  googleDriveConnection: {
    findUnique: async (args: { where: { userId: string } }) => {
      return mockConnections.find(c => c.userId === args.where.userId) || null;
    },
  },
  auditLog: {
    create: async (args: { data: Record<string, unknown> }) => {
      mockAuditLogs.push(args.data);
      return args.data;
    },
  },
  $transaction: async <T>(cb: (tx: unknown) => Promise<T>) => {
    return cb(mockPrisma);
  }
};

(global as unknown as { prisma: typeof mockPrisma }).prisma = mockPrisma;

// Variables for dynamic imports after prisma has been mocked globally
let VideoValidationService: typeof VideoValidationServiceClass;
let handleValidateUploadRequest: typeof handleValidateUploadRequestFn;
import {
  GoogleDriveResumableUploader,
  GoogleUploadTransport,
  GoogleUploadTransportRequest,
  GoogleUploadTransportResponse
} from "../src/lib/uploads/google-drive-resumable-uploader";
import { BrowserMultipartUploader } from "../src/lib/uploads/browser-multipart-uploader";
import { UploadFileLike } from "../src/lib/uploads/upload-types";

// Mock validation probe
const mockProbeResult = {
  durationMs: 5000,
  width: 1920,
  height: 1080,
  frameRate: 30,
  videoCodec: "h264",
  audioCodec: "aac",
  containerFormat: "mp4",
  detectedMimeType: "video/mp4",
};

const mockProbe = {
  probe: async () => mockProbeResult,
};



// -------------------------------------------------------------
// Browser Mocks
// -------------------------------------------------------------
class MockLocalStorage implements Storage {
  private store: Record<string, string> = {};
  get length(): number { return Object.keys(this.store).length; }
  clear(): void { this.store = {}; }
  getItem(key: string): string | null { return this.store[key] || null; }
  key(index: number): string | null { return Object.keys(this.store)[index] || null; }
  removeItem(key: string): void { delete this.store[key]; }
  setItem(key: string, value: string): void { this.store[key] = value; }
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
    return new Blob([], { type: contentType || this.type }).slice(0, (end ?? this.size) - (start ?? 0));
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
      throw new DOMException('The user aborted a request.', 'AbortError');
    }
    return new Promise<Response>((resolve, reject) => {
      const onAbort = () => {
        reject(new DOMException('The user aborted a request.', 'AbortError'));
      };
      if (init?.signal) {
        init.signal.addEventListener('abort', onAbort);
      }
      fetchHandler(url, init)
        .then((res) => {
          if (init?.signal) {
            init.signal.removeEventListener('abort', onAbort);
          }
          resolve(res);
        })
        .catch((err) => {
          if (init?.signal) {
            init.signal.removeEventListener('abort', onAbort);
          }
          reject(err);
        });
    });
  },
  writable: true,
});

function createMockResponse(status: number, body: unknown, headersInit?: Record<string, string>): Response {
  const headers = new Headers();
  if (headersInit) {
    for (const [k, v] of Object.entries(headersInit)) {
      headers.set(k, v);
    }
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function createTransportResponse(status: number, body: string, range?: string): GoogleUploadTransportResponse {
  const headers: Record<string, string> = {};
  if (range) {
    headers['Range'] = range;
  }
  return {
    status,
    headers: {
      get: (name: string) => headers[name] ?? null,
    },
    body,
  };
}

function makeAsset(overrides?: Partial<UploadAsset>): UploadAsset {
  const defaults: UploadAsset = {
    id: "asset-123",
    userId: "user-123",
    idempotencyKey: "key-123",
    requestFingerprint: "fingerprint-123",
    provider: "GOOGLE_DRIVE",
    bucket: "folder-456",
    objectKey: "drive-file-123",
    originalName: "video.mp4",
    expectedSize: BigInt(10485760),
    actualSize: BigInt(10485760),
    declaredMimeType: "video/mp4",
    detectedMimeType: null,
    checksum: null,
    objectETag: null,
    status: UploadStatus.VALIDATING,
    failureCode: null,
    failureMessage: null,
    validationLockToken: null,
    validationLockedAt: null,
    validationLockExpiresAt: null,
    validationAttemptCount: 0,
    validationMaxAttempts: 3,
    validationStartedAt: null,
    finalizationOperation: null,
    finalizationLockToken: null,
    finalizationLockedAt: null,
    finalizationLockExpiresAt: null,
    finalizationAttemptCount: 0,
    durationMs: null,
    containerFormat: null,
    videoCodec: null,
    audioCodec: null,
    width: null,
    height: null,
    frameRate: null,
    uploadExpiresAt: new Date(Date.now() + 100000),
    uploadedAt: null,
    validatedAt: null,
    retentionUntil: null,
    objectDeletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  return { ...defaults, ...overrides } as UploadAsset;
}

function makeConnection(overrides?: Partial<Record<string, unknown>>): Record<string, unknown> {
  const defaults = {
    id: "conn-123",
    userId: "user-123",
    encryptedRefreshToken: "enc:refresh-token-abc",
    refreshTokenKeyVersion: "1",
    googleAccountEmail: "account@gmail.com",
    driveFolderId: "folder-456",
    connectedAt: new Date(),
    updatedAt: new Date(),
    revokedAt: null,
  };
  return { ...defaults, ...overrides };
}

// Helper to reset browser environment
function resetBrowser() {
  fetchRequests.length = 0;
  mockLocalStorage.clear();
  fetchHandler = () => {
    throw new Error("No fetch handler configured");
  };
}

// Mock auth session helper
const mockVerifyAdminSession = async (req: NextRequest) => {
  if (req.headers.get("Authorization") === "Bearer valid-token") {
    return {
      id: "user-123",
      email: "user@gmail.com",
      role: "ADMIN",
      status: "APPROVED"
    } as unknown as Awaited<ReturnType<typeof verifyAdminSessionFn>>;
  }
  return null;
};

// -------------------------------------------------------------
// Test Runner
// -------------------------------------------------------------
async function runTests() {
  // Dynamically import to ensure mockPrisma is registered
  const validationMod = await import("../src/lib/storage/video-validation-service");
  VideoValidationService = validationMod.VideoValidationService;
  VideoValidationService.setProbe(mockProbe);

  const mockPrepareValidationSource = async (asset: Parameters<typeof prepareValidationSourceFn>[0]) => {
    return {
      metadata: {
        size: Number(asset.actualSize),
        contentType: "video/mp4",
        eTag: "mock-etag",
      },
      createReadStream: async () => {
        return Readable.from(["fake-data"]);
      }
    } as unknown as Awaited<ReturnType<typeof prepareValidationSourceFn>>;
  };

  const validateRouteMod = await import("../src/app/api/uploads/[id]/validate/route");
  handleValidateUploadRequest = validateRouteMod.handleValidateUploadRequest;

  console.log("Running Google Drive Automatic Validation and Faster Reconciliation Tests...\n");
  let passedCount = 0;

  // 1. unauthenticated validation endpoint rejected
  try {
    resetMockDb();
    const req = new NextRequest("http://localhost/api/uploads/asset-123/validate", {
      method: "POST",
      headers: {
        Authorization: "Bearer invalid-token",
        Host: "localhost",
        Origin: "http://localhost",
      }
    });
    const res = await handleValidateUploadRequest(
      req,
      { id: "asset-123" },
      { verifyAdminSession: mockVerifyAdminSession }
    );
    assert(res.status === 401, "Expected 401");
    const body = await res.json();
    assert(body.error === "UNAUTHENTICATED", "Expected UNAUTHENTICATED error");
    console.log("Test 1 Passed: unauthenticated validation endpoint rejected [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 1 Failed:", err);
  }

  // 2. wrong-owner asset hidden/rejected
  try {
    resetMockDb();
    mockAssets.push(makeAsset({ userId: "different-user" }));
    const req = new NextRequest("http://localhost/api/uploads/asset-123/validate", {
      method: "POST",
      headers: {
        Authorization: "Bearer valid-token",
        Host: "localhost",
        Origin: "http://localhost",
      }
    });
    const res = await handleValidateUploadRequest(
      req,
      { id: "asset-123" },
      { verifyAdminSession: mockVerifyAdminSession }
    );
    assert(res.status === 404, "Expected 404");
    const body = await res.json();
    assert(body.error === "UPLOAD_NOT_FOUND", "Expected UPLOAD_NOT_FOUND");
    console.log("Test 2 Passed: wrong-owner asset hidden/rejected [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 2 Failed:", err);
  }

  // 3. non-VALIDATING invalid state rejected safely
  try {
    resetMockDb();
    mockAssets.push(makeAsset({ status: UploadStatus.UPLOADING }));
    const req = new NextRequest("http://localhost/api/uploads/asset-123/validate", {
      method: "POST",
      headers: {
        Authorization: "Bearer valid-token",
        Host: "localhost",
        Origin: "http://localhost",
      }
    });
    const res = await handleValidateUploadRequest(
      req,
      { id: "asset-123" },
      { verifyAdminSession: mockVerifyAdminSession }
    );
    assert(res.status === 400, "Expected 400");
    const body = await res.json();
    assert(body.error === "INVALID_UPLOAD_STATE", "Expected INVALID_UPLOAD_STATE error");
    console.log("Test 3 Passed: non-VALIDATING invalid state rejected safely [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 3 Failed:", err);
  }

  // 4. already VALIDATED returns idempotent success
  try {
    resetMockDb();
    mockAssets.push(makeAsset({ status: UploadStatus.VALIDATED }));
    const req = new NextRequest("http://localhost/api/uploads/asset-123/validate", {
      method: "POST",
      headers: {
        Authorization: "Bearer valid-token",
        Host: "localhost",
        Origin: "http://localhost",
      }
    });
    const res = await handleValidateUploadRequest(
      req,
      { id: "asset-123" },
      { verifyAdminSession: mockVerifyAdminSession }
    );
    assert(res.status === 200, "Expected 200");
    const body = await res.json();
    assert(body.status === "VALIDATED", "Expected VALIDATED status");
    console.log("Test 4 Passed: already VALIDATED returns idempotent success [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 4 Failed:", err);
  }

  // 5. owned VALIDATING asset is validated
  try {
    resetMockDb();
    mockAssets.push(makeAsset({ status: UploadStatus.VALIDATING, expectedSize: BigInt(9), actualSize: BigInt(9) }));
    mockConnections.push(makeConnection());

    fetchHandler = async (url) => {
      if (url.includes("oauth2.googleapis.com/token")) {
        return createMockResponse(200, { access_token: "mock-access-token" });
      }
      if (url.includes("drive/v3/files/drive-file-123") && !url.includes("alt=media")) {
        return createMockResponse(200, {
          id: "drive-file-123",
          name: "video.mp4",
          mimeType: "video/mp4",
          size: 10485760,
          parents: ["folder-456"],
          trashed: false,
          appProperties: {
            "assetId": "asset-123",
          },
        });
      }
      if (url.includes("drive/v3/files/drive-file-123") && url.includes("alt=media")) {
        return new Response("fake-stream-data");
      }
      return createMockResponse(500, {});
    };

    const res = await VideoValidationService.validateAssetById(
      "user-123",
      "asset-123",
      { prepareValidationSource: mockPrepareValidationSource }
    );
    assert(res.success === true, "Expected success true");
    assert(res.status === UploadStatus.VALIDATED, "Expected VALIDATED");
    
    // Verify DB update
    const updated = mockAssets[0];
    assert(updated.status === UploadStatus.VALIDATED, "Should be VALIDATED in DB");
    console.log("Test 5 Passed: owned VALIDATING asset is validated [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 5 Failed:", err);
  }

  // 6. duplicate concurrent validation is lock-safe
  try {
    resetMockDb();
    mockAssets.push(makeAsset({
      status: UploadStatus.VALIDATING,
      validationLockToken: "other-lock-token",
      validationLockExpiresAt: new Date(Date.now() + 100000)
    }));

    const res = await VideoValidationService.validateAssetById(
      "user-123",
      "asset-123",
      { prepareValidationSource: mockPrepareValidationSource }
    );
    assert(res.status === UploadStatus.VALIDATING, "Should return VALIDATING when busy");
    console.log("Test 6 Passed: duplicate concurrent validation is lock-safe [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 6 Failed:", err);
  }

  // 7. validation failure is sanitized
  try {
    resetMockDb();
    mockAssets.push(makeAsset({ status: UploadStatus.VALIDATING, expectedSize: BigInt(9), actualSize: BigInt(9) }));
    mockConnections.push(makeConnection());

    const res = await VideoValidationService.validateAssetById(
      "user-123",
      "asset-123",
      {
        prepareValidationSource: async () => {
          throw new Error("Transient storage connection timed out.");
        }
      }
    );
    assert(res.status === UploadStatus.VALIDATING, "Expected transient error to retain VALIDATING status");
    assert(Boolean(res.failureMessage?.includes("Transient infrastructure failure")), "Expected sanitized failure message");
    console.log("Test 7 Passed: validation failure is sanitized [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 7 Failed:", err);
  }

  // 8. Google Drive private values never appear in API responses
  try {
    resetMockDb();
    mockAssets.push(makeAsset({ status: UploadStatus.VALIDATING, expectedSize: BigInt(9), actualSize: BigInt(9) }));
    mockConnections.push(makeConnection());

    const secretSessionUri = "https://www.googleapis.com/upload/drive/v3/files/session-token-123456";
    const res = await VideoValidationService.validateAssetById(
      "user-123",
      "asset-123",
      {
        prepareValidationSource: async () => {
          throw new Error(`Connection timed out on ${secretSessionUri}`);
        }
      }
    );
    assert(res.status === UploadStatus.VALIDATING, "Expected transient error to retain VALIDATING status");
    assert(!res.failureMessage?.includes("session-token"), "Access token / session URI must not leak");
    console.log("Test 8 Passed: Google Drive private values never leak in API errors [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 8 Failed:", err);
  }

  // 9. browser automatically requests validation after normal completion
  try {
    resetBrowser();
    const file = new FakeUploadFile("video.mp4", 5000000, "video/mp4");
    const transport = new MockTransport();

    let validateCalled = false;
    fetchHandler = async (url) => {
      if (url === "/api/uploads/asset-123/complete") {
        return createMockResponse(200, { status: "VALIDATING" });
      }
      if (url === "/api/uploads/asset-123/validate") {
        validateCalled = true;
        return createMockResponse(200, { status: "VALIDATING" });
      }
      return createMockResponse(500, {});
    };

    transport.responseHandler = async () => {
      return createTransportResponse(200, JSON.stringify({ id: "drive-id-123" }));
    };

    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: "asset-123",
      sessionUri: "https://www.googleapis.com/session-url",
      recoveryKey: "key-123",
      maxRetries: 0,
      transport,
    });

    await uploader.start();

    assert(validateCalled, "Should automatically call POST /validate after completion");
    uploader.destroy();
    console.log("Test 9 Passed: browser automatically requests validation after completion [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 9 Failed:", err);
  }

  // 10. browser automatically requests validation after reconciliation
  try {
    resetBrowser();
    const file = new FakeUploadFile("video.mp4", 5000000, "video/mp4");
    const transport = new MockTransport();

    transport.responseHandler = async () => {
      throw createTransportResponse(0, "");
    };

    let validateCalled = false;
    fetchHandler = async (url) => {
      if (url === "/api/uploads/asset-123") {
        return createMockResponse(200, { status: "UPLOADING" });
      }
      if (url === "/api/uploads/asset-123/reconcile") {
        return createMockResponse(200, { status: "VALIDATING" });
      }
      if (url === "/api/uploads/asset-123/validate") {
        validateCalled = true;
        return createMockResponse(200, { status: "VALIDATING" });
      }
      return createMockResponse(500, {});
    };

    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: "asset-123",
      sessionUri: "https://www.googleapis.com/session-url",
      recoveryKey: "key-123",
      maxRetries: 0,
      transport,
    });

    await uploader.start();

    assert(validateCalled, "Should automatically call POST /validate after reconciliation");
    uploader.destroy();
    console.log("Test 10 Passed: browser automatically requests validation after reconciliation [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 10 Failed:", err);
  }

  // 11. browser receives VALIDATED metadata
  try {
    resetBrowser();
    const file = new FakeUploadFile("video.mp4", 5000000, "video/mp4");
    const transport = new MockTransport();

    fetchHandler = async (url) => {
      if (url === "/api/uploads/asset-123/complete") {
        return createMockResponse(200, { status: "VALIDATING" });
      }
      if (url === "/api/uploads/asset-123/validate") {
        return createMockResponse(200, {
          status: "VALIDATED",
          durationMs: 5000,
          containerFormat: "mp4",
          width: 640,
          height: 360,
          frameRate: 30,
          videoCodec: "h264",
          audioCodec: "aac",
          detectedMimeType: "video/mp4"
        });
      }
      return createMockResponse(500, {});
    };

    transport.responseHandler = async () => {
      return createTransportResponse(200, JSON.stringify({ id: "drive-id-123" }));
    };

    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: "asset-123",
      sessionUri: "https://www.googleapis.com/session-url",
      recoveryKey: "key-123",
      maxRetries: 0,
      transport,
    });

    await uploader.start();
    assert(uploader.getStatus().state === "validated", "Should transition directly to validated state");
    const meta = uploader.getStatus().metadata;
    assert(meta?.durationMs === 5000 && meta.width === 640, "Metadata fields must match validation response");
    console.log("Test 11 Passed: browser receives VALIDATED metadata immediately [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 11 Failed:", err);
  }

  // 12. temporary validation endpoint failure falls back to polling
  try {
    resetBrowser();
    const file = new FakeUploadFile("video.mp4", 5000000, "video/mp4");
    const transport = new MockTransport();

    let pollCalled = false;
    fetchHandler = async (url) => {
      if (url === "/api/uploads/asset-123/complete") {
        return createMockResponse(200, { status: "VALIDATING" });
      }
      if (url === "/api/uploads/asset-123/validate") {
        return createMockResponse(500, {}); // Fail temporarily
      }
      if (url === "/api/uploads/asset-123") {
        pollCalled = true;
        return createMockResponse(200, { status: "VALIDATING" });
      }
      return createMockResponse(500, {});
    };

    transport.responseHandler = async () => {
      return createTransportResponse(200, JSON.stringify({ id: "drive-id-123" }));
    };

    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: "asset-123",
      sessionUri: "https://www.googleapis.com/session-url",
      recoveryKey: "key-123",
      maxRetries: 0,
      transport,
    });

    await uploader.start();
    await new Promise(r => setTimeout(r, 20));

    assert(pollCalled, "Should poll status if validate fails temporarily");
    uploader.destroy();
    console.log("Test 12 Passed: temporary validation endpoint failure falls back to polling [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 12 Failed:", err);
  }

  // 13. Pause during validation does not emit failed
  try {
    resetBrowser();
    const file = new FakeUploadFile("video.mp4", 5000000, "video/mp4");
    const transport = new MockTransport();

    let validateResolve: (() => void) | null = null;
    fetchHandler = async (url) => {
      if (url === "/api/uploads/asset-123/complete") {
        return createMockResponse(200, { status: "VALIDATING" });
      }
      if (url === "/api/uploads/asset-123/validate") {
        return new Promise<Response>((resolve) => {
          validateResolve = () => resolve(createMockResponse(200, { status: "VALIDATING" }));
        });
      }
      return createMockResponse(500, {});
    };

    transport.responseHandler = async () => {
      return createTransportResponse(200, JSON.stringify({ id: "drive-id-123" }));
    };

    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: "asset-123",
      sessionUri: "https://www.googleapis.com/session-url",
      recoveryKey: "key-123",
      maxRetries: 0,
      transport,
    });

    let threw = false;
    const startPromise = uploader.start().catch(() => { threw = true; });

    await new Promise(r => setTimeout(r, 20));
    uploader.pause();

    if (validateResolve) {
      (validateResolve as () => void)();
    }
    await startPromise;

    assert(uploader.getStatus().state === "paused", "State should be paused");
    assert(!threw, "uploader.start() must not reject when paused during validation");
    uploader.destroy();
    console.log("Test 13 Passed: Pause during validation does not emit failed [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 13 Failed:", err);
  }

  // 14. Cancel during validation does not emit failed
  try {
    resetBrowser();
    const file = new FakeUploadFile("video.mp4", 5000000, "video/mp4");
    const transport = new MockTransport();

    let validateResolve: (() => void) | null = null;
    let abortApiCalled = false;
    fetchHandler = async (url) => {
      if (url === "/api/uploads/asset-123/complete") {
        return createMockResponse(200, { status: "VALIDATING" });
      }
      if (url === "/api/uploads/asset-123/validate") {
        return new Promise<Response>((resolve) => {
          validateResolve = () => resolve(createMockResponse(200, { status: "VALIDATING" }));
        });
      }
      if (url === "/api/uploads/asset-123/abort") {
        abortApiCalled = true;
        return createMockResponse(200, {});
      }
      return createMockResponse(500, {});
    };

    transport.responseHandler = async () => {
      return createTransportResponse(200, JSON.stringify({ id: "drive-id-123" }));
    };

    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: "asset-123",
      sessionUri: "https://www.googleapis.com/session-url",
      recoveryKey: "key-123",
      maxRetries: 0,
      transport,
    });

    let threw = false;
    const startPromise = uploader.start().catch(() => { threw = true; });

    await new Promise(r => setTimeout(r, 20));
    uploader.cancel().catch(() => {});

    if (validateResolve) {
      (validateResolve as () => void)();
    }
    await startPromise;

    assert(uploader.getStatus().state === "aborted", "State should be aborted");
    assert(!threw, "uploader.start() must not reject when cancelled during validation");
    assert(abortApiCalled, "Server abort API must be called");
    console.log("Test 14 Passed: Cancel during validation does not emit failed [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 14 Failed:", err);
  }

  // 15. R2 behavior remains unchanged
  try {
    resetBrowser();
    const file = new FakeUploadFile("video.mp4", 5000000, "video/mp4");
    const transport = new MockTransport();

    let initiateCalled = false;
    let completeCalled = false;
    let pollCalled = false;
    fetchHandler = async (url) => {
      if (url === "/api/uploads/initiate") {
        initiateCalled = true;
        return createMockResponse(201, {
          provider: "R2",
          assetId: "r2-asset-123",
          totalParts: 1,
          partSize: 5000000
        });
      }
      if (url === "/api/uploads/r2-asset-123/parts") {
        return createMockResponse(200, { uploadUrl: "https://r2.mock/upload-url" });
      }
      if (url === "https://r2.mock/upload-url") {
        return createMockResponse(200, {}, { ETag: "mock-etag" });
      }
      if (url === "/api/uploads/r2-asset-123/complete") {
        completeCalled = true;
        return createMockResponse(202, {});
      }
      if (url === "/api/uploads/r2-asset-123") {
        pollCalled = true;
        return createMockResponse(200, { status: "VALIDATING" });
      }
      return createMockResponse(500, {});
    };

    const uploader = new BrowserMultipartUploader({
      file,
      recoveryKey: "key-r2",
      transport,
    });

    await uploader.start();
    await new Promise(r => setTimeout(r, 20));

    assert(initiateCalled && completeCalled && pollCalled, "R2 complete and polling must occur normally");
    uploader.destroy();
    console.log("Test 15 Passed: R2 behavior remains unchanged [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 15 Failed:", err);
  }

  // 16. first status-0 response triggers immediate reconciliation
  try {
    resetBrowser();
    const file = new FakeUploadFile("video.mp4", 5000000, "video/mp4");
    const transport = new MockTransport();

    transport.responseHandler = async () => {
      throw createTransportResponse(0, ""); // Status 0
    };

    let reconcileCalled = false;
    fetchHandler = async (url) => {
      if (url === "/api/uploads/asset-123") {
        return createMockResponse(200, { status: "UPLOADING" });
      }
      if (url === "/api/uploads/asset-123/reconcile") {
        reconcileCalled = true;
        return createMockResponse(200, { status: "VALIDATING" });
      }
      if (url === "/api/uploads/asset-123/validate") {
        return createMockResponse(200, { status: "VALIDATING" });
      }
      return createMockResponse(500, {});
    };

    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: "asset-123",
      sessionUri: "https://www.googleapis.com/session-url",
      recoveryKey: "key-123",
      maxRetries: 5, // We set maxRetries high
      retryBackoffMs: 1,
      transport,
    });

    await uploader.start();

    assert(reconcileCalled, "Immediate reconciliation must occur on first status-0 response");
    assert(uploader.getStatus().state === "validating", "Should enter validating directly");
    uploader.destroy();
    console.log("Test 16 Passed: first status-0 response triggers immediate reconciliation [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 16 Failed:", err);
  }

  // 17. completed provider response reaches VALIDATING without five retries
  try {
    resetBrowser();
    const file = new FakeUploadFile("video.mp4", 5000000, "video/mp4");
    const transport = new MockTransport();

    let transportAttempts = 0;
    transport.responseHandler = async () => {
      transportAttempts++;
      throw createTransportResponse(0, "");
    };

    fetchHandler = async (url) => {
      if (url === "/api/uploads/asset-123") {
        return createMockResponse(200, { status: "UPLOADING" });
      }
      if (url === "/api/uploads/asset-123/reconcile") {
        return createMockResponse(200, { status: "VALIDATING" });
      }
      if (url === "/api/uploads/asset-123/validate") {
        return createMockResponse(200, { status: "VALIDATING" });
      }
      return createMockResponse(500, {});
    };

    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: "asset-123",
      sessionUri: "https://www.googleapis.com/session-url",
      recoveryKey: "key-123",
      maxRetries: 5,
      retryBackoffMs: 1,
      transport,
    });

    await uploader.start();

    assert(transportAttempts === 1, "Should reconcile and exit after first failed transport attempt without doing 5 retries");
    uploader.destroy();
    console.log("Test 17 Passed: completed response reaches VALIDATING without 5 retries [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 17 Failed:", err);
  }

  // 18. 308/UPLOADING reconciliation resumes from confirmedBytes
  try {
    resetBrowser();
    const file = new FakeUploadFile("video.mp4", 5000000, "video/mp4");
    const transport = new MockTransport();

    let sendAttempts = 0;
    let putRangeHeader = "";
    transport.responseHandler = async (req) => {
      sendAttempts++;
      if (sendAttempts === 1) {
        throw createTransportResponse(0, "");
      }
      if (sendAttempts === 2) {
        return createTransportResponse(308, "", "bytes=0-2621439");
      }
      putRangeHeader = req.headers["Content-Range"] || "";
      return createTransportResponse(200, JSON.stringify({ id: "drive-file-123" }));
    };

    fetchHandler = async (url) => {
      if (url === "/api/uploads/asset-123") {
        return createMockResponse(200, { status: "UPLOADING" });
      }
      if (url === "/api/uploads/asset-123/reconcile") {
        return createMockResponse(200, { status: "UPLOADING", confirmedBytes: 2621440 });
      }
      if (url === "/api/uploads/asset-123/complete") {
        return createMockResponse(200, { status: "VALIDATING" });
      }
      if (url === "/api/uploads/asset-123/validate") {
        return createMockResponse(200, { status: "VALIDATING" });
      }
      return createMockResponse(500, {});
    };

    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: "asset-123",
      sessionUri: "https://www.googleapis.com/session-url",
      recoveryKey: "key-123",
      maxRetries: 1,
      retryBackoffMs: 1,
      transport,
    });

    await uploader.start();

    assert(sendAttempts > 1, "Should retry after reconciliation");
    assert(putRangeHeader.includes("bytes 2621440-"), `Expected PUT to start at 2621440, got: ${putRangeHeader}`);
    uploader.destroy();
    console.log("Test 18 Passed: 308/UPLOADING reconciliation resumes from confirmedBytes [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 18 Failed:", err);
  }

  // 19. zero-progress reconciliation falls back to bounded retries
  try {
    resetBrowser();
    const file = new FakeUploadFile("video.mp4", 5000000, "video/mp4");
    const transport = new MockTransport();

    let transportAttempts = 0;
    transport.responseHandler = async () => {
      transportAttempts++;
      throw createTransportResponse(0, "");
    };

    fetchHandler = async (url) => {
      if (url === "/api/uploads/asset-123") {
        return createMockResponse(200, { status: "UPLOADING" });
      }
      if (url === "/api/uploads/asset-123/reconcile") {
        return createMockResponse(200, { status: "UPLOADING", confirmedBytes: 0 }); // Zero progress
      }
      return createMockResponse(500, {});
    };

    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: "asset-123",
      sessionUri: "https://www.googleapis.com/session-url",
      recoveryKey: "key-123",
      maxRetries: 2, // Retries are bounded to maxRetries
      retryBackoffMs: 1,
      transport,
    });

    let threw = false;
    try {
      await uploader.start();
    } catch {
      threw = true;
    }

    assert(threw, "Uploader must fail after max retries are exhausted");
    assert(transportAttempts === 3, `Expected 3 total transport attempts (1 initial + 2 retries), got: ${transportAttempts}`);
    uploader.destroy();
    console.log("Test 19 Passed: zero-progress reconciliation falls back to bounded retries [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 19 Failed:", err);
  }

  // 20. temporary reconciliation failure falls back to retries
  try {
    resetBrowser();
    const file = new FakeUploadFile("video.mp4", 5000000, "video/mp4");
    const transport = new MockTransport();

    let transportAttempts = 0;
    transport.responseHandler = async () => {
      transportAttempts++;
      throw createTransportResponse(0, "");
    };

    fetchHandler = async (url) => {
      if (url === "/api/uploads/asset-123") {
        return createMockResponse(200, { status: "UPLOADING" });
      }
      if (url === "/api/uploads/asset-123/reconcile") {
        return createMockResponse(500, {}); // Fail reconciliation temporarily
      }
      return createMockResponse(500, {});
    };

    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: "asset-123",
      sessionUri: "https://www.googleapis.com/session-url",
      recoveryKey: "key-123",
      maxRetries: 2,
      retryBackoffMs: 1,
      transport,
    });

    let threw = false;
    try {
      await uploader.start();
    } catch {
      threw = true;
    }

    assert(threw, "Should fail eventually");
    assert(transportAttempts === 3, `Should retry normally after temp reconciliation error, attempts: ${transportAttempts}`);
    uploader.destroy();
    console.log("Test 20 Passed: temporary reconciliation failure falls back to retries [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 20 Failed:", err);
  }

  // 21. only one reconciliation runs at a time
  try {
    resetBrowser();
    const file = new FakeUploadFile("video.mp4", 5000000, "video/mp4");
    const transport = new MockTransport();

    transport.responseHandler = async () => {
      throw createTransportResponse(0, "");
    };

    let reconcileCount = 0;
    fetchHandler = async (url) => {
      if (url === "/api/uploads/asset-123") {
        return createMockResponse(200, { status: "UPLOADING" });
      }
      if (url === "/api/uploads/asset-123/reconcile") {
        reconcileCount++;
        await new Promise(r => setTimeout(r, 100));
        return createMockResponse(200, { status: "VALIDATING" });
      }
      return createMockResponse(500, {});
    };

    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: "asset-123",
      sessionUri: "https://www.googleapis.com/session-url",
      recoveryKey: "key-123",
      maxRetries: 0,
      transport,
    });

    const startPromise = uploader.start();
    await new Promise(r => setTimeout(r, 20));

    const secondReconcile = await uploader["attemptServerReconciliation"]();
    assert(secondReconcile === false, "Second concurrent reconciliation should return false immediately");

    await startPromise;
    assert(reconcileCount === 1, `Expected exactly 1 reconcile API call, got: ${reconcileCount}`);
    uploader.destroy();
    console.log("Test 21 Passed: only one reconciliation runs at a time [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 21 Failed:", err);
  }

  // 22. Pause before immediate reconciliation makes zero reconcile requests
  try {
    resetBrowser();
    const file = new FakeUploadFile("video.mp4", 5000000, "video/mp4");
    const transport = new MockTransport();

    transport.responseHandler = async () => {
      uploader.pause();
      throw createTransportResponse(0, "");
    };

    let reconcileCalled = false;
    fetchHandler = async (url) => {
      if (url === "/api/uploads/asset-123") {
        return createMockResponse(200, { status: "UPLOADING" });
      }
      if (url === "/api/uploads/asset-123/reconcile") {
        reconcileCalled = true;
        return createMockResponse(200, { status: "VALIDATING" });
      }
      return createMockResponse(500, {});
    };

    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: "asset-123",
      sessionUri: "https://www.googleapis.com/session-url",
      recoveryKey: "key-123",
      maxRetries: 0,
      transport,
    });

    await uploader.start();

    assert(!reconcileCalled, "Pause should prevent reconciliation");
    assert(uploader.getStatus().state === "paused", "State should be paused");
    uploader.destroy();
    console.log("Test 22 Passed: Pause before immediate reconciliation makes zero reconcile requests [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 22 Failed:", err);
  }

  // 23. no duplicate bytes are uploaded
  try {
    resetBrowser();
    const file = new FakeUploadFile("video.mp4", 5000000, "video/mp4");
    const transport = new MockTransport();

    const uploadedRanges: string[] = [];
    let putAttempts = 0;
    transport.responseHandler = async (req) => {
      putAttempts++;
      const range = req.headers["Content-Range"] || "";
      if (!range.includes("*")) {
        uploadedRanges.push(range);
      }
      if (putAttempts === 1) {
        throw createTransportResponse(0, "");
      }
      if (putAttempts === 2) {
        return createTransportResponse(308, "", "bytes=0-2621439");
      }
      return createTransportResponse(200, JSON.stringify({ id: "drive-file-123" }));
    };

    fetchHandler = async (url) => {
      if (url === "/api/uploads/asset-123") {
        return createMockResponse(200, { status: "UPLOADING" });
      }
      if (url === "/api/uploads/asset-123/reconcile") {
        return createMockResponse(200, { status: "UPLOADING", confirmedBytes: 2621440 });
      }
      if (url === "/api/uploads/asset-123/complete") {
        return createMockResponse(200, { status: "VALIDATING" });
      }
      if (url === "/api/uploads/asset-123/validate") {
        return createMockResponse(200, { status: "VALIDATING" });
      }
      return createMockResponse(500, {});
    };

    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: "asset-123",
      sessionUri: "https://www.googleapis.com/session-url",
      recoveryKey: "key-123",
      maxRetries: 1,
      retryBackoffMs: 1,
      transport,
    });

    await uploader.start();

    // Verify first put range was at 0, and second was at 2621440
    assert(uploadedRanges[0].includes("bytes 0-"), `Expected first range at 0, got: ${uploadedRanges[0]}`);
    assert(uploadedRanges[1].includes("bytes 2621440-"), `Expected second range at 2621440, got: ${uploadedRanges[1]}`);
    uploader.destroy();
    console.log("Test 23 Passed: no duplicate bytes are uploaded [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 23 Failed:", err);
  }

  // 24. Cancel before immediate reconciliation makes zero reconcile requests
  try {
    resetBrowser();
    const file = new FakeUploadFile("video.mp4", 5000000, "video/mp4");
    const transport = new MockTransport();

    transport.responseHandler = async () => {
      await uploader.cancel();
      throw createTransportResponse(0, "");
    };

    let reconcileCalled = false;
    fetchHandler = async (url) => {
      if (url === "/api/uploads/asset-123") {
        return createMockResponse(200, { status: "UPLOADING" });
      }
      if (url === "/api/uploads/asset-123/reconcile") {
        reconcileCalled = true;
        return createMockResponse(200, { status: "VALIDATING" });
      }
      if (url === "/api/uploads/asset-123/abort") {
        return createMockResponse(200, { status: "ABORTED" });
      }
      return createMockResponse(500, {});
    };

    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: "asset-123",
      sessionUri: "https://www.googleapis.com/session-url",
      recoveryKey: "key-123",
      maxRetries: 0,
      transport,
    });

    await uploader.start();

    assert(!reconcileCalled, "Cancel should prevent reconciliation");
    assert(uploader.getStatus().state === "aborted", "State should be aborted");
    uploader.destroy();
    console.log("Test 24 Passed: Cancel before immediate reconciliation makes zero reconcile requests [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 24 Failed:", err);
  }

  // 25. Pause during reconciliation does not emit failed
  try {
    resetBrowser();
    const file = new FakeUploadFile("video.mp4", 5000000, "video/mp4");
    const transport = new MockTransport();

    transport.responseHandler = async () => {
      throw createTransportResponse(0, "");
    };

    let reconcilePromiseResolve: (() => void) | null = null;
    let reconcileCalled = false;
    fetchHandler = async (url) => {
      if (url === "/api/uploads/asset-123") {
        return createMockResponse(200, { status: "UPLOADING" });
      }
      if (url === "/api/uploads/asset-123/reconcile") {
        reconcileCalled = true;
        return new Promise<Response>((resolve) => {
          reconcilePromiseResolve = () => {
            resolve(createMockResponse(200, { status: "VALIDATING" }));
          };
        });
      }
      return createMockResponse(500, {});
    };

    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: "asset-123",
      sessionUri: "https://www.googleapis.com/session-url",
      recoveryKey: "key-123",
      maxRetries: 0,
      transport,
    });

    let threw = false;
    const startPromise = uploader.start().catch(() => { threw = true; });

    await new Promise((resolve) => setTimeout(resolve, 20));
    uploader.pause();

    if (reconcilePromiseResolve) {
      (reconcilePromiseResolve as () => void)();
    }
    await startPromise;

    assert(reconcileCalled, "Reconciliation must have been triggered");
    assert(uploader.getStatus().state === "paused", "State should be paused");
    assert(!threw, "Should not fail or throw when paused during reconciliation");
    uploader.destroy();
    console.log("Test 25 Passed: Pause during reconciliation does not emit failed [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 25 Failed:", err);
  }

  // 26. Cancel during reconciliation does not emit failed
  try {
    resetBrowser();
    const file = new FakeUploadFile("video.mp4", 5000000, "video/mp4");
    const transport = new MockTransport();

    transport.responseHandler = async () => {
      throw createTransportResponse(0, "");
    };

    let reconcilePromiseResolve: (() => void) | null = null;
    let reconcileCalled = false;
    fetchHandler = async (url) => {
      if (url === "/api/uploads/asset-123") {
        return createMockResponse(200, { status: "UPLOADING" });
      }
      if (url === "/api/uploads/asset-123/reconcile") {
        reconcileCalled = true;
        return new Promise<Response>((resolve) => {
          reconcilePromiseResolve = () => {
            resolve(createMockResponse(200, { status: "VALIDATING" }));
          };
        });
      }
      if (url === "/api/uploads/asset-123/abort") {
        return createMockResponse(200, { status: "ABORTED" });
      }
      return createMockResponse(500, {});
    };

    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: "asset-123",
      sessionUri: "https://www.googleapis.com/session-url",
      recoveryKey: "key-123",
      maxRetries: 0,
      transport,
    });

    let threw = false;
    const startPromise = uploader.start().catch(() => { threw = true; });

    await new Promise((resolve) => setTimeout(resolve, 20));
    await uploader.cancel();

    if (reconcilePromiseResolve) {
      (reconcilePromiseResolve as () => void)();
    }
    await startPromise;

    assert(reconcileCalled, "Reconciliation must have been triggered");
    assert(uploader.getStatus().state === "aborted", "State should be aborted");
    assert(!threw, "Should not fail or throw when cancelled during reconciliation");
    uploader.destroy();
    console.log("Test 26 Passed: Cancel during reconciliation does not emit failed [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 26 Failed:", err);
  }

  // 27. Cancel still calls the abort endpoint
  try {
    resetBrowser();
    const file = new FakeUploadFile("video.mp4", 5000000, "video/mp4");
    const transport = new MockTransport();

    transport.responseHandler = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return createTransportResponse(200, JSON.stringify({ id: "drive-id" }));
    };

    let abortCalled = false;
    fetchHandler = async (url) => {
      if (url === "/api/uploads/asset-123/abort") {
        abortCalled = true;
        return createMockResponse(200, { status: "ABORTED" });
      }
      return createMockResponse(500, {});
    };

    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: "asset-123",
      sessionUri: "https://www.googleapis.com/session-url",
      recoveryKey: "key-123",
      transport,
    });

    uploader.start().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 10));

    await uploader.cancel();
    assert(abortCalled, "Abort API should be called on cancel");
    uploader.destroy();
    console.log("Test 27 Passed: Cancel still calls the abort endpoint [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 27 Failed:", err);
  }

  // 28. TRUE CONCURRENT VALIDATION TEST
  try {
    resetMockDb();
    mockAssets.push(makeAsset({
      status: UploadStatus.VALIDATING,
      validationAttemptCount: 0,
      validationMaxAttempts: 3,
      expectedSize: BigInt(9),
      actualSize: BigInt(9),
    }));
    mockConnections.push(makeConnection());

    fetchHandler = async (url) => {
      if (url.includes("oauth2.googleapis.com/token")) {
        return createMockResponse(200, { access_token: "mock-access-token" });
      }
      if (url.includes("drive/v3/files/drive-file-123") && !url.includes("alt=media")) {
        return createMockResponse(200, {
          id: "drive-file-123",
          name: "video.mp4",
          mimeType: "video/mp4",
          size: 10485760,
          parents: ["folder-456"],
          trashed: false,
          appProperties: { assetId: "asset-123" },
        });
      }
      if (url.includes("drive/v3/files/drive-file-123") && url.includes("alt=media")) {
        return new Response("fake-stream-data");
      }
      return createMockResponse(500, {});
    };

    const [res1, res2] = await Promise.all([
      VideoValidationService.validateAssetById("user-123", "asset-123", { prepareValidationSource: mockPrepareValidationSource }),
      VideoValidationService.validateAssetById("user-123", "asset-123", { prepareValidationSource: mockPrepareValidationSource }),
    ]);

    const oneSuccess = (res1.success && res2.status === UploadStatus.VALIDATING) || (res2.success && res1.status === UploadStatus.VALIDATING);
    assert(oneSuccess, "Only one call must acquire the lock and succeed, the other returns VALIDATING/busy");

    const updated = mockAssets[0];
    assert(updated.validationAttemptCount === 1, `Expected validationAttemptCount to be 1, got ${updated.validationAttemptCount}`);

    console.log("Test 28 Passed: true concurrent validation test [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 28 Failed:", err);
  }

  // 29. Real automatic validation endpoint returns sanitized persisted video metadata
  try {
    resetMockDb();
    mockAssets.push(makeAsset({
      status: UploadStatus.VALIDATING,
      expectedSize: BigInt(9),
      actualSize: BigInt(9),
      durationMs: null,
      width: null,
      height: null,
    }));
    mockConnections.push(makeConnection());

    fetchHandler = async (url) => {
      if (url.includes("oauth2.googleapis.com/token")) {
        return createMockResponse(200, { access_token: "mock-access-token" });
      }
      if (url.includes("drive/v3/files/drive-file-123") && !url.includes("alt=media")) {
        return createMockResponse(200, {
          id: "drive-file-123",
          name: "video.mp4",
          mimeType: "video/mp4",
          size: 10485760,
          parents: ["folder-456"],
          trashed: false,
          appProperties: { assetId: "asset-123" },
        });
      }
      if (url.includes("drive/v3/files/drive-file-123") && url.includes("alt=media")) {
        return new Response("fake-stream-data");
      }
      return createMockResponse(500, {});
    };

    const req = new NextRequest("http://localhost/api/uploads/asset-123/validate", {
      method: "POST",
      headers: {
        Authorization: "Bearer valid-token",
        Host: "localhost",
        Origin: "http://localhost",
      }
    });

    const res = await handleValidateUploadRequest(
      req,
      { id: "asset-123" },
      {
        verifyAdminSession: mockVerifyAdminSession,
        prepareValidationSource: mockPrepareValidationSource,
        validateAssetById: async (userId, assetId, deps) => {
          return await VideoValidationService.validateAssetById(userId, assetId, deps);
        }
      }
    );

    assert(res.status === 200, "Should succeed with HTTP 200");
    const body: Record<string, unknown> = await res.json();
    
    assert(body.status === UploadStatus.VALIDATED, "Status must be VALIDATED");
    assert(body.durationMs === 5000, `Expected durationMs 5000, got ${body.durationMs}`);
    assert(body.width === 1920, `Expected width 1920, got ${body.width}`);
    assert(body.height === 1080, `Expected height 1080, got ${body.height}`);
    assert(body.frameRate === 30, `Expected frameRate 30, got ${body.frameRate}`);
    assert(body.videoCodec === "h264", `Expected videoCodec h264, got ${body.videoCodec}`);
    assert(body.audioCodec === "aac", `Expected audioCodec aac, got ${body.audioCodec}`);
    assert(body.containerFormat === "mp4", `Expected containerFormat mp4, got ${body.containerFormat}`);
    assert(body.detectedMimeType === "video/mp4", `Expected detectedMimeType video/mp4, got ${body.detectedMimeType}`);

    assert(!("objectKey" in body), "Should not expose objectKey");
    assert(!("bucket" in body), "Should not expose bucket");
    assert(!("validationLockToken" in body), "Should not expose validationLockToken");

    const req2 = new NextRequest("http://localhost/api/uploads/asset-123/validate", {
      method: "POST",
      headers: {
        Authorization: "Bearer valid-token",
        Host: "localhost",
        Origin: "http://localhost",
      }
    });
    const res2 = await handleValidateUploadRequest(
      req2,
      { id: "asset-123" },
      {
        verifyAdminSession: mockVerifyAdminSession,
        prepareValidationSource: mockPrepareValidationSource,
        validateAssetById: async (userId, assetId, deps) => {
          return await VideoValidationService.validateAssetById(userId, assetId, deps);
        }
      }
    );
    assert(res2.status === 200, "Should succeed with HTTP 200 on second try");
    const body2: Record<string, unknown> = await res2.json();
    assert(body2.status === UploadStatus.VALIDATED, "Should still be VALIDATED");
    assert(body2.durationMs === 5000, "Should return correct persisted durationMs");

    console.log("Test 29 Passed: real automatic validation endpoint returns metadata [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 29 Failed:", err);
  }

  // 30. Immediate zero-progress reconciliation followed by final completed opaque response
  try {
    resetBrowser();
    const file = new FakeUploadFile("video.mp4", 5000000, "video/mp4");
    const transport = new MockTransport();

    let reconcileCalls = 0;
    transport.responseHandler = async () => {
      throw createTransportResponse(0, "");
    };

    fetchHandler = async (url) => {
      if (url === "/api/uploads/asset-123") {
        if (reconcileCalls === 2) {
          return createMockResponse(200, {
            status: "VALIDATED",
            durationMs: 5000,
            width: 1920,
            height: 1080,
            frameRate: 30,
            videoCodec: "h264",
            audioCodec: "aac",
            containerFormat: "mp4",
            detectedMimeType: "video/mp4",
          });
        }
        return createMockResponse(200, { status: "UPLOADING" });
      }
      if (url === "/api/uploads/asset-123/reconcile") {
        reconcileCalls++;
        if (reconcileCalls === 1) {
          return createMockResponse(200, { status: "UPLOADING", confirmedBytes: 0 });
        }
        return createMockResponse(200, { status: "VALIDATED" });
      }
      return createMockResponse(500, {});
    };

    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: "asset-123",
      sessionUri: "https://www.googleapis.com/session-url",
      recoveryKey: "key-123",
      maxRetries: 2,
      retryBackoffMs: 1,
      transport,
    });

    await uploader.start();

    assert(reconcileCalls === 2, `Expected exactly 2 reconcile calls (1 immediate + 1 terminal), got ${reconcileCalls}`);
    assert(uploader.getStatus().state === "validated", "Upload state should be validated");
    uploader.destroy();
    console.log("Test 30 Passed: immediate zero-progress followed by terminal reconciliation [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 30 Failed:", err instanceof Error ? err.stack : err);
  }

  // 31. Temporary immediate reconciliation failure followed by final completed opaque response
  try {
    resetBrowser();
    const file = new FakeUploadFile("video.mp4", 5000000, "video/mp4");
    const transport = new MockTransport();

    let reconcileCalls = 0;
    transport.responseHandler = async () => {
      throw createTransportResponse(0, "");
    };

    fetchHandler = async (url) => {
      if (url === "/api/uploads/asset-123") {
        if (reconcileCalls === 2) {
          return createMockResponse(200, {
            status: "VALIDATED",
            durationMs: 5000,
            width: 1920,
            height: 1080,
            frameRate: 30,
            videoCodec: "h264",
            audioCodec: "aac",
            containerFormat: "mp4",
            detectedMimeType: "video/mp4",
          });
        }
        return createMockResponse(200, { status: "UPLOADING" });
      }
      if (url === "/api/uploads/asset-123/reconcile") {
        reconcileCalls++;
        if (reconcileCalls === 1) {
          return createMockResponse(500, {});
        }
        return createMockResponse(200, { status: "VALIDATED" });
      }
      return createMockResponse(500, {});
    };

    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: "asset-123",
      sessionUri: "https://www.googleapis.com/session-url",
      recoveryKey: "key-123",
      maxRetries: 2,
      retryBackoffMs: 1,
      transport,
    });

    await uploader.start();

    assert(reconcileCalls === 2, `Expected exactly 2 reconcile calls (1 failed immediate + 1 terminal), got ${reconcileCalls}`);
    assert(uploader.getStatus().state === "validated", "Upload state should be validated");
    uploader.destroy();
    console.log("Test 31 Passed: temporary immediate failure followed by terminal reconciliation [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 31 Failed:", err instanceof Error ? err.stack : err);
  }

  // 32. Exactly bounded reconciliation call counts
  try {
    resetBrowser();
    const file = new FakeUploadFile("video.mp4", 5000000, "video/mp4");
    const transport = new MockTransport();

    let reconcileCalls = 0;
    transport.responseHandler = async () => {
      throw createTransportResponse(0, "");
    };

    fetchHandler = async (url) => {
      if (url === "/api/uploads/asset-123") {
        return createMockResponse(200, { status: "UPLOADING" });
      }
      if (url === "/api/uploads/asset-123/reconcile") {
        reconcileCalls++;
        return createMockResponse(200, { status: "UPLOADING", confirmedBytes: 0 });
      }
      return createMockResponse(500, {});
    };

    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: "asset-123",
      sessionUri: "https://www.googleapis.com/session-url",
      recoveryKey: "key-123",
      maxRetries: 2,
      retryBackoffMs: 1,
      transport,
    });

    let threw = false;
    try {
      await uploader.start();
    } catch {
      threw = true;
    }

    assert(threw, "Uploader should eventually throw retry exhausted");
    assert(reconcileCalls === 2, `Expected exactly 2 reconcile calls, got ${reconcileCalls}`);
    uploader.destroy();
    console.log("Test 32 Passed: exactly bounded reconciliation call counts [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 32 Failed:", err);
  }

  // 33. Server-log sanitization check
  try {
    resetMockDb();
    mockAssets.push(makeAsset({ status: UploadStatus.VALIDATING, expectedSize: BigInt(9), actualSize: BigInt(9) }));
    mockConnections.push(makeConnection());

    const apiErrorsMod = await import("../src/lib/storage/upload-api-errors");
    const testHandleUploadApiError = apiErrorsMod.handleUploadApiError;

    const capturedLogs: string[] = [];
    const originalConsoleError = console.error;
    const originalConsoleWarn = console.warn;
    console.error = (...args: unknown[]) => {
      capturedLogs.push(args.map(arg => typeof arg === "object" ? JSON.stringify(arg) : String(arg)).join(" "));
    };
    console.warn = (...args: unknown[]) => {
      capturedLogs.push(args.map(arg => typeof arg === "object" ? JSON.stringify(arg) : String(arg)).join(" "));
    };

    try {
      const secretSessionUri = "https://www.googleapis.com/upload/drive/v3/files/session-token-123456";
      const driveFileId = "drive-file-123";
      
      // 1. Run validation with transient failure containing secrets
      await VideoValidationService.validateAssetById(
        "user-123",
        "asset-123",
        {
          prepareValidationSource: async () => {
            throw new Error(`Connection timed out on ${secretSessionUri} with ${driveFileId}`);
          }
        }
      );

      // 2. Run handleUploadApiError with a raw error containing secrets and Windows paths
      const rawError = new Error(`Database connection failed at C:\\Users\\HP\\project\\node_modules\\some-file.ts\nat VideoValidationService`);
      testHandleUploadApiError(rawError);

    } finally {
      console.error = originalConsoleError;
      console.warn = originalConsoleWarn;
    }

    // Verify logs
    for (const log of capturedLogs) {
      assert(!log.includes("session-token-123456"), `Log contains leaked session token: ${log}`);
      assert(!log.includes("www.googleapis.com/upload"), `Log contains leaked Google upload hostname: ${log}`);
      assert(!log.includes("drive-file-123"), `Log contains leaked Drive file ID: ${log}`);
      assert(!log.includes("C:\\Users\\"), `Log contains leaked Windows path: ${log}`);
      assert(!log.includes("at VideoValidationService"), `Log contains leaked stack trace frame: ${log}`);
    }

    console.log("Test 33 Passed: server-log sanitization verified [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 33 Failed:", err);
  }

  // -------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------
  console.log(`\nGoogle Drive Validation and Reconciliation complete. Passed: ${passedCount}/33`);

  if (passedCount !== 33) {
    console.error("ERROR: Not all validation tests passed.");
    process.exit(1);
  } else {
    console.log("SUCCESS: All upload reconciliation and automatic validation constraints verified.");
    process.exit(0);
  }
}

runTests().catch((err: unknown) => {
  const errorMsg = err instanceof Error ? err.message : String(err);
  console.error("Fatal error in validation reconciliation test suite:", errorMsg);
  process.exit(1);
});
