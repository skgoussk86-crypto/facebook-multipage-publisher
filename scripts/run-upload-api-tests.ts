import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { NextRequest } from 'next/server';
import {
  injectTestEncryptionKey,
  clearTestEncryptionKey,
} from '../src/lib/storage/upload-session-encryption';
import {
  handleInitiateUpload,
  POST as initiatePOST,
} from '../src/app/api/uploads/initiate/route';
import {
  handleGetUploadStatus,
  GET as statusGET,
} from '../src/app/api/uploads/[id]/route';
import {
  handleIssuePartUrl,
  handleRecordPart,
  POST as partsPOST,
  PATCH as partsPATCH,
} from '../src/app/api/uploads/[id]/parts/route';

const dbUrl = process.env.DATABASE_URL || '';

if (!dbUrl) {
  console.error('REFUSED: DATABASE_URL env variable is missing.');
  process.exit(1);
}

let dbName = '';
try {
  const parsedUrl = new URL(dbUrl);
  dbName = decodeURIComponent(parsedUrl.pathname.slice(1));
} catch {
  console.error('REFUSED: Invalid DATABASE_URL format.');
  process.exit(1);
}

if (dbName !== 'fb_publisher_test') {
  console.error(`REFUSED: Refusing to run tests against database "${dbName}".`);
  console.error('Database name must equal exactly "fb_publisher_test".');
  process.exit(1);
}

const prisma = new PrismaClient();

async function runTests() {
  console.log('Starting Phase 4 Step 3B Upload API Integration Tests...');

  // 1. Database Cleanup
  await prisma.uploadSession.deleteMany({});
  await prisma.uploadAttempt.deleteMany({});
  await prisma.uploadAsset.deleteMany({});
  await prisma.user.deleteMany({
    where: {
      email: {
        contains: 'test-u',
      },
    },
  });

  // 2. Setup mock users
  const testUserId1 = randomUUID();
  const testUserId2 = randomUUID();

  await prisma.user.createMany({
    data: [
      {
        id: testUserId1,
        email: `test-u1-${testUserId1.slice(0, 8)}@example.com`,
        passwordHash: 'dummy',
        role: 'USER',
        status: 'ACTIVE',
        approvalStatus: 'APPROVED',
      },
      {
        id: testUserId2,
        email: `test-u2-${testUserId2.slice(0, 8)}@example.com`,
        passwordHash: 'dummy',
        role: 'USER',
        status: 'ACTIVE',
        approvalStatus: 'APPROVED',
      },
    ],
  });

  // Inject a 32-byte test key
  const testKey = Buffer.alloc(32, 'y');
  const testKeyVersion = 'v-test-api';
  injectTestEncryptionKey(testKey, testKeyVersion);

  try {
    // -------------------------------------------------------------
    // Unauthenticated Rejection Tests
    // -------------------------------------------------------------
    console.log('Test: Unauthenticated request blocks...');
    // We instantiate request without admin session cookies. verifyAdminSession returns null, producing 401.
    const emptyReq = new NextRequest('http://localhost:3000/api/uploads/initiate', { method: 'POST' });
    const emptyRes = await initiatePOST(emptyReq);
    if (emptyRes.status !== 401) {
      throw new Error(`Assertion failed: Expected 401 on unauthenticated initiate. Got ${emptyRes.status}`);
    }

    const emptyStatusRes = await statusGET(emptyReq, { params: Promise.resolve({ id: randomUUID() }) });
    if (emptyStatusRes.status !== 401) {
      throw new Error(`Assertion failed: Expected 401 on unauthenticated status read. Got ${emptyStatusRes.status}`);
    }

    const emptyPartsPostRes = await partsPOST(emptyReq, { params: Promise.resolve({ id: randomUUID() }) });
    if (emptyPartsPostRes.status !== 401) {
      throw new Error(`Assertion failed: Expected 401 on unauthenticated parts URL. Got ${emptyPartsPostRes.status}`);
    }

    const emptyPartsPatchRes = await partsPATCH(emptyReq, { params: Promise.resolve({ id: randomUUID() }) });
    if (emptyPartsPatchRes.status !== 401) {
      throw new Error(`Assertion failed: Expected 401 on unauthenticated part record. Got ${emptyPartsPatchRes.status}`);
    }

    // -------------------------------------------------------------
    // Validation Boundary Tests
    // -------------------------------------------------------------
    console.log('Test: Missing or invalid Idempotency-Key...');
    const badIdemRes1 = await handleInitiateUpload(testUserId1, null, {
      filename: 'vid.mp4',
      expectedSize: 1000000,
      declaredMimeType: 'video/mp4',
    });
    if (badIdemRes1.status !== 400) {
      throw new Error(`Assertion failed: Expected 400. Got ${badIdemRes1.status}`);
    }
    const badIdemData = await badIdemRes1.json();
    if (badIdemData.error !== 'INVALID_IDEMPOTENCY_KEY') {
      throw new Error(`Assertion failed: Expected INVALID_IDEMPOTENCY_KEY. Got ${badIdemData.error}`);
    }

    console.log('Test: Zero or negative file size...');
    const sizeRes1 = await handleInitiateUpload(testUserId1, randomUUID(), {
      filename: 'vid.mp4',
      expectedSize: 0,
      declaredMimeType: 'video/mp4',
    });
    if (sizeRes1.status !== 413) {
      throw new Error(`Assertion failed: Expected 413 for zero size. Got ${sizeRes1.status}`);
    }

    console.log('Test: Excess file size (> 2 GiB)...');
    const sizeRes2 = await handleInitiateUpload(testUserId1, randomUUID(), {
      filename: 'vid.mp4',
      expectedSize: 2147483649, // 2 GiB + 1 byte (2 * 1024 * 1024 * 1024 + 1)
      declaredMimeType: 'video/mp4',
    });
    if (sizeRes2.status !== 413) {
      throw new Error(`Assertion failed: Expected 413 for size > 2 GiB. Got ${sizeRes2.status}`);
    }

    console.log('Test: Unsupported mime types...');
    const mimeRes1 = await handleInitiateUpload(testUserId1, randomUUID(), {
      filename: 'vid.mp4',
      expectedSize: 100000,
      declaredMimeType: 'image/png',
    });
    if (mimeRes1.status !== 415) {
      throw new Error(`Assertion failed: Expected 415 for image/png. Got ${mimeRes1.status}`);
    }

    console.log('Test: Filename extension and MIME compatibility mismatch...');
    const compatibilityRes = await handleInitiateUpload(testUserId1, randomUUID(), {
      filename: 'video.mov', // extension .mov matches video/quicktime
      expectedSize: 100000,
      declaredMimeType: 'video/mp4', // but MIME is video/mp4
    });
    if (compatibilityRes.status !== 415) {
      throw new Error(`Assertion failed: Expected 415 for MIME mismatch. Got ${compatibilityRes.status}`);
    }

    console.log('Test: Unsafe filename rejection...');
    const unsafeNameRes = await handleInitiateUpload(testUserId1, randomUUID(), {
      filename: 'video/../unsafe.mp4',
      expectedSize: 100000,
      declaredMimeType: 'video/mp4',
    });
    if (unsafeNameRes.status !== 400) {
      throw new Error(`Assertion failed: Expected 400 for unsafe filename. Got ${unsafeNameRes.status}`);
    }

    // -------------------------------------------------------------
    // Successful Initiation and Idempotency Tests
    // -------------------------------------------------------------
    console.log('Test: Successful MP4 initiation...');
    const idempotencyKey1 = randomUUID();
    const initPayload = {
      filename: 'good-video.mp4',
      expectedSize: 25 * 1024 * 1024, // 25 MiB -> 3 parts (10 MiB, 10 MiB, 5 MiB)
      declaredMimeType: 'video/mp4',
    };

    const initRes1 = await handleInitiateUpload(testUserId1, idempotencyKey1, initPayload);
    if (initRes1.status !== 201) {
      throw new Error(`Assertion failed: Expected 201. Got ${initRes1.status}`);
    }
    const initData1 = await initRes1.json();
    if (initData1.totalParts !== 3 || initData1.idempotentReplay !== false) {
      throw new Error(`Assertion failed: Expected 3 parts. Replay was: ${initData1.idempotentReplay}`);
    }
    if (initData1.objectKey || initData1.providerSessionId || initData1.etag) {
      throw new Error('Assertion failed: Exposed secrets in response!');
    }

    console.log('Test: Idempotent replay of initiation...');
    const initRes2 = await handleInitiateUpload(testUserId1, idempotencyKey1, initPayload);
    if (initRes2.status !== 200) {
      throw new Error(`Assertion failed: Expected 200 on replay. Got ${initRes2.status}`);
    }
    const initData2 = await initRes2.json();
    if (initData2.assetId !== initData1.assetId || initData2.idempotentReplay !== true) {
      throw new Error('Assertion failed: Idempotent replay mismatch.');
    }

    // Verify UPLOAD_INITIATION_REPLAYED audit log was written
    const replayAudit = await prisma.auditLog.findFirst({
      where: {
        userId: testUserId1,
        action: 'UPLOAD_INITIATION_REPLAYED',
      },
    });
    if (!replayAudit) {
      throw new Error('Assertion failed: Expected UPLOAD_INITIATION_REPLAYED audit log to be written.');
    }

    console.log('Test: Replay with different fingerprint conflict...');
    const conflictRes = await handleInitiateUpload(testUserId1, idempotencyKey1, {
      ...initPayload,
      filename: 'different-name.mp4',
    });
    if (conflictRes.status !== 409) {
      throw new Error(`Assertion failed: Expected 409 for conflict. Got ${conflictRes.status}`);
    }

    // -------------------------------------------------------------
    // Isolation and Lookup Tests
    // -------------------------------------------------------------
    console.log('Test: Owner isolation lookup...');
    const lookupResUser2 = await handleGetUploadStatus(testUserId2, initData1.assetId);
    if (lookupResUser2.status !== 404) {
      throw new Error(`Assertion failed: Expected 404 for non-owned lookup. Got ${lookupResUser2.status}`);
    }

    // -------------------------------------------------------------
    // Part Presigning and Recording Tests
    // -------------------------------------------------------------
    console.log('Test: Presign part upload URL...');
    const partSignRes = await handleIssuePartUrl(testUserId1, initData1.assetId, { partNumber: 1 });
    if (partSignRes.status !== 200) {
      throw new Error(`Assertion failed: Expected 200 on signing part URL. Got ${partSignRes.status}`);
    }
    const partSignData = await partSignRes.json();
    if (!partSignData.uploadUrl || partSignData.expiresInSeconds !== 900) {
      throw new Error('Assertion failed: Invalid presigned URL output format.');
    }

    console.log('Test: Invalid part number signing rejection...');
    const badPartRes = await handleIssuePartUrl(testUserId1, initData1.assetId, { partNumber: 4 }); // totalParts is 3
    if (badPartRes.status !== 400) {
      throw new Error(`Assertion failed: Expected 400 for out of bounds part number. Got ${badPartRes.status}`);
    }

    console.log('Test: Record completed upload parts...');
    const recordRes1 = await handleRecordPart(testUserId1, initData1.assetId, {
      partNumber: 2,
      etag: 'etag-for-part-2',
    });
    if (recordRes1.status !== 200) {
      throw new Error(`Assertion failed: Expected 200. Got ${recordRes1.status}`);
    }
    const recordData1 = await recordRes1.json();
    if (recordData1.completedPartCount !== 1 || recordData1.completedPartNumbers[0] !== 2) {
      throw new Error('Assertion failed: Recorded parts tracking mismatch.');
    }

    console.log('Test: Duplicate part replacement and ascending order...');
    // Record part 1
    await handleRecordPart(testUserId1, initData1.assetId, {
      partNumber: 1,
      etag: 'etag-for-part-1',
    });
    // Replace part 2 etag
    const recordRes2 = await handleRecordPart(testUserId1, initData1.assetId, {
      partNumber: 2,
      etag: 'new-etag-for-part-2',
    });
    const recordData2 = await recordRes2.json();
    if (recordData2.completedPartNumbers[0] !== 1 || recordData2.completedPartNumbers[1] !== 2) {
      throw new Error('Assertion failed: Completed parts must remain sorted in ascending order.');
    }

    console.log('Test: Safe status check with completed part numbers...');
    const statusRes = await handleGetUploadStatus(testUserId1, initData1.assetId);
    if (statusRes.status !== 200) {
      throw new Error(`Assertion failed: Expected 200 status. Got ${statusRes.status}`);
    }
    const statusData = await statusRes.json();
    if (statusData.completedPartNumbers[0] !== 1 || statusData.completedPartNumbers[1] !== 2) {
      throw new Error('Assertion failed: Status response did not list completed parts.');
    }
    if (statusData.completedPartNumbers.length !== 2) {
      throw new Error('Assertion failed: Count mismatch in status parts list.');
    }
    if (JSON.stringify(statusData).includes('etag') || JSON.stringify(statusData).includes('providerSessionId')) {
      throw new Error('Assertion failed: Plaintext secrets leaked in status response JSON.');
    }

    // -------------------------------------------------------------
    // Session Expiration API Tests
    // -------------------------------------------------------------
    console.log('Test: Session expiration API status (410)...');
    // Setup session expiring in the past
    const expiredIdemKey = randomUUID();
    const expiredRes = await handleInitiateUpload(testUserId1, expiredIdemKey, {
      filename: 'expired.mp4',
      expectedSize: 100000,
      declaredMimeType: 'video/mp4',
    });
    const expiredAsset = await expiredRes.json();

    // Manually force session expiry in database
    await prisma.uploadSession.update({
      where: { uploadAssetId: expiredAsset.assetId },
      data: {
        expiresAt: new Date(Date.now() - 5000),
      },
    });

    // Check that GET returns 410 with UPLOAD_SESSION_EXPIRED
    const expiredStatusRes = await handleGetUploadStatus(testUserId1, expiredAsset.assetId);
    if (expiredStatusRes.status !== 410) {
      throw new Error(`Assertion failed: Expected 410. Got ${expiredStatusRes.status}`);
    }
    const expiredStatusData = await expiredStatusRes.json();
    if (expiredStatusData.error !== 'UPLOAD_SESSION_EXPIRED') {
      throw new Error(`Assertion failed: Expected UPLOAD_SESSION_EXPIRED. Got ${expiredStatusData.error}`);
    }

    // Check that POST /parts returns 410
    const expiredPostRes = await handleIssuePartUrl(testUserId1, expiredAsset.assetId, { partNumber: 1 });
    if (expiredPostRes.status !== 410) {
      throw new Error(`Assertion failed: Expected 410 for expired part sign. Got ${expiredPostRes.status}`);
    }

    // Check that PATCH /parts returns 410
    const expiredPatchRes = await handleRecordPart(testUserId1, expiredAsset.assetId, {
      partNumber: 1,
      etag: 'some-etag',
    });
    if (expiredPatchRes.status !== 410) {
      throw new Error(`Assertion failed: Expected 410 for expired part record. Got ${expiredPatchRes.status}`);
    }

    console.log('ALL PERSISTENT UPLOAD API INTEGRATION TESTS PASSED SUCCESSFULLY! 🎉');
  } finally {
    clearTestEncryptionKey();
    await prisma.$disconnect();
  }
}

runTests().catch((e: unknown) => {
  console.error('TEST SUITE FAILED:', e);
  process.exit(1);
});
