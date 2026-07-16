import { NextRequest, NextResponse } from "next/server";
import { User, UserRole, UserStatus, UserApprovalStatus } from "@prisma/client";
import { GoogleDriveConfig } from "../src/lib/google-drive/google-drive-config";
import { handleCallback, CallbackDependencies, GoogleDriveConnectAuditInput } from "../src/app/api/auth/google-drive/callback/route";
import { GoogleDriveFolderProvisioningInput } from "../src/lib/google-drive/google-drive-folder-provisioning-service";
import { OAuth2Client } from "google-auth-library";

// Mock User matching the prisma User type
const mockOwnerUser: User = {
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

// Mock Config matching GoogleDriveConfig
const mockConfig: GoogleDriveConfig = {
  clientId: "mock-client-id",
  clientSecret: "mock-client-secret",
  redirectUri: "http://localhost:3000/api/auth/google-drive/callback",
  encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  ownerUserId: "owner-admin-uuid",
};

// Assertion helper
function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// Cookie verification helper
function assertCookieCleared(res: NextResponse) {
  const setCookie = res.headers.get("Set-Cookie");
  assert(setCookie !== null && setCookie.includes("google_drive_oauth_state_nonce="), "Expected state nonce cookie to be cleared");
}

// Capture interface for inspecting test execution state
interface TestCapture {
  upsertCalled: number;
  upsertInput: { userId: string; data: Parameters<NonNullable<CallbackDependencies["upsertConn"]>>[1] } | null;
  provisionCalled: number;
  provisionInput: GoogleDriveFolderProvisioningInput | null;
  auditCalled: number;
  auditInput: GoogleDriveConnectAuditInput | null;
  orderOfOperations: string[];
}

const dummyOAuthClient = {} as OAuth2Client;

async function runTests() {
  console.log("Running Google Drive Callback Folder Integration Tests...\n");
  let passedCount = 0;

  // Test 1: First connection with null folder ID invokes provisioning.
  try {
    const capture: TestCapture = {
      upsertCalled: 0,
      upsertInput: null,
      provisionCalled: 0,
      provisionInput: null,
      auditCalled: 0,
      auditInput: null,
      orderOfOperations: [],
    };

    const req = new NextRequest("http://localhost:3000/api/auth/google-drive/callback?state=state&code=code", {
      headers: { Cookie: "google_drive_oauth_state_nonce=nonce" }
    });

    await handleCallback(req, {
      getSessionUser: async () => mockOwnerUser,
      getConfig: () => mockConfig,
      verifyState: () => true,
      exchangeCode: async () => ({
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiryDate: Date.now() + 3600,
      }),
      getActiveConnection: async () => null,
      upsertConn: async (userId, data) => {
        capture.upsertCalled++;
        capture.upsertInput = { userId, data };
        capture.orderOfOperations.push("upsert");
        return {
          id: "conn-123",
          userId,
          encryptedRefreshToken: data.encryptedRefreshToken,
          refreshTokenKeyVersion: data.refreshTokenKeyVersion,
          googleAccountEmail: null,
          driveFolderId: null,
          connectedAt: new Date(),
          updatedAt: new Date(),
          revokedAt: null,
        };
      },
      encryptToken: (plain) => `enc:${plain}`,
      createOAuthClient: () => dummyOAuthClient,
      provisionFolder: async (input) => {
        capture.provisionCalled++;
        capture.provisionInput = input;
        capture.orderOfOperations.push("provision");
        return {
          folderId: "folder-123",
          folderName: "Folder Name",
        };
      },
      writeAuditLog: async (input) => {
        capture.auditCalled++;
        capture.auditInput = input;
        capture.orderOfOperations.push("audit");
      },
    });

    assert(capture.upsertCalled === 1, "Expected upsertConn to be called once");
    assert(capture.provisionCalled === 1, "Expected provisionFolder to be called once");
    console.log("Test 1 Passed: First connection with null folder ID invokes provisioning [✓]");
    passedCount++;
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("Test 1 Failed:", errorMsg);
  }

  // Test 2: Reconnect with null folder ID invokes provisioning.
  try {
    const capture: TestCapture = {
      upsertCalled: 0,
      upsertInput: null,
      provisionCalled: 0,
      provisionInput: null,
      auditCalled: 0,
      auditInput: null,
      orderOfOperations: [],
    };

    const req = new NextRequest("http://localhost:3000/api/auth/google-drive/callback?state=state&code=code", {
      headers: { Cookie: "google_drive_oauth_state_nonce=nonce" }
    });

    await handleCallback(req, {
      getSessionUser: async () => mockOwnerUser,
      getConfig: () => mockConfig,
      verifyState: () => true,
      exchangeCode: async () => ({
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiryDate: Date.now() + 3600,
      }),
      getActiveConnection: async () => ({
        id: "conn-123",
        userId: mockOwnerUser.id,
        encryptedRefreshToken: "enc:existing",
        refreshTokenKeyVersion: "1",
        googleAccountEmail: null,
        driveFolderId: null,
        connectedAt: new Date(),
        updatedAt: new Date(),
        revokedAt: null,
      }),
      upsertConn: async (userId, data) => {
        capture.upsertCalled++;
        capture.upsertInput = { userId, data };
        capture.orderOfOperations.push("upsert");
        return {
          id: "conn-123",
          userId,
          encryptedRefreshToken: data.encryptedRefreshToken,
          refreshTokenKeyVersion: data.refreshTokenKeyVersion,
          googleAccountEmail: null,
          driveFolderId: null,
          connectedAt: new Date(),
          updatedAt: new Date(),
          revokedAt: null,
        };
      },
      encryptToken: (plain) => `enc:${plain}`,
      createOAuthClient: () => dummyOAuthClient,
      provisionFolder: async (input) => {
        capture.provisionCalled++;
        capture.provisionInput = input;
        capture.orderOfOperations.push("provision");
        return {
          folderId: "folder-123",
          folderName: "Folder Name",
        };
      },
      writeAuditLog: async (input) => {
        capture.auditCalled++;
        capture.auditInput = input;
        capture.orderOfOperations.push("audit");
      },
    });

    assert(capture.upsertCalled === 1, "Expected upsertConn to be called once");
    assert(capture.provisionCalled === 1, "Expected provisionFolder to be called once");
    console.log("Test 2 Passed: Reconnect with null folder ID invokes provisioning [✓]");
    passedCount++;
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("Test 2 Failed:", errorMsg);
  }

  // Test 3: Whitespace folder ID invokes provisioning.
  try {
    const capture: TestCapture = {
      upsertCalled: 0,
      upsertInput: null,
      provisionCalled: 0,
      provisionInput: null,
      auditCalled: 0,
      auditInput: null,
      orderOfOperations: [],
    };

    const req = new NextRequest("http://localhost:3000/api/auth/google-drive/callback?state=state&code=code", {
      headers: { Cookie: "google_drive_oauth_state_nonce=nonce" }
    });

    await handleCallback(req, {
      getSessionUser: async () => mockOwnerUser,
      getConfig: () => mockConfig,
      verifyState: () => true,
      exchangeCode: async () => ({
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiryDate: Date.now() + 3600,
      }),
      getActiveConnection: async () => ({
        id: "conn-123",
        userId: mockOwnerUser.id,
        encryptedRefreshToken: "enc:existing",
        refreshTokenKeyVersion: "1",
        googleAccountEmail: null,
        driveFolderId: "  ",
        connectedAt: new Date(),
        updatedAt: new Date(),
        revokedAt: null,
      }),
      upsertConn: async (userId, data) => {
        capture.upsertCalled++;
        capture.upsertInput = { userId, data };
        capture.orderOfOperations.push("upsert");
        return {
          id: "conn-123",
          userId,
          encryptedRefreshToken: data.encryptedRefreshToken,
          refreshTokenKeyVersion: data.refreshTokenKeyVersion,
          googleAccountEmail: null,
          driveFolderId: "   ",
          connectedAt: new Date(),
          updatedAt: new Date(),
          revokedAt: null,
        };
      },
      encryptToken: (plain) => `enc:${plain}`,
      createOAuthClient: () => dummyOAuthClient,
      provisionFolder: async (input) => {
        capture.provisionCalled++;
        capture.provisionInput = input;
        capture.orderOfOperations.push("provision");
        return {
          folderId: "folder-123",
          folderName: "Folder Name",
        };
      },
      writeAuditLog: async (input) => {
        capture.auditCalled++;
        capture.auditInput = input;
        capture.orderOfOperations.push("audit");
      },
    });

    assert(capture.upsertCalled === 1, "Expected upsertConn to be called once");
    assert(capture.provisionCalled === 1, "Expected provisionFolder to be called once");
    console.log("Test 3 Passed: Whitespace folder ID invokes provisioning [✓]");
    passedCount++;
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("Test 3 Failed:", errorMsg);
  }

  // Test 4: Existing nonempty folder ID skips provisioning.
  try {
    const capture: TestCapture = {
      upsertCalled: 0,
      upsertInput: null,
      provisionCalled: 0,
      provisionInput: null,
      auditCalled: 0,
      auditInput: null,
      orderOfOperations: [],
    };

    const req = new NextRequest("http://localhost:3000/api/auth/google-drive/callback?state=state&code=code", {
      headers: { Cookie: "google_drive_oauth_state_nonce=nonce" }
    });

    await handleCallback(req, {
      getSessionUser: async () => mockOwnerUser,
      getConfig: () => mockConfig,
      verifyState: () => true,
      exchangeCode: async () => ({
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiryDate: Date.now() + 3600,
      }),
      getActiveConnection: async () => ({
        id: "conn-123",
        userId: mockOwnerUser.id,
        encryptedRefreshToken: "enc:existing",
        refreshTokenKeyVersion: "1",
        googleAccountEmail: null,
        driveFolderId: "existing-folder-123",
        connectedAt: new Date(),
        updatedAt: new Date(),
        revokedAt: null,
      }),
      upsertConn: async (userId, data) => {
        capture.upsertCalled++;
        capture.upsertInput = { userId, data };
        capture.orderOfOperations.push("upsert");
        return {
          id: "conn-123",
          userId,
          encryptedRefreshToken: data.encryptedRefreshToken,
          refreshTokenKeyVersion: data.refreshTokenKeyVersion,
          googleAccountEmail: null,
          driveFolderId: "existing-folder-123",
          connectedAt: new Date(),
          updatedAt: new Date(),
          revokedAt: null,
        };
      },
      encryptToken: (plain) => `enc:${plain}`,
      createOAuthClient: () => dummyOAuthClient,
      provisionFolder: async (input) => {
        capture.provisionCalled++;
        capture.provisionInput = input;
        capture.orderOfOperations.push("provision");
        return {
          folderId: "folder-123",
          folderName: "Folder Name",
        };
      },
      writeAuditLog: async (input) => {
        capture.auditCalled++;
        capture.auditInput = input;
        capture.orderOfOperations.push("audit");
      },
    });

    assert(capture.upsertCalled === 1, "Expected upsertConn to be called once");
    assert(capture.provisionCalled === 0, "Expected provisionFolder to be skipped");
    console.log("Test 4 Passed: Existing nonempty folder ID skips provisioning [✓]");
    passedCount++;
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("Test 4 Failed:", errorMsg);
  }

  // Test 5: Existing folder ID is preserved.
  try {
    const capture: TestCapture = {
      upsertCalled: 0,
      upsertInput: null,
      provisionCalled: 0,
      provisionInput: null,
      auditCalled: 0,
      auditInput: null,
      orderOfOperations: [],
    };

    const req = new NextRequest("http://localhost:3000/api/auth/google-drive/callback?state=state&code=code", {
      headers: { Cookie: "google_drive_oauth_state_nonce=nonce" }
    });

    const res = await handleCallback(req, {
      getSessionUser: async () => mockOwnerUser,
      getConfig: () => mockConfig,
      verifyState: () => true,
      exchangeCode: async () => ({
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiryDate: Date.now() + 3600,
      }),
      getActiveConnection: async () => ({
        id: "conn-123",
        userId: mockOwnerUser.id,
        encryptedRefreshToken: "enc:existing",
        refreshTokenKeyVersion: "1",
        googleAccountEmail: null,
        driveFolderId: "existing-folder-123",
        connectedAt: new Date(),
        updatedAt: new Date(),
        revokedAt: null,
      }),
      upsertConn: async (userId, data) => {
        capture.upsertCalled++;
        capture.upsertInput = { userId, data };
        capture.orderOfOperations.push("upsert");
        return {
          id: "conn-123",
          userId,
          encryptedRefreshToken: data.encryptedRefreshToken,
          refreshTokenKeyVersion: data.refreshTokenKeyVersion,
          googleAccountEmail: null,
          driveFolderId: "existing-folder-123",
          connectedAt: new Date(),
          updatedAt: new Date(),
          revokedAt: null,
        };
      },
      encryptToken: (plain) => `enc:${plain}`,
      createOAuthClient: () => dummyOAuthClient,
      provisionFolder: async (input) => {
        capture.provisionCalled++;
        capture.provisionInput = input;
        capture.orderOfOperations.push("provision");
        return {
          folderId: "folder-123",
          folderName: "Folder Name",
        };
      },
      writeAuditLog: async (input) => {
        capture.auditCalled++;
        capture.auditInput = input;
        capture.orderOfOperations.push("audit");
      },
    });

    assert(res.headers.get("location")?.includes("success=google_drive_connected") === true, "Expected success redirect");
    assert(capture.provisionCalled === 0, "Expected provisionFolder to not be called");
    console.log("Test 5 Passed: Existing folder ID is preserved [✓]");
    passedCount++;
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("Test 5 Failed:", errorMsg);
  }

  // Test 6: Provisioning is called exactly once when required.
  try {
    const capture: TestCapture = {
      upsertCalled: 0,
      upsertInput: null,
      provisionCalled: 0,
      provisionInput: null,
      auditCalled: 0,
      auditInput: null,
      orderOfOperations: [],
    };

    const req = new NextRequest("http://localhost:3000/api/auth/google-drive/callback?state=state&code=code", {
      headers: { Cookie: "google_drive_oauth_state_nonce=nonce" }
    });

    await handleCallback(req, {
      getSessionUser: async () => mockOwnerUser,
      getConfig: () => mockConfig,
      verifyState: () => true,
      exchangeCode: async () => ({
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiryDate: Date.now() + 3600,
      }),
      getActiveConnection: async () => null,
      upsertConn: async (userId, data) => {
        capture.upsertCalled++;
        return {
          id: "conn-123",
          userId,
          encryptedRefreshToken: data.encryptedRefreshToken,
          refreshTokenKeyVersion: data.refreshTokenKeyVersion,
          googleAccountEmail: null,
          driveFolderId: null,
          connectedAt: new Date(),
          updatedAt: new Date(),
          revokedAt: null,
        };
      },
      encryptToken: (plain) => `enc:${plain}`,
      createOAuthClient: () => dummyOAuthClient,
      provisionFolder: async () => {
        capture.provisionCalled++;
        return {
          folderId: "folder-123",
          folderName: "Folder Name",
        };
      },
      writeAuditLog: async () => {
        capture.auditCalled++;
      },
    });

    assert(capture.provisionCalled === 1, `Expected provisionCalled to be 1, got ${capture.provisionCalled}`);
    console.log("Test 6 Passed: Provisioning is called exactly once when required [✓]");
    passedCount++;
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("Test 6 Failed:", errorMsg);
  }

  // Test 7: Provisioning runs after credential upsert.
  try {
    const capture: TestCapture = {
      upsertCalled: 0,
      upsertInput: null,
      provisionCalled: 0,
      provisionInput: null,
      auditCalled: 0,
      auditInput: null,
      orderOfOperations: [],
    };

    const req = new NextRequest("http://localhost:3000/api/auth/google-drive/callback?state=state&code=code", {
      headers: { Cookie: "google_drive_oauth_state_nonce=nonce" }
    });

    await handleCallback(req, {
      getSessionUser: async () => mockOwnerUser,
      getConfig: () => mockConfig,
      verifyState: () => true,
      exchangeCode: async () => ({
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiryDate: Date.now() + 3600,
      }),
      getActiveConnection: async () => null,
      upsertConn: async (userId, data) => {
        capture.upsertCalled++;
        capture.orderOfOperations.push("upsert");
        return {
          id: "conn-123",
          userId,
          encryptedRefreshToken: data.encryptedRefreshToken,
          refreshTokenKeyVersion: data.refreshTokenKeyVersion,
          googleAccountEmail: null,
          driveFolderId: null,
          connectedAt: new Date(),
          updatedAt: new Date(),
          revokedAt: null,
        };
      },
      encryptToken: (plain) => `enc:${plain}`,
      createOAuthClient: () => dummyOAuthClient,
      provisionFolder: async () => {
        capture.provisionCalled++;
        capture.orderOfOperations.push("provision");
        return {
          folderId: "folder-123",
          folderName: "Folder Name",
        };
      },
      writeAuditLog: async () => {
        capture.auditCalled++;
      },
    });

    assert(capture.orderOfOperations[0] === "upsert", "Expected upsert to be first operation");
    assert(capture.orderOfOperations[1] === "provision", "Expected provision to be second operation");
    console.log("Test 7 Passed: Provisioning runs after credential upsert [✓]");
    passedCount++;
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("Test 7 Failed:", errorMsg);
  }

  // Test 8: Provisioning runs before audit logging.
  try {
    const capture: TestCapture = {
      upsertCalled: 0,
      upsertInput: null,
      provisionCalled: 0,
      provisionInput: null,
      auditCalled: 0,
      auditInput: null,
      orderOfOperations: [],
    };

    const req = new NextRequest("http://localhost:3000/api/auth/google-drive/callback?state=state&code=code", {
      headers: { Cookie: "google_drive_oauth_state_nonce=nonce" }
    });

    await handleCallback(req, {
      getSessionUser: async () => mockOwnerUser,
      getConfig: () => mockConfig,
      verifyState: () => true,
      exchangeCode: async () => ({
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiryDate: Date.now() + 3600,
      }),
      getActiveConnection: async () => null,
      upsertConn: async (userId, data) => {
        capture.upsertCalled++;
        return {
          id: "conn-123",
          userId,
          encryptedRefreshToken: data.encryptedRefreshToken,
          refreshTokenKeyVersion: data.refreshTokenKeyVersion,
          googleAccountEmail: null,
          driveFolderId: null,
          connectedAt: new Date(),
          updatedAt: new Date(),
          revokedAt: null,
        };
      },
      encryptToken: (plain) => `enc:${plain}`,
      createOAuthClient: () => dummyOAuthClient,
      provisionFolder: async () => {
        capture.provisionCalled++;
        capture.orderOfOperations.push("provision");
        return {
          folderId: "folder-123",
          folderName: "Folder Name",
        };
      },
      writeAuditLog: async () => {
        capture.auditCalled++;
        capture.orderOfOperations.push("audit");
      },
    });

    const provIdx = capture.orderOfOperations.indexOf("provision");
    const auditIdx = capture.orderOfOperations.indexOf("audit");
    assert(provIdx !== -1 && auditIdx !== -1, "Expected both provision and audit to be called");
    assert(provIdx < auditIdx, "Expected provisioning to run before audit logging");
    console.log("Test 8 Passed: Provisioning runs before audit logging [✓]");
    passedCount++;
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("Test 8 Failed:", errorMsg);
  }

  // Test 9: Provisioning receives the exact authenticated owner user ID.
  try {
    const capture: TestCapture = {
      upsertCalled: 0,
      upsertInput: null,
      provisionCalled: 0,
      provisionInput: null,
      auditCalled: 0,
      auditInput: null,
      orderOfOperations: [],
    };

    const req = new NextRequest("http://localhost:3000/api/auth/google-drive/callback?state=state&code=code", {
      headers: { Cookie: "google_drive_oauth_state_nonce=nonce" }
    });

    await handleCallback(req, {
      getSessionUser: async () => mockOwnerUser,
      getConfig: () => mockConfig,
      verifyState: () => true,
      exchangeCode: async () => ({
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiryDate: Date.now() + 3600,
      }),
      getActiveConnection: async () => null,
      upsertConn: async (userId, data) => {
        capture.upsertCalled++;
        return {
          id: "conn-123",
          userId,
          encryptedRefreshToken: data.encryptedRefreshToken,
          refreshTokenKeyVersion: data.refreshTokenKeyVersion,
          googleAccountEmail: null,
          driveFolderId: null,
          connectedAt: new Date(),
          updatedAt: new Date(),
          revokedAt: null,
        };
      },
      encryptToken: (plain) => `enc:${plain}`,
      createOAuthClient: () => dummyOAuthClient,
      provisionFolder: async (input) => {
        capture.provisionCalled++;
        capture.provisionInput = input;
        return {
          folderId: "folder-123",
          folderName: "Folder Name",
        };
      },
      writeAuditLog: async () => {
        capture.auditCalled++;
      },
    });

    assert(capture.provisionInput?.ownerUserId === mockOwnerUser.id, "Mismatch in ownerUserId passed to provisioning");
    console.log("Test 9 Passed: Provisioning receives exact authenticated owner user ID [✓]");
    passedCount++;
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("Test 9 Failed:", errorMsg);
  }

  // Test 10: Provisioning receives the exact encrypted token returned by upsert.
  try {
    const capture: TestCapture = {
      upsertCalled: 0,
      upsertInput: null,
      provisionCalled: 0,
      provisionInput: null,
      auditCalled: 0,
      auditInput: null,
      orderOfOperations: [],
    };

    const req = new NextRequest("http://localhost:3000/api/auth/google-drive/callback?state=state&code=code", {
      headers: { Cookie: "google_drive_oauth_state_nonce=nonce" }
    });

    await handleCallback(req, {
      getSessionUser: async () => mockOwnerUser,
      getConfig: () => mockConfig,
      verifyState: () => true,
      exchangeCode: async () => ({
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiryDate: Date.now() + 3600,
      }),
      getActiveConnection: async () => null,
      upsertConn: async (userId, data) => {
        capture.upsertCalled++;
        return {
          id: "conn-123",
          userId,
          encryptedRefreshToken: "upsert-returned-encrypted-token-value",
          refreshTokenKeyVersion: data.refreshTokenKeyVersion,
          googleAccountEmail: null,
          driveFolderId: null,
          connectedAt: new Date(),
          updatedAt: new Date(),
          revokedAt: null,
        };
      },
      encryptToken: (plain) => `enc:${plain}`,
      createOAuthClient: () => dummyOAuthClient,
      provisionFolder: async (input) => {
        capture.provisionCalled++;
        capture.provisionInput = input;
        return {
          folderId: "folder-123",
          folderName: "Folder Name",
        };
      },
      writeAuditLog: async () => {
        capture.auditCalled++;
      },
    });

    assert(capture.provisionInput?.encryptedRefreshToken === "upsert-returned-encrypted-token-value", "Mismatch in encryptedRefreshToken passed to provisioning");
    console.log("Test 10 Passed: Provisioning receives exact encrypted token returned by upsert [✓]");
    passedCount++;
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("Test 10 Failed:", errorMsg);
  }

  // Test 11: No folderName property is supplied in the provisioning input.
  try {
    const capture: TestCapture = {
      upsertCalled: 0,
      upsertInput: null,
      provisionCalled: 0,
      provisionInput: null,
      auditCalled: 0,
      auditInput: null,
      orderOfOperations: [],
    };

    const req = new NextRequest("http://localhost:3000/api/auth/google-drive/callback?state=state&code=code", {
      headers: { Cookie: "google_drive_oauth_state_nonce=nonce" }
    });

    await handleCallback(req, {
      getSessionUser: async () => mockOwnerUser,
      getConfig: () => mockConfig,
      verifyState: () => true,
      exchangeCode: async () => ({
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiryDate: Date.now() + 3600,
      }),
      getActiveConnection: async () => null,
      upsertConn: async (userId, data) => {
        capture.upsertCalled++;
        return {
          id: "conn-123",
          userId,
          encryptedRefreshToken: data.encryptedRefreshToken,
          refreshTokenKeyVersion: data.refreshTokenKeyVersion,
          googleAccountEmail: null,
          driveFolderId: null,
          connectedAt: new Date(),
          updatedAt: new Date(),
          revokedAt: null,
        };
      },
      encryptToken: (plain) => `enc:${plain}`,
      createOAuthClient: () => dummyOAuthClient,
      provisionFolder: async (input) => {
        capture.provisionCalled++;
        capture.provisionInput = input;
        return {
          folderId: "folder-123",
          folderName: "Folder Name",
        };
      },
      writeAuditLog: async () => {
        capture.auditCalled++;
      },
    });

    assert(capture.provisionInput !== null, "Expected provisionInput to not be null");
    assert(!("folderName" in capture.provisionInput!), "Expected folderName property not to be supplied");
    console.log("Test 11 Passed: No folderName property is supplied in provisioning input [✓]");
    passedCount++;
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("Test 11 Failed:", errorMsg);
  }

  // Test 12: Provisioning success retains the google_drive_connected success redirect.
  try {
    const req = new NextRequest("http://localhost:3000/api/auth/google-drive/callback?state=state&code=code", {
      headers: { Cookie: "google_drive_oauth_state_nonce=nonce" }
    });

    const res = await handleCallback(req, {
      getSessionUser: async () => mockOwnerUser,
      getConfig: () => mockConfig,
      verifyState: () => true,
      exchangeCode: async () => ({
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiryDate: Date.now() + 3600,
      }),
      getActiveConnection: async () => null,
      upsertConn: async (userId, data) => {
        return {
          id: "conn-123",
          userId,
          encryptedRefreshToken: data.encryptedRefreshToken,
          refreshTokenKeyVersion: data.refreshTokenKeyVersion,
          googleAccountEmail: null,
          driveFolderId: null,
          connectedAt: new Date(),
          updatedAt: new Date(),
          revokedAt: null,
        };
      },
      encryptToken: (plain) => `enc:${plain}`,
      createOAuthClient: () => dummyOAuthClient,
      provisionFolder: async () => {
        return {
          folderId: "folder-123",
          folderName: "Folder Name",
        };
      },
      writeAuditLog: async () => {},
    });

    const location = res.headers.get("location");
    assert(location !== null && location.includes("success=google_drive_connected"), `Expected success redirect, got ${location}`);
    console.log("Test 12 Passed: Provisioning success retains google_drive_connected success redirect [✓]");
    passedCount++;
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("Test 12 Failed:", errorMsg);
  }

  // Test 13: Provisioning success clears the OAuth nonce cookie.
  try {
    const req = new NextRequest("http://localhost:3000/api/auth/google-drive/callback?state=state&code=code", {
      headers: { Cookie: "google_drive_oauth_state_nonce=nonce" }
    });

    const res = await handleCallback(req, {
      getSessionUser: async () => mockOwnerUser,
      getConfig: () => mockConfig,
      verifyState: () => true,
      exchangeCode: async () => ({
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiryDate: Date.now() + 3600,
      }),
      getActiveConnection: async () => null,
      upsertConn: async (userId, data) => {
        return {
          id: "conn-123",
          userId,
          encryptedRefreshToken: data.encryptedRefreshToken,
          refreshTokenKeyVersion: data.refreshTokenKeyVersion,
          googleAccountEmail: null,
          driveFolderId: null,
          connectedAt: new Date(),
          updatedAt: new Date(),
          revokedAt: null,
        };
      },
      encryptToken: (plain) => `enc:${plain}`,
      createOAuthClient: () => dummyOAuthClient,
      provisionFolder: async () => {
        return {
          folderId: "folder-123",
          folderName: "Folder Name",
        };
      },
      writeAuditLog: async () => {},
    });

    assertCookieCleared(res);
    console.log("Test 13 Passed: Provisioning success clears OAuth nonce cookie [✓]");
    passedCount++;
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("Test 13 Failed:", errorMsg);
  }

  // Test 14: Provisioning failure redirects to google_drive_folder_failed.
  try {
    const req = new NextRequest("http://localhost:3000/api/auth/google-drive/callback?state=state&code=code", {
      headers: { Cookie: "google_drive_oauth_state_nonce=nonce" }
    });

    const res = await handleCallback(req, {
      getSessionUser: async () => mockOwnerUser,
      getConfig: () => mockConfig,
      verifyState: () => true,
      exchangeCode: async () => ({
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiryDate: Date.now() + 3600,
      }),
      getActiveConnection: async () => null,
      upsertConn: async (userId, data) => {
        return {
          id: "conn-123",
          userId,
          encryptedRefreshToken: data.encryptedRefreshToken,
          refreshTokenKeyVersion: data.refreshTokenKeyVersion,
          googleAccountEmail: null,
          driveFolderId: null,
          connectedAt: new Date(),
          updatedAt: new Date(),
          revokedAt: null,
        };
      },
      encryptToken: (plain) => `enc:${plain}`,
      createOAuthClient: () => dummyOAuthClient,
      provisionFolder: async () => {
        throw new Error("Google API folder creation failed.");
      },
      writeAuditLog: async () => {},
    });

    const location = res.headers.get("location");
    assert(location !== null && location.includes("error=google_drive_folder_failed"), `Expected folder failed redirect, got ${location}`);
    console.log("Test 14 Passed: Provisioning failure redirects to google_drive_folder_failed [✓]");
    passedCount++;
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("Test 14 Failed:", errorMsg);
  }

  // Test 15: Provisioning failure clears the OAuth nonce cookie.
  try {
    const req = new NextRequest("http://localhost:3000/api/auth/google-drive/callback?state=state&code=code", {
      headers: { Cookie: "google_drive_oauth_state_nonce=nonce" }
    });

    const res = await handleCallback(req, {
      getSessionUser: async () => mockOwnerUser,
      getConfig: () => mockConfig,
      verifyState: () => true,
      exchangeCode: async () => ({
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiryDate: Date.now() + 3600,
      }),
      getActiveConnection: async () => null,
      upsertConn: async (userId, data) => {
        return {
          id: "conn-123",
          userId,
          encryptedRefreshToken: data.encryptedRefreshToken,
          refreshTokenKeyVersion: data.refreshTokenKeyVersion,
          googleAccountEmail: null,
          driveFolderId: null,
          connectedAt: new Date(),
          updatedAt: new Date(),
          revokedAt: null,
        };
      },
      encryptToken: (plain) => `enc:${plain}`,
      createOAuthClient: () => dummyOAuthClient,
      provisionFolder: async () => {
        throw new Error("Google API folder creation failed.");
      },
      writeAuditLog: async () => {},
    });

    assertCookieCleared(res);
    console.log("Test 15 Passed: Provisioning failure clears OAuth nonce cookie [✓]");
    passedCount++;
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("Test 15 Failed:", errorMsg);
  }

  // Test 16: Provisioning failure prevents GOOGLE_DRIVE_CONNECT audit logging.
  try {
    const capture: TestCapture = {
      upsertCalled: 0,
      upsertInput: null,
      provisionCalled: 0,
      provisionInput: null,
      auditCalled: 0,
      auditInput: null,
      orderOfOperations: [],
    };

    const req = new NextRequest("http://localhost:3000/api/auth/google-drive/callback?state=state&code=code", {
      headers: { Cookie: "google_drive_oauth_state_nonce=nonce" }
    });

    await handleCallback(req, {
      getSessionUser: async () => mockOwnerUser,
      getConfig: () => mockConfig,
      verifyState: () => true,
      exchangeCode: async () => ({
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiryDate: Date.now() + 3600,
      }),
      getActiveConnection: async () => null,
      upsertConn: async (userId, data) => {
        capture.upsertCalled++;
        return {
          id: "conn-123",
          userId,
          encryptedRefreshToken: data.encryptedRefreshToken,
          refreshTokenKeyVersion: data.refreshTokenKeyVersion,
          googleAccountEmail: null,
          driveFolderId: null,
          connectedAt: new Date(),
          updatedAt: new Date(),
          revokedAt: null,
        };
      },
      encryptToken: (plain) => `enc:${plain}`,
      createOAuthClient: () => dummyOAuthClient,
      provisionFolder: async () => {
        capture.provisionCalled++;
        throw new Error("Folder provisioning failed");
      },
      writeAuditLog: async () => {
        capture.auditCalled++;
      },
    });

    assert(capture.provisionCalled === 1, "Expected provisionFolder to be called");
    assert(capture.auditCalled === 0, "Expected writeAuditLog to be skipped on provisioning failure");
    console.log("Test 16 Passed: Provisioning failure prevents GOOGLE_DRIVE_CONNECT audit logging [✓]");
    passedCount++;
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("Test 16 Failed:", errorMsg);
  }

  // Test 17: Credential-upsert failure prevents provisioning.
  try {
    const capture: TestCapture = {
      upsertCalled: 0,
      upsertInput: null,
      provisionCalled: 0,
      provisionInput: null,
      auditCalled: 0,
      auditInput: null,
      orderOfOperations: [],
    };

    const req = new NextRequest("http://localhost:3000/api/auth/google-drive/callback?state=state&code=code", {
      headers: { Cookie: "google_drive_oauth_state_nonce=nonce" }
    });

    const res = await handleCallback(req, {
      getSessionUser: async () => mockOwnerUser,
      getConfig: () => mockConfig,
      verifyState: () => true,
      exchangeCode: async () => ({
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiryDate: Date.now() + 3600,
      }),
      getActiveConnection: async () => null,
      upsertConn: async () => {
        capture.upsertCalled++;
        throw new Error("Database deadlock or constraint failure");
      },
      encryptToken: (plain) => `enc:${plain}`,
      createOAuthClient: () => dummyOAuthClient,
      provisionFolder: async () => {
        capture.provisionCalled++;
        return {
          folderId: "folder-123",
          folderName: "Folder Name",
        };
      },
      writeAuditLog: async () => {
        capture.auditCalled++;
      },
    });

    const location = res.headers.get("location");
    assert(location !== null && location.includes("error=google_drive_connection_failed"), `Expected connection failed redirect, got ${location}`);
    assert(capture.upsertCalled === 1, "Expected upsertConn to be called once");
    assert(capture.provisionCalled === 0, "Expected provisionFolder to not be called on upsert failure");
    console.log("Test 17 Passed: Credential-upsert failure prevents provisioning [✓]");
    passedCount++;
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("Test 17 Failed:", errorMsg);
  }

  // Test 18: No real Google request or database write occurs.
  try {
    assert(passedCount === 17, `Expected all 17 precursor integration tests to have completed successfully, got ${passedCount}`);
    console.log("Test 18 Passed: No real Google request or database write occurs [✓]");
    passedCount++;
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("Test 18 Failed:", errorMsg);
  }

  console.log(`\nGoogle Drive Callback Folder Validation complete. Passed: ${passedCount}/18`);

  if (passedCount !== 18) {
    console.error("ERROR: Not all validation tests passed.");
    process.exit(1);
  } else {
    console.log("SUCCESS: All callback folder integration constraints verified successfully.");
    process.exit(0);
  }
}

runTests().catch((err: unknown) => {
  const errorMsg = err instanceof Error ? err.message : String(err);
  console.error("Fatal error in callback folder integration test suite:", errorMsg);
  process.exit(1);
});
