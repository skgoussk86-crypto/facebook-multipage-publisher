import { getStorageConfig, getStorageAdapter, resetStorageAdapterInstance } from '../src/lib/storage';
import { InMemoryFakeStorageAdapter } from '../src/lib/storage/in-memory-fake-adapter';

async function runTests() {
  console.log('Starting Phase 4 storage adapter & config unit tests...');

  // Setup environment variable backup
  const originalEnv = { ...process.env };

  try {
    // -------------------------------------------------------------
    // Test 1: Configuration Parsing & Validation Boundaries
    // -------------------------------------------------------------
    console.log('Test 1: Configuration parsing validation...');
    process.env.STORAGE_PROVIDER = 'R2';
    process.env.R2_PRESIGNED_URL_TTL_SECONDS = '600';
    process.env.UPLOAD_MAX_BYTES = '1000000000'; // Exceeds 500 MiB limit
    process.env.UPLOAD_PART_SIZE_BYTES = '3000000'; // Below 5 MiB limit

    const config = getStorageConfig();
    if (config.provider !== 'R2') throw new Error('Assertion failed: STORAGE_PROVIDER must be R2');
    if (config.r2.presignedUrlTtlSeconds !== 600) throw new Error('Assertion failed: TTL override not parsed');
    // Enforces max limit: 500 MiB (524288000 bytes)
    if (config.r2.uploadMaxBytes !== 524288000) throw new Error('Assertion failed: uploadMaxBytes limit was not capped');
    // Enforces min limit: 5 MiB (5242880 bytes) - since 3000000 was below limit, it keeps default 10MB
    if (config.r2.uploadPartSizeBytes !== 10485760) throw new Error('Assertion failed: uploadPartSizeBytes below 5MB was not ignored');

    // -------------------------------------------------------------
    // Test 2: Invalid Part Numbers
    // -------------------------------------------------------------
    console.log('Test 2: Invalid part numbers...');
    const fakeAdapter = new InMemoryFakeStorageAdapter();
    const bucket = 'my-bucket';
    const key = 'test.mp4';
    const uploadId = await fakeAdapter.createMultipartUpload(bucket, key, 'video/mp4');

    try {
      await fakeAdapter.createPresignedUploadPartUrl(bucket, key, uploadId, 0);
      throw new Error('Assertion failed: part number 0 must be rejected');
    } catch (e: unknown) {
      const err = e as Error;
      if (!err.message.includes('between 1 and 10000')) throw e;
    }

    try {
      await fakeAdapter.createPresignedUploadPartUrl(bucket, key, uploadId, 10001);
      throw new Error('Assertion failed: part number 10001 must be rejected');
    } catch (e: unknown) {
      const err = e as Error;
      if (!err.message.includes('between 1 and 10000')) throw e;
    }

    // -------------------------------------------------------------
    // Test 3: Fake Multipart Lifecycle & Validation Checks
    // -------------------------------------------------------------
    console.log('Test 3: Fake multipart lifecycle...');
    const partData1 = Buffer.alloc(6000000, 'a'); // 6 MB (valid > 5 MB)
    const partData2 = Buffer.alloc(3000000, 'b'); // 3 MB (valid final part)

    fakeAdapter.simulateUploadPart(uploadId, 1, partData1, 'etag-part-1');
    fakeAdapter.simulateUploadPart(uploadId, 2, partData2, 'etag-part-2');

    const parts = await fakeAdapter.listMultipartParts(bucket, key, uploadId);
    if (parts.length !== 2) throw new Error('Assertion failed: listing parts count mismatch');

    // Complete upload
    const metadata = await fakeAdapter.completeMultipartUpload(bucket, key, uploadId, [
      { partNumber: 1, etag: 'etag-part-1' },
      { partNumber: 2, etag: 'etag-part-2' },
    ]);

    if (metadata.size !== 9000000) throw new Error('Assertion failed: completed size mismatch');
    if (metadata.contentType !== 'video/mp4') throw new Error('Assertion failed: contentType mismatch');

    // -------------------------------------------------------------
    // Test 4: Invalid Part Size (Non-final part less than 5 MiB)
    // -------------------------------------------------------------
    console.log('Test 4: Part size constraints...');
    const uploadId2 = await fakeAdapter.createMultipartUpload(bucket, key, 'video/mp4');
    const smallPart = Buffer.alloc(4000000, 'x'); // 4 MB (below 5 MB limit)
    fakeAdapter.simulateUploadPart(uploadId2, 1, smallPart, 'etag-small-1');
    fakeAdapter.simulateUploadPart(uploadId2, 2, partData2, 'etag-small-2');

    try {
      await fakeAdapter.completeMultipartUpload(bucket, key, uploadId2, [
        { partNumber: 1, etag: 'etag-small-1' },
        { partNumber: 2, etag: 'etag-small-2' },
      ]);
      throw new Error('Assertion failed: non-final part below 5 MiB must be rejected');
    } catch (e: unknown) {
      const err = e as Error;
      if (!err.message.includes('less than 5 MiB limit')) throw e;
    }

    // -------------------------------------------------------------
    // Test 5: Duplicate / Expired Completion Checks
    // -------------------------------------------------------------
    console.log('Test 5: Duplicate complete calls...');
    try {
      await fakeAdapter.listMultipartParts(bucket, key, uploadId);
      throw new Error('Assertion failed: should fail listing an already completed session');
    } catch (e: unknown) {
      const err = e as Error;
      if (!err.message.includes('not found')) throw e;
    }

    // -------------------------------------------------------------
    // Test 6: Abort Behavior
    // -------------------------------------------------------------
    console.log('Test 6: Abort session behavior...');
    const uploadId3 = await fakeAdapter.createMultipartUpload(bucket, key, 'video/mp4');
    await fakeAdapter.abortMultipartUpload(bucket, key, uploadId3);

    try {
      await fakeAdapter.listMultipartParts(bucket, key, uploadId3);
      throw new Error('Assertion failed: aborted session should not exist');
    } catch (e: unknown) {
      const err = e as Error;
      if (!err.message.includes('not found')) throw e;
    }

    // -------------------------------------------------------------
    // Test 7: Object Head, Read Stream, and Deletion
    // -------------------------------------------------------------
    console.log('Test 7: Read, Head, and Delete operations...');
    const head = await fakeAdapter.headObject(bucket, key);
    if (!head) throw new Error('Assertion failed: head object must exist');
    if (head.size !== 9000000) throw new Error('Assertion failed: head size mismatch');

    const stream = await fakeAdapter.createReadStream(bucket, key);
    let chunks = 0;
    stream.on('data', (c: Buffer) => { chunks += c.length; });
    await new Promise((resolve) => stream.on('end', resolve));
    if (chunks !== 9000000) throw new Error('Assertion failed: stream chunk length mismatch');

    await fakeAdapter.deleteObject(bucket, key);
    const postHead = await fakeAdapter.headObject(bucket, key);
    if (postHead !== null) throw new Error('Assertion failed: object head should be null post delete');

    // -------------------------------------------------------------
    // Test 8: Production Fail-Closed Adapter Selection
    // -------------------------------------------------------------
    console.log('Test 8: Production fail-closed validation...');
    // Reset state & mock production
    resetStorageAdapterInstance();
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    process.env.STORAGE_PROVIDER = 'FAKE';

    try {
      getStorageAdapter();
      throw new Error('Assertion failed: FAKE adapter must be rejected in production');
    } catch (e: unknown) {
      const err = e as Error;
      if (!err.message.includes('cannot be activated in production') && !err.message.includes('fallback is disabled')) throw e;
    }

    // Test missing configuration for R2 in production
    resetStorageAdapterInstance();
    process.env.STORAGE_PROVIDER = 'R2';
    process.env.R2_ACCOUNT_ID = '';
    process.env.R2_BUCKET_NAME = '';

    try {
      const adapter = getStorageAdapter();
      // Accessing getter forces validation
      await adapter.headObject('', key);
      throw new Error('Assertion failed: invalid configuration must throw');
    } catch (e: unknown) {
      const err = e as Error;
      if (!err.message.includes('missing required variables')) throw e;
    }

    console.log('ALL STORAGE & CONFIG ADAPTER TESTS PASSED SUCCESSFULLY! 🎉');
  } finally {
    // Restore environment
    process.env = originalEnv;
    resetStorageAdapterInstance();
  }
}

runTests().catch((e: unknown) => {
  console.error('TEST SUITE FAILED:', e);
  process.exit(1);
});
