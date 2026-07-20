import "server-only";

import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Readable,
  Transform,
  type TransformCallback,
} from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  GoogleGenAI,
  createPartFromUri,
  createUserContent,
} from "@google/genai";

import type { UploadAsset } from "@prisma/client";

import {
  getGeminiConfig,
  type GeminiConfig,
} from "@/lib/gemini/gemini-config";
import {
  GEMINI_VIDEO_OUTPUT_JSON_SCHEMA,
  parseGeminiVideoOutput,
  type GeminiVideoOutput,
} from "@/lib/gemini/gemini-video-output";

export type GeminiVideoAnalysisErrorCode =
  | "GEMINI_DISABLED"
  | "GEMINI_NOT_CONFIGURED"
  | "UPLOAD_ASSET_NOT_FOUND"
  | "UPLOAD_ASSET_NOT_VALIDATED"
  | "UPLOAD_ASSET_DELETED"
  | "UNSUPPORTED_STORAGE_PROVIDER"
  | "INVALID_VIDEO_METADATA"
  | "VIDEO_TOO_LARGE"
  | "VIDEO_DOWNLOAD_FAILED"
  | "GEMINI_UPLOAD_FAILED"
  | "GEMINI_PROCESSING_FAILED"
  | "GEMINI_ANALYSIS_TIMEOUT"
  | "GEMINI_GENERATION_FAILED"
  | "INVALID_MODEL_OUTPUT";

export class GeminiVideoAnalysisError extends Error {
  constructor(
    public readonly code: GeminiVideoAnalysisErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GeminiVideoAnalysisError";
  }
}

export interface GeminiAnalyzableAsset {
  id: string;
  userId: string;
  provider: string;
  objectKey: string;
  originalName: string;
  expectedSize: bigint;
  actualSize: bigint | null;
  declaredMimeType: string;
  detectedMimeType: string | null;
  status: string;
  durationMs: number | null;
  objectDeletedAt: Date | null;
}

interface GeminiRemoteFile {
  name?: string;
  uri?: string;
  mimeType?: string;
  state?: string;
}

export interface GeminiClientAdapter {
  uploadVideo(params: {
    filePath: string;
    mimeType: string;
    displayName: string;
    abortSignal: AbortSignal;
  }): Promise<GeminiRemoteFile>;

  getFile(
    name: string,
  ): Promise<GeminiRemoteFile>;

  generateVideoMetadata(params: {
    model: string;
    fileUri: string;
    mimeType: string;
    prompt: string;
    responseJsonSchema: unknown;
    abortSignal: AbortSignal;
  }): Promise<string>;

  deleteFile(name: string): Promise<void>;
}

export interface GeminiVideoAnalysisDependencies {
  getConfig?: () => GeminiConfig;
  findAsset?: (
    assetId: string,
  ) => Promise<GeminiAnalyzableAsset | null>;
  getDownloadStream?: (
    userId: string,
    asset: GeminiAnalyzableAsset,
  ) => Promise<Readable>;
  createClient?: (
    apiKey: string,
  ) => GeminiClientAdapter;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

class GoogleGenAIClientAdapter
  implements GeminiClientAdapter {
  private readonly client: GoogleGenAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenAI({ apiKey });
  }

  async uploadVideo(params: {
    filePath: string;
    mimeType: string;
    displayName: string;
    abortSignal: AbortSignal;
  }): Promise<GeminiRemoteFile> {
    return await this.client.files.upload({
      file: params.filePath,
      config: {
        mimeType: params.mimeType,
        displayName: params.displayName,
        abortSignal: params.abortSignal,
      },
    });
  }

  async getFile(
    name: string,
  ): Promise<GeminiRemoteFile> {
    return await this.client.files.get({ name });
  }

  async generateVideoMetadata(params: {
    model: string;
    fileUri: string;
    mimeType: string;
    prompt: string;
    responseJsonSchema: unknown;
    abortSignal: AbortSignal;
  }): Promise<string> {
    const response =
      await this.client.models.generateContent({
        model: params.model,
        contents: createUserContent([
          createPartFromUri(
            params.fileUri,
            params.mimeType,
          ),
          params.prompt,
        ]),
        config: {
          abortSignal: params.abortSignal,
          responseMimeType:
            "application/json",
          responseJsonSchema:
            params.responseJsonSchema,
          temperature: 0.3,
          maxOutputTokens: 1200,
        },
      });

    const text = response.text;

    if (!text || text.trim() === "") {
      throw new Error(
        "Gemini returned an empty response.",
      );
    }

    return text;
  }

  async deleteFile(name: string): Promise<void> {
    await this.client.files.delete({ name });
  }
}

function createDefaultClient(
  apiKey: string,
): GeminiClientAdapter {
  return new GoogleGenAIClientAdapter(apiKey);
}

async function findAssetById(
  assetId: string,
): Promise<GeminiAnalyzableAsset | null> {
  const { prisma } = await import(
    "@/lib/prisma-client"
  );

  return await prisma.uploadAsset.findUnique({
    where: { id: assetId },
    select: {
      id: true,
      userId: true,
      provider: true,
      objectKey: true,
      originalName: true,
      expectedSize: true,
      actualSize: true,
      declaredMimeType: true,
      detectedMimeType: true,
      status: true,
      durationMs: true,
      objectDeletedAt: true,
    },
  });
}

async function getAssetDownloadStream(
  userId: string,
  asset: GeminiAnalyzableAsset,
): Promise<Readable> {
  const { GoogleDriveMediaReader } =
    await import(
      "@/lib/google-drive/google-drive-media-reader"
    );

  return await GoogleDriveMediaReader
    .getDownloadStream(
      userId,
      asset as UploadAsset,
    );
}

function sleep(
  milliseconds: number,
): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function normalizeMimeType(
  asset: GeminiAnalyzableAsset,
): string {
  const mimeType =
    asset.detectedMimeType?.trim() ||
    asset.declaredMimeType.trim();

  if (!mimeType.startsWith("video/")) {
    throw new GeminiVideoAnalysisError(
      "INVALID_VIDEO_METADATA",
      "The upload asset does not contain a supported video MIME type.",
    );
  }

  return mimeType;
}

function getVideoExtension(
  mimeType: string,
): string {
  if (mimeType === "video/quicktime") {
    return ".mov";
  }

  return ".mp4";
}

function buildAnalysisPrompt(
  durationSeconds: number,
): string {
  return [
    "Analyze the entire uploaded video carefully.",
    "Return accurate English metadata for a Facebook video post.",
    "Create one engaging title that matches what is visibly happening.",
    "Create one concise caption that adds context without inventing names, locations, causes, quotes, outcomes, or facts that are not clearly supported by the video.",
    "Return exactly five unique and relevant hashtags, each beginning with #.",
    "Choose the strongest thumbnail timestamp from within the video.",
    "Prefer a sharp, well-lit frame with a clear main subject, visible emotion or action, good composition, and minimal motion blur.",
    "Avoid black frames, transitions, closed eyes, obstructed faces, duplicated subjects, distorted anatomy, or unreadable moments.",
    `The video duration is ${durationSeconds.toFixed(3)} seconds.`,
    "The thumbnail timestamp must be between 0 and the video duration.",
    "Return only the requested structured JSON.",
  ].join(" ");
}

function parseModelOutput(
  rawText: string,
  durationSeconds: number,
): GeminiVideoOutput {
  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(rawText);
  } catch {
    throw new GeminiVideoAnalysisError(
      "INVALID_MODEL_OUTPUT",
      "Gemini returned invalid JSON.",
    );
  }

  try {
    return parseGeminiVideoOutput(
      parsedJson,
      durationSeconds,
    );
  } catch {
    throw new GeminiVideoAnalysisError(
      "INVALID_MODEL_OUTPUT",
      "Gemini returned metadata that failed validation.",
    );
  }
}

function assertAssetCanBeAnalyzed(
  userId: string,
  asset: GeminiAnalyzableAsset | null,
  config: GeminiConfig,
): asserts asset is GeminiAnalyzableAsset {
  if (!asset || asset.userId !== userId) {
    throw new GeminiVideoAnalysisError(
      "UPLOAD_ASSET_NOT_FOUND",
      "Upload asset not found.",
    );
  }

  if (asset.status !== "VALIDATED") {
    throw new GeminiVideoAnalysisError(
      "UPLOAD_ASSET_NOT_VALIDATED",
      "Upload asset must be validated before Gemini analysis.",
    );
  }

  if (asset.objectDeletedAt) {
    throw new GeminiVideoAnalysisError(
      "UPLOAD_ASSET_DELETED",
      "Upload asset has already been deleted.",
    );
  }

  if (asset.provider !== "GOOGLE_DRIVE") {
    throw new GeminiVideoAnalysisError(
      "UNSUPPORTED_STORAGE_PROVIDER",
      "Gemini analysis currently requires a Google Drive upload asset.",
    );
  }

  if (
    asset.durationMs === null ||
    asset.durationMs <= 0
  ) {
    throw new GeminiVideoAnalysisError(
      "INVALID_VIDEO_METADATA",
      "Validated video duration is missing or invalid.",
    );
  }

  const assetSize =
    asset.actualSize ?? asset.expectedSize;

  if (assetSize <= BigInt(0)) {
    throw new GeminiVideoAnalysisError(
      "INVALID_VIDEO_METADATA",
      "Validated video size is missing or invalid.",
    );
  }

  if (
    assetSize > BigInt(config.maxVideoBytes)
  ) {
    throw new GeminiVideoAnalysisError(
      "VIDEO_TOO_LARGE",
      "Video exceeds the configured Gemini analysis size limit.",
    );
  }
}

async function writeStreamToLimitedFile(
  source: Readable,
  destinationPath: string,
  maxBytes: number,
): Promise<number> {
  let bytesWritten = 0;

  const limiter = new Transform({
    transform(
      chunk: Buffer | string,
      encoding: BufferEncoding,
      callback: TransformCallback,
    ) {
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk, encoding);

      bytesWritten += buffer.byteLength;

      if (bytesWritten > maxBytes) {
        callback(
          new GeminiVideoAnalysisError(
            "VIDEO_TOO_LARGE",
            "Downloaded video exceeds the configured Gemini analysis size limit.",
          ),
        );
        return;
      }

      callback(null, buffer);
    },
  });

  await pipeline(
    source,
    limiter,
    createWriteStream(destinationPath, {
      flags: "wx",
    }),
  );

  return bytesWritten;
}

function normalizeRemoteState(
  state: string | undefined,
): string {
  return state?.trim().toUpperCase() || "";
}

export class GeminiVideoAnalysisService {
  static async analyzeValidatedAsset(
    userId: string,
    assetId: string,
    dependencies: GeminiVideoAnalysisDependencies = {},
  ): Promise<GeminiVideoOutput> {
    const getConfig =
      dependencies.getConfig ?? getGeminiConfig;
    const config = getConfig();

    if (!config.enabled) {
      throw new GeminiVideoAnalysisError(
        "GEMINI_DISABLED",
        "Gemini automation is disabled.",
      );
    }

    if (!config.apiKey) {
      throw new GeminiVideoAnalysisError(
        "GEMINI_NOT_CONFIGURED",
        "Gemini API key is not configured.",
      );
    }

    const findAsset =
      dependencies.findAsset ?? findAssetById;
    const asset = await findAsset(assetId);

    assertAssetCanBeAnalyzed(
      userId,
      asset,
      config,
    );

    const mimeType = normalizeMimeType(asset);
    const durationMs = asset.durationMs;

    if (durationMs === null) {
      throw new GeminiVideoAnalysisError(
        "INVALID_VIDEO_METADATA",
        "Validated video duration is missing.",
      );
    }

    const durationSeconds =
      durationMs / 1000;
    const getDownloadStream =
      dependencies.getDownloadStream ??
      getAssetDownloadStream;
    const createClient =
      dependencies.createClient ??
      createDefaultClient;
    const sleepFn =
      dependencies.sleep ?? sleep;
    const now = dependencies.now ?? Date.now;

    const tempDirectory = await mkdtemp(
      join(
        tmpdir(),
        "fb-publisher-gemini-",
      ),
    );
    const tempFilePath = join(
      tempDirectory,
      `video${getVideoExtension(mimeType)}`,
    );

    let remoteFileName: string | null = null;
    let client: GeminiClientAdapter | null = null;
    const abortController =
      new AbortController();
    const deadline =
      now() + config.analysisTimeoutMs;
    const timeoutHandle = setTimeout(() => {
      abortController.abort();
    }, config.analysisTimeoutMs);
    timeoutHandle.unref?.();

    const ensureBeforeDeadline = () => {
      if (
        abortController.signal.aborted ||
        now() >= deadline
      ) {
        throw new GeminiVideoAnalysisError(
          "GEMINI_ANALYSIS_TIMEOUT",
          "Gemini video analysis timed out.",
        );
      }
    };

    try {
      let downloadStream: Readable;

      try {
        downloadStream =
          await getDownloadStream(
            userId,
            asset,
          );

        const downloadedBytes =
          await writeStreamToLimitedFile(
            downloadStream,
            tempFilePath,
            config.maxVideoBytes,
          );

        if (downloadedBytes <= 0) {
          throw new Error(
            "Downloaded video is empty.",
          );
        }
      } catch (error) {
        if (
          error instanceof
          GeminiVideoAnalysisError
        ) {
          throw error;
        }

        throw new GeminiVideoAnalysisError(
          "VIDEO_DOWNLOAD_FAILED",
          "Could not download the video for Gemini analysis.",
        );
      }

      ensureBeforeDeadline();

      client = createClient(config.apiKey);
      let uploadedFile: GeminiRemoteFile;

      try {
        uploadedFile =
          await client.uploadVideo({
            filePath: tempFilePath,
            mimeType,
            displayName: asset.originalName,
            abortSignal:
              abortController.signal,
          });
      } catch {
        ensureBeforeDeadline();
        throw new GeminiVideoAnalysisError(
          "GEMINI_UPLOAD_FAILED",
          "Could not upload the video to Gemini for temporary analysis.",
        );
      }

      if (!uploadedFile.name) {
        throw new GeminiVideoAnalysisError(
          "GEMINI_UPLOAD_FAILED",
          "Gemini did not return a temporary file name.",
        );
      }

      remoteFileName = uploadedFile.name;
      let processedFile: GeminiRemoteFile;

      try {
        processedFile =
          await client.getFile(remoteFileName);
      } catch {
        ensureBeforeDeadline();
        throw new GeminiVideoAnalysisError(
          "GEMINI_PROCESSING_FAILED",
          "Could not read Gemini video processing status.",
        );
      }
      let state = normalizeRemoteState(
        processedFile.state,
      );

      while (state === "PROCESSING") {
        ensureBeforeDeadline();
        await sleepFn(
          config.filePollIntervalMs,
        );
        ensureBeforeDeadline();
        try {
          processedFile =
            await client.getFile(
              remoteFileName,
            );
        } catch {
          ensureBeforeDeadline();
          throw new GeminiVideoAnalysisError(
            "GEMINI_PROCESSING_FAILED",
            "Could not read Gemini video processing status.",
          );
        }
        state = normalizeRemoteState(
          processedFile.state,
        );
      }

      if (state === "FAILED") {
        throw new GeminiVideoAnalysisError(
          "GEMINI_PROCESSING_FAILED",
          "Gemini could not process the uploaded video.",
        );
      }

      if (state !== "ACTIVE") {
        throw new GeminiVideoAnalysisError(
          "GEMINI_PROCESSING_FAILED",
          "Gemini returned an unexpected video processing state.",
        );
      }

      if (!processedFile.uri) {
        throw new GeminiVideoAnalysisError(
          "GEMINI_PROCESSING_FAILED",
          "Gemini did not return a usable temporary file URI.",
        );
      }

      ensureBeforeDeadline();

      let rawOutput: string;

      try {
        rawOutput =
          await client.generateVideoMetadata({
            model: config.model,
            fileUri: processedFile.uri,
            mimeType:
              processedFile.mimeType ||
              mimeType,
            prompt: buildAnalysisPrompt(
              durationSeconds,
            ),
            responseJsonSchema:
              GEMINI_VIDEO_OUTPUT_JSON_SCHEMA,
            abortSignal:
              abortController.signal,
          });
      } catch (error) {
        if (
          error instanceof
          GeminiVideoAnalysisError
        ) {
          throw error;
        }

        ensureBeforeDeadline();
        throw new GeminiVideoAnalysisError(
          "GEMINI_GENERATION_FAILED",
          "Gemini could not generate video metadata.",
        );
      }

      return parseModelOutput(
        rawOutput,
        durationSeconds,
      );
    } finally {
      clearTimeout(timeoutHandle);

      if (remoteFileName && client) {
        try {
          await client.deleteFile(
            remoteFileName,
          );
        } catch {
          console.warn(
            "Gemini temporary file cleanup failed.",
          );
        }
      }

      await rm(tempDirectory, {
        recursive: true,
        force: true,
      });
    }
  }
}
