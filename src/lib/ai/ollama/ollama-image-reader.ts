import "server-only";

import { Readable } from "node:stream";

import { GoogleDriveMediaReader } from "@/lib/google-drive/google-drive-media-reader";
import { AiVideoAnalysisError } from "../ai-types";

export const MAX_AI_IMAGE_BYTES = 25 * 1024 * 1024;

export interface ImageReadResult {
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  base64Image: string;
}

function normalizeSupportedImageMimeType(
  mimeType: string,
): ImageReadResult["mimeType"] {
  const normalized = mimeType.trim().toLowerCase();

  if (
    normalized === "image/jpeg" ||
    normalized === "image/png" ||
    normalized === "image/webp"
  ) {
    return normalized;
  }

  throw new AiVideoAnalysisError(
    "INVALID_IMAGE_METADATA",
    "The upload asset contains an unsupported image MIME type.",
  );
}

async function readBoundedStream(
  stream: Readable,
  expectedSize: number,
  abortSignal?: AbortSignal,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  const handleAbort = () => {
    stream.destroy(new Error("IMAGE_ANALYSIS_ABORTED"));
  };

  abortSignal?.addEventListener("abort", handleAbort, {
    once: true,
  });

  try {
    for await (const chunk of stream) {
      if (abortSignal?.aborted) {
        throw new AiVideoAnalysisError(
          "AI_ANALYSIS_FAILED",
          "Image analysis was cancelled.",
        );
      }

      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk);

      totalBytes += buffer.length;

      if (totalBytes > MAX_AI_IMAGE_BYTES) {
        throw new AiVideoAnalysisError(
          "IMAGE_TOO_LARGE",
          "Image exceeds the 25 MiB local AI analysis limit.",
        );
      }

      if (totalBytes > expectedSize) {
        throw new AiVideoAnalysisError(
          "IMAGE_DOWNLOAD_FAILED",
          "Downloaded image exceeded its validated size.",
        );
      }

      chunks.push(buffer);
    }
  } catch (error: unknown) {
    if (error instanceof AiVideoAnalysisError) {
      throw error;
    }

    throw new AiVideoAnalysisError(
      "IMAGE_DOWNLOAD_FAILED",
      "Failed to read the Google Drive image stream.",
    );
  } finally {
    abortSignal?.removeEventListener("abort", handleAbort);
    stream.destroy();
  }

  if (totalBytes !== expectedSize) {
    throw new AiVideoAnalysisError(
      "IMAGE_DOWNLOAD_FAILED",
      "Downloaded image size did not match validated metadata.",
    );
  }

  if (totalBytes <= 0) {
    throw new AiVideoAnalysisError(
      "IMAGE_DOWNLOAD_FAILED",
      "Downloaded image was empty.",
    );
  }

  return Buffer.concat(chunks, totalBytes);
}

export class OllamaImageReader {
  public static async readImage(params: {
    userId: string;
    asset: {
      id: string;
      userId: string;
      provider: string;
      objectKey: string;
      originalName: string;
      expectedSize: bigint;
      actualSize: bigint | null;
      declaredMimeType: string;
      detectedMimeType: string | null;
    };
    abortSignal?: AbortSignal;
    dependencies?: {
      getDownloadStream?: typeof GoogleDriveMediaReader.getDownloadStream;
    };
  }): Promise<ImageReadResult> {
    const { userId, asset, abortSignal, dependencies } = params;
    const mimeType = normalizeSupportedImageMimeType(
      asset.detectedMimeType || asset.declaredMimeType,
    );

    const sizeValue = asset.actualSize ?? asset.expectedSize;
    const expectedSize = Number(sizeValue);

    if (
      !Number.isSafeInteger(expectedSize) ||
      expectedSize <= 0
    ) {
      throw new AiVideoAnalysisError(
        "INVALID_IMAGE_METADATA",
        "Validated image size is missing or invalid.",
      );
    }

    if (expectedSize > MAX_AI_IMAGE_BYTES) {
      throw new AiVideoAnalysisError(
        "IMAGE_TOO_LARGE",
        "Image exceeds the 25 MiB local AI analysis limit.",
      );
    }

    let stream: Readable;

    try {
      const getDownloadStream =
        dependencies?.getDownloadStream ??
        GoogleDriveMediaReader.getDownloadStream.bind(
          GoogleDriveMediaReader,
        );
      stream = await getDownloadStream(
        userId,
        asset,
      );
    } catch {
      throw new AiVideoAnalysisError(
        "IMAGE_DOWNLOAD_FAILED",
        "Failed to obtain the Google Drive image stream.",
      );
    }

    const bytes = await readBoundedStream(
      stream,
      expectedSize,
      abortSignal,
    );

    return {
      mimeType,
      base64Image: bytes.toString("base64"),
    };
  }
}
