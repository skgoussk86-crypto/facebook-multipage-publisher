import assert from "node:assert/strict";

import type {
  ThumbnailAssetRecord,
} from "../src/lib/thumbnails/thumbnail-asset-repository";
import {
  ThumbnailGenerationError,
  ThumbnailGenerationService,
  type ThumbnailGenerationAsset,
} from "../src/lib/thumbnails/thumbnail-generation-service";
import type {
  GeneratedVideoThumbnail,
} from "../src/lib/thumbnails/video-thumbnail-service";

const userId =
  "11111111-1111-4111-8111-111111111111";
const otherUserId =
  "22222222-2222-4222-8222-222222222222";
const assetId =
  "33333333-3333-4333-8333-333333333333";

function createAsset(
  overrides: Partial<
    ThumbnailGenerationAsset
  > = {},
): ThumbnailGenerationAsset {
  return {
    id: assetId,
    userId,
    provider: "GOOGLE_DRIVE",
    status: "VALIDATED",
    originalName: "video.mp4",
    expectedSize: BigInt(1000),
    actualSize: BigInt(900),
    durationMs: 10000,
    objectDeletedAt: null,
    ...overrides,
  };
}

function createStoredThumbnail(
  overrides: Partial<
    GeneratedVideoThumbnail
  > = {},
): GeneratedVideoThumbnail {
  return {
    fileId: "new-drive-thumbnail",
    storageUri:
      "gdrive://new-drive-thumbnail",
    folderId: "drive-folder",
    fileName:
      "thumbnail-video-2500.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 1234,
    md5Checksum:
      "0123456789abcdef0123456789abcdef",
    source: "MANUAL_FRAME",
    timestampMs: 2500,
    requestedTimestampSeconds: 2.5,
    effectiveTimestampSeconds: 2.5,
    ...overrides,
  };
}

function createRecord(
  overrides: Partial<
    ThumbnailAssetRecord
  > = {},
): ThumbnailAssetRecord {
  const now =
    new Date(
      "2026-07-20T10:00:00.000Z",
    );

  return {
    id: "thumbnail-record",
    userId,
    sourceUploadAssetId: assetId,
    provider: "GOOGLE_DRIVE",
    bucket: "drive-folder",
    objectKey:
      "new-drive-thumbnail",
    storageUri:
      "gdrive://new-drive-thumbnail",
    originalName:
      "thumbnail-video-2500.jpg",
    mimeType: "image/jpeg",
    sizeBytes: BigInt(1234),
    checksum:
      "0123456789abcdef0123456789abcdef",
    source: "MANUAL_FRAME",
    timestampMs: 2500,
    idempotencyKey:
      `thumbnail:v1:${"a".repeat(64)}`,
    requestFingerprint:
      "a".repeat(64),
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function assertGenerationError(
  error: unknown,
  code: string,
): boolean {
  assert(
    error instanceof
      ThumbnailGenerationError,
  );
  assert.equal(error.code, code);
  return true;
}

async function testInvalidTimestampBeforeLookup():
  Promise<void> {
  let findCalls = 0;
  let generateCalls = 0;

  await assert.rejects(
    ThumbnailGenerationService
      .generatePersistedThumbnail(
        {
          userId,
          assetId,
          timestampSeconds:
            Number.NaN,
          source: "MANUAL_FRAME",
        },
        {
          findAsset: async () => {
            findCalls += 1;
            return createAsset();
          },
          generateAndStore:
            async () => {
              generateCalls += 1;
              return createStoredThumbnail();
            },
        },
      ),
    (error: unknown) =>
      assertGenerationError(
        error,
        "INVALID_THUMBNAIL_TIMESTAMP",
      ),
  );

  assert.equal(findCalls, 0);
  assert.equal(generateCalls, 0);
}

async function testCrossUserAssetIsHidden():
  Promise<void> {
  let existingCalls = 0;
  let generateCalls = 0;

  await assert.rejects(
    ThumbnailGenerationService
      .generatePersistedThumbnail(
        {
          userId,
          assetId,
          timestampSeconds: 2.5,
          source: "MANUAL_FRAME",
        },
        {
          findAsset: async () =>
            createAsset({
              userId: otherUserId,
            }),
          findExistingThumbnail:
            async () => {
              existingCalls += 1;
              return null;
            },
          generateAndStore:
            async () => {
              generateCalls += 1;
              return createStoredThumbnail();
            },
        },
      ),
    (error: unknown) =>
      assertGenerationError(
        error,
        "UPLOAD_ASSET_NOT_FOUND",
      ),
  );

  assert.equal(existingCalls, 0);
  assert.equal(generateCalls, 0);
}

async function testInvalidAssetStates():
  Promise<void> {
  const cases: Array<{
    asset:
      Partial<ThumbnailGenerationAsset>;
    code: string;
  }> = [
    {
      asset: {
        status: "UPLOADED",
      },
      code:
        "UPLOAD_ASSET_NOT_VALIDATED",
    },
    {
      asset: {
        objectDeletedAt:
          new Date(),
      },
      code: "UPLOAD_ASSET_DELETED",
    },
    {
      asset: {
        provider: "R2",
      },
      code:
        "UNSUPPORTED_STORAGE_PROVIDER",
    },
    {
      asset: {
        durationMs: null,
      },
      code: "VIDEO_DURATION_MISSING",
    },
  ];

  for (const testCase of cases) {
    let mediaCalls = 0;

    await assert.rejects(
      ThumbnailGenerationService
        .generatePersistedThumbnail(
          {
            userId,
            assetId,
            timestampSeconds: 2.5,
            source: "MANUAL_FRAME",
          },
          {
            findAsset: async () =>
              createAsset(
                testCase.asset,
              ),
            generateAndStore:
              async () => {
                mediaCalls += 1;
                return createStoredThumbnail();
              },
          },
        ),
      (error: unknown) =>
        assertGenerationError(
          error,
          testCase.code,
        ),
    );

    assert.equal(mediaCalls, 0);
  }
}

async function testOutOfRangeBeforeMedia():
  Promise<void> {
  let existingCalls = 0;
  let mediaCalls = 0;

  await assert.rejects(
    ThumbnailGenerationService
      .generatePersistedThumbnail(
        {
          userId,
          assetId,
          timestampSeconds: 11,
          source: "MANUAL_FRAME",
        },
        {
          findAsset:
            async () => createAsset(),
          findExistingThumbnail:
            async () => {
              existingCalls += 1;
              return null;
            },
          generateAndStore:
            async () => {
              mediaCalls += 1;
              return createStoredThumbnail();
            },
        },
      ),
    (error: unknown) =>
      assertGenerationError(
        error,
        "THUMBNAIL_TIMESTAMP_OUT_OF_RANGE",
      ),
  );

  assert.equal(existingCalls, 0);
  assert.equal(mediaCalls, 0);
}

async function testExistingRequestReuse():
  Promise<void> {
  let mediaCalls = 0;
  let persistCalls = 0;
  let lookupInput:
    Record<string, unknown> | null =
    null;

  const result =
    await ThumbnailGenerationService
      .generatePersistedThumbnail(
        {
          userId,
          assetId,
          timestampSeconds: 2.5,
          source: "MANUAL_FRAME",
        },
        {
          findAsset:
            async () => createAsset(),
          findExistingThumbnail:
            async (input) => {
              lookupInput = input;
              return createRecord();
            },
          generateAndStore:
            async () => {
              mediaCalls += 1;
              return createStoredThumbnail();
            },
          persistThumbnail:
            async () => {
              persistCalls += 1;
              throw new Error(
                "Must not persist.",
              );
            },
        },
      );

  assert.equal(result.isReused, true);
  assert.equal(
    result.thumbnail.id,
    "thumbnail-record",
  );
  assert.equal(
    result.thumbnail.timestampSeconds,
    2.5,
  );
  assert.equal(mediaCalls, 0);
  assert.equal(persistCalls, 0);
  assert.deepEqual(
    lookupInput,
    {
      ownerUserId: userId,
      sourceUploadAssetId: assetId,
      source: "MANUAL_FRAME",
      timestampMs: 2500,
    },
  );
}

async function testSuccessfulCreation():
  Promise<void> {
  let generatedInput:
    Record<string, unknown> | null =
    null;
  let persistedInput:
    Record<string, unknown> | null =
    null;
  let deleteCalls = 0;

  const stored =
    createStoredThumbnail();

  const result =
    await ThumbnailGenerationService
      .generatePersistedThumbnail(
        {
          userId,
          assetId,
          timestampSeconds: 2.5,
          source: "MANUAL_FRAME",
        },
        {
          findAsset:
            async () => createAsset(),
          findExistingThumbnail:
            async () => null,
          generateAndStore:
            async (input) => {
              generatedInput =
                input as unknown as
                  Record<string, unknown>;
              return stored;
            },
          persistThumbnail:
            async (input) => {
              persistedInput =
                input as unknown as
                  Record<string, unknown>;

              return {
                thumbnailAsset:
                  createRecord(),
                isReused: false,
              };
            },
          deleteStoredThumbnail:
            async () => {
              deleteCalls += 1;
            },
        },
      );

  assert.equal(result.isReused, false);
  assert.equal(
    result.thumbnail.mimeType,
    "image/jpeg",
  );
  assert.equal(
    result.thumbnail.sizeBytes,
    1234,
  );
  assert.equal(
    "storageUri" in
      result.thumbnail,
    false,
  );
  assert.equal(
    "objectKey" in
      result.thumbnail,
    false,
  );
  assert.equal(deleteCalls, 0);

  assert(generatedInput !== null);

  const actualGeneratedInput =
    generatedInput as
      Record<string, unknown>;

  assert.equal(
    actualGeneratedInput.userId,
    userId,
  );
  assert.equal(
    actualGeneratedInput
      .timestampSeconds,
    2.5,
  );

  assert(persistedInput !== null);

  const actualPersistedInput =
    persistedInput as
      Record<string, unknown>;

  assert.equal(
    actualPersistedInput
      .ownerUserId,
    userId,
  );
  assert.equal(
    actualPersistedInput
      .sourceUploadAssetId,
    assetId,
  );
  assert.equal(
    actualPersistedInput
      .storedThumbnail,
    stored,
  );
}

async function testRaceReuseCleansDuplicate():
  Promise<void> {
  const deletedFileIds:
    string[] = [];

  const result =
    await ThumbnailGenerationService
      .generatePersistedThumbnail(
        {
          userId,
          assetId,
          timestampSeconds: 2.5,
          source: "MANUAL_FRAME",
        },
        {
          findAsset:
            async () => createAsset(),
          findExistingThumbnail:
            async () => null,
          generateAndStore:
            async () =>
              createStoredThumbnail({
                fileId:
                  "duplicate-drive-file",
                storageUri:
                  "gdrive://duplicate-drive-file",
              }),
          persistThumbnail:
            async () => ({
              thumbnailAsset:
                createRecord({
                  objectKey:
                    "winning-drive-file",
                  storageUri:
                    "gdrive://winning-drive-file",
                }),
              isReused: true,
            }),
          deleteStoredThumbnail:
            async (
              actualUserId,
              fileId,
            ) => {
              assert.equal(
                actualUserId,
                userId,
              );
              deletedFileIds.push(
                fileId,
              );
            },
        },
      );

  assert.equal(result.isReused, true);
  assert.deepEqual(
    deletedFileIds,
    ["duplicate-drive-file"],
  );
}

async function testPersistenceFailureCleansUpload():
  Promise<void> {
  const deletedFileIds:
    string[] = [];

  await assert.rejects(
    ThumbnailGenerationService
      .generatePersistedThumbnail(
        {
          userId,
          assetId,
          timestampSeconds: 2.5,
          source: "MANUAL_FRAME",
        },
        {
          findAsset:
            async () => createAsset(),
          findExistingThumbnail:
            async () => null,
          generateAndStore:
            async () =>
              createStoredThumbnail(),
          persistThumbnail:
            async () => {
              throw new Error(
                "Sensitive database detail.",
              );
            },
          deleteStoredThumbnail:
            async (
              actualUserId,
              fileId,
            ) => {
              assert.equal(
                actualUserId,
                userId,
              );
              deletedFileIds.push(
                fileId,
              );
            },
        },
      ),
    (error: unknown) =>
      assertGenerationError(
        error,
        "THUMBNAIL_PERSISTENCE_FAILED",
      ),
  );

  assert.deepEqual(
    deletedFileIds,
    ["new-drive-thumbnail"],
  );
}

async function testGenerationErrorSanitized():
  Promise<void> {
  await assert.rejects(
    ThumbnailGenerationService
      .generatePersistedThumbnail(
        {
          userId,
          assetId,
          timestampSeconds: 2.5,
          source: "MANUAL_FRAME",
        },
        {
          findAsset:
            async () => createAsset(),
          findExistingThumbnail:
            async () => null,
          generateAndStore:
            async () => {
              throw new Error(
                "Google access token secret.",
              );
            },
        },
      ),
    (error: unknown) => {
      assertGenerationError(
        error,
        "THUMBNAIL_GENERATION_FAILED",
      );
      assert(
        error instanceof
          ThumbnailGenerationError,
      );
      assert.equal(
        error.message.includes(
          "access token",
        ),
        false,
      );
      return true;
    },
  );
}

async function main(): Promise<void> {
  await testInvalidTimestampBeforeLookup();
  await testCrossUserAssetIsHidden();
  await testInvalidAssetStates();
  await testOutOfRangeBeforeMedia();
  await testExistingRequestReuse();
  await testSuccessfulCreation();
  await testRaceReuseCleansDuplicate();
  await testPersistenceFailureCleansUpload();
  await testGenerationErrorSanitized();

  console.log(
    "PHASE6I_THUMBNAIL_GENERATION_SERVICE_TESTS=PASSED",
  );
}

void main().catch(
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  },
);
