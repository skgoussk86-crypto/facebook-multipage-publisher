import { UploadAsset, UploadStatus } from "@prisma/client";
import { GoogleDriveUploadReconciliationService, DbClient, GDReconciliationDependencies } from "../src/lib/google-drive/google-drive-upload-reconciliation-service";
import { handleReconcileUpload, POST } from "../src/app/api/uploads/[id]/reconcile/route";
import { ExpiredSessionError } from "../src/lib/storage/upload-session-encryption";
import {
  GoogleDriveResumableUploader,
  GoogleUploadTransport,
  GoogleUploadTransportRequest,
  GoogleUploadTransportResponse
} from '../src/lib/uploads/google-drive-resumable-uploader';
import { UploadFileLike } from '../src/lib/uploads/upload-types';
import { BrowserMultipartUploader } from '../src/lib/uploads/browser-multipart-uploader';
import { NextRequest } from "next/server";

// -------------------------------------------------------------
// Assert Helper
// -------------------------------------------------------------
function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// -------------------------------------------------------------
// Mock Database
// -------------------------------------------------------------
let mockAssets: UploadAsset[] = [];

function resetMockDb() {
  mockAssets = [];
}

const mockDb: DbClient = {
  uploadAsset: {
    findUnique: async (args) => mockAssets.find(a => a.id === args.where.id) || null,
  },
};


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
    actualSize: null,
    declaredMimeType: "video/mp4",
    detectedMimeType: null,
    checksum: null,
    objectETag: null,
    status: UploadStatus.UPLOADING,
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
  return { ...defaults, ...overrides };
}

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
      const err = new DOMException('The user aborted a request.', 'AbortError');
      throw err;
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

// -------------------------------------------------------------
// Test Suite Runner
// -------------------------------------------------------------
async function runTests() {
  console.log("Running Google Drive Upload Reconciliation Integration Tests...\n");
  let passedCount = 0;

  const validUserId = "user-123";
  const validAssetId = "asset-123";
  const validSessionUri = "https://www.googleapis.com/upload/drive/v3/files/session-123";

  const getDecryptedSessionMock = async (userId: string, assetId: string) => {
    assert(userId === validUserId, "getDecryptedSession: userId matches");
    assert(assetId === validAssetId, "getDecryptedSession: assetId matches");
    return { providerSessionId: validSessionUri };
  };

  const defaultDeps: GDReconciliationDependencies = {
    db: mockDb,
    getDecryptedSession: getDecryptedSessionMock,
  };

  // -------------------------------------------------------------
  // Isolated Server Reconciliation Service and API Route Tests
  // -------------------------------------------------------------

  // Test 1: unauthenticated access rejected
  try {
    resetMockDb();
    const req = new NextRequest("http://localhost/api/uploads/asset-123/reconcile", { method: "POST" });
    const response = await POST(req, { params: Promise.resolve({ id: "asset-123" }) });
    assert(response.status === 401, `Expected 401, got ${response.status}`);
    const data = await response.json();
    assert(data.error === "UNAUTHENTICATED", "Should return UNAUTHENTICATED error");
    console.log("Test 1 Passed: unauthenticated access rejected [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 1 Failed:", err);
  }

  // Test 2: wrong-owner access rejected
  try {
    resetMockDb();
    mockAssets.push(makeAsset({ userId: "different-user" }));
    const response = await handleReconcileUpload(validUserId, "asset-123", {
      reconcileUpload: (uid, aid) => GoogleDriveUploadReconciliationService.reconcileUpload(uid, aid, defaultDeps)
    });
    assert(response.status === 404, `Expected 404, got ${response.status}`);
    const data = await response.json();
    assert(data.error === "UPLOAD_NOT_FOUND", "Should return UPLOAD_NOT_FOUND");
    console.log("Test 2 Passed: wrong-owner access rejected [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 2 Failed:", err);
  }

  // Test 3: non-Google asset returns the new stable safe API response
  try {
    resetMockDb();
    mockAssets.push(makeAsset({ provider: "R2" }));
    const response = await handleReconcileUpload(validUserId, "asset-123", {
      reconcileUpload: (uid, aid) => GoogleDriveUploadReconciliationService.reconcileUpload(uid, aid, defaultDeps)
    });
    assert(response.status === 400, `Expected 400, got ${response.status}`);
    const data = await response.json();
    assert(data.error === "INVALID_PROVIDER", "Should return INVALID_PROVIDER");
    console.log("Test 3 Passed: non-Google asset returns the new stable safe API response [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 3 Failed:", err);
  }

  // Test 4: VALIDATING is idempotent success
  try {
    resetMockDb();
    mockAssets.push(makeAsset({ status: UploadStatus.VALIDATING }));
    let sessionLookupCalled = false;
    let fetchCalled = false;

    const result = await GoogleDriveUploadReconciliationService.reconcileUpload(validUserId, "asset-123", {
      db: mockDb,
      getDecryptedSession: async () => { sessionLookupCalled = true; return { providerSessionId: "" }; },
      fetchImpl: async () => { fetchCalled = true; return new Response(); }
    });

    assert(result.reconciled === true, "Should return reconciled true");
    assert(result.status === "VALIDATING", "Should return status VALIDATING");
    assert(!sessionLookupCalled, "Should not look up session");
    assert(!fetchCalled, "Should not call Google");
    console.log("Test 4 Passed: VALIDATING is idempotent success [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 4 Failed:", err);
  }

  // Test 5: VALIDATED is idempotent success
  try {
    resetMockDb();
    mockAssets.push(makeAsset({ status: UploadStatus.VALIDATED }));
    let sessionLookupCalled = false;
    let fetchCalled = false;

    const result = await GoogleDriveUploadReconciliationService.reconcileUpload(validUserId, "asset-123", {
      db: mockDb,
      getDecryptedSession: async () => { sessionLookupCalled = true; return { providerSessionId: "" }; },
      fetchImpl: async () => { fetchCalled = true; return new Response(); }
    });

    assert(result.reconciled === true, "Should return reconciled true");
    assert(result.status === "VALIDATED", "Should return status VALIDATED");
    assert(!sessionLookupCalled, "Should not look up session");
    assert(!fetchCalled, "Should not call Google");
    console.log("Test 5 Passed: VALIDATED is idempotent success [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 5 Failed:", err);
  }

  // Test 6: completed Google HTTP 200 reconciles through the existing completion service
  try {
    resetMockDb();
    mockAssets.push(makeAsset({ status: UploadStatus.UPLOADING }));
    
    let completeUploadCalled = false;
    let completeBody: unknown = null;

    const fetchMock = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = input.toString();
      assert(url === validSessionUri, "PUT requests the sessionUri");
      assert(init?.method === "PUT", "PUT method should be PUT");
      return new Response(JSON.stringify({ id: "drive-file-reconciled-200" }), { status: 200 });
    };

    const completeMock = async (uid: string, aid: string, body: unknown) => {
      completeUploadCalled = true;
      completeBody = body;
      return {
        assetId: aid,
        provider: "GOOGLE_DRIVE" as const,
        filename: "video.mp4",
        expectedSize: "10485760",
        actualSize: "10485760",
        status: UploadStatus.VALIDATING,
      };
    };

    const result = await GoogleDriveUploadReconciliationService.reconcileUpload(validUserId, "asset-123", {
      ...defaultDeps,
      fetchImpl: fetchMock,
      completeUpload: completeMock,
    });

    assert(result.reconciled === true, "Should be reconciled");
    assert(result.status === "VALIDATING", "Should have VALIDATING status");
    assert(completeUploadCalled, "existing completion service should be called");
    assert(Boolean(completeBody) && typeof completeBody === "object" && (completeBody as Record<string, unknown>).driveFileId === "drive-file-reconciled-200", "Drive file ID passed correctly");
    console.log("Test 6 Passed: completed Google HTTP 200 reconciles through completion service [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 6 Failed:", err);
  }

  // Test 7: completed Google HTTP 201 reconciles
  try {
    resetMockDb();
    mockAssets.push(makeAsset({ status: UploadStatus.UPLOADING }));

    let completeUploadCalled = false;
    const fetchMock = async () => {
      return new Response(JSON.stringify({ id: "drive-file-reconciled-201" }), { status: 201 });
    };
    const completeMock = async () => {
      completeUploadCalled = true;
      return {
        assetId: "asset-123",
        provider: "GOOGLE_DRIVE" as const,
        filename: "video.mp4",
        expectedSize: "10485760",
        actualSize: "10485760",
        status: UploadStatus.VALIDATING,
      };
    };

    const result = await GoogleDriveUploadReconciliationService.reconcileUpload(validUserId, "asset-123", {
      ...defaultDeps,
      fetchImpl: fetchMock,
      completeUpload: completeMock,
    });

    assert(result.reconciled === true, "Should be reconciled");
    assert(result.status === "VALIDATING", "Status VALIDATING");
    assert(completeUploadCalled, "completeUpload was called");
    console.log("Test 7 Passed: completed Google HTTP 201 reconciles [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 7 Failed:", err);
  }

  // Test 8: HTTP 308 with missing Range header returns zero confirmed bytes
  try {
    resetMockDb();
    mockAssets.push(makeAsset({ status: UploadStatus.UPLOADING }));

    const fetchMock = async () => {
      return new Response(null, { status: 308 });
    };

    const result = await GoogleDriveUploadReconciliationService.reconcileUpload(validUserId, "asset-123", {
      ...defaultDeps,
      fetchImpl: fetchMock,
    });

    assert(result.reconciled === false, "Not reconciled");
    assert(result.status === "UPLOADING", "Status UPLOADING");
    assert(result.confirmedBytes === 0, `Expected 0 confirmedBytes, got ${result.confirmedBytes}`);
    console.log("Test 8 Passed: HTTP 308 with missing Range header returns zero confirmed bytes [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 8 Failed:", err);
  }

  // Test 9: HTTP 308 with valid Range returns N + 1
  try {
    resetMockDb();
    mockAssets.push(makeAsset({ status: UploadStatus.UPLOADING }));

    const fetchMock = async () => {
      const headers = new Headers();
      headers.set("Range", "bytes=0-5242879");
      return new Response(null, { status: 308, headers });
    };

    const result = await GoogleDriveUploadReconciliationService.reconcileUpload(validUserId, "asset-123", {
      ...defaultDeps,
      fetchImpl: fetchMock,
    });

    assert(result.reconciled === false, "Not reconciled");
    assert(result.status === "UPLOADING", "Status UPLOADING");
    assert(result.confirmedBytes === 5242880, `Expected 5242880 confirmedBytes, got ${result.confirmedBytes}`);
    console.log("Test 9 Passed: HTTP 308 with valid Range returns N + 1 [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 9 Failed:", err);
  }

  // Test 10: malformed 308 Range is rejected
  try {
    resetMockDb();
    mockAssets.push(makeAsset({ status: UploadStatus.UPLOADING }));

    const fetchMock = async () => {
      const headers = new Headers();
      headers.set("Range", "bytes=1-5242879");
      return new Response(null, { status: 308, headers });
    };

    let failed = false;
    try {
      await GoogleDriveUploadReconciliationService.reconcileUpload(validUserId, "asset-123", {
        ...defaultDeps,
        fetchImpl: fetchMock,
      });
    } catch (err) {
      failed = true;
      assert(err instanceof Error && err.message === "GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE", "Should throw invalid response error");
    }
    assert(failed, "Malformed Range should fail");
    console.log("Test 10 Passed: malformed 308 Range is rejected [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 10 Failed:", err);
  }

  // Test 11: out-of-bounds 308 Range is rejected
  try {
    resetMockDb();
    mockAssets.push(makeAsset({ status: UploadStatus.UPLOADING }));

    const fetchMock = async () => {
      const headers = new Headers();
      headers.set("Range", "bytes=0-10485760");
      return new Response(null, { status: 308, headers });
    };

    let failed = false;
    try {
      await GoogleDriveUploadReconciliationService.reconcileUpload(validUserId, "asset-123", {
        ...defaultDeps,
        fetchImpl: fetchMock,
      });
    } catch (err) {
      failed = true;
      assert(err instanceof Error && err.message === "GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE", "Should throw invalid response error");
    }
    assert(failed, "Out of bounds Range should fail");
    console.log("Test 11 Passed: out-of-bounds 308 Range is rejected [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 11 Failed:", err);
  }

  // Test 12: Google 404 expires safely
  try {
    resetMockDb();
    mockAssets.push(makeAsset({ status: UploadStatus.UPLOADING }));

    const fetchMock = async () => new Response(null, { status: 404 });

    let failed = false;
    try {
      await GoogleDriveUploadReconciliationService.reconcileUpload(validUserId, "asset-123", {
        ...defaultDeps,
        fetchImpl: fetchMock,
      });
    } catch (err) {
      failed = true;
      assert(err instanceof ExpiredSessionError, "Should throw ExpiredSessionError");
    }
    assert(failed, "404 should trigger throw");
    console.log("Test 12 Passed: Google 404 expires safely [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 12 Failed:", err);
  }

  // Test 13: Google 410 expires safely
  try {
    resetMockDb();
    mockAssets.push(makeAsset({ status: UploadStatus.UPLOADING }));

    const fetchMock = async () => new Response(null, { status: 410 });

    let failed = false;
    try {
      await GoogleDriveUploadReconciliationService.reconcileUpload(validUserId, "asset-123", {
        ...defaultDeps,
        fetchImpl: fetchMock,
      });
    } catch (err) {
      failed = true;
      assert(err instanceof ExpiredSessionError, "Should throw ExpiredSessionError");
    }
    assert(failed, "410 should trigger throw");
    console.log("Test 13 Passed: Google 410 expires safely [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 13 Failed:", err);
  }

  // Test 14: other 4xx uses safe restart-required behavior
  try {
    resetMockDb();
    mockAssets.push(makeAsset({ status: UploadStatus.UPLOADING }));

    const fetchMock = async () => new Response(null, { status: 400 });

    let failed = false;
    try {
      await GoogleDriveUploadReconciliationService.reconcileUpload(validUserId, "asset-123", {
        ...defaultDeps,
        fetchImpl: fetchMock,
      });
    } catch (err) {
      failed = true;
      assert(err instanceof Error && err.message === "UPLOAD_SESSION_RESTART_REQUIRED", "Should throw UPLOAD_SESSION_RESTART_REQUIRED");
    }
    assert(failed, "400 should trigger throw");
    console.log("Test 14 Passed: other 4xx uses safe restart-required behavior [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 14 Failed:", err);
  }

  // Test 15: HTTP 503 is sanitized to GOOGLE_DRIVE_UPLOAD_FAILED
  try {
    resetMockDb();
    mockAssets.push(makeAsset({ status: UploadStatus.UPLOADING }));

    const fetchMock = async () => new Response(null, { status: 503 });

    let failed = false;
    try {
      await GoogleDriveUploadReconciliationService.reconcileUpload(validUserId, "asset-123", {
        ...defaultDeps,
        fetchImpl: fetchMock,
      });
    } catch (err) {
      failed = true;
      assert(err instanceof Error && err.message === "GOOGLE_DRIVE_UPLOAD_FAILED", "Should throw GOOGLE_DRIVE_UPLOAD_FAILED");
    }
    assert(failed, "503 should trigger throw");
    console.log("Test 15 Passed: HTTP 503 is sanitized [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 15 Failed:", err);
  }

  // Test 16: a thrown network exception is sanitized
  try {
    resetMockDb();
    mockAssets.push(makeAsset({ status: UploadStatus.UPLOADING }));

    const fetchMock = async () => {
      throw new Error("Network connection lost");
    };

    let failed = false;
    try {
      await GoogleDriveUploadReconciliationService.reconcileUpload(validUserId, "asset-123", {
        ...defaultDeps,
        fetchImpl: fetchMock,
      });
    } catch (err) {
      failed = true;
      assert(err instanceof Error && err.message === "GOOGLE_DRIVE_UPLOAD_FAILED", "Should throw GOOGLE_DRIVE_UPLOAD_FAILED");
    }
    assert(failed, "Network throw should trigger throw");
    console.log("Test 16 Passed: thrown network exception is sanitized [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 16 Failed:", err);
  }

  // Test 17: malformed final Drive file ID is rejected
  try {
    resetMockDb();
    mockAssets.push(makeAsset({ status: UploadStatus.UPLOADING }));

    const malformedBodies = [
      { id: "" },
      { id: "a".repeat(129) },
      { id: "invalid@chars" },
      {},
      "not-json"
    ];

    for (const malformed of malformedBodies) {
      const fetchMock = async () => new Response(typeof malformed === "string" ? malformed : JSON.stringify(malformed), { status: 200 });

      let failed = false;
      try {
        await GoogleDriveUploadReconciliationService.reconcileUpload(validUserId, "asset-123", {
          ...defaultDeps,
          fetchImpl: fetchMock,
        });
      } catch (err) {
        failed = true;
        const msg = err instanceof Error ? err.message : String(err);
        assert(err instanceof Error && msg === "GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE", `Expected GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE, got: ${msg}`);
      }
      assert(failed, "Malformed Drive ID should trigger throw");
    }
    console.log("Test 17 Passed: malformed final Drive file ID is rejected [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 17 Failed:", err);
  }

  // Test 18: session URI, refresh token, access token, Drive response body, and encrypted values never leak
  try {
    resetMockDb();
    mockAssets.push(makeAsset({ status: UploadStatus.UPLOADING }));
    
    const secretSessionUri = "https://www.googleapis.com/upload/drive/v3/files/super-secret-token-123456";
    const fetchMock = async () => new Response(JSON.stringify({ error: "secret leak test body" }), { status: 500 });
    
    try {
      await GoogleDriveUploadReconciliationService.reconcileUpload(validUserId, "asset-123", {
        db: mockDb,
        getDecryptedSession: async () => ({ providerSessionId: secretSessionUri }),
        fetchImpl: fetchMock,
      });
    } catch (err: unknown) {
      const trace = err instanceof Error ? err.stack || err.message : String(err);
      assert(!trace.includes(secretSessionUri), "Leaked session URI in error");
      assert(!trace.includes("super-secret-token"), "Leaked credentials in error");
      assert(!trace.includes("secret leak test body"), "Leaked response body in error");
    }
    console.log("Test 18 Passed: session URI and private details never leak [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 18 Failed:", err);
  }


  // -------------------------------------------------------------
  // Extended Browser Uploader Recovery Tests
  // -------------------------------------------------------------

  // Helper to reset browser environment
  function resetBrowser() {
    fetchRequests.length = 0;
    mockLocalStorage.clear();
    fetchHandler = () => {
      throw new Error("No fetch handler configured");
    };
  }

  // Test 19: terminal network failure performs exactly one server reconciliation request
  try {
    resetBrowser();
    const file = new FakeUploadFile("video.mp4", 5000000, "video/mp4");
    const transport = new MockTransport();
    
    transport.responseHandler = async () => createTransportResponse(0, "");

    let reconcileCalls = 0;
    fetchHandler = async (url) => {
      if (url === "/api/uploads/asset-123") {
        return createMockResponse(200, { status: "UPLOADING" });
      }
      if (url === "/api/uploads/asset-123/reconcile") {
        reconcileCalls++;
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

    assert(uploader.getStatus().state === "validating", `State should be validating, got ${uploader.getStatus().state}`);
    assert(reconcileCalls === 1, `Expected exactly 1 reconcile call, got ${reconcileCalls}`);
    console.log("Test 19 Passed: terminal network failure performs exactly one server reconciliation [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 19 Failed:", err);
  }

  // Test 20: server VALIDATING starts polling instead of showing failure
  try {
    resetBrowser();
    const file = new FakeUploadFile("video.mp4", 5000000, "video/mp4");
    const transport = new MockTransport();
    
    transport.responseHandler = async () => createTransportResponse(0, "");

    let pollAttempts = 0;
    fetchHandler = async (url) => {
      if (url === "/api/uploads/asset-123") {
        pollAttempts++;
        if (pollAttempts > 1) {
          return createMockResponse(200, { status: "VALIDATED", durationMs: 1000, containerFormat: "mp4" });
        }
        return createMockResponse(200, { status: "UPLOADING" });
      }
      if (url === "/api/uploads/asset-123/reconcile") {
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
      retryBackoffMs: 1,
      transport,
    });

    await uploader.start();

    await new Promise(r => setTimeout(r, 2200));

    assert(uploader.getStatus().state === "validated", `State should be validated, got ${uploader.getStatus().state}`);
    assert(pollAttempts >= 2, `Should poll server status, got attempts: ${pollAttempts}`);
    uploader.destroy();
    console.log("Test 20 Passed: server VALIDATING starts polling instead of showing failure [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 20 Failed:", err);
  }

  // Test 21: server VALIDATED emits validated success and clears recovery storage
  try {
    resetBrowser();
    const file = new FakeUploadFile("video.mp4", 5000000, "video/mp4");
    const transport = new MockTransport();

    transport.responseHandler = async () => createTransportResponse(0, "");

    fetchHandler = async (url) => {
      if (url === "/api/uploads/asset-123") {
        return createMockResponse(200, { status: "VALIDATED", durationMs: 1200 });
      }
      if (url === "/api/uploads/asset-123/reconcile") {
        return createMockResponse(200, { status: "VALIDATED" });
      }
      return createMockResponse(500, {});
    };

    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: "asset-123",
      sessionUri: "https://www.googleapis.com/session-url",
      recoveryKey: "key-123",
      maxRetries: 0,
      retryBackoffMs: 1,
      transport,
    });

    await uploader.start();

    assert(uploader.getStatus().state === "validated", `State should be validated, got ${uploader.getStatus().state}`);
    assert(mockLocalStorage.getItem("upload_recovery_key-123") === null, "Recovery storage should be cleared");
    console.log("Test 21 Passed: server VALIDATED emits success and clears recovery storage [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 21 Failed:", err);
  }

  // Test 22: Retry from server VALIDATED invokes zero Google transport requests
  try {
    resetBrowser();
    const file = new FakeUploadFile("video.mp4", 5000000, "video/mp4");
    const transport = new MockTransport();
    let googleTransportCalled = false;
    transport.responseHandler = async () => {
      googleTransportCalled = true;
      return createTransportResponse(308, "");
    };

    fetchHandler = async (url) => {
      if (url === "/api/uploads/asset-123") {
        return createMockResponse(200, { status: "VALIDATED", durationMs: 1300 });
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

    uploader["state"] = "failed";
    await uploader.retry();

    assert(uploader.getStatus().state === "validated", `State should be validated on retry, got ${uploader.getStatus().state}`);
    assert(!googleTransportCalled, "Google transport should not be called at all");
    console.log("Test 22 Passed: Retry from server VALIDATED invokes zero Google transport requests [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 22 Failed:", err);
  }

  // Test 23: Resume from server VALIDATING invokes zero Google transport requests
  try {
    resetBrowser();
    const file = new FakeUploadFile("video.mp4", 5000000, "video/mp4");
    const transport = new MockTransport();
    let googleTransportCalled = false;
    transport.responseHandler = async () => {
      googleTransportCalled = true;
      return createTransportResponse(308, "");
    };

    fetchHandler = async (url) => {
      if (url === "/api/uploads/asset-123") {
        return createMockResponse(200, { status: "VALIDATING" });
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

    uploader["state"] = "paused";
    await uploader.resume();

    assert(uploader.getStatus().state === "validating", `State should be validating on resume, got ${uploader.getStatus().state}`);
    assert(!googleTransportCalled, "Google transport should not be called at all");
    uploader.destroy();
    console.log("Test 23 Passed: Resume from server VALIDATING invokes zero Google transport requests [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 23 Failed:", err);
  }

  // Test 24: server UPLOADING does not cause an infinite reconciliation loop
  try {
    resetBrowser();
    const file = new FakeUploadFile("video.mp4", 5000000, "video/mp4");
    const transport = new MockTransport();

    transport.responseHandler = async () => createTransportResponse(0, "");

    let reconcileCalls = 0;
    fetchHandler = async (url) => {
      if (url === "/api/uploads/asset-123") {
        return createMockResponse(200, { status: "UPLOADING" });
      }
      if (url === "/api/uploads/asset-123/reconcile") {
        reconcileCalls++;
        return createMockResponse(200, { status: "UPLOADING" });
      }
      return createMockResponse(500, {});
    };

    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: "asset-123",
      sessionUri: "https://www.googleapis.com/session-url",
      recoveryKey: "key-123",
      maxRetries: 0,
      retryBackoffMs: 1,
      transport,
    });

    let threw = false;
    try {
      await uploader.start();
    } catch {
      threw = true;
    }

    assert(threw, "Uploader should throw when reconciliation reports UPLOADING");
    assert(uploader.getStatus().state === "failed", `Uploader state should be failed, got ${uploader.getStatus().state}`);
    assert(reconcileCalls === 1, `Expected exactly 1 reconcile call, got ${reconcileCalls}`);
    console.log("Test 24 Passed: server UPLOADING does not cause infinite loop [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 24 Failed:", err);
  }

  // Test 25: Pause before reconciliation does not trigger reconciliation
  try {
    resetBrowser();
    const file = new FakeUploadFile("video.mp4", 5000000, "video/mp4");
    const transport = new MockTransport();

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

    transport.responseHandler = async () => {
      uploader.pause();
      throw new DOMException("Aborted", "AbortError");
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

    assert(uploader.getStatus().state === "paused", `Uploader state should be paused, got ${uploader.getStatus().state}`);
    assert(!reconcileCalled, "Reconciliation must not be called after user pause");
    console.log("Test 25 Passed: Pause before reconciliation does not trigger reconciliation [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 25 Failed:", err);
  }

  // Test 26: Cancel before reconciliation does not trigger reconciliation
  try {
    resetBrowser();
    const file = new FakeUploadFile("video.mp4", 5000000, "video/mp4");
    const transport = new MockTransport();

    let reconcileCalled = false;
    let abortApiCalled = false;
    fetchHandler = async (url) => {
      if (url === "/api/uploads/asset-123") {
        return createMockResponse(200, { status: "UPLOADING" });
      }
      if (url === "/api/uploads/asset-123/reconcile") {
        reconcileCalled = true;
        return createMockResponse(200, { status: "VALIDATING" });
      }
      if (url === "/api/uploads/asset-123/abort") {
        abortApiCalled = true;
        return createMockResponse(200, { status: "ABORTED" });
      }
      return createMockResponse(500, {});
    };

    transport.responseHandler = async () => {
      uploader.cancel().catch(() => {});
      throw new DOMException("Aborted", "AbortError");
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

    assert(uploader.getStatus().state === "aborted", `Uploader state should be aborted, got ${uploader.getStatus().state}`);
    assert(!reconcileCalled, "Reconciliation must not be called after cancel");
    assert(abortApiCalled, "Server abort API must be called");
    console.log("Test 26 Passed: Cancel before reconciliation does not trigger reconciliation [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 26 Failed:", err);
  }

  // Test 27: Pause during an in-flight reconciliation request does not emit failed or clear recovery storage
  try {
    resetBrowser();
    const file = new FakeUploadFile("video.mp4", 5000000, "video/mp4");
    const transport = new MockTransport();

    transport.responseHandler = async () => {
      throw createTransportResponse(0, "");
    };

    let reconcileCalled = false;
    const resolveHolder = { current: null as (() => void) | null };
    fetchHandler = async (url) => {
      if (url === "/api/uploads/asset-123") {
        return createMockResponse(200, { status: "UPLOADING" });
      }
      if (url === "/api/uploads/asset-123/reconcile") {
        reconcileCalled = true;
        return new Promise<Response>((resolve) => {
          resolveHolder.current = () => {
            resolve(createMockResponse(200, { status: "VALIDATING" }));
          };
        });
      }
      return createMockResponse(500, {});
    };

    mockLocalStorage.setItem("upload_recovery_key-123", JSON.stringify({ assetId: "asset-123" }));

    const uploader = new GoogleDriveResumableUploader({
      file,
      assetId: "asset-123",
      sessionUri: "https://www.googleapis.com/session-url",
      recoveryKey: "key-123",
      maxRetries: 0,
      transport,
    });

    let startPromiseThrew = false;
    const startPromise = uploader.start().catch(() => {
      startPromiseThrew = true;
    });

    await new Promise(r => setTimeout(r, 20));
    assert(reconcileCalled, "Reconciliation request should be in flight");

    uploader.pause();
    
    if (resolveHolder.current) {
      resolveHolder.current();
    }
    
    await startPromise;

    assert(uploader.getStatus().state === "paused", `State should be paused, got ${uploader.getStatus().state}`);
    assert(!startPromiseThrew, "start() should not throw or fail when paused");
    assert(mockLocalStorage.getItem("upload_recovery_key-123") !== null, "Recovery storage should be preserved");
    console.log("Test 27 Passed: Pause during in-flight reconciliation does not emit failed or clear recovery storage [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 27 Failed:", err);
  }

  // Test 28: Cancel during an in-flight reconciliation request does not emit failed
  try {
    resetBrowser();
    const file = new FakeUploadFile("video.mp4", 5000000, "video/mp4");
    const transport = new MockTransport();

    transport.responseHandler = async () => {
      throw createTransportResponse(0, "");
    };

    let reconcileCalled = false;
    const resolveHolder = { current: null as (() => void) | null };
    let abortApiCalled = false;
    fetchHandler = async (url) => {
      if (url === "/api/uploads/asset-123") {
        return createMockResponse(200, { status: "UPLOADING" });
      }
      if (url === "/api/uploads/asset-123/reconcile") {
        reconcileCalled = true;
        return new Promise<Response>((resolve) => {
          resolveHolder.current = () => {
            resolve(createMockResponse(200, { status: "VALIDATING" }));
          };
        });
      }
      if (url === "/api/uploads/asset-123/abort") {
        abortApiCalled = true;
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

    let startPromiseThrew = false;
    const startPromise = uploader.start().catch(() => {
      startPromiseThrew = true;
    });

    await new Promise(r => setTimeout(r, 20));
    assert(reconcileCalled, "Reconciliation request in flight");

    uploader.cancel().catch(() => {});

    if (resolveHolder.current) {
      resolveHolder.current();
    }

    await startPromise;
    await new Promise(r => setTimeout(r, 20));

    assert(uploader.getStatus().state === "aborted", `State should be aborted, got ${uploader.getStatus().state}`);
    assert(!startPromiseThrew, "start() should not throw failed state error when cancelled");
    assert(abortApiCalled, "Abort API called");
    console.log("Test 28 Passed: Cancel during in-flight reconciliation does not emit failed [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 28 Failed:", err);
  }

  // Test 29: fresh upload does not run retry/resume preliminary server GET
  try {
    resetBrowser();
    const events: string[] = [];
    const transport = new MockTransport();

    fetchHandler = async (url) => {
      if (url === "/api/uploads/initiate") {
        events.push("initiate-fetch");
        return createMockResponse(201, {
          provider: "GOOGLE_DRIVE",
          assetId: "gd-asset-id",
          sessionUri: "https://google.mock/session-123",
          filename: "video.mp4",
          mimeType: "video/mp4",
          totalBytes: "5000000",
          idempotentReplay: false,
        });
      }
      if (url === "/api/uploads/gd-asset-id") {
        events.push("preliminary-status-get");
        return createMockResponse(200, { status: "UPLOADING" });
      }
      if (url === "/api/uploads/gd-asset-id/complete") {
        events.push("complete-fetch");
        return createMockResponse(200, { status: "VALIDATING" });
      }
      return createMockResponse(500, {});
    };

    transport.responseHandler = async () => {
      events.push("google-transport");
      return createTransportResponse(200, JSON.stringify({ id: "drive-id-123" }));
    };

    const file = new FakeUploadFile("video.mp4", 5000000, "video/mp4");
    const uploader = new BrowserMultipartUploader({
      file,
      recoveryKey: "test-key-fresh",
      transport,
    });

    await uploader.start();

    assert(events.includes("initiate-fetch"), "initiate-fetch must occur");
    assert(events.includes("google-transport"), "google-transport must occur");

    const initiateIndex = events.indexOf("initiate-fetch");
    const transportIndex = events.indexOf("google-transport");
    const statusIndex = events.indexOf("preliminary-status-get");

    assert(initiateIndex < transportIndex, "initiate-fetch must occur before google-transport");

    if (statusIndex !== -1) {
      assert(statusIndex > transportIndex, "preliminary-status-get must not occur before google-transport");
    }

    console.log("Test 29 Passed: fresh upload does not run retry/resume preliminary server GET [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 29 Failed:", err);
  }

  // Test 30: no concurrent duplicate reconciliation request occurs
  try {
    resetBrowser();
    const file = new FakeUploadFile("video.mp4", 5000000, "video/mp4");
    const transport = new MockTransport();

    transport.responseHandler = async () => {
      throw createTransportResponse(0, "");
    };

    let reconcileCalls = 0;
    fetchHandler = async (url) => {
      if (url === "/api/uploads/asset-123") {
        return createMockResponse(200, { status: "UPLOADING" });
      }
      if (url === "/api/uploads/asset-123/reconcile") {
        reconcileCalls++;
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
    assert(uploader["isReconciling"] === true, "Uploader should be reconciling");

    const secondReconcile = await uploader["attemptServerReconciliation"]();
    assert(secondReconcile === false, "Concurrent duplicate reconciliation check must return false immediately");

    await startPromise;
    assert(reconcileCalls === 1, `Expected exactly 1 reconcile call to the server, got: ${reconcileCalls}`);
    console.log("Test 30 Passed: no concurrent duplicate reconciliation request occurs [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 30 Failed:", err);
  }

  // -------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------
  console.log(`\nGoogle Drive Upload Reconciliation Validation complete. Passed: ${passedCount}/30`);

  if (passedCount !== 30) {
    console.error("ERROR: Not all validation tests passed.");
    process.exit(1);
  } else {
    console.log("SUCCESS: All upload reconciliation integration constraints verified successfully.");
    process.exit(0);
  }
}

runTests().catch((err: unknown) => {
  const errorMsg = err instanceof Error ? err.message : String(err);
  console.error("Fatal error in upload reconciliation test suite:", errorMsg);
  process.exit(1);
});
