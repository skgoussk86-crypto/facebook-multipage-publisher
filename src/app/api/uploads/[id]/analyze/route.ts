import { NextRequest, NextResponse } from "next/server";

import { verifyAdminSession } from "@/lib/auth";
import {
  AiVideoAnalysisError,
  AiService,
  type AiVideoAnalysisErrorCode,
} from "@/lib/ai";
import {
  GeminiVideoAnalysisError,
  type GeminiVideoAnalysisErrorCode,
} from "@/lib/gemini/gemini-video-analysis-service";

export interface GeminiAnalysisRouteDependencies {
  verifySession?: typeof verifyAdminSession;
  analyzeValidatedAsset?:
    | typeof AiService.analyzeValidatedAsset
    | typeof import("@/lib/gemini/gemini-video-analysis-service").GeminiVideoAnalysisService.analyzeValidatedAsset;
}

interface SafeErrorResponse {
  error: AiVideoAnalysisErrorCode | GeminiVideoAnalysisErrorCode | "INTERNAL_SERVER_ERROR";
  message: string;
  retryable?: boolean;
}

interface ErrorMapping {
  status: number;
  body: SafeErrorResponse;
}

const AI_ERROR_STATUS_BY_CODE: Record<AiVideoAnalysisErrorCode, number> = {
  AI_DISABLED: 503,
  AI_NOT_CONFIGURED: 503,
  AI_PROVIDER_UNAVAILABLE: 502,
  AI_TIMEOUT: 504,
  AI_BUSY: 429,
  AI_INVALID_RESPONSE: 502,
  AI_ANALYSIS_FAILED: 502,
  UPLOAD_ASSET_NOT_FOUND: 404,
  UPLOAD_ASSET_NOT_VALIDATED: 409,
  UPLOAD_ASSET_DELETED: 409,
  UNSUPPORTED_STORAGE_PROVIDER: 422,
  INVALID_VIDEO_METADATA: 422,
  VIDEO_TOO_LARGE: 413,
  VIDEO_DOWNLOAD_FAILED: 502,
};

const GEMINI_ERROR_STATUS_BY_CODE: Record<GeminiVideoAnalysisErrorCode, number> = {
  GEMINI_DISABLED: 503,
  GEMINI_NOT_CONFIGURED: 503,
  UPLOAD_ASSET_NOT_FOUND: 404,
  UPLOAD_ASSET_NOT_VALIDATED: 409,
  UPLOAD_ASSET_DELETED: 409,
  UNSUPPORTED_STORAGE_PROVIDER: 422,
  INVALID_VIDEO_METADATA: 422,
  VIDEO_TOO_LARGE: 413,
  VIDEO_DOWNLOAD_FAILED: 502,
  GEMINI_UPLOAD_FAILED: 502,
  GEMINI_PROCESSING_FAILED: 502,
  GEMINI_ANALYSIS_TIMEOUT: 504,
  GEMINI_GENERATION_FAILED: 502,
  INVALID_MODEL_OUTPUT: 502,
};

export function mapGeminiAnalysisError(
  error: unknown,
): ErrorMapping {
  if (error instanceof AiVideoAnalysisError) {
    const isRetryable = error.code === "AI_BUSY" || error.code === "AI_TIMEOUT" || error.code === "AI_PROVIDER_UNAVAILABLE";
    return {
      status: AI_ERROR_STATUS_BY_CODE[error.code] || 500,
      body: {
        error: error.code,
        message: error.message,
        ...(isRetryable ? { retryable: true } : {}),
      },
    };
  }

  if (error instanceof GeminiVideoAnalysisError) {
    const isRetryable = error.code === "GEMINI_ANALYSIS_TIMEOUT" || error.code === "VIDEO_DOWNLOAD_FAILED";
    return {
      status: GEMINI_ERROR_STATUS_BY_CODE[error.code] || 500,
      body: {
        error: error.code,
        message: error.message,
        ...(isRetryable ? { retryable: true } : {}),
      },
    };
  }

  console.error(
    "Unexpected AI analysis API error:",
    error,
  );

  return {
    status: 500,
    body: {
      error: "INTERNAL_SERVER_ERROR",
      message:
        "An unexpected error occurred while analyzing the video.",
    },
  };
}

export async function handleAnalyzeUploadRequest(
  request: NextRequest,
  params: { id: string },
  dependencies: GeminiAnalysisRouteDependencies = {},
): Promise<NextResponse> {
  const verifySession =
    dependencies.verifySession ?? verifyAdminSession;

  const user = await verifySession(request);

  if (!user) {
    return NextResponse.json(
      {
        error: "UNAUTHENTICATED",
        message: "Authentication is required.",
      },
      { status: 401 },
    );
  }

  const assetId = params.id?.trim();

  if (!assetId) {
    return NextResponse.json(
      {
        error: "INVALID_REQUEST",
        message: "Upload asset ID is required.",
      },
      { status: 400 },
    );
  }

  const analyzeValidatedAsset =
    dependencies.analyzeValidatedAsset ??
    AiService.analyzeValidatedAsset.bind(AiService);

  try {
    const analysis = await analyzeValidatedAsset(
      user.id,
      assetId,
    );

    return NextResponse.json(
      {
        success: true,
        analysis: {
          title: analysis.title,
          caption: analysis.caption,
          hashtags: analysis.hashtags,
          thumbnailTimestampSeconds:
            analysis.thumbnailTimestampSeconds,
          thumbnailReason:
            (analysis as unknown as Record<string, unknown>).thumbnailReason as string || "AI recommended thumbnail frame.",
        },
      },
      { status: 200 },
    );
  } catch (error) {
    const mapped = mapGeminiAnalysisError(error);

    return NextResponse.json(
      mapped.body,
      { status: mapped.status },
    );
  }
}

export async function POST(
  request: NextRequest,
  context: {
    params: Promise<{ id: string }>;
  },
): Promise<NextResponse> {
  const params = await context.params;

  return await handleAnalyzeUploadRequest(
    request,
    params,
  );
}
