import "server-only";

import { AiProvider } from "./ai-types";

export interface AiConfig {
  provider: AiProvider;
  ollamaBaseUrl: string;
  ollamaModel: string;
  ollamaFrameCount: number;
  ollamaRequestTimeoutMs: number;
  ollamaMaxConcurrency: number;
  geminiEnabled: boolean;
  geminiApiKey: string | null;
  geminiModel: string;
}

export function validateLocalhostUrl(urlStr: string): string {
  const trimmed = urlStr.trim();
  if (!trimmed) {
    throw new Error("Ollama base URL is empty.");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Ollama base URL "${trimmed}" is not a valid URL.`);
  }

  if (parsed.protocol !== "http:") {
    throw new Error("Ollama base URL protocol must be http.");
  }

  if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
    throw new Error("Ollama base URL host must be 127.0.0.1 or localhost.");
  }

  if (parsed.username || parsed.password) {
    throw new Error("Ollama base URL must not contain credentials.");
  }

  if (parsed.search) {
    throw new Error("Ollama base URL must not contain query parameters.");
  }

  if (parsed.hash) {
    throw new Error("Ollama base URL must not contain hash fragments.");
  }

  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new Error("Ollama base URL must not contain subpaths.");
  }

  return trimmed;
}

export function getAiConfig(
  environment: Record<string, string | undefined> = process.env
): AiConfig {
  const rawProvider = environment.AI_PROVIDER?.trim().toUpperCase();

  if (!rawProvider) {
    throw new Error("AI_PROVIDER environment variable is missing.");
  }

  if (rawProvider !== "OLLAMA" && rawProvider !== "GEMINI") {
    throw new Error(`AI_PROVIDER "${rawProvider}" is unsupported.`);
  }

  const provider = rawProvider as AiProvider;

  // Ollama configuration parsing
  let ollamaBaseUrl = environment.OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434";
  if (provider === "OLLAMA") {
    ollamaBaseUrl = validateLocalhostUrl(ollamaBaseUrl);
  }

  const ollamaModel = environment.OLLAMA_MODEL?.trim() || "qwen3-vl:2b-instruct";

  // Parse and clamp frame count between 4 and 12
  const rawFrameCount = environment.OLLAMA_FRAME_COUNT?.trim();
  let ollamaFrameCount = 8;
  if (rawFrameCount) {
    const parsedFrames = parseInt(rawFrameCount, 10);
    if (isNaN(parsedFrames)) {
      throw new Error(`OLLAMA_FRAME_COUNT "${rawFrameCount}" is not a valid number.`);
    }
    ollamaFrameCount = Math.max(4, Math.min(12, parsedFrames));
  }

  // Timeout parsing (default to 240,000ms)
  const rawTimeout = environment.OLLAMA_REQUEST_TIMEOUT_MS?.trim();
  let ollamaRequestTimeoutMs = 240000;
  if (rawTimeout) {
    const parsedTimeout = parseInt(rawTimeout, 10);
    if (isNaN(parsedTimeout) || parsedTimeout <= 0) {
      throw new Error(`OLLAMA_REQUEST_TIMEOUT_MS "${rawTimeout}" must be a positive integer.`);
    }
    ollamaRequestTimeoutMs = parsedTimeout;
  }

  const ollamaMaxConcurrency = 1; // Strict concurrency limit of 1

  // Gemini compatibility
  const geminiEnabled = environment.GEMINI_ENABLED?.trim().toLowerCase() === "true";
  const geminiApiKey = environment.GEMINI_API_KEY?.trim() || null;
  const geminiModel = environment.GEMINI_MODEL?.trim() || "gemini-2.5-flash";

  if (provider === "GEMINI" && !geminiApiKey) {
    throw new Error("AI_PROVIDER is GEMINI, but GEMINI_API_KEY is not configured.");
  }

  return {
    provider,
    ollamaBaseUrl,
    ollamaModel,
    ollamaFrameCount,
    ollamaRequestTimeoutMs,
    ollamaMaxConcurrency,
    geminiEnabled,
    geminiApiKey,
    geminiModel,
  };
}
