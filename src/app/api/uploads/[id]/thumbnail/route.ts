import {
  NextRequest,
  NextResponse,
} from "next/server";

import {
  verifyAdminSession,
} from "@/lib/auth";
import {
  ThumbnailGenerationError,
  ThumbnailGenerationService,
  type FrameThumbnailSource,
  type GeneratePersistedThumbnailResult,
  type ThumbnailGenerationErrorCode,
} from "@/lib/thumbnails/thumbnail-generation-service";

const MAX_REQUEST_BYTES = 2048;

interface ParsedThumbnailRequest {
  readonly timestampSeconds: number;
  readonly source: FrameThumbnailSource;
}

interface SafeErrorResponse {
  readonly error:
    | ThumbnailGenerationErrorCode
    | "UNAUTHENTICATED"
    | "UNSUPPORTED_MEDIA_TYPE"
    | "INTERNAL_SERVER_ERROR";
  readonly message: string;
}

interface ErrorMapping {
  readonly status: number;
  readonly body: SafeErrorResponse;
}

export interface ThumbnailGenerationRouteDependencies {
  readonly verifySession?:
    typeof verifyAdminSession;
  readonly generateThumbnail?: (
    input: {
      userId: string;
      assetId: string;
      timestampSeconds: number;
      source: FrameThumbnailSource;
    },
  ) => Promise<GeneratePersistedThumbnailResult>;
}

const ERROR_STATUS_BY_CODE: Record<
  ThumbnailGenerationErrorCode,
  number
> = {
  INVALID_REQUEST: 400,
  UPLOAD_ASSET_NOT_FOUND: 404,
  UPLOAD_ASSET_NOT_VALIDATED: 409,
  UPLOAD_ASSET_DELETED: 409,
  UNSUPPORTED_STORAGE_PROVIDER: 422,
  VIDEO_DURATION_MISSING: 422,
  INVALID_THUMBNAIL_TIMESTAMP: 400,
  THUMBNAIL_TIMESTAMP_OUT_OF_RANGE: 422,
  THUMBNAIL_SOURCE_TOO_LARGE: 413,
  SOURCE_VIDEO_UNAVAILABLE: 409,
  GOOGLE_DRIVE_NOT_CONNECTED: 503,
  FFMPEG_NOT_AVAILABLE: 503,
  THUMBNAIL_GENERATION_FAILED: 502,
  THUMBNAIL_PERSISTENCE_FAILED: 500,
};

function invalidRequest(
  message: string,
): ThumbnailGenerationError {
  return new ThumbnailGenerationError(
    "INVALID_REQUEST",
    message,
  );
}

function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

export async function parseThumbnailRequest(
  request: NextRequest,
): Promise<ParsedThumbnailRequest> {
  const contentType =
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();

  if (contentType !== "application/json") {
    throw new ThumbnailGenerationError(
      "INVALID_REQUEST",
      "A JSON request body is required.",
    );
  }

  const contentLength =
    request.headers.get("content-length");

  if (contentLength !== null) {
    const parsedLength =
      Number(contentLength);

    if (
      !Number.isSafeInteger(parsedLength) ||
      parsedLength < 0
    ) {
      throw invalidRequest(
        "Content-Length is invalid.",
      );
    }

    if (parsedLength > MAX_REQUEST_BYTES) {
      throw invalidRequest(
        "Request body is too large.",
      );
    }
  }

  let rawBody: string;

  try {
    rawBody = await request.text();
  } catch {
    throw invalidRequest(
      "Request body could not be read.",
    );
  }

  if (
    Buffer.byteLength(
      rawBody,
      "utf8",
    ) > MAX_REQUEST_BYTES
  ) {
    throw invalidRequest(
      "Request body is too large.",
    );
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw invalidRequest(
      "Request body must contain valid JSON.",
    );
  }

  if (!isPlainRecord(parsed)) {
    throw invalidRequest(
      "Request body must be a JSON object.",
    );
  }

  const allowedKeys =
    new Set([
      "timestampSeconds",
      "source",
    ]);

  const unknownKeys =
    Object.keys(parsed).filter(
      (key) => !allowedKeys.has(key),
    );

  if (unknownKeys.length > 0) {
    throw invalidRequest(
      "Request body contains unsupported fields.",
    );
  }

  if (
    typeof parsed.timestampSeconds !==
      "number" ||
    !Number.isFinite(
      parsed.timestampSeconds,
    ) ||
    parsed.timestampSeconds < 0
  ) {
    throw new ThumbnailGenerationError(
      "INVALID_THUMBNAIL_TIMESTAMP",
      "Thumbnail timestamp must be a non-negative finite number.",
    );
  }

  const source =
    parsed.source === undefined
      ? "MANUAL_FRAME"
      : parsed.source;

  if (
    source !== "GEMINI_FRAME" &&
    source !== "MANUAL_FRAME"
  ) {
    throw invalidRequest(
      "Thumbnail source is invalid.",
    );
  }

  return {
    timestampSeconds:
      parsed.timestampSeconds,
    source,
  };
}

export function mapThumbnailGenerationError(
  error: unknown,
): ErrorMapping {
  if (
    error instanceof
      ThumbnailGenerationError
  ) {
    return {
      status:
        ERROR_STATUS_BY_CODE[
          error.code
        ],
      body: {
        error: error.code,
        message: error.message,
      },
    };
  }

  console.error(
    "Unexpected thumbnail generation API error.",
  );

  return {
    status: 500,
    body: {
      error: "INTERNAL_SERVER_ERROR",
      message:
        "An unexpected error occurred while generating the thumbnail.",
    },
  };
}

export async function handleGenerateThumbnailRequest(
  request: NextRequest,
  params: {
    id: string;
  },
  dependencies:
    ThumbnailGenerationRouteDependencies = {},
): Promise<NextResponse> {
  const verifySession =
    dependencies.verifySession ??
    verifyAdminSession;

  const user =
    await verifySession(request);

  if (!user) {
    return NextResponse.json(
      {
        error: "UNAUTHENTICATED",
        message:
          "Authentication is required.",
      },
      {
        status: 401,
      },
    );
  }

  const assetId =
    params.id?.trim();

  if (!assetId) {
    return NextResponse.json(
      {
        error: "INVALID_REQUEST",
        message:
          "Upload asset ID is required.",
      },
      {
        status: 400,
      },
    );
  }

  try {
    const body =
      await parseThumbnailRequest(
        request,
      );

    const generateThumbnail =
      dependencies.generateThumbnail ??
      (async (input) =>
        await ThumbnailGenerationService
          .generatePersistedThumbnail(
            input,
          ));

    const result =
      await generateThumbnail({
        userId: user.id,
        assetId,
        timestampSeconds:
          body.timestampSeconds,
        source: body.source,
      });

    return NextResponse.json(
      {
        success: true,
        reused: result.isReused,
        thumbnail:
          result.thumbnail,
      },
      {
        status: result.isReused
          ? 200
          : 201,
      },
    );
  } catch (error: unknown) {
    const mapped =
      mapThumbnailGenerationError(
        error,
      );

    return NextResponse.json(
      mapped.body,
      {
        status: mapped.status,
      },
    );
  }
}

export async function POST(
  request: NextRequest,
  context: {
    params: Promise<{
      id: string;
    }>;
  },
): Promise<NextResponse> {
  const params =
    await context.params;

  return await handleGenerateThumbnailRequest(
    request,
    params,
  );
}
