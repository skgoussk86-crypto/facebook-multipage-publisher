/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from "node:assert/strict";
import fs from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getAiConfig, validateLocalhostUrl } from "../src/lib/ai/ai-config";
import {
  AiService,
  generatedVideoContentSchema,
} from "../src/lib/ai";
import { OllamaClient } from "../src/lib/ai/ollama/ollama-client";
import { OllamaFrameExtractor } from "../src/lib/ai/ollama/ollama-frame-extractor";
process.env.AI_PROVIDER = "OLLAMA";
process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11434";
process.env.OLLAMA_MODEL = "qwen3-vl:4b";
process.env.OLLAMA_FRAME_COUNT = "8";
process.env.OLLAMA_REQUEST_TIMEOUT_MS = "240000";
process.env.OLLAMA_MAX_CONCURRENCY = "1";
function testProviderSelection() {
  const config = getAiConfig({
    AI_PROVIDER: "OLLAMA",
    OLLAMA_BASE_URL: "http://127.0.0.1:11434",
  });
  assert.equal(config.provider, "OLLAMA");

  // Missing provider fails closed
  assert.throws(() => {
    getAiConfig({ AI_PROVIDER: "" });
  }, /variable is missing/);

  // Unsupported provider fails closed
  assert.throws(() => {
    getAiConfig({ AI_PROVIDER: "CLAUDE" });
  }, /is unsupported/);
}

function testOllamaUrlValidation() {
  // Localhosts are accepted
  assert.equal(validateLocalhostUrl("http://127.0.0.1:11434"), "http://127.0.0.1:11434");
  assert.equal(validateLocalhostUrl("http://localhost:11434"), "http://localhost:11434");

  // Non-local hosts are rejected
  assert.throws(() => validateLocalhostUrl("http://example.com:11434"), /host must be 127.0.0.1 or localhost/);
  assert.throws(() => validateLocalhostUrl("https://127.0.0.1:11434"), /protocol must be http/);

  // Path, query, credentials rejected
  assert.throws(() => validateLocalhostUrl("http://127.0.0.1:11434/api"), /subpaths/);
  assert.throws(() => validateLocalhostUrl("http://user:pass@127.0.0.1:11434"), /credentials/);
  assert.throws(() => validateLocalhostUrl("http://127.0.0.1:11434?query=1"), /query parameters/);
}

function testSchemaValidation() {
  const validOutput = {
    title: "Encounter on Camera",
    caption: "A wild experience captured on local video footage.",
    hashtags: ["#nature", "#wildlife", "#video", "#cam", "#viral"],
    thumbnailTimestampSeconds: 4.5,
  };

  // Valid schema passes
  assert.ok(generatedVideoContentSchema.parse(validOutput));

  // Invalid title
  assert.throws(() => {
    generatedVideoContentSchema.parse({
      ...validOutput,
      title: "  ", // too short
    });
  });

  // Multiline title
  assert.throws(() => {
    generatedVideoContentSchema.parse({
      ...validOutput,
      title: "Title\nSecondLine",
    });
  });

  // Invalid caption (too short)
  assert.throws(() => {
    generatedVideoContentSchema.parse({
      ...validOutput,
      caption: "Short",
    });
  });

  // Hashtag missing '#' prefix
  assert.throws(() => {
    generatedVideoContentSchema.parse({
      ...validOutput,
      hashtags: ["nature", "#wildlife", "#video", "#cam", "#viral"],
    });
  });

  // Wrong hashtag count (4)
  assert.throws(() => {
    generatedVideoContentSchema.parse({
      ...validOutput,
      hashtags: ["#nature", "#wildlife", "#video", "#cam"],
    });
  });

  // Duplicate hashtags (case-insensitive)
  assert.throws(() => {
    generatedVideoContentSchema.parse({
      ...validOutput,
      hashtags: ["#nature", "#NATURE", "#video", "#cam", "#viral"],
    });
  });

  // Negative timestamp
  assert.throws(() => {
    generatedVideoContentSchema.parse({
      ...validOutput,
      thumbnailTimestampSeconds: -1,
    });
  });
}

// Global fetch mock helper
let mockFetchImpl: ((url: string, init?: RequestInit) => Promise<Response>) | null = null;
const originalFetch = globalThis.fetch;

function setupMockFetch() {
  globalThis.fetch = async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as any).url || input.toString();
    if (mockFetchImpl) {
      return mockFetchImpl(url, init);
    }
    return originalFetch(input, init);
  };
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

async function testOllamaClientUnavailable() {
  const client = new OllamaClient({
    baseUrl: "http://127.0.0.1:11434",
    model: "qwen3-vl:4b",
    timeoutMs: 1000,
  });

  mockFetchImpl = async () => {
    throw new Error("Connection refused");
  };

  await assert.rejects(
    client.generateVideoMetadata({
      durationSeconds: 10,
      timestamps: [1, 2, 3],
      base64Frames: ["f1", "f2"],
    }),
    (err: unknown) => {
      const e = err as any;
      assert.equal(e.name, "AiVideoAnalysisError");
      assert.equal(e.code, "AI_PROVIDER_UNAVAILABLE");
      return true;
    }
  );
}

async function testOllamaClientTimeout() {
  const client = new OllamaClient({
    baseUrl: "http://127.0.0.1:11434",
    model: "qwen3-vl:4b",
    timeoutMs: 10,
  });

  mockFetchImpl = async (url, init) => {
    const signal = init?.signal;
    return new Promise((_, reject) => {
      signal?.addEventListener("abort", () => {
        const err = new Error("The operation was aborted.");
        err.name = "AbortError";
        reject(err);
      });
    });
  };

  await assert.rejects(
    client.generateVideoMetadata({
      durationSeconds: 10,
      timestamps: [1, 2, 3],
      base64Frames: ["f1", "f2"],
    }),
    (err: unknown) => {
      const e = err as any;
      assert.equal(e.name, "AiVideoAnalysisError");
      assert.equal(e.code, "AI_TIMEOUT");
      return true;
    }
  );
}

async function testOllamaClientResponseParsing() {
  const client = new OllamaClient({
    baseUrl: "http://127.0.0.1:11434",
    model: "qwen3-vl:4b",
    timeoutMs: 2000,
  });

  // Mock valid response enveloped by prose
  mockFetchImpl = async () => {
    const rawEnvelope = JSON.stringify({
      message: {
        content: `Here is the response:
\`\`\`json
{
  "title": "A Great Video",
  "caption": "This is a longer caption for description",
  "hashtags": ["#cool", "#video", "#neat", "#viral", "#awesome"],
  "thumbnailTimestampSeconds": 2.0
}
\`\`\`
Have a nice day!`,
      },
    });

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(rawEnvelope));
        controller.close();
      },
    });

    return {
      ok: true,
      body: stream,
    } as unknown as Response;
  };

  const result = await client.generateVideoMetadata({
    durationSeconds: 5,
    timestamps: [1.0, 2.0, 3.0],
    base64Frames: ["f1", "f2"],
  });

  assert.equal(result.title, "A Great Video");
  assert.equal(result.thumbnailTimestampSeconds, 2.0);
}

async function testOllamaClientJsonRepair() {
  const client = new OllamaClient({
    baseUrl: "http://127.0.0.1:11434",
    model: "qwen3-vl:4b",
    timeoutMs: 5000,
  });

  let callCount = 0;

  mockFetchImpl = async () => {
    callCount++;
    // First call returns malformed JSON
    const contentText =
      callCount === 1
        ? '{"title": "Broken Caption",' // Malformed
        : JSON.stringify({
            title: "Fixed Caption Title",
            caption: "This is a repaired caption block for test",
            hashtags: ["#fixed", "#repair", "#video", "#cool", "#viral"],
            thumbnailTimestampSeconds: 3.5,
          });

    const envelope = JSON.stringify({ message: { content: contentText } });
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(envelope));
        controller.close();
      },
    });

    return {
      ok: true,
      body: stream,
    } as unknown as Response;
  };

  const result = await client.generateVideoMetadata({
    durationSeconds: 10,
    timestamps: [1.5, 3.5, 5.5],
    base64Frames: ["f1", "f2"],
  });

  assert.equal(callCount, 2); // Assert repair request triggered
  assert.equal(result.title, "Fixed Caption Title");
}

async function testAiServiceConcurrency() {
  // Clear any existing locks
  AiService.releaseLock();

  const mockAsset = {
    id: "asset-1",
    userId: "user-1",
    provider: "GOOGLE_DRIVE",
    objectKey: "mock-google-drive-file-id",
    status: "VALIDATED",
    originalName: "test.mp4",
    expectedSize: BigInt(100),
    actualSize: BigInt(100),
    declaredMimeType: "video/mp4",
    detectedMimeType: "video/mp4",
    durationMs: 10000,
    objectDeletedAt: null,
  };

  const slowExtract = async () => {
    // Wait for lock concurrency trigger
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { timestamps: [1, 2], base64Frames: ["f1", "f2"] };
  };

  const mockOllamaMeta = async () => {
    return {
      title: "Simulated Success",
      caption: "Some long caption text for test purposes",
      hashtags: ["#sim", "#test", "#video", "#cool", "#post"],
      thumbnailTimestampSeconds: 2.0,
    };
  };

  // Fire first analysis
  const firstPromise = AiService.analyzeValidatedAsset("user-1", "asset-1", {
    findAsset: async () => mockAsset,
    extractFrames: slowExtract,
    generateOllamaMetadata: mockOllamaMeta,
  });

  // Fire second analysis immediately while first is running
  await assert.rejects(
    AiService.analyzeValidatedAsset("user-1", "asset-1", {
      findAsset: async () => mockAsset,
      extractFrames: async () => ({ timestamps: [], base64Frames: [] }),
      generateOllamaMetadata: mockOllamaMeta,
    }),
    (err: unknown) => {
      const e = err as any;
      assert.equal(e.name, "AiVideoAnalysisError");
      assert.equal(e.code, "AI_BUSY");
      return true;
    }
  );

  const result = await firstPromise;
  assert.equal(result.title, "Simulated Success");
  assert.equal(AiService.isBusy(), false); // Lock must be released
}

async function testOwnershipIsolationAndValidation() {
  AiService.releaseLock();

  const mockAsset = {
    id: "asset-1",
    userId: "user-owner",
    provider: "GOOGLE_DRIVE",
    objectKey: "mock-google-drive-file-id",
    status: "VALIDATED",
    originalName: "test.mp4",
    expectedSize: BigInt(100),
    actualSize: BigInt(100),
    declaredMimeType: "video/mp4",
    detectedMimeType: "video/mp4",
    durationMs: 10000,
    objectDeletedAt: null,
  };

  // Cross-user reject: user-other tries to access asset owned by user-owner
  await assert.rejects(
    AiService.analyzeValidatedAsset("user-other", "asset-1", {
      findAsset: async () => mockAsset,
    }),
    (err: unknown) => {
      const e = err as any;
      assert.equal(e.name, "AiVideoAnalysisError");
      assert.equal(e.code, "UPLOAD_ASSET_NOT_FOUND");
      return true;
    }
  );

  // Asset not validated rejected
  await assert.rejects(
    AiService.analyzeValidatedAsset("user-owner", "asset-1", {
      findAsset: async () => ({ ...mockAsset, status: "UPLOADING" }),
    }),
    (err: unknown) => {
      const e = err as any;
      assert.equal(e.name, "AiVideoAnalysisError");
      assert.equal(e.code, "UPLOAD_ASSET_NOT_VALIDATED");
      return true;
    }
  );
}

async function testAiServiceDefaultExtractorBinding() {
  AiService.releaseLock();

  const mockAsset = {
    id: "asset-binding",
    userId: "user-binding",
    provider: "GOOGLE_DRIVE",
    objectKey: "mock-google-drive-file-id",
    status: "VALIDATED",
    originalName: "binding-test.mp4",
    expectedSize: BigInt(100),
    actualSize: BigInt(100),
    declaredMimeType: "video/mp4",
    detectedMimeType: "video/mp4",
    durationMs: 10000,
    objectDeletedAt: null,
  };

  const originalExtractFrames =
    OllamaFrameExtractor.extractFrames;

  let extractorWasCalled = false;
  let receiverWasBound = false;

  const receiverAwareExtractor:
    typeof OllamaFrameExtractor.extractFrames =
    async function (
      this: typeof OllamaFrameExtractor,
      params
    ) {
      extractorWasCalled = true;
      receiverWasBound =
        this === OllamaFrameExtractor;

      assert.equal(
        params.userId,
        "user-binding"
      );

      assert.equal(
        params.asset.objectKey,
        "mock-google-drive-file-id"
      );

      assert.equal(
        params.frameCount,
        8
      );

      return {
        timestamps: [2, 4],
        base64Frames: [
          "mock-frame-one",
          "mock-frame-two",
        ],
      };
    };

  OllamaFrameExtractor.extractFrames =
    receiverAwareExtractor;

  try {
    const result =
      await AiService.analyzeValidatedAsset(
        "user-binding",
        "asset-binding",
        {
          findAsset: async () => mockAsset,
          generateOllamaMetadata:
            async () => ({
              title: "Binding Test Passed",
              caption:
                "The default frame extractor retained its class receiver.",
              hashtags: [
                "#binding",
                "#ollama",
                "#video",
                "#test",
                "#localai",
              ],
              thumbnailTimestampSeconds: 2,
            }),
        }
      );

    assert.equal(
      extractorWasCalled,
      true
    );

    assert.equal(
      receiverWasBound,
      true,
      "Default extractor must retain OllamaFrameExtractor as its receiver."
    );

    assert.equal(
      result.title,
      "Binding Test Passed"
    );

    console.log(
      "PHASE6M_BINDING_REGRESSION=PASSED"
    );
  } finally {
    OllamaFrameExtractor.extractFrames =
      originalExtractFrames;

    AiService.releaseLock();
  }
}
async function testFrameExtractorDiskCleanup() {
  const tempTestDir = join(
    tmpdir(),
    "fb-extractor-cleanup-test"
  );
  const tempVideoPath = join(
    tempTestDir,
    "stub.mp4"
  );

  await rm(tempTestDir, {
    recursive: true,
    force: true,
  });

  fs.mkdirSync(tempTestDir);
  fs.writeFileSync(
    tempVideoPath,
    "stub-bytes"
  );

  const mockAsset = {
    id: "asset-1",
    userId: "user-1",
    provider: "GOOGLE_DRIVE",
    objectKey: "mock-google-drive-file-id",
    status: "VALIDATED",
    originalName: "stub.mp4",
    expectedSize: BigInt(10),
    actualSize: BigInt(10),
    durationMs: 5000,
  };

  const { GoogleDriveMediaReader } =
    await import(
      "../src/lib/google-drive/google-drive-media-reader"
    );

  const originalGetDownloadStream =
    GoogleDriveMediaReader.getDownloadStream;

  const previousFfmpegPath =
    process.env.FFMPEG_PATH;

  GoogleDriveMediaReader.getDownloadStream =
    async () => fs.createReadStream(
      tempVideoPath
    );

  process.env.FFMPEG_PATH =
    "invalid-ffmpeg-path-xyz";

  try {
    await assert.rejects(
      OllamaFrameExtractor.extractFrames({
        userId: "user-1",
        asset: mockAsset,
        frameCount: 5,
      }),
      (err: unknown) => {
        const error = err as {
          name?: string;
          code?: string;
        };

        assert.equal(
          error.name,
          "AiVideoAnalysisError"
        );

        assert.equal(
          error.code,
          "AI_ANALYSIS_FAILED"
        );

        return true;
      }
    );
  } finally {
    GoogleDriveMediaReader.getDownloadStream =
      originalGetDownloadStream;

    if (previousFfmpegPath === undefined) {
      delete process.env.FFMPEG_PATH;
    } else {
      process.env.FFMPEG_PATH =
        previousFfmpegPath;
    }

    await rm(tempTestDir, {
      recursive: true,
      force: true,
    });
  }
}

async function main() {
  console.log("Starting Phase 6M Local Ollama AI tests...");

  setupMockFetch();

  try {
    testProviderSelection();
    testOllamaUrlValidation();
    testSchemaValidation();
    await testOllamaClientUnavailable();
    await testOllamaClientTimeout();
    await testOllamaClientResponseParsing();
    await testOllamaClientJsonRepair();
    await testAiServiceConcurrency();
    await testOwnershipIsolationAndValidation();
    await testAiServiceDefaultExtractorBinding();
    await testFrameExtractorDiskCleanup();

    console.log("PHASE6M_LOCAL_OLLAMA_AI_TESTS=PASSED");
  } finally {
    restoreFetch();
  }
}

main().catch((err) => {
  console.error("Test suite failed:", err);
  process.exit(1);
});
