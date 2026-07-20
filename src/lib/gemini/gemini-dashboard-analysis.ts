export interface GeminiDashboardAnalysis {
  title: string;
  caption: string;
  hashtags: string[];
  hashtagsText: string;
  thumbnailTimestampSeconds: number;
  thumbnailReason: string;
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function readTrimmedString(
  value: unknown,
  fieldName: string,
  minimumLength: number,
  maximumLength: number,
): string {
  if (typeof value !== "string") {
    throw new Error(
      `Gemini response field ${fieldName} must be a string.`,
    );
  }

  const trimmed = value.trim();

  if (
    trimmed.length < minimumLength ||
    trimmed.length > maximumLength
  ) {
    throw new Error(
      `Gemini response field ${fieldName} has an invalid length.`,
    );
  }

  return trimmed;
}

export function buildGeminiAnalysisUrl(
  assetId: string,
): string {
  const normalizedAssetId = assetId.trim();

  if (!normalizedAssetId) {
    throw new Error(
      "Upload asset ID is required for Gemini analysis.",
    );
  }

  return `/api/uploads/${encodeURIComponent(normalizedAssetId)}/analyze`;
}

export function parseGeminiAnalysisApiResponse(
  payload: unknown,
): GeminiDashboardAnalysis {
  if (
    !isRecord(payload) ||
    payload.success !== true ||
    !isRecord(payload.analysis)
  ) {
    throw new Error(
      "Gemini returned an invalid analysis response.",
    );
  }

  const analysis = payload.analysis;
  const title = readTrimmedString(
    analysis.title,
    "title",
    3,
    255,
  );
  const caption = readTrimmedString(
    analysis.caption,
    "caption",
    10,
    2200,
  );
  const thumbnailReason = readTrimmedString(
    analysis.thumbnailReason,
    "thumbnailReason",
    3,
    300,
  );

  if (title.includes("\n") || title.includes("\r")) {
    throw new Error(
      "Gemini title must be a single line.",
    );
  }

  if (!Array.isArray(analysis.hashtags)) {
    throw new Error(
      "Gemini hashtags must be an array.",
    );
  }

  if (analysis.hashtags.length !== 5) {
    throw new Error(
      "Gemini must return exactly five hashtags.",
    );
  }

  const hashtags = analysis.hashtags.map(
    (value, index) => {
      const hashtag = readTrimmedString(
        value,
        `hashtags[${index}]`,
        3,
        51,
      );

      if (!/^#[A-Za-z0-9_]{2,50}$/.test(hashtag)) {
        throw new Error(
          "Gemini returned an invalid hashtag.",
        );
      }

      return hashtag;
    },
  );

  const normalizedHashtags = hashtags.map(
    (hashtag) => hashtag.toLowerCase(),
  );

  if (
    new Set(normalizedHashtags).size !==
    normalizedHashtags.length
  ) {
    throw new Error(
      "Gemini hashtags must be unique.",
    );
  }

  const thumbnailTimestampSeconds =
    analysis.thumbnailTimestampSeconds;

  if (
    typeof thumbnailTimestampSeconds !== "number" ||
    !Number.isFinite(thumbnailTimestampSeconds) ||
    thumbnailTimestampSeconds < 0
  ) {
    throw new Error(
      "Gemini returned an invalid thumbnail timestamp.",
    );
  }

  return {
    title,
    caption,
    hashtags,
    hashtagsText: hashtags.join(" "),
    thumbnailTimestampSeconds,
    thumbnailReason,
  };
}

export function getGeminiAnalysisErrorMessage(
  status: number,
  payload: unknown,
): string {
  if (isRecord(payload)) {
    const message = payload.message;

    if (typeof message === "string") {
      const trimmed = message.trim();

      if (trimmed.length >= 3 && trimmed.length <= 500) {
        return trimmed;
      }
    }
  }

  if (status === 401) {
    return "Your session has expired. Sign in again before using Gemini.";
  }

  if (status === 404) {
    return "The validated upload could not be found.";
  }

  if (status === 409) {
    return "The video must finish uploading and validation before Gemini can analyze it.";
  }

  if (status === 413) {
    return "This video is larger than the configured Gemini analysis limit.";
  }

  if (status === 503) {
    return "Gemini is currently disabled or its API key has not been configured.";
  }

  if (status === 504) {
    return "Gemini analysis timed out. Try again once.";
  }

  return "Gemini could not analyze this video. Try again later.";
}
