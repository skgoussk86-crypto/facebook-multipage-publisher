import "server-only";

import { getAiConfig } from "./ai-config";
import {
  AiVideoAnalysisError,
  GeneratedVideoContent,
} from "./ai-types";
import { OllamaClient } from "./ollama/ollama-client";
import { OllamaFrameExtractor } from "./ollama/ollama-frame-extractor";

// Global process-level mutex to enforce concurrency limit
const activeAiAnalysisSymbol = Symbol.for("fb-publisher-active-ai-analysis");
const globalObject = globalThis as unknown as Record<symbol, boolean>;

if (globalObject[activeAiAnalysisSymbol] === undefined) {
  globalObject[activeAiAnalysisSymbol] = false;
}

export interface AiServiceAsset {
  id: string;
  userId: string;
  provider: string;
  objectKey: string;
  status: string;
  originalName: string;
  expectedSize: bigint;
  actualSize: bigint | null;
  declaredMimeType: string;
  detectedMimeType: string | null;
  durationMs: number | null;
  objectDeletedAt: Date | null;
}

export interface AiServiceDependencies {
  abortSignal?: AbortSignal;
  now?: () => number;
  findAsset?: (assetId: string) => Promise<AiServiceAsset | null>;
  extractFrames?: (params: {
    userId: string;
    asset: AiServiceAsset;
    frameCount: number;
  }) => Promise<{ timestamps: number[]; base64Frames: string[] }>;
  generateOllamaMetadata?: (params: {
    durationSeconds: number;
    timestamps: number[];
    base64Frames: string[];
    abortSignal?: AbortSignal;
  }) => Promise<GeneratedVideoContent>;
}

export class AiService {
  /**
   * Helper to check if analysis is active
   */
  public static isBusy(): boolean {
    return !!globalObject[activeAiAnalysisSymbol];
  }

  /**
   * Safe process-local acquire lock
   */
  private static acquireLock(): boolean {
    if (globalObject[activeAiAnalysisSymbol]) {
      return false;
    }
    globalObject[activeAiAnalysisSymbol] = true;
    return true;
  }

  /**
   * Safe process-local release lock
   */
  public static releaseLock(): void {
    globalObject[activeAiAnalysisSymbol] = false;
  }

  /**
   * Central orchestrator for video asset analysis
   */
  public static async analyzeValidatedAsset(
    userId: string,
    assetId: string,
    dependencies: AiServiceDependencies = {}
  ): Promise<GeneratedVideoContent> {
    const { abortSignal, findAsset, extractFrames, generateOllamaMetadata } = dependencies;

    // 1. Concurrency control: check and acquire lock
    const lockAcquired = this.acquireLock();
    if (!lockAcquired) {
      throw new AiVideoAnalysisError(
        "AI_BUSY",
        "The local AI service is currently busy processing another video. Please try again."
      );
    }

    try {
      // 2. Load configurations
      const config = getAiConfig(process.env);

      // 3. Retrieve and validate the asset with ownership checks
      let asset: AiServiceAsset | null = null;
      if (findAsset) {
        asset = await findAsset(assetId);
      } else {
        const { prisma } = await import("@/lib/prisma-client");
        asset = await prisma.uploadAsset.findUnique({
          where: { id: assetId },
          select: {
            id: true,
            userId: true,
            provider: true,
            objectKey: true,
            status: true,
            originalName: true,
            expectedSize: true,
            actualSize: true,
            declaredMimeType: true,
            detectedMimeType: true,
            durationMs: true,
            objectDeletedAt: true,
          },
        });
      }

      if (!asset || asset.userId !== userId) {
        throw new AiVideoAnalysisError(
          "UPLOAD_ASSET_NOT_FOUND",
          "The requested video upload asset was not found or is inaccessible."
        );
      }

      if (asset.status !== "VALIDATED") {
        throw new AiVideoAnalysisError(
          "UPLOAD_ASSET_NOT_VALIDATED",
          "The video file must complete upload validation before running analysis."
        );
      }

      if (asset.objectDeletedAt) {
        throw new AiVideoAnalysisError(
          "UPLOAD_ASSET_DELETED",
          "The video file is no longer available."
        );
      }

      if (asset.provider !== "GOOGLE_DRIVE") {
        throw new AiVideoAnalysisError(
          "UNSUPPORTED_STORAGE_PROVIDER",
          "AI content generation is only supported for Google Drive uploads."
        );
      }

      if (!asset.durationMs || asset.durationMs <= 0) {
        throw new AiVideoAnalysisError(
          "INVALID_VIDEO_METADATA",
          "The validated video does not contain a valid duration."
        );
      }

      const mimeType = asset.detectedMimeType || asset.declaredMimeType;
      if (!mimeType.startsWith("video/")) {
        throw new AiVideoAnalysisError(
          "INVALID_VIDEO_METADATA",
          "The upload asset contains an unsupported non-video MIME type."
        );
      }

      // 4. Delegate to the selected provider
      if (config.provider === "OLLAMA") {
        // Step 4A: Frame extraction on the local disk
        const extractorFn =
          extractFrames ??
          OllamaFrameExtractor.extractFrames.bind(
            OllamaFrameExtractor
          );
        const { timestamps, base64Frames } = await extractorFn({
          userId,
          asset: {
            ...asset,
            expectedSize: BigInt(asset.expectedSize),
          },
          frameCount: config.ollamaFrameCount,
        });

        if (base64Frames.length === 0) {
          throw new AiVideoAnalysisError(
            "AI_ANALYSIS_FAILED",
            "Could not extract representative frames from the video."
          );
        }

        // Step 4B: Query the Ollama local chat API
        let analysis: GeneratedVideoContent;
        if (generateOllamaMetadata) {
          analysis = await generateOllamaMetadata({
            durationSeconds: asset.durationMs / 1000,
            timestamps,
            base64Frames,
            abortSignal,
          });
        } else {
          const ollamaClient = new OllamaClient({
            baseUrl: config.ollamaBaseUrl,
            model: config.ollamaModel,
            timeoutMs: config.ollamaRequestTimeoutMs,
          });
          analysis = await ollamaClient.generateVideoMetadata({
            durationSeconds: asset.durationMs / 1000,
            timestamps,
            base64Frames,
            abortSignal,
          });
        }

        return analysis;
      } else if (config.provider === "GEMINI") {
        // Keep Gemini implementation available but isolated
        const { GeminiVideoAnalysisService } = await import(
          "../gemini/gemini-video-analysis-service"
        );
        const result = await GeminiVideoAnalysisService.analyzeValidatedAsset(
          userId,
          assetId,
          {
            getConfig: () => ({
              enabled: config.geminiEnabled,
              apiKey: config.geminiApiKey,
              model: config.geminiModel,
              maxVideoBytes: 524288000,
              analysisTimeoutMs: 180000,
              filePollIntervalMs: 5000,
            }),
          }
        );

        return {
          title: result.title,
          caption: result.caption,
          hashtags: result.hashtags,
          thumbnailTimestampSeconds: result.thumbnailTimestampSeconds,
        };
      } else {
        throw new AiVideoAnalysisError(
          "AI_NOT_CONFIGURED",
          "Unsupported AI provider specified in configuration."
        );
      }
    } finally {
      // 5. Release lock in finally block
      this.releaseLock();
    }
  }
}
