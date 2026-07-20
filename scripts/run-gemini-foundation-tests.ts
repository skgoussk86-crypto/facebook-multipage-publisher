import assert from "node:assert/strict";

import {
  getGeminiConfig,
  getGeminiSafeStatus,
} from "../src/lib/gemini/gemini-config";

import {
  GEMINI_VIDEO_OUTPUT_JSON_SCHEMA,
  parseGeminiVideoOutput,
} from "../src/lib/gemini/gemini-video-output";

function runConfigTests(): void {
  const disabledConfig =
    getGeminiConfig({
      GEMINI_ENABLED: "false",
    });

  assert.equal(
    disabledConfig.enabled,
    false,
  );

  assert.equal(
    disabledConfig.apiKey,
    null,
  );

  assert.equal(
    disabledConfig.model,
    "gemini-2.5-flash",
  );

  assert.throws(
    () =>
      getGeminiConfig({
        GEMINI_ENABLED: "true",
      }),
    /GEMINI_API_KEY is missing/,
  );

  const configuredStatus =
    getGeminiSafeStatus({
      GEMINI_ENABLED: "true",
      GEMINI_API_KEY:
        "test-key-not-a-real-secret",
      GEMINI_MODEL:
        "gemini-2.5-flash",
      GEMINI_MAX_VIDEO_BYTES:
        "524288000",
      GEMINI_ANALYSIS_TIMEOUT_MS:
        "180000",
      GEMINI_FILE_POLL_INTERVAL_MS:
        "5000",
    });

  assert.deepEqual(
    configuredStatus,
    {
      enabled: true,
      configured: true,
      model: "gemini-2.5-flash",
      maxVideoBytes: 524288000,
      analysisTimeoutMs: 180000,
      filePollIntervalMs: 5000,
    },
  );

  assert.equal(
    Object.prototype.hasOwnProperty.call(
      configuredStatus,
      "apiKey",
    ),
    false,
  );
}

function runOutputTests(): void {
  const parsed =
    parseGeminiVideoOutput(
      {
        title:
          "The Moment Everything Changed",

        caption:
          "A surprising moment unfolds in this short video and leads to an unforgettable reaction.",

        hashtags: [
          "#ViralVideo",
          "#Unexpected",
          "#Reaction",
          "#MustWatch",
          "#FacebookReels",
        ],

        thumbnailTimestampSeconds:
          7.5,

        thumbnailReason:
          "The subject is clear, expressive, and sharply visible.",
      },
      15,
    );

  assert.equal(
    parsed.hashtags.length,
    5,
  );

  assert.equal(
    parsed.thumbnailTimestampSeconds,
    7.5,
  );

  assert.throws(
    () =>
      parseGeminiVideoOutput(
        {
          ...parsed,
          hashtags: [
            "#One",
            "#Two",
            "#Three",
            "#Four",
          ],
        },
        15,
      ),
    /Exactly five hashtags/,
  );

  assert.throws(
    () =>
      parseGeminiVideoOutput(
        {
          ...parsed,
          hashtags: [
            "#Same",
            "#Same",
            "#Three",
            "#Four",
            "#Five",
          ],
        },
        15,
      ),
    /unique/,
  );

  assert.throws(
    () =>
      parseGeminiVideoOutput(
        {
          ...parsed,
          thumbnailTimestampSeconds:
            20,
        },
        15,
      ),
    /beyond the end/,
  );

  assert.equal(
    GEMINI_VIDEO_OUTPUT_JSON_SCHEMA
      .additionalProperties,
    false,
  );
}

function main(): void {
  runConfigTests();
  runOutputTests();

  console.log(
    "PHASE6I_GEMINI_FOUNDATION_TESTS=PASSED",
  );
}

main();
