import { NextRequest, NextResponse } from "next/server";

import { verifyAdminSession } from "@/lib/auth";
import { AiService, AiVideoAnalysisError, type AiVideoAnalysisErrorCode } from "@/lib/ai";
import { GeminiVideoAnalysisError, type GeminiVideoAnalysisErrorCode } from "@/lib/gemini/gemini-video-analysis-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface SafeStreamingErrorResponse {
  error: string;
  message: string;
  retryable?: boolean;
}

export function mapSafeStreamingError(error: unknown): SafeStreamingErrorResponse {
  if (error instanceof AiVideoAnalysisError) {
    const isRetryable = error.code === "AI_BUSY" || error.code === "AI_TIMEOUT" || error.code === "AI_PROVIDER_UNAVAILABLE";
    const messages: Record<AiVideoAnalysisErrorCode, string> = {
      AI_DISABLED: "AI analysis is currently disabled.",
      AI_NOT_CONFIGURED: "AI analysis is not configured.",
      AI_PROVIDER_UNAVAILABLE: "The local AI service is unavailable. Please try again.",
      AI_TIMEOUT: "The local AI service took too long to respond. Please try again.",
      AI_BUSY: "The local AI service is busy. Please try again.",
      AI_INVALID_RESPONSE: "The local AI service returned an invalid response. Please try again.",
      AI_ANALYSIS_FAILED: "The video could not be analyzed. Please try again.",
      UPLOAD_ASSET_NOT_FOUND: "The uploaded video could not be found.",
      UPLOAD_ASSET_NOT_VALIDATED: "Wait until the video finishes validation.",
      UPLOAD_ASSET_DELETED: "The uploaded video is no longer available.",
      UNSUPPORTED_STORAGE_PROVIDER: "This video's storage provider is not supported for AI analysis.",
      INVALID_VIDEO_METADATA: "The uploaded video metadata is invalid.",
      VIDEO_TOO_LARGE: "The video is too large for AI analysis.",
      VIDEO_DOWNLOAD_FAILED: "The video could not be prepared for AI analysis. Please try again.",
    };
    return {
      error: error.code,
      message: messages[error.code] || "The video could not be analyzed. Please try again.",
      ...(isRetryable ? { retryable: true } : {}),
    };
  }

  if (error instanceof GeminiVideoAnalysisError) {
    const isRetryable = error.code === "GEMINI_ANALYSIS_TIMEOUT" || error.code === "VIDEO_DOWNLOAD_FAILED";
    const messages: Record<GeminiVideoAnalysisErrorCode, string> = {
      GEMINI_DISABLED: "Gemini AI analysis is currently disabled.",
      GEMINI_NOT_CONFIGURED: "Gemini AI analysis is not configured.",
      UPLOAD_ASSET_NOT_FOUND: "The uploaded video could not be found.",
      UPLOAD_ASSET_NOT_VALIDATED: "Wait until the video finishes validation.",
      UPLOAD_ASSET_DELETED: "The uploaded video is no longer available.",
      UNSUPPORTED_STORAGE_PROVIDER: "This video's storage provider is not supported for AI analysis.",
      INVALID_VIDEO_METADATA: "The uploaded video metadata is invalid.",
      VIDEO_TOO_LARGE: "The video is too large for AI analysis.",
      VIDEO_DOWNLOAD_FAILED: "The video could not be prepared for AI analysis. Please try again.",
      GEMINI_UPLOAD_FAILED: "The video could not be prepared for Gemini analysis. Please try again.",
      GEMINI_PROCESSING_FAILED: "Gemini processing failed. Please try again.",
      GEMINI_ANALYSIS_TIMEOUT: "Gemini analysis timed out. Please try again.",
      GEMINI_GENERATION_FAILED: "Gemini content generation failed. Please try again.",
      INVALID_MODEL_OUTPUT: "Gemini returned an invalid output structure. Please try again.",
    };
    return {
      error: error.code,
      message: messages[error.code] || "The video could not be analyzed. Please try again.",
      ...(isRetryable ? { retryable: true } : {}),
    };
  }

  return {
    error: "INTERNAL_SERVER_ERROR",
    message: "An unexpected error occurred while analyzing the video.",
  };
}

export async function handleAnalyzeStreamRequest(
  request: NextRequest,
  params: { id: string },
  dependencies: {
    verifySession?: typeof verifyAdminSession;
    analyzeValidatedAsset?: typeof AiService.analyzeValidatedAsset;
    heartbeatIntervalMs?: number;
  } = {}
): Promise<NextResponse> {
  const verifySession = dependencies.verifySession ?? verifyAdminSession;
  const analyzeValidatedAsset =
    dependencies.analyzeValidatedAsset ??
    AiService.analyzeValidatedAsset.bind(AiService);
  const heartbeatIntervalMs = dependencies.heartbeatIntervalMs ?? 10000;

  const user = await verifySession(request);

  if (!user) {
    return NextResponse.json(
      {
        error: "UNAUTHENTICATED",
        message: "Authentication is required.",
      },
      { status: 401 }
    );
  }

  const assetId = params.id?.trim();

  if (!assetId) {
    return NextResponse.json(
      {
        error: "INVALID_REQUEST",
        message: "Upload asset ID is required.",
      },
      { status: 400 }
    );
  }

  const encoder = new TextEncoder();

  let heartbeatTimer: NodeJS.Timeout | null = null;
  let isClosed = false;
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;

  const cleanUp = () => {
    if (isClosed) return;
    isClosed = true;

    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    request.signal.removeEventListener("abort", handleAbort);
  };

  const handleAbort = () => {
    cleanUp();
    if (streamController) {
      try {
        streamController.close();
      } catch {}
    }
  };

  const safeEnqueue = (chunk: string) => {
    if (isClosed || !streamController) return;
    try {
      streamController.enqueue(encoder.encode(chunk));
    } catch {
      cleanUp();
    }
  };

  const safeClose = () => {
    cleanUp();
    if (streamController) {
      try {
        streamController.close();
      } catch {}
    }
  };

  request.signal.addEventListener("abort", handleAbort);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      streamController = controller;

      if (request.signal.aborted) {
        handleAbort();
        return;
      }

      try {
        // Enqueue 2 KB padding followed by ready event to flush proxy buffering
        const padding = " ".repeat(2048);
        safeEnqueue(`: ${padding}\n\nevent: ready\ndata: {"status":"started"}\n\n`);

        // Start heartbeat timer
        heartbeatTimer = setInterval(() => {
          if (isClosed) return;
          const timestamp = new Date().toISOString();
          safeEnqueue(`: heartbeat ${timestamp}\n\n`);
        }, heartbeatIntervalMs);

        // Run analysis once
        const analysis = await analyzeValidatedAsset(user.id, assetId, {
          abortSignal: request.signal,
        });

        if (isClosed) return;

        const resultPayload = {
          success: true,
          analysis: {
            title: analysis.title,
            caption: analysis.caption,
            hashtags: analysis.hashtags,
            thumbnailTimestampSeconds: analysis.thumbnailTimestampSeconds,
            thumbnailReason:
              (analysis as unknown as Record<string, unknown>).thumbnailReason as string ||
              "AI recommended thumbnail frame.",
          },
        };

        safeEnqueue(`event: result\ndata: ${JSON.stringify(resultPayload)}\n\n`);
        safeClose();
      } catch (error) {
        if (isClosed) return;

        let errorPayload: SafeStreamingErrorResponse;

        if (error instanceof AiVideoAnalysisError || error instanceof GeminiVideoAnalysisError) {
          console.error("AI_ANALYSIS_STREAM_EXPECTED_ERROR", error.code);
          errorPayload = mapSafeStreamingError(error);
        } else {
          console.error("AI_ANALYSIS_STREAM_UNEXPECTED_ERROR");
          errorPayload = mapSafeStreamingError(error);
        }

        safeEnqueue(`event: error\ndata: ${JSON.stringify(errorPayload)}\n\n`);
        safeClose();
      }
    },
    cancel() {
      cleanUp();
    }
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

export async function POST(
  request: NextRequest,
  context: {
    params: Promise<{ id: string }>;
  }
): Promise<NextResponse> {
  const params = await context.params;
  return handleAnalyzeStreamRequest(request, params);
}
