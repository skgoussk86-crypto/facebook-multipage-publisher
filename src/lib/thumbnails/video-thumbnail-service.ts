import "server-only";
import {
  execFile,
} from "node:child_process";
import {
  createWriteStream,
} from "node:fs";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import {
  tmpdir,
} from "node:os";
import {
  join,
} from "node:path";
import {
  Readable,
  Transform,
  TransformCallback,
} from "node:stream";
import {
  pipeline,
} from "node:stream/promises";
import {
  getThumbnailConfig,
  ThumbnailConfig,
} from "./thumbnail-config";
import {
  GoogleDriveMediaReader,
} from "../google-drive/google-drive-media-reader";
import {
  GoogleDriveThumbnailStorage,
  StoredGoogleDriveThumbnail,
} from "../google-drive/google-drive-thumbnail-storage";

export interface ThumbnailSourceVideoAsset {
  readonly id: string;
  readonly userId: string;
  readonly provider: string;
  readonly status: string;
  readonly originalName: string;
  readonly expectedSize: bigint;
  readonly actualSize: bigint | null;
  readonly objectKey: string;
  readonly durationMs: number | null;
  readonly objectDeletedAt: Date | null;
}

export interface GenerateVideoThumbnailInput {
  readonly userId: string;
  readonly asset: ThumbnailSourceVideoAsset;
  readonly timestampSeconds: number;
  readonly source?:
    | "GEMINI_FRAME"
    | "MANUAL_FRAME";
}

export interface GeneratedVideoThumbnail
  extends StoredGoogleDriveThumbnail {
  readonly requestedTimestampSeconds: number;
  readonly effectiveTimestampSeconds: number;
}

export interface FfmpegThumbnailCommandInput {
  readonly ffmpegPath: string;
  readonly sourcePath: string;
  readonly outputPath: string;
  readonly timestampSeconds: number;
  readonly maxWidth: number;
  readonly jpegQuality: number;
  readonly timeoutMs: number;
}

export interface VideoThumbnailServiceDependencies {
  readonly getConfig?: () => ThumbnailConfig;
  readonly getDownloadStream?: (
    userId: string,
    asset: ThumbnailSourceVideoAsset,
  ) => Promise<Readable>;
  readonly runFfmpeg?: (
    input: FfmpegThumbnailCommandInput,
  ) => Promise<void>;
  readonly storeThumbnail?: (
    userId: string,
    input: {
      sourceVideoAssetId: string;
      jpegBytes: Buffer;
      source:
        | "GEMINI_FRAME"
        | "MANUAL_FRAME";
      timestampMs: number;
    },
  ) => Promise<StoredGoogleDriveThumbnail>;
}

class ByteLimitTransform extends Transform {
  private count = 0;

  constructor(
    private readonly maximumBytes: number,
  ) {
    super();
  }

  override _transform(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    void encoding;

    this.count += chunk.length;

    if (this.count > this.maximumBytes) {
      callback(
        new Error(
          "THUMBNAIL_SOURCE_TOO_LARGE",
        ),
      );
      return;
    }

    callback(null, chunk);
  }
}

function toSafeNumber(
  value: bigint,
  name: string,
): number {
  if (
    value <= BigInt(0) ||
    value > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error(`${name}_INVALID`);
  }

  return Number(value);
}

export function resolveEffectiveThumbnailTimestamp(
  requestedTimestampSeconds: number,
  durationMs: number,
): number {
  if (
    !Number.isFinite(requestedTimestampSeconds) ||
    requestedTimestampSeconds < 0
  ) {
    throw new Error(
      "INVALID_THUMBNAIL_TIMESTAMP",
    );
  }

  const durationSeconds =
    durationMs / 1000;

  if (
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0
  ) {
    throw new Error(
      "VIDEO_DURATION_MISSING",
    );
  }

  if (
    requestedTimestampSeconds >
    durationSeconds
  ) {
    throw new Error(
      "THUMBNAIL_TIMESTAMP_OUT_OF_RANGE",
    );
  }

  const maximumTime =
    Math.max(
      0,
      durationSeconds - 0.05,
    );

  return Math.min(
    requestedTimestampSeconds,
    maximumTime,
  );
}

export async function runFfmpegThumbnailCommand(
  input: FfmpegThumbnailCommandInput,
): Promise<void> {
  const argumentsList = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-ss",
    input.timestampSeconds.toFixed(3),
    "-i",
    input.sourcePath,
    "-frames:v",
    "1",
    "-vf",
    `scale=${input.maxWidth}:-2:force_original_aspect_ratio=decrease`,
    "-q:v",
    input.jpegQuality.toString(),
    input.outputPath,
  ];

  await new Promise<void>(
    (resolve, reject) => {
      execFile(
        input.ffmpegPath,
        argumentsList,
        {
          shell: false,
          timeout: input.timeoutMs,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        },
        (
          error,
          _stdout,
          stderr,
        ) => {
          if (!error) {
            resolve();
            return;
          }

          const typedError =
            error as Error & {
              code?: string | number;
              killed?: boolean;
            };

          if (
            typedError.code === "ENOENT"
          ) {
            reject(
              new Error("FFMPEG_NOT_FOUND"),
            );
            return;
          }

          if (typedError.killed) {
            reject(
              new Error(
                "THUMBNAIL_EXTRACTION_TIMEOUT",
              ),
            );
            return;
          }

          const safeStderr =
            typeof stderr === "string"
              ? stderr.trim().slice(0, 500)
              : "";

          reject(
            new Error(
              safeStderr
                ? `THUMBNAIL_EXTRACTION_FAILED: ${safeStderr}`
                : "THUMBNAIL_EXTRACTION_FAILED",
            ),
          );
        },
      );
    },
  );
}

async function defaultDownloadStream(
  userId: string,
  asset: ThumbnailSourceVideoAsset,
): Promise<Readable> {
  return await GoogleDriveMediaReader.getDownloadStream(
    userId,
    asset as unknown as Parameters<
      typeof GoogleDriveMediaReader.getDownloadStream
    >[1],
  );
}

async function defaultStoreThumbnail(
  userId: string,
  input: {
    sourceVideoAssetId: string;
    jpegBytes: Buffer;
    source:
      | "GEMINI_FRAME"
      | "MANUAL_FRAME";
    timestampMs: number;
  },
): Promise<StoredGoogleDriveThumbnail> {
  return await GoogleDriveThumbnailStorage.store(
    userId,
    input,
  );
}

export class VideoThumbnailService {
  static async generateAndStore(
    input: GenerateVideoThumbnailInput,
    dependencies?: VideoThumbnailServiceDependencies,
  ): Promise<GeneratedVideoThumbnail> {
    const userId =
      input.userId.trim();

    if (!userId) {
      throw new Error("USER_ID_REQUIRED");
    }

    const asset =
      input.asset;

    if (
      !asset ||
      asset.userId !== userId
    ) {
      throw new Error(
        "UPLOAD_ASSET_NOT_FOUND",
      );
    }

    if (
      asset.status !== "VALIDATED"
    ) {
      throw new Error(
        "UPLOAD_ASSET_NOT_VALIDATED",
      );
    }

    if (
      asset.objectDeletedAt !== null
    ) {
      throw new Error(
        "UPLOAD_ASSET_DELETED",
      );
    }

    if (
      asset.provider !==
      "GOOGLE_DRIVE"
    ) {
      throw new Error(
        "UNSUPPORTED_STORAGE_PROVIDER",
      );
    }

    if (
      asset.durationMs === null ||
      asset.durationMs <= 0
    ) {
      throw new Error(
        "VIDEO_DURATION_MISSING",
      );
    }

    const config =
      dependencies?.getConfig
        ? dependencies.getConfig()
        : getThumbnailConfig();

    const sourceSize =
      asset.actualSize !== null
        ? toSafeNumber(
            asset.actualSize,
            "ACTUAL_SIZE",
          )
        : toSafeNumber(
            asset.expectedSize,
            "EXPECTED_SIZE",
          );

    if (
      sourceSize >
      config.maxSourceBytes
    ) {
      throw new Error(
        "THUMBNAIL_SOURCE_TOO_LARGE",
      );
    }

    const effectiveTimestampSeconds =
      resolveEffectiveThumbnailTimestamp(
        input.timestampSeconds,
        asset.durationMs,
      );

    const timestampMs =
      Math.round(
        effectiveTimestampSeconds * 1000,
      );

    const tempDirectory =
      await mkdtemp(
        join(
          tmpdir(),
          "fb-publisher-thumbnail-",
        ),
      );

    const sourcePath =
      join(
        tempDirectory,
        "source-video",
      );

    const outputPath =
      join(
        tempDirectory,
        "thumbnail.jpg",
      );

    const getDownloadStream =
      dependencies?.getDownloadStream ||
      defaultDownloadStream;

    const runFfmpeg =
      dependencies?.runFfmpeg ||
      runFfmpegThumbnailCommand;

    const storeThumbnail =
      dependencies?.storeThumbnail ||
      defaultStoreThumbnail;

    let mediaStream: Readable | null = null;

    try {
      mediaStream =
        await getDownloadStream(
          userId,
          asset,
        );

      await pipeline(
        mediaStream,
        new ByteLimitTransform(
          config.maxSourceBytes,
        ),
        createWriteStream(sourcePath),
      );
    } catch (error: unknown) {
      if (mediaStream) {
        mediaStream.destroy();
      }

      await rm(
        tempDirectory,
        {
          recursive: true,
          force: true,
        },
      );

      throw error;
    }

    return await (async () => {
      try {
        await runFfmpeg({
          ffmpegPath:
            config.ffmpegPath,
          sourcePath,
          outputPath,
          timestampSeconds:
            effectiveTimestampSeconds,
          maxWidth:
            config.maxWidth,
          jpegQuality:
            config.jpegQuality,
          timeoutMs:
            config.extractionTimeoutMs,
        });

        const outputStats =
          await stat(outputPath);

        if (
          !outputStats.isFile() ||
          outputStats.size <= 0
        ) {
          throw new Error(
            "THUMBNAIL_OUTPUT_EMPTY",
          );
        }

        if (
          outputStats.size >
          config.maxThumbnailBytes
        ) {
          throw new Error(
            "THUMBNAIL_OUTPUT_TOO_LARGE",
          );
        }

        const jpegBytes =
          await readFile(outputPath);

        if (
          jpegBytes.length < 4 ||
          jpegBytes[0] !== 0xff ||
          jpegBytes[1] !== 0xd8 ||
          jpegBytes[
            jpegBytes.length - 2
          ] !== 0xff ||
          jpegBytes[
            jpegBytes.length - 1
          ] !== 0xd9
        ) {
          throw new Error(
            "THUMBNAIL_OUTPUT_NOT_JPEG",
          );
        }

        const stored =
          await storeThumbnail(
            userId,
            {
              sourceVideoAssetId:
                asset.id,
              jpegBytes,
              source:
                input.source ||
                "GEMINI_FRAME",
              timestampMs,
            },
          );

        return {
          ...stored,
          requestedTimestampSeconds:
            input.timestampSeconds,
          effectiveTimestampSeconds,
        };
      } finally {
        await rm(
          tempDirectory,
          {
            recursive: true,
            force: true,
          },
        );
      }
    })();
  }
}
