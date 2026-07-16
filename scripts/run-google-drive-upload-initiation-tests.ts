import crypto from "crypto";
import { User, GoogleDriveConnection, UploadAsset, UploadSession, AuditLog, UploadStatus, UserRole, UserStatus, UserApprovalStatus } from "@prisma/client";
import { GoogleDriveUploadInitiationService, DbClient, GDUploadInitiationDependencies } from "../src/lib/google-drive/google-drive-upload-initiation-service";
import { GoogleDriveConfig } from "../src/lib/google-drive/google-drive-config";
import { handleInitiateUpload } from "../src/app/api/uploads/initiate/route";
import { IdempotencyConflictError, ExpiredSessionError } from "../src/lib/storage/upload-session-encryption";
import { UploadSessionService } from "../src/lib/storage/upload-session-service";
import { UploadInitiationService } from "../src/lib/storage/upload-initiation-service";

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
      const { userId, idempotencyKey } = args.where.userId_idempotencyKey;
      return mockAssets.find(a => a.userId === userId && a.idempotencyKey === idempotencyKey) || null;
    },
    create: async (args) => {
      const newAsset: UploadAsset = {
        id: crypto.randomUUID(),
        userId: args.data.userId,
        idempotencyKey: args.data.idempotencyKey,
        requestFingerprint: args.data.requestFingerprint,
        provider: args.data.provider,
        bucket: args.data.bucket,
        objectKey: args.data.objectKey,
        originalName: args.data.originalName,
        expectedSize: args.data.expectedSize,
        actualSize: null,
        declaredMimeType: args.data.declaredMimeType,
        detectedMimeType: null,
        checksum: null,
        objectETag: null,
        status: args.data.status,
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
        uploadExpiresAt: args.data.uploadExpiresAt,
        uploadedAt: null,
        validatedAt: null,
        retentionUntil: null,
        objectDeletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockAssets.push(newAsset);
      return newAsset;
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
    create: async (args) => {
      const newSession: UploadSession = {
        uploadAssetId: args.data.uploadAssetId,
        encryptionKeyVersion: args.data.encryptionKeyVersion,
        encryptedProviderSessionId: args.data.encryptedProviderSessionId,
        encryptedCompletedParts: args.data.encryptedCompletedParts,
        expiresAt: args.data.expiresAt,
        lastActivityAt: args.data.lastActivityAt,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockSessions.push(newSession);
      return newSession;
    },
  },
  auditLog: {
    create: async (args) => {
      const newAudit: AuditLog = {
        id: crypto.randomUUID(),
        action: args.data.action,
        details: args.data.details,
        userId: args.data.userId ?? null,
        ipAddress: null,
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

// Default dependencies mock
const defaultDeps: GDUploadInitiationDependencies = {
  db: mockDb,
  getActiveConnection: async (userId) => {
    return mockConnections.find(c => c.userId === userId) || null;
  },
  getGoogleDriveConfig: () => defaultTestConfig,
  decryptRefreshToken: (env) => env.replace("enc:", ""),
  getAccessToken: async () => "access-token-999",
  initiateResumableUpload: async () => ({ sessionUri: "https://www.googleapis.com/session-abc" }),
  encryptSessionSecret: (secret) => `enc:${secret}`,
  decryptSessionSecret: (envelope) => envelope.replace("enc:", ""),
};

async function runTests() {
  console.log("Running Google Drive Upload Initiation Integration Tests...\n");
  let passedCount = 0;

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

  const validInitiationInput = {
    idempotencyKey: "key-1",
    originalName: "video.mp4",
    expectedSize: BigInt(10485760), // 10 MiB
    declaredMimeType: "video/mp4",
  };

  // Test 1: Active approved USER is accepted without ADMIN role
  try {
    resetMockDb();
    mockUsers.push(validUser);
    mockConnections.push(validConnection);

    const res = await GoogleDriveUploadInitiationService.initiateGDUpload(validUserId, validInitiationInput, defaultDeps);
    assert(res.assetId !== undefined, "Active approved user should succeed");
    assert(res.provider === "GOOGLE_DRIVE", "Should use GOOGLE_DRIVE provider");
    console.log("Test 1 Passed: Active approved USER is accepted without ADMIN role [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 1 Failed:", err);
  }

  // Test 2: Inactive user is rejected
  try {
    resetMockDb();
    const inactiveUser = makeUser({ id: validUserId, status: UserStatus.SUSPENDED });
    mockUsers.push(inactiveUser);
    mockConnections.push(validConnection);

    let failed = false;
    try {
      await GoogleDriveUploadInitiationService.initiateGDUpload(validUserId, validInitiationInput, defaultDeps);
    } catch (err: unknown) {
      failed = true;
      assert(err instanceof Error && err.message === "UNAUTHORIZED_USER", "Expected unauthorized user error");
    }
    assert(failed, "Inactive user should be rejected");
    console.log("Test 2 Passed: Inactive user is rejected [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 2 Failed:", err);
  }

  // Test 3: Unapproved user is rejected
  try {
    resetMockDb();
    const unapprovedUser = makeUser({ id: validUserId, approvalStatus: UserApprovalStatus.PENDING });
    mockUsers.push(unapprovedUser);
    mockConnections.push(validConnection);

    let failed = false;
    try {
      await GoogleDriveUploadInitiationService.initiateGDUpload(validUserId, validInitiationInput, defaultDeps);
    } catch (err: unknown) {
      failed = true;
      assert(err instanceof Error && err.message === "UNAUTHORIZED_USER", "Expected unauthorized user error");
    }
    assert(failed, "Unapproved user should be rejected");
    console.log("Test 3 Passed: Unapproved user is rejected [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 3 Failed:", err);
  }

  // Test 4: Existing R2 asset with the same idempotency key is rejected
  try {
    resetMockDb();
    mockUsers.push(validUser);
    mockConnections.push(validConnection);

    // Seed existing R2 asset
    const r2Asset: UploadAsset = {
      id: "r2-asset-123",
      userId: validUserId,
      idempotencyKey: validInitiationInput.idempotencyKey,
      requestFingerprint: "d07246b9a896d8e23f03b0d2d3a6d48227b6c59b207eb18d6a89c89012f20de9", // Matches fingerprint of video.mp4:10485760:video/mp4
      provider: "R2",
      bucket: "bucket",
      objectKey: "key",
      originalName: validInitiationInput.originalName,
      expectedSize: validInitiationInput.expectedSize,
      actualSize: null,
      declaredMimeType: validInitiationInput.declaredMimeType,
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
    mockAssets.push(r2Asset);

    let failed = false;
    try {
      await GoogleDriveUploadInitiationService.initiateGDUpload(validUserId, validInitiationInput, defaultDeps);
    } catch (err: unknown) {
      failed = true;
      assert(err instanceof IdempotencyConflictError, "Expected IdempotencyConflictError");
      assert(err instanceof Error && err.message.includes("different storage provider"), "Expected different storage provider error message");
    }
    assert(failed, "Existing R2 asset replay should be rejected");
    console.log("Test 4 Passed: Existing R2 asset with the same idempotency key is rejected [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 4 Failed:", err);
  }

  // Test 5: P2002 race returning an R2 asset is rejected
  try {
    resetMockDb();
    mockUsers.push(validUser);
    mockConnections.push(validConnection);

    // Mock create to simulate unique constraint failure
    const dbMockWithRace: DbClient = {
      ...mockDb,
      uploadAsset: {
        ...mockDb.uploadAsset,
        create: async () => {
          const err = Object.assign(new Error("Unique constraint violation"), { code: "P2002" });
          throw err;
        },
      },
    };

    // Seed existing R2 asset
    const r2Asset: UploadAsset = {
      id: "r2-asset-123",
      userId: validUserId,
      idempotencyKey: validInitiationInput.idempotencyKey,
      requestFingerprint: "d07246b9a896d8e23f03b0d2d3a6d48227b6c59b207eb18d6a89c89012f20de9",
      provider: "R2",
      bucket: "bucket",
      objectKey: "key",
      originalName: validInitiationInput.originalName,
      expectedSize: validInitiationInput.expectedSize,
      actualSize: null,
      declaredMimeType: validInitiationInput.declaredMimeType,
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
    mockAssets.push(r2Asset);

    let failed = false;
    try {
      await GoogleDriveUploadInitiationService.initiateGDUpload(validUserId, validInitiationInput, {
        ...defaultDeps,
        db: dbMockWithRace,
      });
    } catch (err: unknown) {
      failed = true;
      assert(err instanceof IdempotencyConflictError, "Expected IdempotencyConflictError");
      assert(err instanceof Error && err.message.includes("different storage provider"), "Expected different storage provider error message");
    }
    assert(failed, "P2002 concurrent race with existing R2 asset should be rejected");
    console.log("Test 5 Passed: P2002 race returning an R2 asset is rejected [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 5 Failed:", err);
  }

  // Test 6: R2 provider session data is never decrypted as a Drive session
  try {
    resetMockDb();
    mockUsers.push(validUser);
    mockConnections.push(validConnection);

    // Seed existing R2 asset
    const r2Asset: UploadAsset = {
      id: "r2-asset-123",
      userId: validUserId,
      idempotencyKey: validInitiationInput.idempotencyKey,
      requestFingerprint: "d07246b9a896d8e23f03b0d2d3a6d48227b6c59b207eb18d6a89c89012f20de9",
      provider: "R2",
      bucket: "bucket",
      objectKey: "key",
      originalName: validInitiationInput.originalName,
      expectedSize: validInitiationInput.expectedSize,
      actualSize: null,
      declaredMimeType: validInitiationInput.declaredMimeType,
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
    mockAssets.push(r2Asset);

    // Set decryption hook that throws if called
    let decryptCalled = false;
    const decryptRefreshTokenHook = (env: string) => {
      decryptCalled = true;
      return env;
    };

    try {
      await GoogleDriveUploadInitiationService.initiateGDUpload(validUserId, validInitiationInput, {
        ...defaultDeps,
        decryptRefreshToken: decryptRefreshTokenHook,
      });
    } catch {
      // expected fail
    }

    assert(!decryptCalled, "Decryption logic should not be reached for R2 provider asset replays");
    console.log("Test 6 Passed: R2 provider session data is never decrypted as a Drive session [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 6 Failed:", err);
  }

  // Test 7: Expired Google Drive upload session is not replayed
  try {
    resetMockDb();
    mockUsers.push(validUser);
    mockConnections.push(validConnection);

    const requestFingerprint = UploadSessionService.generateRequestFingerprint(
      validInitiationInput.originalName,
      validInitiationInput.expectedSize,
      validInitiationInput.declaredMimeType
    );

    // Seed existing unexpired GD asset but expired upload session
    const gdAsset: UploadAsset = {
      id: "gd-asset-123",
      userId: validUserId,
      idempotencyKey: validInitiationInput.idempotencyKey,
      requestFingerprint,
      provider: "GOOGLE_DRIVE",
      bucket: "bucket",
      objectKey: "key",
      originalName: validInitiationInput.originalName,
      expectedSize: validInitiationInput.expectedSize,
      actualSize: null,
      declaredMimeType: validInitiationInput.declaredMimeType,
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
      uploadExpiresAt: new Date(Date.now() - 1000), // Expired asset expiration
      uploadedAt: null,
      validatedAt: null,
      retentionUntil: null,
      objectDeletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockAssets.push(gdAsset);

    const expiredSession: UploadSession = {
      uploadAssetId: gdAsset.id,
      encryptionKeyVersion: "1",
      encryptedProviderSessionId: "enc:https://www.googleapis.com/session-abc",
      encryptedCompletedParts: "enc:[]",
      expiresAt: new Date(Date.now() - 5000), // Expired session expiration
      lastActivityAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockSessions.push(expiredSession);

    let failed = false;
    try {
      await GoogleDriveUploadInitiationService.initiateGDUpload(validUserId, validInitiationInput, defaultDeps);
    } catch (err: unknown) {
      failed = true;
      assert(err instanceof ExpiredSessionError, "Expected ExpiredSessionError");
    }
    assert(failed, "Expired session should reject replay");
    console.log("Test 7 Passed: Expired Google Drive upload session is not replayed [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 7 Failed:", err);
  }

  // Test 8: Provider error body is not stored in failureMessage
  try {
    resetMockDb();
    mockUsers.push(validUser);
    mockConnections.push(validConnection);

    const secretDetails = "Detailed Google token parsing failure description trace logs";
    const initiateResumableUpload = async () => {
      throw new Error(secretDetails);
    };

    try {
      await GoogleDriveUploadInitiationService.initiateGDUpload(validUserId, validInitiationInput, {
        ...defaultDeps,
        initiateResumableUpload,
      });
    } catch {
      // expected
    }

    const createdAsset = mockAssets[0];
    assert(createdAsset !== undefined, "Asset should be created");
    if (createdAsset.failureMessage === null) {
      throw new Error("Expected a sanitized failure message.");
    }
    assert(createdAsset.failureMessage === "Google Drive resumable upload initiation failed.", `Expected constant error message, got: ${createdAsset.failureMessage}`);
    assert(!createdAsset.failureMessage.includes(secretDetails), "Provider error details must not leak into failureMessage");
    console.log("Test 8 Passed: Provider error body is not stored in failureMessage [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 8 Failed:", err);
  }

  // Test 9: Provider error body is not returned or thrown
  try {
    resetMockDb();
    mockUsers.push(validUser);
    mockConnections.push(validConnection);

    const secretDetails = "Detailed Google token parsing failure description trace logs";
    const initiateResumableUpload = async () => {
      throw new Error(secretDetails);
    };

    let failed = false;
    try {
      await GoogleDriveUploadInitiationService.initiateGDUpload(validUserId, validInitiationInput, {
        ...defaultDeps,
        initiateResumableUpload,
      });
    } catch (err: unknown) {
      failed = true;
      const msg = err instanceof Error ? err.message : String(err);
      assert(msg === "GOOGLE_DRIVE_INITIATION_FAILED", `Expected GOOGLE_DRIVE_INITIATION_FAILED error message, got: ${msg}`);
      assert(!msg.includes(secretDetails), "Provider error details must not leak in thrown message");
    }
    assert(failed, "Should fail initiation");
    console.log("Test 9 Passed: Provider error body is not returned or thrown [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 9 Failed:", err);
  }

  // Test 10: Access token, refresh token and session URI are not leaked on failure
  try {
    resetMockDb();
    mockUsers.push(validUser);
    mockConnections.push(validConnection);

    const initiateResumableUpload = async () => {
      throw new Error("Initiation failed.");
    };

    let failed = false;
    try {
      await GoogleDriveUploadInitiationService.initiateGDUpload(validUserId, validInitiationInput, {
        ...defaultDeps,
        initiateResumableUpload,
      });
    } catch (err: unknown) {
      failed = true;
      const msg = err instanceof Error ? err.message : String(err);
      assert(!msg.includes("access-token-999"), "Access token should not leak in error message");
      assert(!msg.includes("refresh-token-abc"), "Refresh token should not leak in error message");
    }
    assert(failed, "Should fail");

    const createdAsset = mockAssets[0];
    assert(createdAsset !== undefined, "Asset should be created");
    assert(createdAsset.status === "FAILED", "Asset status must be FAILED");
    assert(createdAsset.failureMessage !== null && !createdAsset.failureMessage.includes("access-token"), "Access token should not leak in database record");

    console.log("Test 10 Passed: Access token, refresh token and session URI are not leaked on failure [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 10 Failed:", err);
  }

  // Test 11: Existing successful Google Drive replay still works
  try {
    resetMockDb();
    mockUsers.push(validUser);
    mockConnections.push(validConnection);

    const requestFingerprint = UploadSessionService.generateRequestFingerprint(
      validInitiationInput.originalName,
      validInitiationInput.expectedSize,
      validInitiationInput.declaredMimeType
    );

    // Seed unexpired GD asset and session
    const gdAsset: UploadAsset = {
      id: "gd-asset-123",
      userId: validUserId,
      idempotencyKey: validInitiationInput.idempotencyKey,
      requestFingerprint,
      provider: "GOOGLE_DRIVE",
      bucket: "bucket",
      objectKey: "key",
      originalName: validInitiationInput.originalName,
      expectedSize: validInitiationInput.expectedSize,
      actualSize: null,
      declaredMimeType: validInitiationInput.declaredMimeType,
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
    mockAssets.push(gdAsset);

    const envelope = "enc:https://www.googleapis.com/session-abc";

    const validSession: UploadSession = {
      uploadAssetId: gdAsset.id,
      encryptionKeyVersion: "1",
      encryptedProviderSessionId: envelope,
      encryptedCompletedParts: "enc:[]",
      expiresAt: new Date(Date.now() + 100000),
      lastActivityAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockSessions.push(validSession);

    const res = await GoogleDriveUploadInitiationService.initiateGDUpload(validUserId, validInitiationInput, defaultDeps);
    assert(res.sessionUri === "https://www.googleapis.com/session-abc", "Replayed sessionUri mismatch");
    assert(res.idempotentReplay === true, "Should set idempotentReplay to true");
    console.log("Test 11 Passed: Existing successful Google Drive replay still works [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 11 Failed:", err);
  }

  // Test 12: Existing R2 route fallback behavior remains unchanged
  try {
    resetMockDb();
    const validUserIdUuid = crypto.randomUUID();
    const uuidUser = makeUser({ id: validUserIdUuid });
    mockUsers.push(uuidUser);
    // User has no Google Drive connection config

    const mockRequestPayload = {
      filename: "video.mp4",
      expectedSize: "10485760",
      declaredMimeType: "video/mp4",
    };

    const getActiveConnection = async () => null;

    let gdInitiateCalled = false;
    const mockInitiateGDUpload: typeof GoogleDriveUploadInitiationService.initiateGDUpload = async () => {
      gdInitiateCalled = true;
      return {
        assetId: "gd-asset",
        provider: "GOOGLE_DRIVE",
        sessionUri: "uri",
        filename: "video.mp4",
        mimeType: "video/mp4",
        totalBytes: 10485760,
        idempotentReplay: false,
      };
    };

    const mockR2Asset = {
      id: crypto.randomUUID(),
      originalName: "video.mp4",
      expectedSize: "10485760",
      declaredMimeType: "video/mp4",
      status: "UPLOADING",
      uploadExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      createdAt: new Date().toISOString(),
    };

    type R2InitiationData =
      Parameters<typeof UploadInitiationService.initiateFlow>[1];

    const r2Calls: Array<{
      userId: string;
      data: R2InitiationData;
    }> = [];

    const mockInitiateR2Upload: typeof UploadInitiationService.initiateFlow = async (
      userIdArg,
      dataArg
    ) => {
      r2Calls.push({
        userId: userIdArg,
        data: dataArg,
      });
      return {
        asset: mockR2Asset,
        idempotentReplay: false,
      };
    };

    const response = await handleInitiateUpload(validUserIdUuid, "key-r2", mockRequestPayload, {
      getActiveConnection,
      initiateGDUpload: mockInitiateGDUpload,
      initiateR2Upload: mockInitiateR2Upload,
    });

    assert(response.status === 201 || response.status === 200, `Expected 201/200, got ${response.status}`);
    assert(!gdInitiateCalled, "Google Drive flow should not be called when connection is missing");
    assert(
      r2Calls.length === 1,
      `Expected R2 initiate flow to be called once, called: ${r2Calls.length}`
    );

    const firstR2Call = r2Calls[0];

    if (!firstR2Call) {
      throw new Error("Expected one captured R2 initiation call.");
    }

    assert(
      firstR2Call.userId === validUserIdUuid,
      "Passed R2 userId mismatch"
    );
    assert(
      firstR2Call.data.idempotencyKey === "key-r2",
      "Idempotency key mismatch"
    );
    assert(
      firstR2Call.data.originalName === "video.mp4",
      "Original name mismatch"
    );
    assert(
      firstR2Call.data.expectedSize === BigInt(10485760),
      "Expected size mismatch"
    );
    assert(
      firstR2Call.data.declaredMimeType === "video/mp4",
      "Declared mime type mismatch"
    );

    const json = await response.json();
    assert(json.provider === "R2", `Expected provider R2, got ${json.provider}`);
    assert(json.assetId === mockR2Asset.id, "assetId mismatch");
    assert(json.filename === mockR2Asset.originalName, "filename mismatch");
    assert(json.expectedSize === mockR2Asset.expectedSize, "expectedSize mismatch");
    assert(json.declaredMimeType === mockR2Asset.declaredMimeType, "declaredMimeType mismatch");
    assert(json.status === mockR2Asset.status, "status mismatch");
    assert(json.uploadExpiresAt === mockR2Asset.uploadExpiresAt, "uploadExpiresAt mismatch");
    assert(json.createdAt === mockR2Asset.createdAt, "createdAt mismatch");

    console.log("Test 12 Passed: Existing R2 route fallback behavior remains unchanged [✓]");
    passedCount++;
  } catch (err) {
    console.error("Test 12 Failed:", err);
  }

  console.log(`\nGoogle Drive Upload Initiation Integration Validation complete. Passed: ${passedCount}/12`);

  if (passedCount !== 12) {
    console.error("ERROR: Not all validation tests passed.");
    process.exit(1);
  } else {
    console.log("SUCCESS: All initiation integration constraints verified successfully.");
    process.exit(0);
  }
}

runTests().catch((err: unknown) => {
  const errorMsg = err instanceof Error ? err.message : String(err);
  console.error("Fatal error in upload initiation integration test suite:", errorMsg);
  process.exit(1);
});
