import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { User, UserRole, UserStatus, UserApprovalStatus } from "@prisma/client";
import { getGoogleDriveConfig } from "../src/lib/google-drive/google-drive-config";
import {
  encryptRefreshToken,
  decryptRefreshToken,
} from "../src/lib/google-drive/google-drive-token-crypto";
import {
  disconnectConnection,
  GoogleDriveConnectionRecord,
} from "../src/lib/google-drive/google-drive-connection-repository";
import {
  generateOAuthState,
  verifyOAuthState,
} from "../src/lib/google-drive/google-drive-oauth-state";
import { handleInitiate } from "../src/app/api/auth/google-drive/initiate/route";
import { handleCallback, CallbackDependencies, GoogleDriveConnectAuditInput } from "../src/app/api/auth/google-drive/callback/route";
import { getAccessTokenFromRefreshToken, GoogleDriveAccessTokenClient } from "../src/lib/google-drive/google-drive-oauth-client";

type UpsertDataInput = NonNullable<Parameters<NonNullable<CallbackDependencies["upsertConn"]>>[1]>;
import { handleStatus } from "../src/app/api/auth/google-drive/status/route";
import { handleDisconnect } from "../src/app/api/auth/google-drive/disconnect/route";
import { prisma as defaultPrisma } from "../src/lib/prisma-client";

// --- CUSTOM TYPES ---
interface MockConnection {
  id: string;
  userId: string;
  encryptedRefreshToken: string;
  refreshTokenKeyVersion: string;
  googleAccountEmail: string | null;
  driveFolderId: string | null;
  connectedAt: Date;
  updatedAt: Date;
  revokedAt: Date | null;
}

// --- MOCK DATABASE STATE ---
const mockDb: {
  connection: MockConnection | null;
  auditLog: { action: string; details: string; userId: string }[];
} = {
  connection: null,
  auditLog: [],
};

const mockPrisma = {
  googleDriveConnection: {
    findUnique: async (args: { where: { userId: string } }): Promise<MockConnection | null> => {
      if (mockDb.connection && mockDb.connection.userId === args.where.userId) {
        return mockDb.connection;
      }
      return null;
    },
    upsert: async (args: {
      where: { userId: string };
      update: {
        encryptedRefreshToken: string;
        refreshTokenKeyVersion: string;
        googleAccountEmail: string | null;
        driveFolderId: string | null;
        connectedAt: Date;
        revokedAt: Date | null;
        updatedAt: Date;
      };
      create: {
        userId: string;
        encryptedRefreshToken: string;
        refreshTokenKeyVersion: string;
        googleAccountEmail: string | null;
        driveFolderId: string | null;
        connectedAt: Date;
        revokedAt: Date | null;
      };
    }): Promise<MockConnection> => {
      const existing = mockDb.connection && mockDb.connection.userId === args.where.userId;
      const data: MockConnection = existing
        ? {
            ...mockDb.connection!,
            ...args.update,
            googleAccountEmail: args.update.googleAccountEmail ?? mockDb.connection!.googleAccountEmail,
            driveFolderId: args.update.driveFolderId ?? mockDb.connection!.driveFolderId,
          }
        : {
            id: crypto.randomUUID(),
            userId: args.create.userId,
            encryptedRefreshToken: args.create.encryptedRefreshToken,
            refreshTokenKeyVersion: args.create.refreshTokenKeyVersion,
            googleAccountEmail: args.create.googleAccountEmail ?? null,
            driveFolderId: args.create.driveFolderId ?? null,
            connectedAt: args.create.connectedAt,
            updatedAt: new Date(),
            revokedAt: args.create.revokedAt,
          };
      mockDb.connection = data;
      return data;
    },
    update: async (args: {
      where: { userId: string };
      data: {
        encryptedRefreshToken?: string;
        revokedAt?: Date | null;
        updatedAt?: Date;
      };
    }): Promise<MockConnection> => {
      if (mockDb.connection && mockDb.connection.userId === args.where.userId) {
        mockDb.connection = {
          ...mockDb.connection,
          ...args.data,
        };
        return mockDb.connection;
      }
      throw new Error("Record not found");
    },
  },
};

const fakePrismaClient = mockPrisma as unknown as typeof defaultPrisma;

const fakeProvisionFolder: NonNullable<
  CallbackDependencies["provisionFolder"]
> = async () => ({
  folderId: "test-folder-id",
  folderName: "Test Folder",
});

// --- CONFIG MOCKS ---
const testConfig = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  redirectUri: "http://localhost:3000/api/auth/google-drive/callback",
  encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  ownerUserId: "owner-admin-uuid",
};

const mockOwnerAdmin: User = {
  id: "owner-admin-uuid",
  email: "owner@domain.com",
  passwordHash: "hash",
  name: "Owner Admin",
  role: UserRole.ADMIN,
  status: UserStatus.ACTIVE,
  approvalStatus: UserApprovalStatus.APPROVED,
  approvedAt: new Date(),
  approvedById: null,
  rejectedAt: null,
  rejectionReason: null,
  registrationIp: "127.0.0.1",
  lastLoginAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockOrdinaryUser: User = {
  id: "ordinary-user-uuid",
  email: "user@domain.com",
  passwordHash: "hash",
  name: "User",
  role: UserRole.USER,
  status: UserStatus.ACTIVE,
  approvalStatus: UserApprovalStatus.APPROVED,
  approvedAt: new Date(),
  approvedById: null,
  rejectedAt: null,
  rejectionReason: null,
  registrationIp: "127.0.0.1",
  lastLoginAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockOtherAdmin: User = {
  id: "other-admin-uuid",
  email: "admin2@domain.com",
  passwordHash: "hash",
  name: "Other Admin",
  role: UserRole.ADMIN,
  status: UserStatus.ACTIVE,
  approvalStatus: UserApprovalStatus.APPROVED,
  approvedAt: new Date(),
  approvedById: null,
  rejectedAt: null,
  rejectionReason: null,
  registrationIp: "127.0.0.1",
  lastLoginAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
};

// --- ASSERT HELPER ---
function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertCookieCleared(res: NextResponse) {
  const setCookie = res.headers.get("Set-Cookie");
  assert(setCookie !== null && setCookie.includes("google_drive_oauth_state_nonce="), "Expected state nonce cookie to be cleared on NextResponse");
}

function resetMocks() {
  mockDb.connection = null;
  mockDb.auditLog = [];
}

async function runTests() {
  console.log("Running Updated Google Drive OAuth & Credential Security Tests...\n");
  let passedCount = 0;

  // Environment setup
  process.env.GOOGLE_DRIVE_CLIENT_ID = testConfig.clientId;
  process.env.GOOGLE_DRIVE_CLIENT_SECRET = testConfig.clientSecret;
  process.env.GOOGLE_DRIVE_REDIRECT_URI = testConfig.redirectUri;
  process.env.GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY = testConfig.encryptionKey;
  process.env.GOOGLE_DRIVE_STORAGE_OWNER_USER_ID = testConfig.ownerUserId;
  process.env.STORAGE_PROVIDER = "GOOGLE_DRIVE";

  // Test 1: Missing configuration fails closed
  try {
    resetMocks();
    process.env.GOOGLE_DRIVE_CLIENT_ID = "";
    try {
      getGoogleDriveConfig();
      assert(false, "Should fail when Client ID is missing");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      assert(msg.includes("GOOGLE_DRIVE_CLIENT_ID"), "Error message mismatch");
    }
    process.env.GOOGLE_DRIVE_CLIENT_ID = testConfig.clientId;
    console.log("Test 1 Passed: Missing configuration fails closed [✓]");
    passedCount++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Test 1 Failed:", msg);
  }

  // Test 2: Non-authenticated user rejected
  try {
    resetMocks();
    const req = new NextRequest("http://localhost:3000/api/auth/google-drive/initiate");
    const res = await handleInitiate(req, {
      getSessionUser: async () => null,
      getConfig: () => testConfig,
    });
    assert(res.status === 401, "Expected 401 status");
    const body = await res.json() as { error: string };
    assert(body.error === "UNAUTHENTICATED", "Expected UNAUTHENTICATED error code");
    console.log("Test 2 Passed: Non-authenticated user rejected [✓]");
    passedCount++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Test 2 Failed:", msg);
  }

  // Test 3: ACTIVE + APPROVED USER is permitted
  try {
    resetMocks();
    const req = new NextRequest("http://localhost:3000/api/auth/google-drive/initiate");
    const res = await handleInitiate(req, {
      getSessionUser: async () => mockOrdinaryUser,
      getConfig: () => testConfig,
      getActiveConnection: async (uid) => {
        assert(uid === mockOrdinaryUser.id, "Expected getActiveConnection to be called with authenticated user ID");
        return null;
      },
      generateState: (uid) => {
        assert(uid === mockOrdinaryUser.id, "Expected generateState to be called with authenticated user ID");
        return { state: "mock-state", nonce: "mock-nonce" };
      },
      setCookie: () => {},
    });
    assert(res.status === 307 || res.status === 302, `Expected 307/302 redirect, got ${res.status}`);
    const location = res.headers.get("location") || "";
    assert(location.includes("scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.file"), "Requested OAuth scope must remain drive.file");
    console.log("Test 3 Passed: ACTIVE + APPROVED USER is permitted [✓]");
    passedCount++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Test 3 Failed:", msg);
  }

  // Test 4: ACTIVE + APPROVED ADMIN is permitted
  try {
    resetMocks();
    const req = new NextRequest("http://localhost:3000/api/auth/google-drive/initiate");
    const res = await handleInitiate(req, {
      getSessionUser: async () => mockOtherAdmin,
      getConfig: () => testConfig,
      getActiveConnection: async (uid) => {
        assert(uid === mockOtherAdmin.id, "Expected getActiveConnection to be called with authenticated user ID");
        return null;
      },
      generateState: (uid) => {
        assert(uid === mockOtherAdmin.id, "Expected generateState to be called with authenticated user ID");
        return { state: "mock-state", nonce: "mock-nonce" };
      },
      setCookie: () => {},
    });
    assert(res.status === 307 || res.status === 302, `Expected 307/302 redirect, got ${res.status}`);
    console.log("Test 4 Passed: ACTIVE + APPROVED ADMIN is permitted [✓]");
    passedCount++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Test 4 Failed:", msg);
  }

  // Test 5: SUSPENDED user is denied
  try {
    resetMocks();
    const inactiveUser = { ...mockOrdinaryUser, status: UserStatus.SUSPENDED };
    const req = new NextRequest("http://localhost:3000/api/auth/google-drive/initiate");
    const res = await handleInitiate(req, {
      getSessionUser: async () => inactiveUser,
      getConfig: () => testConfig,
    });
    assert(res.status === 403, "Expected 403 status");
    console.log("Test 5 Passed: SUSPENDED user is denied [✓]");
    passedCount++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Test 5 Failed:", msg);
  }

  // Test 6: PENDING, REJECTED, or otherwise unapproved user is denied
  try {
    resetMocks();
    const pendingUser = { ...mockOrdinaryUser, approvalStatus: UserApprovalStatus.PENDING };
    const req1 = new NextRequest("http://localhost:3000/api/auth/google-drive/initiate");
    const res1 = await handleInitiate(req1, {
      getSessionUser: async () => pendingUser,
      getConfig: () => testConfig,
    });
    assert(res1.status === 403, "Expected 403 status for pending user");

    const rejectedUser = { ...mockOrdinaryUser, approvalStatus: UserApprovalStatus.REJECTED };
    const req2 = new NextRequest("http://localhost:3000/api/auth/google-drive/initiate");
    const res2 = await handleInitiate(req2, {
      getSessionUser: async () => rejectedUser,
      getConfig: () => testConfig,
    });
    assert(res2.status === 403, "Expected 403 status for rejected user");

    console.log("Test 6 Passed: PENDING, REJECTED, or otherwise unapproved user is denied [✓]");
    passedCount++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Test 6 Failed:", msg);
  }

  // Test 7: OAuth state is random
  try {
    resetMocks();
    const state1 = generateOAuthState(mockOwnerAdmin.id);
    const state2 = generateOAuthState(mockOwnerAdmin.id);
    assert(state1.state !== state2.state, "States should not be identical");
    assert(state1.nonce !== state2.nonce, "Nonces should not be identical");
    console.log("Test 7 Passed: OAuth state and nonce are random [✓]");
    passedCount++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Test 7 Failed:", msg);
  }

  // Test 8: State tampering rejected
  try {
    resetMocks();
    const { state, nonce } = generateOAuthState(mockOwnerAdmin.id);
    const tampered = state + "a";
    const verified = verifyOAuthState(tampered, nonce, mockOwnerAdmin.id, testConfig.ownerUserId);
    assert(verified === false, "Tampered state verification must return false");
    console.log("Test 8 Passed: State tampering rejected [✓]");
    passedCount++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Test 8 Failed:", msg);
  }

  // Test 9: Expired state rejected
  try {
    resetMocks();
    const expiredPayload = {
      version: "v1",
      userId: mockOwnerAdmin.id,
      purpose: "GOOGLE_DRIVE",
      nonce: "nonce",
      issuedAt: Date.now() - 20 * 60 * 1000,
      expiresAt: Date.now() - 10 * 60 * 1000, // already expired
    };
    const expiredState = encryptRefreshToken(JSON.stringify(expiredPayload), testConfig.encryptionKey);
    const verified = verifyOAuthState(expiredState, "nonce", mockOwnerAdmin.id, testConfig.ownerUserId);
    assert(verified === false, "Expired state verification must return false");
    console.log("Test 9 Passed: Expired state rejected [✓]");
    passedCount++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Test 9 Failed:", msg);
  }

  // Test 10: Wrong user rejected
  try {
    resetMocks();
    const { state, nonce } = generateOAuthState(mockOwnerAdmin.id);
    const verified = verifyOAuthState(state, nonce, "other-user-uuid", testConfig.ownerUserId);
    assert(verified === false, "State verified for wrong user must return false");
    console.log("Test 10 Passed: Wrong user rejected [✓]");
    passedCount++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Test 10 Failed:", msg);
  }

  // Test 11: Wrong purpose rejected
  try {
    resetMocks();
    const wrongPurposePayload = {
      version: "v1",
      userId: mockOwnerAdmin.id,
      purpose: "FACEBOOK_CONNECT",
      nonce: "nonce",
      issuedAt: Date.now(),
      expiresAt: Date.now() + 10000,
    };
    const state = encryptRefreshToken(JSON.stringify(wrongPurposePayload), testConfig.encryptionKey);
    const verified = verifyOAuthState(state, "nonce", mockOwnerAdmin.id, testConfig.ownerUserId);
    assert(verified === false, "State verified for wrong purpose must return false");
    console.log("Test 11 Passed: Wrong purpose rejected [✓]");
    passedCount++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Test 11 Failed:", msg);
  }

  // Test 12: Timing safe nonce verification checks
  try {
    resetMocks();
    const { state, nonce } = generateOAuthState(mockOwnerAdmin.id);
    const v1 = verifyOAuthState(state, nonce, mockOwnerAdmin.id, testConfig.ownerUserId);
    assert(v1 === true, "Valid nonce should succeed");

    const v2 = verifyOAuthState(state, nonce + "diff", mockOwnerAdmin.id, testConfig.ownerUserId);
    assert(v2 === false, "Different length nonce must fail");

    const v3 = verifyOAuthState(state, nonce.substring(0, nonce.length - 1) + (nonce.endsWith("a") ? "b" : "a"), mockOwnerAdmin.id, testConfig.ownerUserId);
    assert(v3 === false, "Same length invalid nonce must fail");

    console.log("Test 12 Passed: Timing safe nonce verification [✓]");
    passedCount++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Test 12 Failed:", msg);
  }

  // Test 13: Missing callback code rejected
  try {
    resetMocks();
    const { state, nonce } = generateOAuthState(mockOwnerAdmin.id);
    const req = new NextRequest(`http://localhost:3000/api/auth/google-drive/callback?state=${state}`, {
      headers: {
        Cookie: `google_drive_oauth_state_nonce=${nonce}`
      }
    });
    const res = await handleCallback(req, {
      getSessionUser: async () => mockOwnerAdmin,
      getConfig: () => testConfig,
      verifyState: () => true,
      writeAuditLog: async () => {},
    });
    assert(res.headers.get("location")?.includes("error=google_oauth_code_missing") === true, "Expected missing code error redirect");
    assertCookieCleared(res);
    console.log("Test 13 Passed: Missing callback code rejected [✓]");
    passedCount++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Test 13 Failed:", msg);
  }

  // Test 14: Google callback error rejected safely
  try {
    resetMocks();
    const { state, nonce } = generateOAuthState(mockOwnerAdmin.id);
    const req = new NextRequest(`http://localhost:3000/api/auth/google-drive/callback?state=${state}&error=access_denied`, {
      headers: {
        Cookie: `google_drive_oauth_state_nonce=${nonce}`
      }
    });
    const res = await handleCallback(req, {
      getSessionUser: async () => mockOwnerAdmin,
      getConfig: () => testConfig,
      verifyState: () => true,
      writeAuditLog: async () => {},
    });
    assert(res.headers.get("location")?.includes("error=google_oauth_cancelled") === true, "Expected cancelled error redirect");
    assertCookieCleared(res);
    console.log("Test 14 Passed: Google callback error rejected safely [✓]");
    passedCount++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Test 14 Failed:", msg);
  }

  // Test 15: Token endpoint non-200 rejected safely
  try {
    resetMocks();
    const { state, nonce } = generateOAuthState(mockOwnerAdmin.id);
    const req = new NextRequest(`http://localhost:3000/api/auth/google-drive/callback?state=${state}&code=mock-code`, {
      headers: {
        Cookie: `google_drive_oauth_state_nonce=${nonce}`
      }
    });
    const res = await handleCallback(req, {
      getSessionUser: async () => mockOwnerAdmin,
      getConfig: () => testConfig,
      verifyState: () => true,
      exchangeCode: async () => {
        throw new Error("Invalid token endpoint exchange request");
      },
      writeAuditLog: async () => {},
    });
    assert(res.headers.get("location")?.includes("error=google_token_exchange_failed") === true, "Expected exchange failure redirect");
    assertCookieCleared(res);
    console.log("Test 15 Passed: Token endpoint non-200 rejected safely [✓]");
    passedCount++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Test 15 Failed:", msg);
  }

  // Test 16: Missing refresh token on first connection rejected
  try {
    resetMocks();
    const { state, nonce } = generateOAuthState(mockOwnerAdmin.id);
    const req = new NextRequest(`http://localhost:3000/api/auth/google-drive/callback?state=${state}&code=mock-code`, {
      headers: {
        Cookie: `google_drive_oauth_state_nonce=${nonce}`
      }
    });
    const res = await handleCallback(req, {
      getSessionUser: async () => mockOwnerAdmin,
      getConfig: () => testConfig,
      verifyState: () => true,
      exchangeCode: async () => ({
        accessToken: "access-token",
        refreshToken: null,
        expiryDate: Date.now() + 3600,
      }),
      getActiveConnection: async () => null, // first connection
      writeAuditLog: async () => {},
    });
    assert(res.headers.get("location")?.includes("error=google_refresh_token_missing") === true, "Expected refresh token missing redirect");
    assertCookieCleared(res);
    console.log("Test 16 Passed: Missing refresh token on first connection rejected [✓]");
    passedCount++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Test 16 Failed:", msg);
  }

  // Test 17: Existing token preserved when reconnect response omits refresh token
  try {
    resetMocks();
    const { state, nonce } = generateOAuthState(mockOwnerAdmin.id);
    const activeConn: GoogleDriveConnectionRecord = {
      id: "connection-id",
      userId: mockOwnerAdmin.id,
      encryptedRefreshToken: "v1:existing-token-envelope",
      refreshTokenKeyVersion: "1",
      googleAccountEmail: null,
      driveFolderId: null,
      connectedAt: new Date(),
      updatedAt: new Date(),
      revokedAt: null,
    };
    const req = new NextRequest(`http://localhost:3000/api/auth/google-drive/callback?state=${state}&code=mock-code`, {
      headers: {
        Cookie: `google_drive_oauth_state_nonce=${nonce}`
      }
    });

    const capture17: {
      value: UpsertDataInput | null;
    } = {
      value: null,
    };
    const auditLogs17: GoogleDriveConnectAuditInput[] = [];
    const res = await handleCallback(req, {
      getSessionUser: async () => mockOwnerAdmin,
      getConfig: () => testConfig,
      verifyState: () => true,
      exchangeCode: async () => ({
        accessToken: "access-token",
        refreshToken: null, // Google does not send new refresh token on reconnect
        expiryDate: Date.now() + 3600,
      }),
      getActiveConnection: async () => activeConn,
      upsertConn: async (uid, data) => {
        capture17.value = data;
        return activeConn;
      },
      provisionFolder: fakeProvisionFolder,
      writeAuditLog: async (input) => {
        auditLogs17.push(input);
      },
    });
    const captured17 = capture17.value;
    if (captured17 === null) {
      throw new Error("Expected repository input to be captured.");
    }
    assert(res.headers.get("location")?.includes("success=google_drive_connected") === true, "Expected success redirect");
    assert(captured17.encryptedRefreshToken === "v1:existing-token-envelope", "Should preserve existing refresh token");
    assertCookieCleared(res);
    assert(auditLogs17.length === 1, "Expected exactly 1 audit call");
    assert(auditLogs17[0].action === "GOOGLE_DRIVE_CONNECT", "Action should be GOOGLE_DRIVE_CONNECT");
    assert(auditLogs17[0].userId === mockOwnerAdmin.id, "User ID should match");
    assert(auditLogs17[0].details.includes("whether Google returned a new refresh token: no"), "Details should say refresh token: no");
    assert(auditLogs17[0].details.includes("drive.file"), "Details should contain drive.file");
    assert(!auditLogs17[0].details.includes("access-token"), "Details must not leak access token");
    console.log("Test 17 Passed: Existing token preserved when reconnect response omits refresh token [✓]");
    passedCount++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Test 17 Failed:", msg);
  }

  // Test 18: Refresh token encrypted before repository write
  try {
    resetMocks();
    const { state, nonce } = generateOAuthState(mockOwnerAdmin.id);
    const req = new NextRequest(`http://localhost:3000/api/auth/google-drive/callback?state=${state}&code=mock-code`, {
      headers: {
        Cookie: `google_drive_oauth_state_nonce=${nonce}`
      }
    });

    const capture18: {
      value: UpsertDataInput | null;
    } = {
      value: null,
    };
    const auditLogs18: GoogleDriveConnectAuditInput[] = [];
    const res = await handleCallback(req, {
      getSessionUser: async () => mockOwnerAdmin,
      getConfig: () => testConfig,
      verifyState: () => true,
      exchangeCode: async () => ({
        accessToken: "access-token",
        refreshToken: "new-secret-refresh-token",
        expiryDate: Date.now() + 3600,
      }),
      getActiveConnection: async () => null,
      upsertConn: async (uid, data) => {
        capture18.value = data;
        return {
          id: "connection-id",
          userId: uid,
          ...data,
          connectedAt: new Date(),
          updatedAt: new Date(),
          revokedAt: null,
        } as GoogleDriveConnectionRecord;
      },
      provisionFolder: fakeProvisionFolder,
      writeAuditLog: async (input) => {
        auditLogs18.push(input);
      },
    });
    const captured18 = capture18.value;
    if (captured18 === null) {
      throw new Error("Expected repository input to be captured.");
    }
    assert(res.headers.get("location")?.includes("success=google_drive_connected") === true, "Expected success redirect");
    assert(captured18.encryptedRefreshToken.startsWith("v1:"), "Should start with version envelope prefix");
    assert(captured18.encryptedRefreshToken !== "new-secret-refresh-token", "Token must be encrypted");
    assertCookieCleared(res);
    assert(auditLogs18.length === 1, "Expected exactly 1 audit call");
    assert(auditLogs18[0].action === "GOOGLE_DRIVE_CONNECT", "Action should be GOOGLE_DRIVE_CONNECT");
    assert(auditLogs18[0].userId === mockOwnerAdmin.id, "User ID should match");
    assert(auditLogs18[0].details.includes("whether Google returned a new refresh token: yes"), "Details should say refresh token: yes");
    assert(auditLogs18[0].details.includes("drive.file"), "Details should contain drive.file");
    assert(!auditLogs18[0].details.includes("new-secret-refresh-token"), "Details must not contain new-secret-refresh-token");
    assert(!auditLogs18[0].details.includes("access-token"), "Details must not contain access token");
    console.log("Test 18 Passed: Refresh token encrypted before repository write [✓]");
    passedCount++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Test 18 Failed:", msg);
  }

  // Test 19: Wrong encryption key fails closed
  try {
    resetMocks();
    const plainToken = "my-secret-token";
    const encrypted = encryptRefreshToken(plainToken, testConfig.encryptionKey);
    const wrongKey = "9923456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    try {
      decryptRefreshToken(encrypted, wrongKey);
      assert(false, "Decryption with wrong key must fail");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      assert(msg.includes("Decryption failed"), "Expected decryption failure error message");
    }
    console.log("Test 19 Passed: Wrong encryption key fails closed [✓]");
    passedCount++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Test 19 Failed:", msg);
  }

  // Test 20: Malformed ciphertext fails closed
  try {
    resetMocks();
    const malformed = "v1:abcdef:abcdef:abcdef";
    try {
      decryptRefreshToken(malformed, testConfig.encryptionKey);
      assert(false, "Malformed ciphertext envelope decryption must fail");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      assert(msg.includes("Decryption failed"), "Expected decryption failure error message");
    }
    console.log("Test 20 Passed: Malformed ciphertext fails closed [✓]");
    passedCount++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Test 20 Failed:", msg);
  }

  // Test 21: Status response excludes all secrets and folder ID
  try {
    resetMocks();
    const mockConn: GoogleDriveConnectionRecord = {
      id: "connection-primary-key-uuid",
      userId: mockOwnerAdmin.id,
      encryptedRefreshToken: "v1:encrypted-token",
      refreshTokenKeyVersion: "1",
      googleAccountEmail: null,
      driveFolderId: "folder-uuid-12345",
      connectedAt: new Date("2026-07-15T12:00:00Z"),
      updatedAt: new Date("2026-07-15T12:05:00Z"),
      revokedAt: null,
    };
    const req = new NextRequest("http://localhost:3000/api/auth/google-drive/status");
    const res = await handleStatus(req, {
      getSessionUser: async () => mockOwnerAdmin,
      getConfig: () => testConfig,
      getConnection: async () => mockConn,
    });
    assert(res.status === 200, "Expected status 200");
    const body = await res.json() as Record<string, unknown>;
    assert(body.connected === true, "Expected connected true");
    assert(body.revoked === false, "Expected revoked false");
    assert(body.googleAccountEmail === null, "Expected email null");
    assert(body.driveFolderConfigured === true, "Expected drive folder config status mismatch");

    // Safety assertions
    assert(body.id === undefined, "Should not return connection primary key ID");
    assert(body.encryptedRefreshToken === undefined, "Should not return encryptedRefreshToken");
    assert(body.driveFolderId === undefined, "Should not return folder ID");
    console.log("Test 21 Passed: Status response excludes all secrets and folder ID [✓]");
    passedCount++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Test 21 Failed:", msg);
  }

  // Test 22: Disconnect is permitted for any active approved user and is idempotent
  try {
    resetMocks();
    const reqSuspended = new NextRequest("http://localhost:3000/api/auth/google-drive/disconnect", { method: "POST" });
    const resSuspended = await handleDisconnect(reqSuspended, {
      verifySession: async () => ({ ...mockOtherAdmin, status: UserStatus.SUSPENDED }),
      getConfig: () => testConfig,
    });
    assert(resSuspended.status === 403, "Expected 403 for suspended user disconnect request");

    // Idempotent check for active approved user
    const reqIdempotent = new NextRequest("http://localhost:3000/api/auth/google-drive/disconnect", { method: "POST" });
    const resIdempotent = await handleDisconnect(reqIdempotent, {
      verifySession: async () => mockOtherAdmin,
      getConfig: () => testConfig,
      disconnect: async () => null,
    });
    assert(resIdempotent.status === 200, "Expected 200 status for idempotent disconnect");
    const body = await resIdempotent.json() as { disconnected: boolean };
    assert(body.disconnected === true, "Expected disconnected true");
    console.log("Test 22 Passed: Disconnect is permitted for active users and idempotent [✓]");
    passedCount++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Test 22 Failed:", msg);
  }

  // Test 23: Disconnect writes an AES-GCM encrypted tombstone, not REVOKED plaintext
  try {
    resetMocks();
    mockDb.connection = {
      id: "connection-id",
      userId: mockOwnerAdmin.id,
      encryptedRefreshToken: "v1:secret-token-gcm-data",
      refreshTokenKeyVersion: "1",
      googleAccountEmail: null,
      driveFolderId: null,
      connectedAt: new Date(),
      updatedAt: new Date(),
      revokedAt: null,
    };

    const req = new NextRequest("http://localhost:3000/api/auth/google-drive/disconnect", { method: "POST" });
    const res = await handleDisconnect(req, {
      verifySession: async () => mockOwnerAdmin,
      getConfig: () => testConfig,
      disconnect: async (uid) => {
        return await disconnectConnection(uid, fakePrismaClient);
      },
    });
    assert(res.status === 200, "Expected status 200");
    assert(mockDb.connection.encryptedRefreshToken.startsWith("v1:"), "Tombstone must use standard version prefix");
    assert(mockDb.connection.encryptedRefreshToken !== "REVOKED", "Tombstone must be encrypted, not literal plaintext");

    assert(mockDb.connection.revokedAt !== null, "revokedAt timestamp must be set");
    console.log("Test 23 Passed: Disconnect writes GCM encrypted tombstone [✓]");
    passedCount++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Test 23 Failed:", msg);
  }

  // Test 24: Reconnect with new refresh token replaces tombstone
  try {
    resetMocks();
    // Start with a revoked (tombstoned) connection
    mockDb.connection = {
      id: "connection-id",
      userId: mockOwnerAdmin.id,
      encryptedRefreshToken: "v1:tombstone-envelope",
      refreshTokenKeyVersion: "1",
      googleAccountEmail: null,
      driveFolderId: null,
      connectedAt: new Date(),
      updatedAt: new Date(),
      revokedAt: new Date(),
    };

    const { state, nonce } = generateOAuthState(mockOwnerAdmin.id);
    const req = new NextRequest(`http://localhost:3000/api/auth/google-drive/callback?state=${state}&code=mock-code`, {
      headers: {
        Cookie: `google_drive_oauth_state_nonce=${nonce}`
      }
    });

    const capture24: {
      value: UpsertDataInput | null;
    } = {
      value: null,
    };
    const auditLogs24: GoogleDriveConnectAuditInput[] = [];
    const res = await handleCallback(req, {
      getSessionUser: async () => mockOwnerAdmin,
      getConfig: () => testConfig,
      verifyState: () => true,
      exchangeCode: async () => ({
        accessToken: "access-token",
        refreshToken: "brand-new-refresh-token",
        expiryDate: Date.now() + 3600,
      }),
      getActiveConnection: async () => null, // active connection checks returns null when revoked
      upsertConn: async (uid, data) => {
        capture24.value = data;
        return {
          id: "connection-id",
          userId: uid,
          ...data,
          connectedAt: new Date(),
          updatedAt: new Date(),
          revokedAt: null,
        } as GoogleDriveConnectionRecord;
      },
      provisionFolder: fakeProvisionFolder,
      writeAuditLog: async (input) => {
        auditLogs24.push(input);
      },
    });

    const captured24 = capture24.value;
    if (captured24 === null) {
      throw new Error("Expected repository input to be captured.");
    }
    assert(res.headers.get("location")?.includes("success=google_drive_connected") === true, "Expected success redirect on reconnect");
    assert(captured24.encryptedRefreshToken.startsWith("v1:"), "Should start with version prefix");
    assert(captured24.encryptedRefreshToken !== "v1:tombstone-envelope", "Should replace the tombstone with new encrypted token");

    const decrypted = decryptRefreshToken(captured24.encryptedRefreshToken, testConfig.encryptionKey);
    assert(decrypted === "brand-new-refresh-token", "Should decrypt back to the brand new refresh token");
    assertCookieCleared(res);
    assert(auditLogs24.length === 1, "Expected exactly 1 audit call");
    assert(auditLogs24[0].action === "GOOGLE_DRIVE_CONNECT", "Action should be GOOGLE_DRIVE_CONNECT");
    assert(auditLogs24[0].userId === mockOwnerAdmin.id, "User ID should match");
    assert(auditLogs24[0].details.includes("whether Google returned a new refresh token: yes"), "Details should say refresh token: yes");
    assert(auditLogs24[0].details.includes("drive.file"), "Details should contain drive.file");
    assert(!auditLogs24[0].details.includes("brand-new-refresh-token"), "Details must not contain new refresh token");
    assert(!auditLogs24[0].details.includes("access-token"), "Details must not contain access token");
    console.log("Test 24 Passed: Reconnect replacing tombstone [✓]");
    passedCount++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Test 24 Failed:", msg);
  }

  // Test 25: Connect fails if audit logging fails
  try {
    resetMocks();
    const { state, nonce } = generateOAuthState(mockOwnerAdmin.id);
    const req = new NextRequest(`http://localhost:3000/api/auth/google-drive/callback?state=${state}&code=mock-code`, {
      headers: {
        Cookie: `google_drive_oauth_state_nonce=${nonce}`
      }
    });

    const res = await handleCallback(req, {
      getSessionUser: async () => mockOwnerAdmin,
      getConfig: () => testConfig,
      verifyState: () => true,
      exchangeCode: async () => ({
        accessToken: "access-token",
        refreshToken: "brand-new-refresh-token",
        expiryDate: Date.now() + 3600,
      }),
      getActiveConnection: async () => null,
      upsertConn: async () => {
        return {
          id: "connection-id",
          userId: mockOwnerAdmin.id,
          encryptedRefreshToken: "v1:enc",
          refreshTokenKeyVersion: "1",
          googleAccountEmail: null,
          driveFolderId: null,
          connectedAt: new Date(),
          updatedAt: new Date(),
          revokedAt: null,
        };
      },
      provisionFolder: fakeProvisionFolder,
      writeAuditLog: async () => {
        throw new Error("Audit service unavailable");
      },
    });

    assert(res.headers.get("location")?.includes("error=google_drive_connection_failed") === true, "Expected redirect to connection failed on audit error");
    assertCookieCleared(res);
    console.log("Test 25 Passed: Connect fails if audit logging fails [✓]");
    passedCount++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Test 25 Failed:", msg);
  }

  // Test 26: Empty refresh token is rejected
  try {
    let failed = false;
    try {
      await getAccessTokenFromRefreshToken("");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      assert(msg.includes("Refresh token is required."), "Expected refresh token required error");
      assert(!msg.includes("secret-refresh-token"), "Must not leak secret in error");
      failed = true;
    }
    assert(failed, "Empty refresh token should be rejected");
    console.log("Test 26 Passed: Empty refresh token rejected [✓]");
    passedCount++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Test 26 Failed:", msg);
  }

  // Test 27: Whitespace refresh token is rejected
  try {
    let failed = false;
    try {
      await getAccessTokenFromRefreshToken("   ");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      assert(msg.includes("Refresh token is required."), "Expected refresh token required error");
      failed = true;
    }
    assert(failed, "Whitespace refresh token should be rejected");
    console.log("Test 27 Passed: Whitespace refresh token rejected [✓]");
    passedCount++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Test 27 Failed:", msg);
  }

  // Test 28: Supplied client receives exact refresh token
  try {
    const setCredentialsCapture: {
      value:
        | Parameters<GoogleDriveAccessTokenClient["setCredentials"]>[0]
        | null;
    } = {
      value: null,
    };
    let getAccessTokenCalls = 0;
    const fakeClient: GoogleDriveAccessTokenClient = {
      setCredentials: (creds) => {
        setCredentialsCapture.value = creds;
      },
      getAccessToken: async () => {
        getAccessTokenCalls++;
        return { token: "fake-access-token" };
      },
    };

    const token = await getAccessTokenFromRefreshToken("my-test-refresh-token", fakeClient);
    assert(token === "fake-access-token", "Expected fake-access-token returned");
    assert(
      setCredentialsCapture.value?.refresh_token === "my-test-refresh-token",
      "Client should receive the exact refresh token"
    );
    assert(getAccessTokenCalls === 1, "getAccessToken should be called exactly once");
    console.log("Test 28 Passed: Supplied client receives exact refresh token [✓]");
    passedCount++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Test 28 Failed:", msg);
  }

  // Test 29: Null access token is rejected
  try {
    const fakeClient: GoogleDriveAccessTokenClient = {
      setCredentials: () => {},
      getAccessToken: async () => {
        return { token: null };
      },
    };

    let failed = false;
    try {
      await getAccessTokenFromRefreshToken("my-test-refresh-token", fakeClient);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      assert(msg.includes("Access token missing from Google refresh response."), "Expected missing token error");
      assert(!msg.includes("my-test-refresh-token"), "Must not leak refresh token in error");
      failed = true;
    }
    assert(failed, "Null access token should be rejected");
    console.log("Test 29 Passed: Null access token is rejected [✓]");
    passedCount++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Test 29 Failed:", msg);
  }

  // Test 30: Empty access token is rejected
  try {
    const fakeClient: GoogleDriveAccessTokenClient = {
      setCredentials: () => {},
      getAccessToken: async () => {
        return { token: "" };
      },
    };

    let failed = false;
    try {
      await getAccessTokenFromRefreshToken("my-test-refresh-token", fakeClient);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      assert(msg.includes("Access token missing from Google refresh response."), "Expected missing token error");
      assert(!msg.includes("my-test-refresh-token"), "Must not leak refresh token in error");
      failed = true;
    }
    assert(failed, "Empty access token should be rejected");
    console.log("Test 30 Passed: Empty access token is rejected [✓]");
    passedCount++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Test 30 Failed:", msg);
  }

  // Test 31: Initiate looks up the Drive connection using the authenticated user ID
  try {
    resetMocks();
    let lookedUpUserId = "";
    const req = new NextRequest("http://localhost:3000/api/auth/google-drive/initiate");
    await handleInitiate(req, {
      getSessionUser: async () => mockOrdinaryUser,
      getConfig: () => testConfig,
      getActiveConnection: async (uid) => {
        lookedUpUserId = uid;
        return null;
      },
      generateState: () => ({ state: "mock-state", nonce: "mock-nonce" }),
      setCookie: () => {},
    });
    assert(lookedUpUserId === mockOrdinaryUser.id, `Expected to look up user connection for ${mockOrdinaryUser.id}, got ${lookedUpUserId}`);
    console.log("Test 31 Passed: Initiate looks up connection using authenticated user ID [✓]");
    passedCount++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Test 31 Failed:", msg);
  }

  // Test 32: Callback validates state against the authenticated user
  try {
    resetMocks();
    const { state, nonce } = generateOAuthState(mockOrdinaryUser.id);
    const req = new NextRequest(`http://localhost:3000/api/auth/google-drive/callback?state=${state}&code=mock-code`, {
      headers: {
        Cookie: `google_drive_oauth_state_nonce=${nonce}`
      }
    });

    let stateValidatedExpectedUserId = "";
    const res = await handleCallback(req, {
      getSessionUser: async () => mockOrdinaryUser,
      getConfig: () => testConfig,
      verifyState: (st, cNonce, expectedUid, ownerUid) => {
        stateValidatedExpectedUserId = expectedUid;
        return verifyOAuthState(st, cNonce, expectedUid, ownerUid);
      },
      exchangeCode: async () => ({
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiryDate: Date.now() + 3600,
      }),
      getActiveConnection: async () => null,
      upsertConn: async (uid, data) => ({
        id: "conn-id",
        userId: uid,
        encryptedRefreshToken: data.encryptedRefreshToken,
        refreshTokenKeyVersion: data.refreshTokenKeyVersion,
        googleAccountEmail: data.googleAccountEmail ?? null,
        driveFolderId: data.driveFolderId ?? null,
        connectedAt: new Date(),
        updatedAt: new Date(),
        revokedAt: null,
      }),
      provisionFolder: fakeProvisionFolder,
      writeAuditLog: async () => {},
    });

    assert(stateValidatedExpectedUserId === mockOrdinaryUser.id, `Expected state to be validated against authenticated user ID ${mockOrdinaryUser.id}, got ${stateValidatedExpectedUserId}`);
    assert(res.headers.get("location")?.includes("success=google_drive_connected") === true, "Expected success redirect");
    console.log("Test 32 Passed: Callback validates state against the authenticated user [✓]");
    passedCount++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Test 32 Failed:", msg);
  }

  // Test 33: Callback looks up and saves connection using the authenticated user ID
  try {
    resetMocks();
    const { state, nonce } = generateOAuthState(mockOrdinaryUser.id);
    const req = new NextRequest(`http://localhost:3000/api/auth/google-drive/callback?state=${state}&code=mock-code`, {
      headers: {
        Cookie: `google_drive_oauth_state_nonce=${nonce}`
      }
    });

    let lookedUpUserId = "";
    let savedUserId = "";
    const res = await handleCallback(req, {
      getSessionUser: async () => mockOrdinaryUser,
      getConfig: () => testConfig,
      verifyState: () => true,
      exchangeCode: async () => ({
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiryDate: Date.now() + 3600,
      }),
      getActiveConnection: async (uid) => {
        lookedUpUserId = uid;
        return null;
      },
      upsertConn: async (uid, data) => {
        savedUserId = uid;
        return {
          id: "conn-id",
          userId: uid,
          encryptedRefreshToken: data.encryptedRefreshToken,
          refreshTokenKeyVersion: data.refreshTokenKeyVersion,
          googleAccountEmail: data.googleAccountEmail ?? null,
          driveFolderId: data.driveFolderId ?? null,
          connectedAt: new Date(),
          updatedAt: new Date(),
          revokedAt: null,
        };
      },
      provisionFolder: fakeProvisionFolder,
      writeAuditLog: async () => {},
    });

    assert(lookedUpUserId === mockOrdinaryUser.id, `Expected connection look up for ${mockOrdinaryUser.id}, got ${lookedUpUserId}`);
    assert(savedUserId === mockOrdinaryUser.id, `Expected connection save for ${mockOrdinaryUser.id}, got ${savedUserId}`);
    assert(res.headers.get("location")?.includes("success=google_drive_connected") === true, "Expected success redirect");
    console.log("Test 33 Passed: Callback looks up and saves connection using authenticated user ID [✓]");
    passedCount++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Test 33 Failed:", msg);
  }

  // Test 34: Isolation - Two users cannot read or overwrite each other's Drive connections
  try {
    resetMocks();
    const userA = mockOrdinaryUser;
    const userB = mockOtherAdmin;

    const connectionA: MockConnection = {
      id: "conn-a-id",
      userId: userA.id,
      encryptedRefreshToken: "v1:token-a-envelope",
      refreshTokenKeyVersion: "1",
      googleAccountEmail: "userA@gmail.com",
      driveFolderId: "folder-a-id",
      connectedAt: new Date(),
      updatedAt: new Date(),
      revokedAt: null,
    };

    mockDb.connection = connectionA;

    const reqStatusB = new NextRequest("http://localhost:3000/api/auth/google-drive/status");
    const resStatusB = await handleStatus(reqStatusB, {
      getSessionUser: async () => userB,
      getConfig: () => testConfig,
      getConnection: async (uid) => {
        if (uid === userA.id) {
          return connectionA as GoogleDriveConnectionRecord;
        }
        return null;
      },
    });
    assert(resStatusB.status === 200, "Expected status 200");
    const bodyB = await resStatusB.json() as Record<string, unknown>;
    assert(bodyB.connected === false, "User B should be reported as disconnected (not seeing User A's connection)");
    assert(bodyB.googleAccountEmail === null, "User B should not see User A's email");

    const reqDisconnectB = new NextRequest("http://localhost:3000/api/auth/google-drive/disconnect", { method: "POST" });
    const resDisconnectB = await handleDisconnect(reqDisconnectB, {
      verifySession: async () => userB,
      getConfig: () => testConfig,
      disconnect: async (uid) => {
        if (uid === userB.id) {
          return null;
        }
        throw new Error("Invalid disconnect target");
      }
    });
    assert(resDisconnectB.status === 200, "Expected status 200 for idempotent disconnect");
    assert(mockDb.connection.revokedAt === null, "User A's connection must not be revoked by User B's disconnect action");

    console.log("Test 34 Passed: Two users cannot read or overwrite each other's Drive connections [✓]");
    passedCount++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Test 34 Failed:", msg);
  }

  console.log(`\nGoogle Drive OAuth Validation complete. Passed: ${passedCount}/34`);
  if (passedCount !== 34) {
    console.error("ERROR: Not all validation tests passed.");
    process.exit(1);
  } else {
    console.log("SUCCESS: All security, correctness, and encryption check constraints verified successfully.");
  }
}

runTests().catch((err) => {
  console.error("Fatal error in test suite execution:", err);
  process.exit(1);
});
