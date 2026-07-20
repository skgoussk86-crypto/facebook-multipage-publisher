import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { Readable } from "node:stream";

import type { GeminiConfig } from "../src/lib/gemini/gemini-config";
import {
  GeminiVideoAnalysisError,
  GeminiVideoAnalysisService,
  type GeminiAnalyzableAsset,
  type GeminiClientAdapter,
} from "../src/lib/gemini/gemini-video-analysis-service";

const enabledConfig: GeminiConfig = {
  enabled: true,
  apiKey: "test-key-not-a-real-secret",
  model: "gemini-2.5-flash",
  maxVideoBytes: 1024 * 1024,
  analysisTimeoutMs: 60_000,
  filePollIntervalMs: 1,
};

function createAsset(
  overrides: Partial<GeminiAnalyzableAsset> = {},
): GeminiAnalyzableAsset {
  return {
    id: "2d34444b-8487-44c3-bbb9-7fcdb74ad999",
    userId: "926cb6ba-f169-4871-b8d7-6eec2f1d23b4",
    provider: "GOOGLE_DRIVE",
    objectKey: "drive-file-id",
    originalName: "example.mp4",
    expectedSize: BigInt(11),
    actualSize: BigInt(11),
    declaredMimeType: "video/mp4",
    detectedMimeType: "video/mp4",
    status: "VALIDATED",
    durationMs: 15_000,
    objectDeletedAt: null,
    ...overrides,
  };
}

class FakeGeminiClient
  implements GeminiClientAdapter {
  uploadedPath: string | null = null;
  deleteCalls: string[] = [];
  getFileCalls = 0;
  generatedPrompt = "";
  generatedSchema: unknown = null;
  states = ["PROCESSING", "ACTIVE"];
  output = JSON.stringify({
    title: "A Surprising Moment Unfolds",
    caption:
      "A clear and unexpected moment unfolds in this short video.",
    hashtags: [
      "#ViralVideo",
      "#Unexpected",
      "#MustWatch",
      "#FacebookVideo",
      "#TrendingNow",
    ],
    thumbnailTimestampSeconds: 7.25,
    thumbnailReason:
      "The subject is sharp, expressive, and clearly visible.",
  });
  generationError: Error | null = null;

  async uploadVideo(params: {
    filePath: string;
    mimeType: string;
    displayName: string;
    abortSignal: AbortSignal;
  }) {
    assert.equal(params.mimeType, "video/mp4");
    assert.equal(params.displayName, "example.mp4");
    assert.equal(params.abortSignal.aborted, false);
    assert.equal(existsSync(params.filePath), true);
    this.uploadedPath = params.filePath;

    return {
      name: "files/test-video",
      state: "PROCESSING",
    };
  }

  async getFile(name: string) {
    assert.equal(name, "files/test-video");
    const state =
      this.states[
        Math.min(
          this.getFileCalls,
          this.states.length - 1,
        )
      ];
    this.getFileCalls += 1;

    return {
      name,
      state,
      uri:
        state === "ACTIVE"
          ? "https://example.invalid/video"
          : undefined,
      mimeType: "video/mp4",
    };
  }

  async generateVideoMetadata(params: {
    model: string;
    fileUri: string;
    mimeType: string;
    prompt: string;
    responseJsonSchema: unknown;
    abortSignal: AbortSignal;
  }) {
    if (this.generationError) {
      throw this.generationError;
    }

    assert.equal(
      params.model,
      "gemini-2.5-flash",
    );
    assert.equal(
      params.fileUri,
      "https://example.invalid/video",
    );
    assert.equal(
      params.mimeType,
      "video/mp4",
    );
    assert.equal(
      params.abortSignal.aborted,
      false,
    );
    this.generatedPrompt = params.prompt;
    this.generatedSchema =
      params.responseJsonSchema;

    return this.output;
  }

  async deleteFile(name: string) {
    this.deleteCalls.push(name);
  }
}

async function expectAnalysisError(
  expectedCode: string,
  run: () => Promise<unknown>,
): Promise<void> {
  await assert.rejects(
    run,
    (error: unknown) => {
      assert.ok(
        error instanceof
          GeminiVideoAnalysisError,
      );
      assert.equal(error.code, expectedCode);
      return true;
    },
  );
}

async function testSuccessfulAnalysis(): Promise<void> {
  const asset = createAsset();
  const client = new FakeGeminiClient();

  const result =
    await GeminiVideoAnalysisService
      .analyzeValidatedAsset(
        asset.userId,
        asset.id,
        {
          getConfig: () => enabledConfig,
          findAsset: async () => asset,
          getDownloadStream: async () =>
            Readable.from([
              Buffer.from("video-bytes"),
            ]),
          createClient: () => client,
          sleep: async () => undefined,
        },
      );

  assert.equal(
    result.title,
    "A Surprising Moment Unfolds",
  );
  assert.equal(result.hashtags.length, 5);
  assert.equal(
    result.thumbnailTimestampSeconds,
    7.25,
  );
  assert.match(
    client.generatedPrompt,
    /15\.000 seconds/,
  );
  assert.ok(client.generatedSchema);
  assert.deepEqual(
    client.deleteCalls,
    ["files/test-video"],
  );
  assert.ok(client.uploadedPath);
  assert.equal(
    existsSync(client.uploadedPath),
    false,
  );
}

async function testDisabledConfiguration(): Promise<void> {
  await expectAnalysisError(
    "GEMINI_DISABLED",
    async () =>
      await GeminiVideoAnalysisService
        .analyzeValidatedAsset(
          "user-id",
          "asset-id",
          {
            getConfig: () => ({
              ...enabledConfig,
              enabled: false,
              apiKey: null,
            }),
          },
        ),
  );
}

async function testOwnershipIsolation(): Promise<void> {
  const asset = createAsset();

  await expectAnalysisError(
    "UPLOAD_ASSET_NOT_FOUND",
    async () =>
      await GeminiVideoAnalysisService
        .analyzeValidatedAsset(
          "different-user-id",
          asset.id,
          {
            getConfig: () => enabledConfig,
            findAsset: async () => asset,
          },
        ),
  );
}

async function testAssetGuards(): Promise<void> {
  const userId = createAsset().userId;

  const cases: Array<{
    asset: GeminiAnalyzableAsset;
    code: string;
  }> = [
    {
      asset: createAsset({
        status: "UPLOADED",
      }),
      code: "UPLOAD_ASSET_NOT_VALIDATED",
    },
    {
      asset: createAsset({
        objectDeletedAt: new Date(),
      }),
      code: "UPLOAD_ASSET_DELETED",
    },
    {
      asset: createAsset({
        provider: "R2",
      }),
      code: "UNSUPPORTED_STORAGE_PROVIDER",
    },
    {
      asset: createAsset({
        durationMs: null,
      }),
      code: "INVALID_VIDEO_METADATA",
    },
    {
      asset: createAsset({
        actualSize: BigInt(
          enabledConfig.maxVideoBytes + 1,
        ),
      }),
      code: "VIDEO_TOO_LARGE",
    },
  ];

  for (const testCase of cases) {
    await expectAnalysisError(
      testCase.code,
      async () =>
        await GeminiVideoAnalysisService
          .analyzeValidatedAsset(
            userId,
            testCase.asset.id,
            {
              getConfig: () => enabledConfig,
              findAsset: async () =>
                testCase.asset,
            },
          ),
    );
  }
}

async function testInvalidModelOutput(): Promise<void> {
  const asset = createAsset();
  const client = new FakeGeminiClient();
  client.states = ["ACTIVE"];
  client.output = JSON.stringify({
    title: "Valid title",
    caption:
      "A sufficiently long valid caption.",
    hashtags: [
      "#One",
      "#Two",
      "#Three",
      "#Four",
      "#Five",
    ],
    thumbnailTimestampSeconds: 99,
    thumbnailReason:
      "A clear frame was selected.",
  });

  await expectAnalysisError(
    "INVALID_MODEL_OUTPUT",
    async () =>
      await GeminiVideoAnalysisService
        .analyzeValidatedAsset(
          asset.userId,
          asset.id,
          {
            getConfig: () => enabledConfig,
            findAsset: async () => asset,
            getDownloadStream: async () =>
              Readable.from([
                Buffer.from("video-bytes"),
              ]),
            createClient: () => client,
          },
        ),
  );

  assert.deepEqual(
    client.deleteCalls,
    ["files/test-video"],
  );
  assert.ok(client.uploadedPath);
  assert.equal(
    existsSync(client.uploadedPath),
    false,
  );
}

async function testGenerationFailureCleanup(): Promise<void> {
  const asset = createAsset();
  const client = new FakeGeminiClient();
  client.states = ["ACTIVE"];
  client.generationError =
    new Error("simulated failure");

  await expectAnalysisError(
    "GEMINI_GENERATION_FAILED",
    async () =>
      await GeminiVideoAnalysisService
        .analyzeValidatedAsset(
          asset.userId,
          asset.id,
          {
            getConfig: () => enabledConfig,
            findAsset: async () => asset,
            getDownloadStream: async () =>
              Readable.from([
                Buffer.from("video-bytes"),
              ]),
            createClient: () => client,
          },
        ),
  );

  assert.deepEqual(
    client.deleteCalls,
    ["files/test-video"],
  );
  assert.ok(client.uploadedPath);
  assert.equal(
    existsSync(client.uploadedPath),
    false,
  );
}

async function main(): Promise<void> {
  await testSuccessfulAnalysis();
  await testDisabledConfiguration();
  await testOwnershipIsolation();
  await testAssetGuards();
  await testInvalidModelOutput();
  await testGenerationFailureCleanup();

  console.log(
    "PHASE6I_GEMINI_VIDEO_ANALYSIS_TESTS=PASSED",
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
