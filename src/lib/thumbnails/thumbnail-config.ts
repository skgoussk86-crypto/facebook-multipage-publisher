import "server-only";

export interface ThumbnailConfig {
  readonly ffmpegPath: string;
  readonly extractionTimeoutMs: number;
  readonly maxSourceBytes: number;
  readonly maxThumbnailBytes: number;
  readonly maxWidth: number;
  readonly jpegQuality: number;
}

function readPositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }

  return parsed;
}

export function getThumbnailConfig(
  env: NodeJS.ProcessEnv = process.env,
): ThumbnailConfig {
  const ffmpegPath =
    env.FFMPEG_PATH?.trim() || "ffmpeg";

  const extractionTimeoutMs =
    readPositiveInteger(
      env.THUMBNAIL_EXTRACTION_TIMEOUT_MS,
      60_000,
      "THUMBNAIL_EXTRACTION_TIMEOUT_MS",
    );

  const maxSourceBytes =
    readPositiveInteger(
      env.THUMBNAIL_MAX_SOURCE_BYTES,
      524_288_000,
      "THUMBNAIL_MAX_SOURCE_BYTES",
    );

  const maxThumbnailBytes =
    readPositiveInteger(
      env.THUMBNAIL_MAX_BYTES,
      10_485_760,
      "THUMBNAIL_MAX_BYTES",
    );

  const maxWidth =
    readPositiveInteger(
      env.THUMBNAIL_MAX_WIDTH,
      1_280,
      "THUMBNAIL_MAX_WIDTH",
    );

  const jpegQuality =
    readPositiveInteger(
      env.THUMBNAIL_JPEG_QUALITY,
      2,
      "THUMBNAIL_JPEG_QUALITY",
    );

  if (jpegQuality > 31) {
    throw new Error(
      "THUMBNAIL_JPEG_QUALITY must be between 1 and 31.",
    );
  }

  return {
    ffmpegPath,
    extractionTimeoutMs,
    maxSourceBytes,
    maxThumbnailBytes,
    maxWidth,
    jpegQuality,
  };
}
