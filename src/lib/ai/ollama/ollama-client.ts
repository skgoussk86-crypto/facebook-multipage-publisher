import "server-only";

import { validateLocalhostUrl } from "../ai-config";
import {
  AiVideoAnalysisError,
  GeneratedVideoContent,
  generatedVideoContentSchema,
} from "../ai-types";

interface OllamaMessage {
  role: "system" | "user" | "assistant";
  content: string;
  images?: string[];
}

interface OllamaChatResponse {
  message?: {
    content?: string;
  };
}

export class OllamaClient {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(params: { baseUrl: string; model: string; timeoutMs: number }) {
    this.baseUrl = validateLocalhostUrl(params.baseUrl);
    this.model = params.model.trim();
    this.timeoutMs = params.timeoutMs;
  }

  /**
   * Helper to perform fetch with timeout and max size protection
   */
  private async executeFetch(
    endpoint: string,
    body: Record<string, unknown>,
    abortSignal?: AbortSignal
  ): Promise<string> {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    if (abortSignal) {
      abortSignal.addEventListener("abort", () => {
        controller.abort();
      });
    }

    const url = `${this.baseUrl}${endpoint}`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutHandle);

      if (!response.ok) {
        throw new AiVideoAnalysisError(
          "AI_PROVIDER_UNAVAILABLE",
          `Ollama returned HTTP error status: ${response.status}`
        );
      }

      if (!response.body) {
        throw new AiVideoAnalysisError(
          "AI_INVALID_RESPONSE",
          "Ollama returned an empty response body."
        );
      }

      // Read response stream safely with a hard limit on size (128 KB)
      const reader = response.body.getReader();
      const maxBytes = 128 * 1024;
      let totalBytes = 0;
      const chunks: Uint8Array[] = [];

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            totalBytes += value.length;
            if (totalBytes > maxBytes) {
              await reader.cancel();
              throw new AiVideoAnalysisError(
                "AI_INVALID_RESPONSE",
                "Ollama response size exceeded safe limits."
              );
            }
            chunks.push(value);
          }
        }
      } finally {
        reader.releaseLock();
      }

      const decoded = new TextDecoder("utf-8").decode(
        Buffer.concat(chunks)
      );

      if (!decoded.trim()) {
        throw new AiVideoAnalysisError(
          "AI_INVALID_RESPONSE",
          "Ollama returned an empty response content."
        );
      }

      return decoded;
    } catch (error: unknown) {
      clearTimeout(timeoutHandle);

      if (error instanceof AiVideoAnalysisError) {
        throw error;
      }

      const err = error as Error;
      if (err.name === "AbortError" || controller.signal.aborted) {
        throw new AiVideoAnalysisError(
          "AI_TIMEOUT",
          "Ollama AI request timed out."
        );
      }

      throw new AiVideoAnalysisError(
        "AI_PROVIDER_UNAVAILABLE",
        `Could not reach local Ollama instance: ${err.message}`
      );
    }
  }

  /**
   * Extract JSON block from prose response
   */
  private extractJsonBlock(text: string): string {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error("No JSON object block found in the model output.");
    }
    return match[0];
  }

  /**
   * Sends the chat prompt (with optional base64 images) and validates response schema.
   * Offers 1 single retry to repair invalid JSON or schema violations.
   */
  public async generateVideoMetadata(params: {
    durationSeconds: number;
    timestamps: number[];
    base64Frames: string[];
    abortSignal?: AbortSignal;
  }): Promise<GeneratedVideoContent> {
    const { durationSeconds, timestamps, base64Frames, abortSignal } = params;

    const systemInstructions =
      "You are an AI assistant specialized in Facebook video metadata optimization. " +
      "You must always output ONLY a single valid raw JSON object matching the requested schema. " +
      "Never explain your reasoning, never wrap in markdown fence blocks, and never include conversational prose.";

    const promptText =
      `Analyze the provided sequence of ${base64Frames.length} frames extracted chronologically from a video. ` +
      `Generate post metadata for a Facebook post. ` +
      `The video duration is exactly ${durationSeconds.toFixed(3)} seconds. ` +
      `The frames were extracted at these specific timestamps (in seconds): [${timestamps.join(", ")}]. ` +
      `Choose one of these timestamps as the thumbnailTimestampSeconds. ` +
      `Evaluate every candidate for sharpness, low motion blur, useful brightness, an unobstructed main subject, clean composition, and immediate visual appeal. ` +
      `Reject black frames, transition frames, near-duplicates, partially formed actions, obstructed subjects, and frames where the main subject is too small. ` +
      `For food, product, craft, or demonstration videos, prefer a clearly completed or most informative view of the main item. ` +
      `Do not default to the same ordinal frame across videos; choose only from the visible quality of this video's candidates. ` +
      `You must output exactly one valid JSON object with the following keys:\n` +
      `{\n` +
      `  "title": "catchy title, single line (3-255 characters)",\n` +
      `  "caption": "short engaging caption (10-2200 characters)",\n` +
      `  "hashtags": ["five", "unique", "hashtags", "starting", "with #"],\n` +
      `  "thumbnailTimestampSeconds": chosen_number\n` +
      `}\n` +
      `Ensure hashtags are lowercased and start with '#'. Ensure the thumbnail timestamp is exactly one of the values from the timestamps list.`;

    const messages: OllamaMessage[] = [
      { role: "system", content: systemInstructions },
      { role: "user", content: promptText, images: base64Frames },
    ];

    let attempt = 1;
    let lastErrorMsg = "";

    while (attempt <= 2) {
      try {
        const responseJsonStr = await this.executeFetch(
          "/api/chat",
          {
            model: this.model,
            messages,
            stream: false,
            options: {
              temperature: 0.0,
              num_ctx: 8192,
            },
            think: false,
          },
          abortSignal
        );

        let parsedResponse: OllamaChatResponse;
        try {
          parsedResponse = JSON.parse(responseJsonStr);
        } catch {
          throw new Error("Failed to parse Ollama chat API response envelope.");
        }

        const modelOutputText = parsedResponse.message?.content;
        if (!modelOutputText || !modelOutputText.trim()) {
          throw new Error("Ollama returned an empty chat message.");
        }

        let rawJsonBlock: string;
        try {
          rawJsonBlock = this.extractJsonBlock(modelOutputText);
        } catch (e) {
          throw new Error(`Invalid response structure: ${(e as Error).message}`);
        }

        let parsedContent: unknown;
        try {
          parsedContent = JSON.parse(rawJsonBlock);
        } catch {
          throw new Error("Extracted text block is not valid JSON.");
        }

        // Validate the structure using Zod
        const validated = generatedVideoContentSchema.parse(parsedContent);

        // Additional validation: ensure timestamp is in bounds and reasonably close to video duration
        if (validated.thumbnailTimestampSeconds > durationSeconds) {
          throw new Error(
            `Selected thumbnail timestamp (${validated.thumbnailTimestampSeconds}s) exceeds video duration (${durationSeconds}s).`
          );
        }

        return validated;
      } catch (error: unknown) {
        if (
          error instanceof AiVideoAnalysisError &&
          (error.code === "AI_TIMEOUT" ||
            error.code === "AI_PROVIDER_UNAVAILABLE" ||
            error.code === "AI_NOT_CONFIGURED")
        ) {
          throw error; // Immediately fail on hard timeout, unavailable host, or missing config
        }

        const errMsg = error instanceof Error ? error.message : String(error);
        lastErrorMsg = errMsg;

        if (attempt === 1) {
          attempt += 1;
          // Append repair message to history and retry
          messages.push({
            role: "assistant",
            content: `Error occurred. Reason: ${errMsg}`,
          });
          messages.push({
            role: "user",
            content:
              "Your previous response was invalid. Please regenerate the JSON object. " +
              "Make sure to return ONLY a raw JSON object with NO additional text or markdown fences, and ensure " +
              `exactly five unique hashtags and a thumbnail timestamp from [${timestamps.join(", ")}].`,
          });
          continue;
        }

        break;
      }
    }

    throw new AiVideoAnalysisError(
      "AI_INVALID_RESPONSE",
      `Ollama returned invalid metadata or schema violations after retry: ${lastErrorMsg}`
    );
  }

  public async generateImageMetadata(params: {
    mimeType: "image/jpeg" | "image/png" | "image/webp";
    base64Image: string;
    abortSignal?: AbortSignal;
  }): Promise<GeneratedVideoContent> {
    const { mimeType, base64Image, abortSignal } = params;

    if (!base64Image.trim()) {
      throw new AiVideoAnalysisError(
        "INVALID_IMAGE_METADATA",
        "The image payload is empty.",
      );
    }

    const systemInstructions =
      "You are an AI assistant specialized in accurate Facebook image post metadata. " +
      "You must output ONLY one valid raw JSON object matching the requested schema. " +
      "Never invent names, locations, causes, quotes, outcomes, or facts that are not clearly visible. " +
      "Never wrap the JSON in markdown and never include explanatory prose.";

    const promptText =
      `Analyze this ${mimeType} image carefully and generate accurate English metadata for a Facebook photo post. ` +
      `Return exactly one JSON object with these keys:\n` +
      `{\n` +
      `  "title": "engaging single-line title, 3-255 characters",\n` +
      `  "caption": "accurate engaging caption, 10-2200 characters",\n` +
      `  "hashtags": ["exactly", "five", "unique", "relevant", "hashtags"],\n` +
      `  "thumbnailTimestampSeconds": 0\n` +
      `}\n` +
      `Every hashtag must begin with #, use only letters, numbers, or underscores, and all five must be unique. ` +
      `thumbnailTimestampSeconds must be exactly 0 because this is a still image.`;

    const messages: OllamaMessage[] = [
      { role: "system", content: systemInstructions },
      {
        role: "user",
        content: promptText,
        images: [base64Image],
      },
    ];

    let attempt = 1;
    let lastErrorMsg = "";

    while (attempt <= 2) {
      try {
        const responseJsonStr = await this.executeFetch(
          "/api/chat",
          {
            model: this.model,
            messages,
            stream: false,
            options: {
              temperature: 0.0,
              num_ctx: 8192,
            },
            think: false,
          },
          abortSignal,
        );

        const parsedResponse = JSON.parse(
          responseJsonStr,
        ) as OllamaChatResponse;

        const modelOutputText =
          parsedResponse.message?.content;

        if (!modelOutputText?.trim()) {
          throw new Error(
            "Ollama returned an empty image-analysis message.",
          );
        }

        const rawJsonBlock =
          this.extractJsonBlock(modelOutputText);
        const parsedContent = JSON.parse(rawJsonBlock);
        const validated =
          generatedVideoContentSchema.parse(parsedContent);

        if (validated.thumbnailTimestampSeconds !== 0) {
          throw new Error(
            "Image metadata must use thumbnailTimestampSeconds equal to 0.",
          );
        }

        return validated;
      } catch (error: unknown) {
        if (
          error instanceof AiVideoAnalysisError &&
          (
            error.code === "AI_TIMEOUT" ||
            error.code === "AI_PROVIDER_UNAVAILABLE" ||
            error.code === "AI_NOT_CONFIGURED"
          )
        ) {
          throw error;
        }

        lastErrorMsg =
          error instanceof Error
            ? error.message
            : String(error);

        if (attempt === 1) {
          attempt += 1;
          messages.push({
            role: "assistant",
            content: `Invalid response: ${lastErrorMsg}`,
          });
          messages.push({
            role: "user",
            content:
              "Regenerate only the raw JSON object. Use exactly five unique hashtags and set thumbnailTimestampSeconds to 0.",
          });
          continue;
        }

        break;
      }
    }

    throw new AiVideoAnalysisError(
      "AI_INVALID_RESPONSE",
      `Ollama returned invalid image metadata after retry: ${lastErrorMsg}`,
    );
  }

}
