import "server-only";

const DEFAULT_MODEL = "gemini-2.5-flash";
const DEFAULT_MAX_VIDEO_BYTES =
  500 * 1024 * 1024;
const DEFAULT_ANALYSIS_TIMEOUT_MS =
  180_000;
const DEFAULT_FILE_POLL_INTERVAL_MS =
  5_000;

export interface GeminiEnvironment {
  readonly [key: string]:
    | string
    | undefined;
}
export interface GeminiConfig {
  enabled: boolean;
  apiKey: string | null;
  model: string;
  maxVideoBytes: number;
  analysisTimeoutMs: number;
  filePollIntervalMs: number;
}

export interface GeminiSafeStatus {
  enabled: boolean;
  configured: boolean;
  model: string;
  maxVideoBytes: number;
  analysisTimeoutMs: number;
  filePollIntervalMs: number;
}

function readBoolean(
  value: string | undefined,
  defaultValue: boolean,
): boolean {
  if (
    value === undefined ||
    value.trim() === ""
  ) {
    return defaultValue;
  }

  const normalized =
    value.trim().toLowerCase();

  if (normalized === "true") {
    return true;
  }

  if (normalized === "false") {
    return false;
  }

  throw new Error(
    `Invalid boolean environment value "${value}".`,
  );
}

function readPositiveInteger(
  value: string | undefined,
  defaultValue: number,
  name: string,
): number {
  if (
    value === undefined ||
    value.trim() === ""
  ) {
    return defaultValue;
  }

  const parsed = Number(value);

  if (
    !Number.isSafeInteger(parsed) ||
    parsed <= 0
  ) {
    throw new Error(
      `${name} must be a positive integer.`,
    );
  }

  return parsed;
}

export function getGeminiConfig(
  environment: GeminiEnvironment =
    process.env,
): GeminiConfig {
  const enabled = readBoolean(
    environment.GEMINI_ENABLED,
    false,
  );

  const apiKey =
    environment.GEMINI_API_KEY?.trim() ||
    null;

  const model =
    environment.GEMINI_MODEL?.trim() ||
    DEFAULT_MODEL;

  const maxVideoBytes =
    readPositiveInteger(
      environment.GEMINI_MAX_VIDEO_BYTES,
      DEFAULT_MAX_VIDEO_BYTES,
      "GEMINI_MAX_VIDEO_BYTES",
    );

  const analysisTimeoutMs =
    readPositiveInteger(
      environment
        .GEMINI_ANALYSIS_TIMEOUT_MS,
      DEFAULT_ANALYSIS_TIMEOUT_MS,
      "GEMINI_ANALYSIS_TIMEOUT_MS",
    );

  const filePollIntervalMs =
    readPositiveInteger(
      environment
        .GEMINI_FILE_POLL_INTERVAL_MS,
      DEFAULT_FILE_POLL_INTERVAL_MS,
      "GEMINI_FILE_POLL_INTERVAL_MS",
    );

  if (enabled && !apiKey) {
    throw new Error(
      "GEMINI_ENABLED is true, but GEMINI_API_KEY is missing.",
    );
  }

  return {
    enabled,
    apiKey,
    model,
    maxVideoBytes,
    analysisTimeoutMs,
    filePollIntervalMs,
  };
}

export function getGeminiSafeStatus(
  environment: GeminiEnvironment =
    process.env,
): GeminiSafeStatus {
  const config =
    getGeminiConfig(environment);

  return {
    enabled: config.enabled,
    configured: config.apiKey !== null,
    model: config.model,
    maxVideoBytes: config.maxVideoBytes,
    analysisTimeoutMs:
      config.analysisTimeoutMs,
    filePollIntervalMs:
      config.filePollIntervalMs,
  };
}
