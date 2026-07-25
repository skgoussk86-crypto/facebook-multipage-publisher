import "server-only";

import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";

import { GoogleDriveMediaReader } from "../../google-drive/google-drive-media-reader";
import { AiVideoAnalysisError } from "../ai-types";

// Maximum source video bytes allowed for AI analysis (default 500 MB)
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;

class ByteLimitTransform extends Transform {
  private count = 0;

  constructor(private readonly maximumBytes: number) {
    super();
  }

  override _transform(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    void encoding;
    this.count += chunk.length;

    if (this.count > this.maximumBytes) {
      callback(
        new AiVideoAnalysisError(
          "VIDEO_TOO_LARGE",
          "Downloaded video exceeds the maximum file size limit for AI analysis."
        )
      );
      return;
    }

    callback(null, chunk);
  }
}

export interface FrameExtractionResult {
  timestamps: number[];
  base64Frames: string[];
}

export class OllamaFrameExtractor {
  /**
   * Helper to run the ffmpeg CLI process for a single frame extraction
   */
  private static async extractSingleFrame(params: {
    ffmpegPath: string;
    sourcePath: string;
    outputPath: string;
    timestampSeconds: number;
    timeoutMs: number;
  }): Promise<void> {
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      "-ss",
      params.timestampSeconds.toFixed(3),
      "-i",
      params.sourcePath,
      "-frames:v",
      "1",
      "-vf",
      "scale=640:-2:force_original_aspect_ratio=decrease",
      "-q:v",
      "5", // Bounded JPEG quality
      params.outputPath,
    ];

    await new Promise<void>((resolve, reject) => {
      execFile(
        params.ffmpegPath,
        args,
        {
          shell: false,
          timeout: params.timeoutMs,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        },
        (error, _stdout, stderr) => {
          if (!error) {
            resolve();
            return;
          }

          const typedError = error as Error & { killed?: boolean; code?: string };
          if (typedError.code === "ENOENT") {
            reject(new Error("FFMPEG_NOT_FOUND"));
            return;
          }
          if (typedError.killed) {
            reject(new Error("FFMPEG_TIMEOUT"));
            return;
          }

          const errMsg = typeof stderr === "string" ? stderr.trim().slice(0, 500) : "";
          reject(new Error(errMsg || "FFMPEG_EXTRACTION_FAILED"));
        }
      );
    });
  }

  /**
   * Calculates timestamps, downloads video stream from Google Drive, extracts frames using ffmpeg,
   * reads frames as base64, and cleans up all temporary files.
   */
  public static async extractFrames(params: {
    userId: string;
    asset: {
      id: string;
      userId: string;
      provider: string;
      objectKey: string;
      status: string;
      originalName: string;
      expectedSize: bigint;
      actualSize: bigint | null;
      durationMs: number | null;
    };
    frameCount: number;
  }): Promise<FrameExtractionResult> {
    const { userId, asset, frameCount } = params;

    if (!asset.durationMs || asset.durationMs <= 0) {
      throw new AiVideoAnalysisError(
        "INVALID_VIDEO_METADATA",
        "Video duration is missing or invalid."
      );
    }

    const durationSeconds = asset.durationMs / 1000;
    const timestamps: number[] = [];
    const step = durationSeconds / (frameCount + 1);

    for (let i = 1; i <= frameCount; i++) {
      const t = Math.max(
        0.01,
        Math.min(durationSeconds - 0.01, parseFloat((i * step).toFixed(3)))
      );
      if (!timestamps.includes(t)) {
        timestamps.push(t);
      }
    }

    const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
    const tempDirectory = await mkdtemp(
      join(tmpdir(), "fb-publisher-ollama-")
    );

    const sourcePath = join(tempDirectory, "source-video");
    let downloadStream: Readable | null = null;

    try {
      // 1. Download video file stream safely
      try {
        downloadStream = await GoogleDriveMediaReader.getDownloadStream(
          userId,
          asset as unknown as Parameters<
            typeof GoogleDriveMediaReader.getDownloadStream
          >[1]
        );
      } catch (err: unknown) {
        throw new AiVideoAnalysisError(
          "VIDEO_DOWNLOAD_FAILED",
          `Failed to obtain Google Drive download stream: ${(err as Error).message}`
        );
      }

      try {
        await pipeline(
          downloadStream,
          new ByteLimitTransform(MAX_VIDEO_BYTES),
          createWriteStream(sourcePath)
        );
      } catch (err: unknown) {
        if (err instanceof AiVideoAnalysisError) {
          throw err;
        }
        throw new AiVideoAnalysisError(
          "VIDEO_DOWNLOAD_FAILED",
          `Error saving video stream to disk: ${(err as Error).message}`
        );
      }

      // Verify downladed file size
      const videoStats = await stat(sourcePath);
      if (!videoStats.isFile() || videoStats.size <= 0) {
        throw new AiVideoAnalysisError(
          "VIDEO_DOWNLOAD_FAILED",
          "Downloaded video is empty."
        );
      }

      // 2. Extract frames sequentially using FFmpeg
      const base64Frames: string[] = [];

      for (let i = 0; i < timestamps.length; i++) {
        const timestamp = timestamps[i];
        const frameOutputPath = join(tempDirectory, `frame_${i}.jpg`);

        try {
          await this.extractSingleFrame({
            ffmpegPath,
            sourcePath,
            outputPath: frameOutputPath,
            timestampSeconds: timestamp,
            timeoutMs: 20000, // 20 seconds timeout per frame
          });
        } catch (err: unknown) {
          const msg = (err as Error).message;
          if (msg === "FFMPEG_NOT_FOUND") {
            throw new AiVideoAnalysisError(
              "AI_ANALYSIS_FAILED",
              "ffmpeg executable was not found. Please verify FFMPEG_PATH."
            );
          }
          throw new AiVideoAnalysisError(
            "AI_ANALYSIS_FAILED",
            `Frame extraction at timestamp ${timestamp}s failed: ${msg}`
          );
        }

        // Read JPEG file as base64
        const frameBytes = await readFile(frameOutputPath);
        if (frameBytes.length === 0) {
          throw new AiVideoAnalysisError(
            "AI_ANALYSIS_FAILED",
            `Frame output at ${timestamp}s was empty.`
          );
        }
        base64Frames.push(frameBytes.toString("base64"));
      }

      return {
        timestamps,
        base64Frames,
      };
    } finally {
      // 3. Cleanup: delete temp folder and files recursively
      if (downloadStream) {
        downloadStream.destroy();
      }
      await rm(tempDirectory, {
        recursive: true,
        force: true,
      });
    }
  }
}
