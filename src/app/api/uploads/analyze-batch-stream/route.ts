import { NextRequest, NextResponse } from "next/server";

import { verifyAdminSession } from "@/lib/auth";
import { AiService, AiVideoAnalysisError, aiSemaphore } from "@/lib/ai";
import { GeminiVideoAnalysisError } from "@/lib/gemini/gemini-video-analysis-service";
import { mapSafeStreamingError } from "../[id]/analyze-stream/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface BatchRequestPayload {
  assetIds: string[];
  regenerateCompleted?: boolean;
  concurrency?: number;
}

export async function handleAnalyzeBatchStreamRequest(
  request: NextRequest,
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

  if (user.status !== "ACTIVE" || user.approvalStatus !== "APPROVED") {
    return NextResponse.json(
      {
        error: "FORBIDDEN",
        message: "User is not active or approved.",
      },
      { status: 403 }
    );
  }

  let body: BatchRequestPayload;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        error: "INVALID_REQUEST",
        message: "Invalid JSON request body.",
      },
      { status: 400 }
    );
  }

  const { assetIds, concurrency } = body;

  if (!assetIds || !Array.isArray(assetIds) || assetIds.length === 0) {
    return NextResponse.json(
      {
        error: "INVALID_REQUEST",
        message: "assetIds must be a non-empty array.",
      },
      { status: 400 }
    );
  }

  if (assetIds.some((id) => typeof id !== "string" || !id.trim())) {
    return NextResponse.json(
      {
        error: "INVALID_REQUEST",
        message: "All assetIds must be non-empty strings.",
      },
      { status: 400 }
    );
  }

  const uniqueAssetIds = Array.from(new Set(assetIds.map((id) => id.trim())));

  if (uniqueAssetIds.length > 50) {
    return NextResponse.json(
      {
        error: "INVALID_REQUEST",
        message: "A batch cannot exceed 50 media files.",
      },
      { status: 400 }
    );
  }

  let parsedConcurrency = typeof concurrency === "number" ? concurrency : 2;
  parsedConcurrency = Math.max(1, Math.min(5, Math.floor(parsedConcurrency)));

  const { prisma } = await import("@/lib/prisma-client");
  const dbAssets = await prisma.uploadAsset.findMany({
    where: {
      id: { in: uniqueAssetIds },
    },
    select: {
      id: true,
      userId: true,
      status: true,
      objectDeletedAt: true,
    },
  });

  const assetMap = new Map(dbAssets.map((a) => [a.id, a]));

  for (const assetId of uniqueAssetIds) {
    const asset = assetMap.get(assetId);
    if (!asset || asset.userId !== user.id) {
      return NextResponse.json(
        {
          error: "UPLOAD_ASSET_NOT_FOUND",
          message: "One or more requested media assets were not found.",
        },
        { status: 404 }
      );
    }
    if (asset.status !== "VALIDATED") {
      return NextResponse.json(
        {
          error: "UPLOAD_ASSET_NOT_VALIDATED",
          message: `Media asset ${assetId} must complete validation.`,
        },
        { status: 400 }
      );
    }
    if (asset.objectDeletedAt) {
      return NextResponse.json(
        {
          error: "UPLOAD_ASSET_DELETED",
          message: `Media asset ${assetId} is deleted.`,
        },
        { status: 400 }
      );
    }
  }

  const encoder = new TextEncoder();
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let isClosed = false;
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  const batchAbortController = new AbortController();

  const cleanUp = () => {
    if (isClosed) return;
    isClosed = true;

    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    request.signal.removeEventListener("abort", handleAbort);
    batchAbortController.abort();
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

      // Enqueue 2 KB padding followed by ready event to flush proxy buffering
      const padding = " ".repeat(2048);
      safeEnqueue(`: ${padding}\n\nevent: ready\ndata: {"status":"started"}\n\n`);

      // Start heartbeat timer
      heartbeatTimer = setInterval(() => {
        if (isClosed) return;
        const timestamp = new Date().toISOString();
        safeEnqueue(`: heartbeat ${timestamp}\n\n`);
      }, heartbeatIntervalMs);

      // Dynamically configure semaphore concurrency
      aiSemaphore.setMaxPermits(parsedConcurrency);

      let activeCount = 0;
      let completedCount = 0;
      let failedCount = 0;
      let succeededCount = 0;
      let nextIndex = 0;
      const totalCount = uniqueAssetIds.length;

      // Emit batch-ready event
      safeEnqueue(`event: batch-ready\ndata: ${JSON.stringify({ total: totalCount, concurrency: parsedConcurrency })}\n\n`);

      // Emit item-queued events at start
      for (let i = 0; i < totalCount; i++) {
        safeEnqueue(`event: item-queued\ndata: ${JSON.stringify({ assetId: uniqueAssetIds[i], position: i + 1 })}\n\n`);
      }

      const finishBatch = () => {
        if (isClosed) return;
        const completePayload = {
          total: totalCount,
          succeeded: succeededCount,
          failed: failedCount,
          cancelled: batchAbortController.signal.aborted ? (totalCount - succeededCount - failedCount) : 0,
        };
        safeEnqueue(`event: batch-complete\ndata: ${JSON.stringify(completePayload)}\n\n`);
        safeClose();
      };

      const runTask = async (assetId: string) => {
        if (batchAbortController.signal.aborted || isClosed) {
          return;
        }

        activeCount++;

        safeEnqueue(`event: item-started\ndata: ${JSON.stringify({
          assetId,
          active: activeCount,
          completed: completedCount,
          failed: failedCount,
          total: totalCount
        })}\n\n`);

        try {
          const analysis = await analyzeValidatedAsset(user.id, assetId, {
            abortSignal: batchAbortController.signal,
          });

          if (batchAbortController.signal.aborted || isClosed) {
            return;
          }

          succeededCount++;
          completedCount++;

          const resultPayload = {
            assetId,
            analysis: {
              title: analysis.title,
              caption: analysis.caption,
              hashtags: analysis.hashtags,
              thumbnailTimestampSeconds: analysis.thumbnailTimestampSeconds,
              thumbnailReason:
                (analysis as { thumbnailReason?: string }).thumbnailReason || "AI recommended thumbnail frame.",
            },
            completed: completedCount,
            failed: failedCount,
            remaining: totalCount - completedCount - failedCount,
            total: totalCount,
          };

          safeEnqueue(`event: item-result\ndata: ${JSON.stringify(resultPayload)}\n\n`);
        } catch (error: unknown) {
          if (batchAbortController.signal.aborted || isClosed) {
            return;
          }

          failedCount++;

          const errorResponse = mapSafeStreamingError(error);

          const errorPayload = {
            assetId,
            code: errorResponse.error,
            message: errorResponse.message,
            retryable: errorResponse.retryable || false,
            completed: completedCount,
            failed: failedCount,
            remaining: totalCount - completedCount - failedCount,
            total: totalCount,
          };

          if (error instanceof AiVideoAnalysisError || error instanceof GeminiVideoAnalysisError) {
            console.error("AI_ANALYSIS_STREAM_EXPECTED_ERROR", error.code);
          } else {
            console.error("AI_ANALYSIS_STREAM_UNEXPECTED_ERROR");
          }

          safeEnqueue(`event: item-error\ndata: ${JSON.stringify(errorPayload)}\n\n`);
        } finally {
          activeCount--;

          if (nextIndex < totalCount && !batchAbortController.signal.aborted && !isClosed) {
            const idx = nextIndex++;
            void runTask(uniqueAssetIds[idx]);
          } else if (activeCount === 0) {
            finishBatch();
          }
        }
      };

      // Trigger the pool workers
      const initialCount = Math.min(parsedConcurrency, totalCount);
      nextIndex = initialCount;
      for (let i = 0; i < initialCount; i++) {
        void runTask(uniqueAssetIds[i]);
      }
    },
    cancel() {
      cleanUp();
    },
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

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handleAnalyzeBatchStreamRequest(request);
}
