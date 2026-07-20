import assert from "node:assert/strict";
import {
  readFile,
} from "node:fs/promises";
import {
  CreateThumbnailAssetRecordInput,
  OwnedThumbnailSourceAsset,
  persistStoredThumbnailAsset,
  ThumbnailAssetPersistence,
  ThumbnailAssetRecord,
} from "../src/lib/thumbnails/thumbnail-asset-repository";
import type {
  StoredGoogleDriveThumbnail,
} from "../src/lib/google-drive/google-drive-thumbnail-storage";

function createStoredThumbnail(
  overrides: Partial<
    StoredGoogleDriveThumbnail
  > = {},
): StoredGoogleDriveThumbnail {
  return {
    fileId: "drive-thumbnail-123",
    storageUri:
      "gdrive://drive-thumbnail-123",
    folderId: "folder-123",
    fileName:
      "thumbnail-video-123-2500.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 6,
    md5Checksum:
      "abcdef0123456789abcdef0123456789",
    source: "GEMINI_FRAME",
    timestampMs: 2500,
    ...overrides,
  };
}

function createSourceAsset(
  overrides: Partial<
    OwnedThumbnailSourceAsset
  > = {},
): OwnedThumbnailSourceAsset {
  return {
    id: "video-123",
    userId: "user-123",
    status: "VALIDATED",
    objectDeletedAt: null,
    ...overrides,
  };
}

function createRecord(
  input: CreateThumbnailAssetRecordInput,
  overrides: Partial<
    ThumbnailAssetRecord
  > = {},
): ThumbnailAssetRecord {
  const now = new Date(
    "2026-07-20T00:00:00.000Z",
  );

  return {
    id: "thumbnail-record-123",
    ...input,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function main(): Promise<void> {
  const schema =
    await readFile(
      "prisma/schema.prisma",
      "utf8",
    );

  const migration =
    await readFile(
      "prisma/migrations/20260720110000_add_thumbnail_asset_persistence/migration.sql",
      "utf8",
    );

  assert.match(
    schema,
    /model ThumbnailAsset \{/,
  );
  assert.match(
    schema,
    /thumbnailAssetId\s+String\?\s+@db\.Uuid/,
  );
  assert.match(
    schema,
    /@@unique\(\[userId, idempotencyKey\]\)/,
  );
  assert.match(
    migration,
    /CREATE TYPE "ThumbnailSource"/,
  );
  assert.match(
    migration,
    /CREATE TABLE "ThumbnailAsset"/,
  );
  assert.match(
    migration,
    /VideoJob_thumbnailAssetId_fkey/,
  );

  let sourceCalls = 0;
  let existingCalls = 0;
  let createCalls = 0;
  let capturedCreate:
    CreateThumbnailAssetRecordInput | null =
    null;

  const persistence:
    ThumbnailAssetPersistence = {
      findValidatedOwnedSourceAsset:
        async (
          ownerUserId,
          sourceUploadAssetId,
        ) => {
          sourceCalls += 1;
          assert.equal(
            ownerUserId,
            "user-123",
          );
          assert.equal(
            sourceUploadAssetId,
            "video-123",
          );
          return createSourceAsset();
        },
      findByOwnerAndIdempotencyKey:
        async (
          ownerUserId,
          idempotencyKey,
        ) => {
          existingCalls += 1;
          assert.equal(
            ownerUserId,
            "user-123",
          );
          assert.match(
            idempotencyKey,
            /^thumbnail:[a-f0-9]{64}$/,
          );
          return null;
        },
      create: async (input) => {
        createCalls += 1;
        capturedCreate = input;
        return createRecord(input);
      },
    };

  const created =
    await persistStoredThumbnailAsset(
      {
        ownerUserId: "  user-123  ",
        sourceUploadAssetId:
          "  video-123  ",
        storedThumbnail:
          createStoredThumbnail(),
      },
      persistence,
    );

  assert.equal(created.isReused, false);
  assert.equal(sourceCalls, 1);
  assert.equal(existingCalls, 1);
  assert.equal(createCalls, 1);
  assert(capturedCreate !== null);

  const createInput =
    capturedCreate as
      CreateThumbnailAssetRecordInput;

  assert.deepEqual(
    Object.keys(createInput).sort(),
    [
      "bucket",
      "checksum",
      "idempotencyKey",
      "mimeType",
      "objectKey",
      "originalName",
      "provider",
      "requestFingerprint",
      "sizeBytes",
      "source",
      "sourceUploadAssetId",
      "storageUri",
      "timestampMs",
      "userId",
    ].sort(),
  );

  assert.equal(
    createInput.provider,
    "GOOGLE_DRIVE",
  );
  assert.equal(
    createInput.storageUri,
    "gdrive://drive-thumbnail-123",
  );
  assert.equal(
    createInput.sizeBytes,
    BigInt(6),
  );
  assert.match(
    createInput.requestFingerprint,
    /^[a-f0-9]{64}$/,
  );

  const existingRecord =
    createRecord(createInput);

  const reused =
    await persistStoredThumbnailAsset(
      {
        ownerUserId: "user-123",
        sourceUploadAssetId:
          "video-123",
        storedThumbnail:
          createStoredThumbnail(),
      },
      {
        findValidatedOwnedSourceAsset:
          async () =>
            createSourceAsset(),
        findByOwnerAndIdempotencyKey:
          async () =>
            existingRecord,
        create: async () => {
          throw new Error(
            "create must not run",
          );
        },
      },
    );

  assert.equal(reused.isReused, true);
  assert.equal(
    reused.thumbnailAsset.id,
    existingRecord.id,
  );

  await assert.rejects(
    persistStoredThumbnailAsset(
      {
        ownerUserId: "user-123",
        sourceUploadAssetId:
          "video-123",
        storedThumbnail:
          createStoredThumbnail({
            storageUri:
              "gdrive://wrong-file",
          }),
      },
      persistence,
    ),
    /does not match/,
  );

  await assert.rejects(
    persistStoredThumbnailAsset(
      {
        ownerUserId: "user-123",
        sourceUploadAssetId:
          "video-123",
        storedThumbnail:
          createStoredThumbnail({
            md5Checksum: null,
          }),
      },
      persistence,
    ),
    /Thumbnail checksum is required/,
  );

  await assert.rejects(
    persistStoredThumbnailAsset(
      {
        ownerUserId: "user-123",
        sourceUploadAssetId:
          "video-123",
        storedThumbnail:
          createStoredThumbnail({
            source: "CUSTOM_UPLOAD",
            timestampMs: 2500,
          }),
      },
      persistence,
    ),
    /must not have a video timestamp/,
  );

  await assert.rejects(
    persistStoredThumbnailAsset(
      {
        ownerUserId: "user-123",
        sourceUploadAssetId:
          "video-123",
        storedThumbnail:
          createStoredThumbnail(),
      },
      {
        findValidatedOwnedSourceAsset:
          async () => null,
        findByOwnerAndIdempotencyKey:
          async () => null,
        create: async (input) =>
          createRecord(input),
      },
    ),
    /Validated owned source upload asset was not found/,
  );

  let raceLookupCount = 0;
  const raced =
    await persistStoredThumbnailAsset(
      {
        ownerUserId: "user-123",
        sourceUploadAssetId:
          "video-123",
        storedThumbnail:
          createStoredThumbnail(),
      },
      {
        findValidatedOwnedSourceAsset:
          async () =>
            createSourceAsset(),
        findByOwnerAndIdempotencyKey:
          async () => {
            raceLookupCount += 1;
            return raceLookupCount === 1
              ? null
              : existingRecord;
          },
        create: async () => {
          throw {
            code: "P2002",
          };
        },
      },
    );

  assert.equal(raced.isReused, true);
  assert.equal(raceLookupCount, 2);

  const conflictingRecord = {
    ...existingRecord,
    requestFingerprint:
      "0".repeat(64),
  };

  await assert.rejects(
    persistStoredThumbnailAsset(
      {
        ownerUserId: "user-123",
        sourceUploadAssetId:
          "video-123",
        storedThumbnail:
          createStoredThumbnail(),
      },
      {
        findValidatedOwnedSourceAsset:
          async () =>
            createSourceAsset(),
        findByOwnerAndIdempotencyKey:
          async () =>
            conflictingRecord,
        create: async () => {
          throw new Error(
            "create must not run",
          );
        },
      },
    ),
    /THUMBNAIL_IDEMPOTENCY_CONFLICT/,
  );

  console.log(
    "PHASE6I_THUMBNAIL_PERSISTENCE_TESTS=PASSED",
  );
}

void main().catch(
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  },
);
