import crypto from "crypto";
import { User, GoogleDriveConnection, UploadAsset, UploadSession, AuditLog, UploadStatus, UserRole, UserStatus, UserApprovalStatus } from "@prisma/client";
import { GoogleDriveUploadCompletionService, DbClient, GDCompletionDependencies } from "../src/lib/google-drive/google-drive-upload-completion-service";
import { GoogleDriveConfig } from "../src/lib/google-drive/google-drive-config";
import { handleCompleteUpload } from "../src/app/api/uploads/[id]/complete/route";
import { handleAbortUpload } from "../src/app/api/uploads/[id]/abort/route";
import { ForbiddenOwnershipError, ExpiredSessionError } from "../src/lib/storage/upload-session-encryption";
import { GoogleDriveFileMetadata } from "../src/lib/google-drive/google-drive-media-client";

// Assertion helper
function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// Mock states
let mockUsers: User[] = [];
let mockConnections: GoogleDriveConnection[] = [];
let mockAssets: UploadAsset[] = [];
let mockSessions: UploadSession[] = [];
let mockAudits: AuditLog[] = [];

function resetMockDb() {
  mockUsers = [];
  mockConnections = [];
  mockAssets = [];
  mockSessions = [];
  mockAudits = [];
}

function makeUser(overrides?: Partial<User>): User {
  const defaults: User = {
    id: "user-123",
    email: "admin@publisher.com",
    passwordHash: "hash",
    name: null,
    role: UserRole.USER,
    status: UserStatus.ACTIVE,
    approvalStatus: UserApprovalStatus.APPROVED,
    approvedAt: null,
    approvedById: null,
    rejectedAt: null,
    rejectionReason: null,
    registrationIp: null,
    lastLoginAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const finalUser: User = {
    ...defaults,
    ...overrides,
  };
  return finalUser;
}

function makeAsset(overrides?: Partial<UploadAsset>): UploadAsset {
  const defaults: UploadAsset = {
    id: "asset-123",
    userId: "user-123",
    idempotencyKey: "key-123",
    requestFingerprint: "fingerprint-123",
    provider: "GOOGLE_DRIVE",
    bucket: "folder-456",
    objectKey: "uploads/user-123/video.mp4",
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
  const finalAsset: UploadAsset = {
    ...defaults,
    ...overrides,
  };
  return finalAsset;
}

function makeSession(overrides?: Partial<UploadSession>): UploadSession {
  const defaults: UploadSession = {
    uploadAssetId: "asset-123",
    encryptionKeyVersion: "1",
    encryptedProviderSessionId: "enc:provider-session-id",
    encryptedCompletedParts: "enc:[]",
    expiresAt: new Date(Date.now() + 100000),
    lastActivityAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const finalSession: UploadSession = {
    ...defaults,
    ...overrides,
  };
  return finalSession;
}

function makeGoogleDriveFileMetadata(overrides?: Partial<GoogleDriveFileMetadata>): GoogleDriveFileMetadata {
  const defaults: GoogleDriveFileMetadata = {
    id: "drive-file-123",
    name: "video.mp4",
    mimeType: "video/mp4",
    size: 10485760,
    md5Checksum: null,
    modifiedTime: null,
    parents: ["folder-456"],
    trashed: false,
    appProperties: {
      assetId: "asset-123",
    },
  };
  return {
    ...defaults,
    ...overrides,
  };
}

const mockDb: DbClient = {
  user: {
    findUnique: async (args) => mockUsers.find(u => u.id === args.where.id) || null,
  },
  googleDriveConnection: {
    findUnique: async (args) => {
      return mockConnections.find(c => c.userId === args.where.userId) || null;
    },
  },
  uploadAsset: {
    findUnique: async (args) => {
      return mockAssets.find(a => a.id === args.where.id) || null;
    },
    update: async (args) => {
      const idx = mockAssets.findIndex(a => a.id === args.where.id);
      if (idx === -1) throw new Error("Asset not found");
      mockAssets[idx] = {
        ...mockAssets[idx],
        ...args.data,
      };
      return mockAssets[idx];
    },
  },
  uploadSession: {
    findUnique: async (args) => mockSessions.find(s => s.uploadAssetId === args.where.uploadAssetId) || null,
    deleteMany: async (args) => {
      const initialCount = mockSessions.length;
      mockSessions = mockSessions.filter(s => s.uploadAssetId !== args.where.uploadAssetId);
      return { count: initialCount - mockSessions.length };
    },
  },
  auditLog: {
    create: async (args) => {
      const newAudit: AuditLog = {
        id: crypto.randomUUID(),
        action: args.data.action,
        details: args.data.details,
        userId: args.data.userId,
        ipAddress: args.data.ipAddress ?? null,
        createdAt: new Date(),
      };
      mockAudits.push(newAudit);
      return newAudit;
    },
  },
  $transaction: async (fn) => fn(mockDb),
};

const defaultTestConfig: GoogleDriveConfig = {
  clientId: "mock-client-id",
  clientSecret: "mock-client-secret",
  redirectUri: "https://staudtmaxturtle.com/api/auth/google-drive/callback",
  encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  ownerUserId: "user-123",
};

const defaultDeps: GDCompletionDependencies = {
  db: mockDb,
  getActiveConnection: async (userId) => {
    return mockConnections.find(c => c.userId === userId) || null;
  },
  getGoogleDriveConfig: () => defaultTestConfig,
  decryptRefreshToken: (env) => env.replace("enc:", ""),
  getAccessToken: async (refreshToken) => {
    void refreshToken;
    return "access-token-999";
  },
  getFileMetadata: async (accessToken, fileId, options) => {
    void accessToken;
    void fileId;
    void options;
    return makeGoogleDriveFileMetadata();
  },
  deleteFile: async (accessToken, fileId, options) => {
    void accessToken;
    void fileId;
    void options;
    return true;
  },
};

const validUserId = "user-123";
const validUser = makeUser({ id: validUserId });
const validConnection: GoogleDriveConnection = {
  id: "conn-123",
  userId: validUserId,
  encryptedRefreshToken: "enc:refresh-token-abc",
  refreshTokenKeyVersion: "1",
  googleAccountEmail: "account@gmail.com",
  driveFolderId: "folder-456",
  connectedAt: new Date(),
  updatedAt: new Date(),
  revokedAt: null,
};
const validAsset = makeAsset({ id: "asset-123", userId: validUserId, bucket: "folder-456" });
const validSession = makeSession({ uploadAssetId: "asset-123" });
const validBody = { driveFileId: "drive-file-123" };

async function runTests() {
  console.log("Running Google Drive Upload Completion and Abort Integration Tests...\n");
  let passedCount = 0;

  // ==========================================
  // COMPLETION TESTS
  // ==========================================

  // Test 1: unauthenticated/unauthorized ownership rejection
  try {
    resetMockDb();
    mockUsers.push(validUser);
    mockAssets.push(makeAsset({ id: "asset-123", userId: "other-user" }));

    let failed = false;
    try {
      await GoogleDriveUploadCompletionService.completeUpload(validUserId, "asset-123", validBody, defaultDeps);
    } catch (err: unknown) {
      failed = true;
      assert(err instanceof ForbiddenOwnershipError, "Expected ForbiddenOwnershipError");
    }
    assert(failed, "Ownership mismatch should be rejected");
    console.log("Test 1 Passed: unauthenticated/unauthorized ownership rejection [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 1 Failed:", err);
  }

  // Test 2: non-Google asset rejected by Google completion service
  try {
    resetMockDb();
    mockUsers.push(validUser);
    mockAssets.push(makeAsset({ id: "asset-123", userId: validUserId, provider: "R2" }));

    let failed = false;
    try {
      await GoogleDriveUploadCompletionService.completeUpload(validUserId, "asset-123", validBody, defaultDeps);
    } catch (err: unknown) {
      failed = true;
      assert(err instanceof Error && err.message === "INVALID_PROVIDER", "Expected INVALID_PROVIDER error");
    }
    assert(failed, "R2 provider should be rejected by GDUploadCompletionService");
    console.log("Test 2 Passed: non-Google asset rejected by Google completion service [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 2 Failed:", err);
  }

  // Test 3: missing or revoked Drive connection
  try {
    resetMockDb();
    mockUsers.push(validUser);
    mockAssets.push(validAsset);
    mockConnections.push({ ...validConnection, revokedAt: new Date() });

    let failed = false;
    try {
      await GoogleDriveUploadCompletionService.completeUpload(validUserId, "asset-123", validBody, defaultDeps);
    } catch (err: unknown) {
      failed = true;
      assert(err instanceof Error && err.message === "GOOGLE_DRIVE_NOT_CONNECTED", "Expected GOOGLE_DRIVE_NOT_CONNECTED error");
    }
    assert(failed, "Revoked Drive connection should be rejected");
    console.log("Test 3 Passed: missing or revoked Drive connection [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 3 Failed:", err);
  }

  // Test 4: expired session rejection
  try {
    resetMockDb();
    mockUsers.push(validUser);
    mockAssets.push(validAsset);
    mockConnections.push(validConnection);
    mockSessions.push(makeSession({ uploadAssetId: "asset-123", expiresAt: new Date(Date.now() - 5000) }));

    let failed = false;
    try {
      await GoogleDriveUploadCompletionService.completeUpload(validUserId, "asset-123", validBody, defaultDeps);
    } catch (err: unknown) {
      failed = true;
      assert(err instanceof ExpiredSessionError, "Expected ExpiredSessionError");
    }
    assert(failed, "Expired session should be rejected");
    console.log("Test 4 Passed: expired session rejection [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 4 Failed:", err);
  }

  // Test 5: blank/malformed Drive file ID rejection
  try {
    resetMockDb();
    mockUsers.push(validUser);
    mockAssets.push(validAsset);
    mockConnections.push(validConnection);
    mockSessions.push(validSession);

    let failedCount = 0;
    const malformedBodies = [
      { driveFileId: "" },
      { driveFileId: "file id with spaces" },
      { driveFileId: "file@id" },
      { driveFileId: "a".repeat(150) },
    ];

    for (const body of malformedBodies) {
      try {
        await GoogleDriveUploadCompletionService.completeUpload(validUserId, "asset-123", body, defaultDeps);
      } catch (err: unknown) {
        if (err instanceof Error && (err.message === "INVALID_FILE_ID" || err.message === "INVALID_REQUEST")) {
          failedCount++;
        }
      }
    }

    assert(failedCount === malformedBodies.length, "All malformed IDs must be rejected");

    // Assertion 1: Blank driveFileId is rejected even for VALIDATING assets
    mockAssets = [];
    mockAssets.push(makeAsset({ id: "asset-123", userId: validUserId, status: UploadStatus.VALIDATING, objectKey: "drive-file-123", actualSize: BigInt(10485760) }));
    let blankValidatedFailed = false;
    try {
      await GoogleDriveUploadCompletionService.completeUpload(validUserId, "asset-123", { driveFileId: "" }, defaultDeps);
    } catch (err: unknown) {
      if (err instanceof Error && err.message === "INVALID_FILE_ID") {
        blankValidatedFailed = true;
      }
    }
    assert(blankValidatedFailed, "Blank driveFileId must be rejected even for completed assets");

    console.log("Test 5 Passed: blank/malformed Drive file ID rejection [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 5 Failed:", err);
  }

  // Test 6: missing Drive file
  try {
    resetMockDb();
    mockUsers.push(validUser);
    mockAssets.push(validAsset);
    mockConnections.push(validConnection);
    mockSessions.push(validSession);

    const getFileMetadataMock = async (accessToken: string, fileId: string) => {
      void accessToken;
      void fileId;
      return null; // missing file
    };

    let failed = false;
    try {
      await GoogleDriveUploadCompletionService.completeUpload(validUserId, "asset-123", validBody, {
        ...defaultDeps,
        getFileMetadata: getFileMetadataMock,
      });
    } catch (err: unknown) {
      failed = true;
      assert(err instanceof Error && err.message === "GOOGLE_DRIVE_FILE_MISSING_OR_TRASHED", "Expected missing/trashed error");
    }
    assert(failed, "Missing Drive file should be rejected");
    console.log("Test 6 Passed: missing Drive file [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 6 Failed:", err);
  }

  // Test 7: trashed Drive file
  try {
    resetMockDb();
    mockUsers.push(validUser);
    mockAssets.push(validAsset);
    mockConnections.push(validConnection);
    mockSessions.push(validSession);

    const getFileMetadataMock = async (accessToken: string, fileId: string) => {
      void accessToken;
      void fileId;
      return makeGoogleDriveFileMetadata({ trashed: true });
    };

    let failed = false;
    try {
      await GoogleDriveUploadCompletionService.completeUpload(validUserId, "asset-123", validBody, {
        ...defaultDeps,
        getFileMetadata: getFileMetadataMock,
      });
    } catch (err: unknown) {
      failed = true;
      assert(err instanceof Error && err.message === "GOOGLE_DRIVE_FILE_MISSING_OR_TRASHED", "Expected GOOGLE_DRIVE_FILE_MISSING_OR_TRASHED error");
    }
    assert(failed, "Trashed Drive file should be rejected");
    console.log("Test 7 Passed: trashed Drive file [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 7 Failed:", err);
  }

  // Test 8: wrong appProperties assetId
  try {
    resetMockDb();
    mockUsers.push(validUser);
    mockAssets.push(validAsset);
    mockConnections.push(validConnection);
    mockSessions.push(validSession);

    const getFileMetadataMock = async (accessToken: string, fileId: string) => {
      void accessToken;
      void fileId;
      return makeGoogleDriveFileMetadata({
        appProperties: {
          assetId: "wrong-asset-id",
        },
      });
    };

    let failed = false;
    try {
      await GoogleDriveUploadCompletionService.completeUpload(validUserId, "asset-123", validBody, {
        ...defaultDeps,
        getFileMetadata: getFileMetadataMock,
      });
    } catch (err: unknown) {
      failed = true;
      assert(err instanceof Error && err.message === "METADATA_MISMATCH", "Expected METADATA_MISMATCH error");
    }
    assert(failed, "Wrong assetId in appProperties should be rejected");
    console.log("Test 8 Passed: wrong appProperties assetId [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 8 Failed:", err);
  }

  // Test 9: wrong parent folder (bucket parent)
  // proving:
  // - connection.driveFolderId differing from asset.bucket is rejected
  // - Metadata parent matching the connection but not asset.bucket is rejected
  try {
    // Sub-test A: connection.driveFolderId differing from asset.bucket is rejected
    resetMockDb();
    mockUsers.push(validUser);
    mockAssets.push(makeAsset({ id: "asset-123", userId: validUserId, bucket: "original-folder" }));
    mockConnections.push({ ...validConnection, driveFolderId: "changed-folder" });
    mockSessions.push(validSession);

    let failedA = false;
    try {
      await GoogleDriveUploadCompletionService.completeUpload(validUserId, "asset-123", validBody, defaultDeps);
    } catch (err: unknown) {
      failedA = true;
      assert(err instanceof Error && err.message === "METADATA_MISMATCH", "Expected METADATA_MISMATCH error");
    }
    assert(failedA, "driveFolderId differing from asset.bucket must be rejected");

    // Sub-test B: Metadata parent matching the connection but not asset.bucket is rejected
    resetMockDb();
    mockUsers.push(validUser);
    mockAssets.push(makeAsset({ id: "asset-123", userId: validUserId, bucket: "folder-456" }));
    mockConnections.push({ ...validConnection, driveFolderId: "folder-456" });
    mockSessions.push(validSession);

    const getFileMetadataMock = async (accessToken: string, fileId: string) => {
      void accessToken;
      void fileId;
      return makeGoogleDriveFileMetadata({
        parents: ["wrong-parent"],
      });
    };

    let failedB = false;
    try {
      await GoogleDriveUploadCompletionService.completeUpload(validUserId, "asset-123", validBody, {
        ...defaultDeps,
        getFileMetadata: getFileMetadataMock,
      });
    } catch (err: unknown) {
      failedB = true;
      assert(err instanceof Error && err.message === "METADATA_MISMATCH", "Expected METADATA_MISMATCH error");
    }
    assert(failedB, "Metadata parent lacking asset.bucket must be rejected");

    console.log("Test 9 Passed: wrong parent folder (bucket parent) [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 9 Failed:", err);
  }

  // Test 10: size mismatch
  try {
    resetMockDb();
    mockUsers.push(validUser);
    mockAssets.push(validAsset);
    mockConnections.push(validConnection);
    mockSessions.push(validSession);

    const getFileMetadataMock = async (accessToken: string, fileId: string) => {
      void accessToken;
      void fileId;
      return makeGoogleDriveFileMetadata({
        size: 999999,
      });
    };

    let failed = false;
    try {
      await GoogleDriveUploadCompletionService.completeUpload(validUserId, "asset-123", validBody, {
        ...defaultDeps,
        getFileMetadata: getFileMetadataMock,
      });
    } catch (err: unknown) {
      failed = true;
      assert(err instanceof Error && err.message === "METADATA_MISMATCH", "Expected METADATA_MISMATCH error");
    }
    assert(failed, "Size mismatch should be rejected");
    console.log("Test 10 Passed: size mismatch [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 10 Failed:", err);
  }

  // Test 11: filename mismatch
  try {
    resetMockDb();
    mockUsers.push(validUser);
    mockAssets.push(validAsset);
    mockConnections.push(validConnection);
    mockSessions.push(validSession);

    const getFileMetadataMock = async (accessToken: string, fileId: string) => {
      void accessToken;
      void fileId;
      return makeGoogleDriveFileMetadata({
        name: "wrong-name.mp4",
      });
    };

    let failed = false;
    try {
      await GoogleDriveUploadCompletionService.completeUpload(validUserId, "asset-123", validBody, {
        ...defaultDeps,
        getFileMetadata: getFileMetadataMock,
      });
    } catch (err: unknown) {
      failed = true;
      assert(err instanceof Error && err.message === "METADATA_MISMATCH", "Expected METADATA_MISMATCH error");
    }
    assert(failed, "Filename mismatch should be rejected");
    console.log("Test 11 Passed: filename mismatch [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 11 Failed:", err);
  }

  // Test 12: MIME mismatch
  try {
    resetMockDb();
    mockUsers.push(validUser);
    mockAssets.push(validAsset);
    mockConnections.push(validConnection);
    mockSessions.push(validSession);

    const getFileMetadataMock = async (accessToken: string, fileId: string) => {
      void accessToken;
      void fileId;
      return makeGoogleDriveFileMetadata({
        mimeType: "video/quicktime",
      });
    };

    let failed = false;
    try {
      await GoogleDriveUploadCompletionService.completeUpload(validUserId, "asset-123", validBody, {
        ...defaultDeps,
        getFileMetadata: getFileMetadataMock,
      });
    } catch (err: unknown) {
      failed = true;
      assert(err instanceof Error && err.message === "METADATA_MISMATCH", "Expected METADATA_MISMATCH error");
    }
    assert(failed, "MIME mismatch should be rejected");
    console.log("Test 12 Passed: MIME mismatch [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 12 Failed:", err);
  }

  // Test 13: successful verified completion (proving metadata parent matching asset.bucket succeeds)
  try {
    resetMockDb();
    mockUsers.push(validUser);
    mockAssets.push(validAsset);
    mockConnections.push(validConnection);
    mockSessions.push(validSession);

    const res = await GoogleDriveUploadCompletionService.completeUpload(validUserId, "asset-123", validBody, defaultDeps);
    assert(res.status === UploadStatus.VALIDATING, "Status should be VALIDATING");
    assert(res.provider === "GOOGLE_DRIVE", "Provider should be GOOGLE_DRIVE");

    const updatedAsset = mockAssets[0];
    assert(updatedAsset !== undefined && updatedAsset.status === UploadStatus.VALIDATING, "Prisma transition status failed");
    console.log("Test 13 Passed: successful verified completion [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 13 Failed:", err);
  }

  // Test 14: exact Drive file ID saved to objectKey
  try {
    resetMockDb();
    mockUsers.push(validUser);
    mockAssets.push(validAsset);
    mockConnections.push(validConnection);
    mockSessions.push(validSession);

    await GoogleDriveUploadCompletionService.completeUpload(validUserId, "asset-123", validBody, defaultDeps);
    const updatedAsset = mockAssets[0];
    assert(updatedAsset !== undefined && updatedAsset.objectKey === "drive-file-123", "Verified Drive file ID must be saved to objectKey");
    console.log("Test 14 Passed: exact Drive file ID saved to objectKey [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 14 Failed:", err);
  }

  // Test 15: actualSize comes only from verified metadata
  try {
    resetMockDb();
    mockUsers.push(validUser);
    mockAssets.push(validAsset);
    mockConnections.push(validConnection);
    mockSessions.push(validSession);

    await GoogleDriveUploadCompletionService.completeUpload(validUserId, "asset-123", validBody, defaultDeps);
    const updatedAsset = mockAssets[0];
    assert(updatedAsset !== undefined && updatedAsset.actualSize !== null && updatedAsset.actualSize === BigInt(10485760), "actualSize should match metadata size exactly");
    console.log("Test 15 Passed: actualSize comes only from verified metadata [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 15 Failed:", err);
  }

  // Test 16: successful idempotent completion retry
  // proving:
  // - Wrong driveFileId is rejected for an idempotent retry.
  // - Matching stored objectKey returns safe idempotent success.
  // - Idempotent retry performs no token refresh or metadata request.
  try {
    resetMockDb();
    mockUsers.push(validUser);
    mockAssets.push(makeAsset({ id: "asset-123", userId: validUserId, status: UploadStatus.VALIDATING, objectKey: "drive-file-123", actualSize: BigInt(10485760) }));
    mockConnections.push(validConnection);

    // Assertion A: Wrong driveFileId is rejected with COMPLETION_FILE_ID_MISMATCH
    let failedWrongId = false;
    try {
      await GoogleDriveUploadCompletionService.completeUpload(validUserId, "asset-123", { driveFileId: "wrong-file-id" }, defaultDeps);
    } catch (err: unknown) {
      if (err instanceof Error && err.message === "COMPLETION_FILE_ID_MISMATCH") {
        failedWrongId = true;
      }
    }
    assert(failedWrongId, "Mismatched file ID should throw COMPLETION_FILE_ID_MISMATCH");

    // Assertion B: Matching stored objectKey returns safe idempotent success
    const res = await GoogleDriveUploadCompletionService.completeUpload(validUserId, "asset-123", validBody, defaultDeps);
    assert(res.status === UploadStatus.VALIDATING, "Should return VALIDATING");

    // Assertion C: Idempotent retry performs no token refresh or metadata request
    let refreshCalled = false;
    const refreshHelperMock = async (refreshToken: string) => {
      void refreshToken;
      refreshCalled = true;
      return "token";
    };
    let metadataCalled = false;
    const metadataHelperMock = async (accessToken: string, fileId: string) => {
      void accessToken;
      void fileId;
      metadataCalled = true;
      return null;
    };

    await GoogleDriveUploadCompletionService.completeUpload(validUserId, "asset-123", validBody, {
      ...defaultDeps,
      getAccessToken: refreshHelperMock,
      getFileMetadata: metadataHelperMock,
    });

    assert(!refreshCalled, "Should not refresh token on idempotent retry");
    assert(!metadataCalled, "Should not fetch metadata on idempotent retry");

    console.log("Test 16 Passed: successful idempotent completion retry [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 16 Failed:", err);
  }

  // Test 17: provider secrets and Google response body never leaked
  try {
    resetMockDb();
    mockUsers.push(validUser);
    mockAssets.push(validAsset);
    mockConnections.push(validConnection);
    mockSessions.push(validSession);

    const secretBody = "Google authentication backend tokens details 999";
    const getFileMetadataMock = async (accessToken: string, fileId: string) => {
      void accessToken;
      void fileId;
      throw new Error(secretBody);
    };

    let failed = false;
    try {
      await GoogleDriveUploadCompletionService.completeUpload(validUserId, "asset-123", validBody, {
        ...defaultDeps,
        getFileMetadata: getFileMetadataMock,
      });
    } catch (err: unknown) {
      failed = true;
      const msg = err instanceof Error ? err.message : String(err);
      assert(!msg.includes(secretBody), "Throws sanitized error only, must not leak body");
      assert(!msg.includes("access-token-999"), "Must not leak access token");
    }
    assert(failed, "Verification error should throw");
    console.log("Test 17 Passed: provider secrets and Google response body never leaked [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 17 Failed:", err);
  }

  // Test 18: R2 completion path remains unchanged
  try {
    resetMockDb();
    const mockR2Asset = { provider: "R2", userId: validUserId };

    let r2CompletionCalled = false;
    const completeR2Mock = async () => {
      r2CompletionCalled = true;
      return { success: true };
    };

    const response = await handleCompleteUpload(validUserId, "asset-r2", validBody, {
      findUploadAsset: async () => mockR2Asset,
      completeR2Upload: completeR2Mock,
    });

    assert(response.status === 202, `Expected 202 status, got ${response.status}`);
    assert(r2CompletionCalled, "R2 complete flow must be called for non-Google assets");
    console.log("Test 18 Passed: R2 completion path remains unchanged [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 18 Failed:", err);
  }

  // ==========================================
  // ABORT TESTS
  // ==========================================

  // Test 19: ownership rejection in abort
  try {
    resetMockDb();
    mockUsers.push(validUser);
    mockAssets.push(makeAsset({ id: "asset-123", userId: "other-user" }));

    let failed = false;
    try {
      await GoogleDriveUploadCompletionService.abortUpload(validUserId, "asset-123", defaultDeps);
    } catch (err: unknown) {
      failed = true;
      assert(err instanceof ForbiddenOwnershipError, "Expected ForbiddenOwnershipError");
    }
    assert(failed, "Ownership mismatch on abort should be rejected");
    console.log("Test 19 Passed: ownership rejection in abort [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 19 Failed:", err);
  }

  // Test 20: Google upload without finalized file ID performs no Drive delete
  // Proving:
  // - VALIDATING asset with objectKey "uploads/..." performs no Drive deletion
  // - VALIDATED asset with objectKey "uploads/..." performs no Drive deletion
  // - Malformed non-temporary objectKey performs no Drive deletion
  try {
    // Sub-test A: status is UPLOADING, temporary path
    resetMockDb();
    mockUsers.push(validUser);
    mockAssets.push(validAsset);
    mockConnections.push(validConnection);
    mockSessions.push(validSession);

    let deleteCalledA = false;
    const deleteFileMockA = async (accessToken: string, fileId: string) => {
      void accessToken;
      void fileId;
      deleteCalledA = true;
      return true;
    };

    await GoogleDriveUploadCompletionService.abortUpload(validUserId, "asset-123", {
      ...defaultDeps,
      deleteFile: deleteFileMockA,
    });
    assert(!deleteCalledA, "UPLOADING temporary path should perform zero deletion calls");

    // Sub-test B: status is VALIDATING, but objectKey is temporary path "uploads/..."
    resetMockDb();
    mockUsers.push(validUser);
    mockAssets.push(makeAsset({ id: "asset-123", userId: validUserId, status: UploadStatus.VALIDATING, objectKey: "uploads/user-123/video.mp4" }));
    mockConnections.push(validConnection);

    let deleteCalledB = false;
    const deleteFileMockB = async (accessToken: string, fileId: string) => {
      void accessToken;
      void fileId;
      deleteCalledB = true;
      return true;
    };

    await GoogleDriveUploadCompletionService.abortUpload(validUserId, "asset-123", {
      ...defaultDeps,
      deleteFile: deleteFileMockB,
    });
    assert(!deleteCalledB, "VALIDATING temporary path should perform zero deletion calls");

    // Sub-test C: status is VALIDATED, but objectKey is temporary path "uploads/..."
    resetMockDb();
    mockUsers.push(validUser);
    mockAssets.push(makeAsset({ id: "asset-123", userId: validUserId, status: UploadStatus.VALIDATED, objectKey: "uploads/user-123/video.mp4" }));
    mockConnections.push(validConnection);

    let deleteCalledC = false;
    const deleteFileMockC = async (accessToken: string, fileId: string) => {
      void accessToken;
      void fileId;
      deleteCalledC = true;
      return true;
    };

    await GoogleDriveUploadCompletionService.abortUpload(validUserId, "asset-123", {
      ...defaultDeps,
      deleteFile: deleteFileMockC,
    });
    assert(!deleteCalledC, "VALIDATED temporary path should perform zero deletion calls");

    // Sub-test D: Malformed non-temporary objectKey performs no Drive deletion
    resetMockDb();
    mockUsers.push(validUser);
    mockAssets.push(makeAsset({ id: "asset-123", userId: validUserId, status: UploadStatus.VALIDATING, objectKey: "invalid@file_id" }));
    mockConnections.push(validConnection);

    let deleteCalledD = false;
    const deleteFileMockD = async (accessToken: string, fileId: string) => {
      void accessToken;
      void fileId;
      deleteCalledD = true;
      return true;
    };

    await GoogleDriveUploadCompletionService.abortUpload(validUserId, "asset-123", {
      ...defaultDeps,
      deleteFile: deleteFileMockD,
    });
    assert(!deleteCalledD, "Malformed non-temporary objectKey should perform zero deletion calls");

    console.log("Test 20 Passed: Google upload without finalized file ID performs no Drive delete [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 20 Failed:", err);
  }

  // Test 21: finalized Google file is deleted
  try {
    resetMockDb();
    mockUsers.push(validUser);
    mockAssets.push(makeAsset({ id: "asset-123", userId: validUserId, status: UploadStatus.VALIDATING, objectKey: "drive-file-123" }));
    mockConnections.push(validConnection);
    mockSessions.push(validSession);

    let deleteCalled = false;
    let deletedFileId = "";
    const deleteFileMock = async (accessToken: string, fileId: string) => {
      void accessToken;
      deleteCalled = true;
      deletedFileId = fileId;
      return true;
    };

    const res = await GoogleDriveUploadCompletionService.abortUpload(validUserId, "asset-123", {
      ...defaultDeps,
      deleteFile: deleteFileMock,
    });

    assert(res.status === UploadStatus.ABORTED, "Should transition to ABORTED");
    assert(deleteCalled && deletedFileId === "drive-file-123", "Delete should be called on Google Drive with verified file ID");
    console.log("Test 21 Passed: finalized Google file is deleted [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 21 Failed:", err);
  }

  // Test 22: deleteGoogleDriveFile false/404 result is idempotent success
  try {
    resetMockDb();
    mockUsers.push(validUser);
    mockAssets.push(makeAsset({ id: "asset-123", userId: validUserId, status: UploadStatus.VALIDATING, objectKey: "drive-file-123" }));
    mockConnections.push(validConnection);
    mockSessions.push(validSession);

    let deleteCalled = false;
    const deleteFileMock = async (accessToken: string, fileId: string) => {
      void accessToken;
      void fileId;
      deleteCalled = true;
      return false; // 404
    };

    const res = await GoogleDriveUploadCompletionService.abortUpload(validUserId, "asset-123", {
      ...defaultDeps,
      deleteFile: deleteFileMock,
    });

    assert(res.status === UploadStatus.ABORTED, "Should transition to ABORTED even on 404 (false)");
    assert(deleteCalled, "Delete helper was invoked");
    console.log("Test 22 Passed: Drive 404 is idempotent success [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 22 Failed:", err);
  }

  // Test 23: provider delete failure uses a safe error (and Provider error text is never leaked)
  try {
    resetMockDb();
    mockUsers.push(validUser);
    mockAssets.push(makeAsset({ id: "asset-123", userId: validUserId, status: UploadStatus.VALIDATING, objectKey: "drive-file-123" }));
    mockConnections.push(validConnection);
    mockSessions.push(validSession);

    const providerErrorText = "Internal Google OAuth expired token signature 999";
    const deleteFileMock = async () => {
      throw new Error(providerErrorText);
    };

    let failed = false;
    try {
      await GoogleDriveUploadCompletionService.abortUpload(validUserId, "asset-123", {
        ...defaultDeps,
        deleteFile: deleteFileMock,
      });
    } catch (err: unknown) {
      failed = true;
      const msg = err instanceof Error ? err.message : String(err);
      assert(msg === "GOOGLE_DRIVE_DELETE_FAILED", `Expected GOOGLE_DRIVE_DELETE_FAILED error, got: ${msg}`);
      assert(!msg.includes(providerErrorText), "Throws only safe error, must not leak provider error text");
    }
    assert(failed, "Delete failure should throw");

    // Assertion: Provider error text is never returned, persisted, audited, or logged
    for (const a of mockAssets) {
      assert(!a.failureMessage || !a.failureMessage.includes(providerErrorText), "Failure message leak");
    }
    for (const log of mockAudits) {
      assert(!log.details.includes(providerErrorText), "Audit log details leak");
    }

    console.log("Test 23 Passed: provider delete failure uses a safe error [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 23 Failed:", err);
  }

  // Test 24: R2 abort path remains unchanged
  try {
    resetMockDb();
    const mockR2Asset = { provider: "R2", userId: validUserId };

    let r2AbortCalled = false;
    const abortR2Mock = async () => {
      r2AbortCalled = true;
      return { success: true };
    };

    const response = await handleAbortUpload(validUserId, "asset-r2", {
      findUploadAsset: async () => mockR2Asset,
      abortR2Upload: abortR2Mock,
    });

    assert(response.status === 200, `Expected 200 status, got ${response.status}`);
    assert(r2AbortCalled, "R2 abort flow must be called for non-Google assets");
    console.log("Test 24 Passed: R2 abort path remains unchanged [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 24 Failed:", err);
  }

  console.log(`\nGoogle Drive Upload Completion and Abort Integration Validation complete. Passed: ${passedCount}/24`);

  if (passedCount !== 24) {
    console.error("ERROR: Not all validation tests passed.");
    process.exit(1);
  } else {
    console.log("SUCCESS: All completion/abort integration constraints verified successfully.");
    process.exit(0);
  }
}

runTests().catch((err: unknown) => {
  const errorMsg = err instanceof Error ? err.message : String(err);
  console.error("Fatal error in upload completion integration test suite:", errorMsg);
  process.exit(1);
});
