import assert from "node:assert/strict";

import {
  buildGeminiAnalysisUrl,
  getGeminiAnalysisErrorMessage,
  parseGeminiAnalysisApiResponse,
} from "../src/lib/gemini/gemini-dashboard-analysis";

function createValidPayload(): unknown {
  return {
    success: true,
    analysis: {
      title: "A Surprising Moment on Camera",
      caption:
        "A quick moment turns into an unforgettable reaction.",
      hashtags: [
        "#ViralVideo",
        "#Unexpected",
        "#Reaction",
        "#MustWatch",
        "#FacebookReels",
      ],
      thumbnailTimestampSeconds: 6.25,
      thumbnailReason:
        "The subject is sharp and expressive.",
    },
  };
}

function testSuccessParsing(): void {
  const result = parseGeminiAnalysisApiResponse(
    createValidPayload(),
  );

  assert.equal(
    result.title,
    "A Surprising Moment on Camera",
  );
  assert.equal(result.hashtags.length, 5);
  assert.equal(
    result.hashtagsText,
    "#ViralVideo #Unexpected #Reaction #MustWatch #FacebookReels",
  );
  assert.equal(
    result.thumbnailTimestampSeconds,
    6.25,
  );
}

function testInvalidPayloads(): void {
  assert.throws(
    () => parseGeminiAnalysisApiResponse(null),
    /invalid analysis response/,
  );

  const fourHashtags = createValidPayload() as {
    analysis: { hashtags: string[] };
  };
  fourHashtags.analysis.hashtags = [
    "#One",
    "#Two",
    "#Three",
    "#Four",
  ];

  assert.throws(
    () => parseGeminiAnalysisApiResponse(fourHashtags),
    /exactly five hashtags/,
  );

  const duplicateHashtags = createValidPayload() as {
    analysis: { hashtags: string[] };
  };
  duplicateHashtags.analysis.hashtags = [
    "#Same",
    "#same",
    "#Three",
    "#Four",
    "#Five",
  ];

  assert.throws(
    () => parseGeminiAnalysisApiResponse(duplicateHashtags),
    /unique/,
  );

  const invalidTimestamp = createValidPayload() as {
    analysis: {
      thumbnailTimestampSeconds: number;
    };
  };
  invalidTimestamp.analysis.thumbnailTimestampSeconds = -1;

  assert.throws(
    () => parseGeminiAnalysisApiResponse(invalidTimestamp),
    /invalid thumbnail timestamp/,
  );
}

function testUrlBuilder(): void {
  assert.equal(
    buildGeminiAnalysisUrl(" asset/id "),
    "/api/uploads/asset%2Fid/analyze",
  );

  assert.throws(
    () => buildGeminiAnalysisUrl("   "),
    /asset ID is required/,
  );
}

function testSafeErrors(): void {
  assert.equal(
    getGeminiAnalysisErrorMessage(
      503,
      {
        message:
          "Gemini is disabled for this environment.",
      },
    ),
    "Gemini is disabled for this environment.",
  );

  assert.equal(
    getGeminiAnalysisErrorMessage(409, null),
    "The video must finish uploading and validation before Gemini can analyze it.",
  );

  assert.equal(
    getGeminiAnalysisErrorMessage(504, {}),
    "Gemini analysis timed out. Try again once.",
  );
}

function main(): void {
  testSuccessParsing();
  testInvalidPayloads();
  testUrlBuilder();
  testSafeErrors();

  console.log(
    "PHASE6I_GEMINI_DASHBOARD_ANALYSIS_TESTS=PASSED",
  );
}

main();
