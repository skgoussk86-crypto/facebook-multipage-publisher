import assert from "node:assert/strict";

import { NextRequest } from "next/server";

import {
  GeminiVideoAnalysisError,
  type GeminiVideoAnalysisErrorCode,
} from "../src/lib/gemini/gemini-video-analysis-service";
import {
  handleAnalyzeUploadRequest,
  mapGeminiAnalysisError,
} from "../src/app/api/uploads/[id]/analyze/route";

const assetId =
  "11111111-1111-4111-8111-111111111111";
const userId =
  "22222222-2222-4222-8222-222222222222";

function createRequest(): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/uploads/${assetId}/analyze`,
    { method: "POST" },
  );
}

async function readJson(
  response: Response,
): Promise<Record<string, unknown>> {
  return await response.json() as Record<
    string,
    unknown
  >;
}

async function testUnauthenticated(): Promise<void> {
  let serviceCalls = 0;

  const response =
    await handleAnalyzeUploadRequest(
      createRequest(),
      { id: assetId },
      {
        verifySession: async () => null,
        analyzeValidatedAsset: async () => {
          serviceCalls += 1;
          throw new Error(
            "Service must not be called.",
          );
        },
      },
    );

  assert.equal(response.status, 401);
  assert.equal(serviceCalls, 0);

  const body = await readJson(response);
  assert.equal(
    body.error,
    "UNAUTHENTICATED",
  );
}

async function testInvalidAssetId(): Promise<void> {
  let serviceCalls = 0;

  const response =
    await handleAnalyzeUploadRequest(
      createRequest(),
      { id: "   " },
      {
        verifySession: async () => ({
          id: userId,
        } as never),
        analyzeValidatedAsset: async () => {
          serviceCalls += 1;
          throw new Error(
            "Service must not be called.",
          );
        },
      },
    );

  assert.equal(response.status, 400);
  assert.equal(serviceCalls, 0);

  const body = await readJson(response);
  assert.equal(
    body.error,
    "INVALID_REQUEST",
  );
}

async function testSuccess(): Promise<void> {
  let receivedUserId = "";
  let receivedAssetId = "";

  const response =
    await handleAnalyzeUploadRequest(
      createRequest(),
      { id: assetId },
      {
        verifySession: async () => ({
          id: userId,
        } as never),
        analyzeValidatedAsset: async (
          actualUserId,
          actualAssetId,
        ) => {
          receivedUserId = actualUserId;
          receivedAssetId = actualAssetId;

          return {
            title:
              "A Surprising Moment on Camera",
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
          };
        },
      },
    );

  assert.equal(response.status, 200);
  assert.equal(receivedUserId, userId);
  assert.equal(receivedAssetId, assetId);

  const body = await readJson(response);
  assert.equal(body.success, true);

  const analysis = body.analysis as {
    title: string;
    caption: string;
    hashtags: string[];
    thumbnailTimestampSeconds: number;
    thumbnailReason: string;
  };

  assert.equal(
    analysis.title,
    "A Surprising Moment on Camera",
  );
  assert.equal(analysis.hashtags.length, 5);
  assert.equal(
    analysis.thumbnailTimestampSeconds,
    6.25,
  );
}

async function testErrorMapping(
  code: GeminiVideoAnalysisErrorCode,
  expectedStatus: number,
): Promise<void> {
  const response =
    await handleAnalyzeUploadRequest(
      createRequest(),
      { id: assetId },
      {
        verifySession: async () => ({
          id: userId,
        } as never),
        analyzeValidatedAsset: async () => {
          throw new GeminiVideoAnalysisError(
            code,
            `Safe message for ${code}.`,
          );
        },
      },
    );

  assert.equal(
    response.status,
    expectedStatus,
    code,
  );

  const body = await readJson(response);
  assert.equal(body.error, code);
  assert.equal(
    body.message,
    `Safe message for ${code}.`,
  );
}

async function testKnownErrors(): Promise<void> {
  const expectedMappings: Array<[
    GeminiVideoAnalysisErrorCode,
    number,
  ]> = [
    ["GEMINI_DISABLED", 503],
    ["GEMINI_NOT_CONFIGURED", 503],
    ["UPLOAD_ASSET_NOT_FOUND", 404],
    ["UPLOAD_ASSET_NOT_VALIDATED", 409],
    ["UPLOAD_ASSET_DELETED", 409],
    ["UNSUPPORTED_STORAGE_PROVIDER", 422],
    ["INVALID_VIDEO_METADATA", 422],
    ["VIDEO_TOO_LARGE", 413],
    ["VIDEO_DOWNLOAD_FAILED", 502],
    ["GEMINI_UPLOAD_FAILED", 502],
    ["GEMINI_PROCESSING_FAILED", 502],
    ["GEMINI_ANALYSIS_TIMEOUT", 504],
    ["GEMINI_GENERATION_FAILED", 502],
    ["INVALID_MODEL_OUTPUT", 502],
  ];

  for (const [code, status] of
    expectedMappings) {
    await testErrorMapping(code, status);
  }
}

async function testUnknownError(): Promise<void> {
  const originalConsoleError = console.error;
  const capturedErrors: unknown[][] = [];

  console.error = (...values: unknown[]) => {
    capturedErrors.push(values);
  };

  try {
    const response =
      await handleAnalyzeUploadRequest(
        createRequest(),
        { id: assetId },
        {
          verifySession: async () => ({
            id: userId,
          } as never),
          analyzeValidatedAsset: async () => {
            throw new Error(
              "Sensitive internal database detail.",
            );
          },
        },
      );

    assert.equal(response.status, 500);

    const body = await readJson(response);
    assert.equal(
      body.error,
      "INTERNAL_SERVER_ERROR",
    );
    assert.equal(
      body.message,
      "An unexpected error occurred while analyzing the video.",
    );
    assert.equal(
      JSON.stringify(body).includes(
        "Sensitive internal database detail",
      ),
      false,
    );
    assert.equal(capturedErrors.length, 1);
  } finally {
    console.error = originalConsoleError;
  }
}

function testDirectMapping(): void {
  const mapped = mapGeminiAnalysisError(
    new GeminiVideoAnalysisError(
      "VIDEO_TOO_LARGE",
      "Video is too large.",
    ),
  );

  assert.equal(mapped.status, 413);
  assert.equal(
    mapped.body.error,
    "VIDEO_TOO_LARGE",
  );
}

async function main(): Promise<void> {
  await testUnauthenticated();
  await testInvalidAssetId();
  await testSuccess();
  await testKnownErrors();
  await testUnknownError();
  testDirectMapping();

  console.log(
    "PHASE6I_GEMINI_ANALYSIS_API_TESTS=PASSED",
  );
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
