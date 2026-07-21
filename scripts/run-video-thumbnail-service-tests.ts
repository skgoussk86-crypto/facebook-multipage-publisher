import assert from "node:assert/strict";
import {
  access,
  mkdir,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
} from "node:path";
import {
  Readable,
} from "node:stream";
import {
  FfmpegThumbnailCommandInput,
  ThumbnailSourceVideoAsset,
  VideoThumbnailService,
} from "../src/lib/thumbnails/video-thumbnail-service";
import {
  ThumbnailConfig,
} from "../src/lib/thumbnails/thumbnail-config";

const config: ThumbnailConfig = {
  ffmpegPath: "fake-ffmpeg",
  extractionTimeoutMs: 5000,
  maxSourceBytes: 1024,
  maxThumbnailBytes: 128,
  maxWidth: 1280,
  jpegQuality: 2,
};

function createAsset(
  overrides: Partial<
    ThumbnailSourceVideoAsset
  > = {},
): ThumbnailSourceVideoAsset {
  return {
    id: "video-asset-123",
    userId: "user-123",
    provider: "GOOGLE_DRIVE",
    status: "VALIDATED",
    originalName: "video.mp4",
    objectKey: "drive-video-file",
    expectedSize: BigInt(8),
    actualSize: BigInt(8),
    durationMs: 10_000,
    objectDeletedAt: null,
    ...overrides,
  };
}

async function pathExists(
  path: string,
): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const videoBytes =
    Buffer.from("video123");

  const jpegBytes =
    Buffer.from([
      0xff,
      0xd8,
      0x01,
      0x02,
      0xff,
      0xd9,
    ]);

  let ffmpegInput:
    | FfmpegThumbnailCommandInput
    | null = null;

  let storedInput:
    | {
        sourceVideoAssetId:
          string;
        jpegBytes: Buffer;
        source:
          | "GEMINI_FRAME"
          | "MANUAL_FRAME";
        timestampMs: number;
      }
    | null = null;

  const generated =
    await VideoThumbnailService.generateAndStore(
      {
        userId: "user-123",
        asset: createAsset(),
        timestampSeconds: 2.5,
        source:
          "GEMINI_FRAME",
      },
      {
        getConfig:
          () => config,
        getDownloadStream:
          async () =>
            Readable.from([
              videoBytes,
            ]),
        runFfmpeg:
          async (input) => {
            ffmpegInput = input;

            await mkdir(
              dirname(
                input.outputPath,
              ),
              {
                recursive: true,
              },
            );

            await writeFile(
              input.outputPath,
              jpegBytes,
            );
          },
        storeThumbnail:
          async (
            _userId,
            input,
          ) => {
            storedInput = input;

            return {
              fileId:
                "thumbnail-file-123",
              storageUri:
                "gdrive://thumbnail-file-123",
              folderId:
                "folder-123",
              fileName:
                "thumbnail.jpg",
              mimeType:
                "image/jpeg",
              sizeBytes:
                input.jpegBytes.length,
              md5Checksum: null,
              source:
                input.source,
              timestampMs:
                input.timestampMs,
            };
          },
      },
    );

  assert.equal(
    generated.fileId,
    "thumbnail-file-123",
  );

  assert.equal(
    generated.storageUri,
    "gdrive://thumbnail-file-123",
  );

  assert.equal(
    generated.requestedTimestampSeconds,
    2.5,
  );

  assert.equal(
    generated.effectiveTimestampSeconds,
    2.5,
  );

  assert.equal(
    generated.timestampMs,
    2500,
  );

  assert.ok(ffmpegInput);
  assert.ok(storedInput);

  const verifiedFfmpegInput =
    ffmpegInput as FfmpegThumbnailCommandInput;

  const verifiedStoredInput =
    storedInput as {
      sourceVideoAssetId: string;
      jpegBytes: Buffer;
      source:
        | "GEMINI_FRAME"
        | "MANUAL_FRAME";
      timestampMs: number;
    };

  assert.equal(
    verifiedFfmpegInput.timestampSeconds,
    2.5,
  );

  assert.equal(
    verifiedFfmpegInput.maxWidth,
    1280,
  );

  assert.equal(
    verifiedStoredInput.sourceVideoAssetId,
    "video-asset-123",
  );

  assert.deepEqual(
    verifiedStoredInput.jpegBytes,
    jpegBytes,
  );

  const tempDirectory =
    dirname(
      verifiedFfmpegInput.sourcePath,
    );

  assert.equal(
    await pathExists(
      tempDirectory,
    ),
    false,
  );

  const clamped =
    await VideoThumbnailService.generateAndStore(
      {
        userId: "user-123",
        asset: createAsset(),
        timestampSeconds: 10,
      },
      {
        getConfig:
          () => config,
        getDownloadStream:
          async () =>
            Readable.from([
              videoBytes,
            ]),
        runFfmpeg:
          async (input) => {
            await writeFile(
              input.outputPath,
              jpegBytes,
            );
          },
        storeThumbnail:
          async (
            _userId,
            input,
          ) => ({
            fileId:
              "thumbnail-file-456",
            storageUri:
              "gdrive://thumbnail-file-456",
            folderId:
              "folder-123",
            fileName:
              "thumbnail.jpg",
            mimeType:
              "image/jpeg",
            sizeBytes:
              input.jpegBytes.length,
            md5Checksum: null,
            source:
              input.source,
            timestampMs:
              input.timestampMs,
          }),
      },
    );

  assert.equal(
    clamped.effectiveTimestampSeconds,
    9.95,
  );

  assert.equal(
    clamped.timestampMs,
    9950,
  );

  await assert.rejects(
    async () =>
      await VideoThumbnailService.generateAndStore(
        {
          userId: "other-user",
          asset: createAsset(),
          timestampSeconds: 1,
        },
        {
          getConfig:
            () => config,
        },
      ),
    /UPLOAD_ASSET_NOT_FOUND/,
  );

  await assert.rejects(
    async () =>
      await VideoThumbnailService.generateAndStore(
        {
          userId: "user-123",
          asset: createAsset({
            status: "VALIDATING",
          }),
          timestampSeconds: 1,
        },
        {
          getConfig:
            () => config,
        },
      ),
    /UPLOAD_ASSET_NOT_VALIDATED/,
  );

  await assert.rejects(
    async () =>
      await VideoThumbnailService.generateAndStore(
        {
          userId: "user-123",
          asset: createAsset({
            provider: "R2",
          }),
          timestampSeconds: 1,
        },
        {
          getConfig:
            () => config,
        },
      ),
    /UNSUPPORTED_STORAGE_PROVIDER/,
  );

  await assert.rejects(
    async () =>
      await VideoThumbnailService.generateAndStore(
        {
          userId: "user-123",
          asset: createAsset(),
          timestampSeconds: 11,
        },
        {
          getConfig:
            () => config,
        },
      ),
    /THUMBNAIL_TIMESTAMP_OUT_OF_RANGE/,
  );

  await assert.rejects(
    async () =>
      await VideoThumbnailService.generateAndStore(
        {
          userId: "user-123",
          asset: createAsset({
            actualSize:
              BigInt(2048),
          }),
          timestampSeconds: 1,
        },
        {
          getConfig:
            () => config,
        },
      ),
    /THUMBNAIL_SOURCE_TOO_LARGE/,
  );

  let failedOutputPath = "";

  await assert.rejects(
    async () =>
      await VideoThumbnailService.generateAndStore(
        {
          userId: "user-123",
          asset: createAsset(),
          timestampSeconds: 1,
        },
        {
          getConfig:
            () => config,
          getDownloadStream:
            async () =>
              Readable.from([
                videoBytes,
              ]),
          runFfmpeg:
            async (input) => {
              failedOutputPath =
                input.outputPath;

              throw new Error(
                "THUMBNAIL_EXTRACTION_FAILED",
              );
            },
        },
      ),
    /THUMBNAIL_EXTRACTION_FAILED/,
  );

  assert.equal(
    await pathExists(
      dirname(
        failedOutputPath,
      ),
    ),
    false,
  );

  console.log(
    "PHASE6I_VIDEO_THUMBNAIL_SERVICE_TESTS=PASSED",
  );
}

void main().catch(
  (error: unknown) => {
    console.error(
      "PHASE6I_VIDEO_THUMBNAIL_SERVICE_TESTS=FAILED",
    );

    console.error(
      error instanceof Error
        ? error.message
        : String(error),
    );

    process.exitCode = 1;
  },
);
