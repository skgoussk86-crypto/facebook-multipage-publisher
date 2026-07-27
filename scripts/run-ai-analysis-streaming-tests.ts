/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars, @typescript-eslint/no-require-imports */
import assert from "assert";
import { NextRequest } from "next/server";
import { handleAnalyzeStreamRequest } from "../src/app/api/uploads/[id]/analyze-stream/route";
import {
  parseAnalysisStream,
  validateStreamResponseContentType,
  AnalysisRequestRegistry,
} from "../src/lib/ai/ai-analysis-stream-client";

// Global network guard
let networkCallAttempted = false;
const originalFetch = global.fetch;
global.fetch = async () => {
  networkCallAttempted = true;
  throw new Error("Network call blocked by fetch guard!");
};

// Mock user session helper cast as any to bypass Prisma User type strictness
const mockUserSession = (async () => ({
  id: "user-1",
  email: "user@example.com",
  role: "USER",
})) as any;

async function runTests() {
  try {
    console.log("--- Executing AI Analysis Streaming Tests ---");

    // Test 1: Unauthenticated requests are rejected before streaming.
    {
      const req = new NextRequest("http://localhost/api/uploads/asset-1/analyze-stream", { method: "POST" });
      const res = await handleAnalyzeStreamRequest(req, { id: "asset-1" }, {
        verifySession: async () => null,
      });
      assert.strictEqual(res.status, 401);
      const data = await res.json();
      assert.strictEqual(data.error, "UNAUTHENTICATED");
      console.log("✓ Test 1: Unauthenticated requests are rejected before streaming.");
    }

    // Test 2: Invalid or blank asset IDs are rejected before streaming.
    {
      const req = new NextRequest("http://localhost/api/uploads/ /analyze-stream", { method: "POST" });
      const res = await handleAnalyzeStreamRequest(req, { id: " " }, {
        verifySession: mockUserSession,
      });
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.strictEqual(data.error, "INVALID_REQUEST");
      console.log("✓ Test 2: Invalid or blank asset IDs are rejected before streaming.");
    }

    // Test 3: The stream emits ready bytes before a deliberately unresolved analysis promise completes.
    {
      let resolveAnalysis: any = null;
      const analysisPromise = new Promise<any>((resolve) => {
        resolveAnalysis = resolve;
      });

      const req = new NextRequest("http://localhost/api/uploads/asset-1/analyze-stream", { method: "POST" });
      const res = await handleAnalyzeStreamRequest(req, { id: "asset-1" }, {
        verifySession: mockUserSession,
        analyzeValidatedAsset: async () => {
          return await analysisPromise;
        },
        heartbeatIntervalMs: 50,
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers.get("Content-Type"), "text/event-stream; charset=utf-8");

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();

      const { value } = await reader.read();
      const text = decoder.decode(value);
      assert.ok(text.includes(":   ")); // Padding even
      assert.ok(text.includes("event: ready"));

      reader.releaseLock();
      resolveAnalysis({
        title: "Title",
        caption: "Caption",
        hashtags: ["#one", "#two", "#three", "#four", "#five"],
        thumbnailTimestampSeconds: 10,
        thumbnailReason: "reason",
      });
      console.log("✓ Test 3: The stream emits ready bytes before a deliberately unresolved analysis promise completes.");
    }

    // Test 4: At least one heartbeat is emitted while the injected analysis promise remains pending.
    {
      let resolveAnalysis: any = null;
      const analysisPromise = new Promise<any>((resolve) => {
        resolveAnalysis = resolve;
      });

      const req = new NextRequest("http://localhost/api/uploads/asset-1/analyze-stream", { method: "POST" });
      const res = await handleAnalyzeStreamRequest(req, { id: "asset-1" }, {
        verifySession: mockUserSession,
        analyzeValidatedAsset: async () => {
          return await analysisPromise;
        },
        heartbeatIntervalMs: 20,
      });

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();

      let allText = "";
      for (let i = 0; i < 10; i++) {
        const { value, done } = await reader.read();
        if (done) break;
        allText += decoder.decode(value);
        if (allText.includes("heartbeat")) break;
        await new Promise((r) => setTimeout(r, 10));
      }

      assert.ok(allText.includes("heartbeat"));
      reader.releaseLock();
      resolveAnalysis({
        title: "Title",
        caption: "Caption",
        hashtags: ["#one", "#two", "#three", "#four", "#five"],
        thumbnailTimestampSeconds: 10,
        thumbnailReason: "reason",
      });
      console.log("✓ Test 4: At least one heartbeat is emitted while the injected analysis promise remains pending.");
    }

    // Test 5: A successful analysis emits one result event containing title, caption, exactly five hashtags, thumbnailTimestampSeconds, and thumbnailReason.
    {
      const req = new NextRequest("http://localhost/api/uploads/asset-1/analyze-stream", { method: "POST" });
      const res = await handleAnalyzeStreamRequest(req, { id: "asset-1" }, {
        verifySession: mockUserSession,
        analyzeValidatedAsset: async () => ({
          title: "Dynamic Title",
          caption: "Dynamic Caption",
          hashtags: ["#one", "#two", "#three", "#four", "#five"],
          thumbnailTimestampSeconds: 12.34,
          thumbnailReason: "reasoning",
        }),
        heartbeatIntervalMs: 1000,
      });

      const response = new Response(res.body);
      const events: any[] = [];
      await parseAnalysisStream(response, {
        onReady() {},
        onResult(result) {
          events.push(result);
        },
      });

      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].success, true);
      assert.strictEqual(events[0].analysis.title, "Dynamic Title");
      assert.strictEqual(events[0].analysis.caption, "Dynamic Caption");
      assert.deepStrictEqual(events[0].analysis.hashtags, ["#one", "#two", "#three", "#four", "#five"]);
      assert.strictEqual(events[0].analysis.thumbnailTimestampSeconds, 12.34);
      assert.strictEqual(events[0].analysis.thumbnailReason, "reasoning");
      console.log("✓ Test 5: A successful analysis emits one result event containing expected details.");
    }

    // Test 6: An expected AI error emits one safe error event and no result event.
    {
      const { AiVideoAnalysisError } = require("../src/lib/ai");
      const req = new NextRequest("http://localhost/api/uploads/asset-1/analyze-stream", { method: "POST" });
      const res = await handleAnalyzeStreamRequest(req, { id: "asset-1" }, {
        verifySession: mockUserSession,
        analyzeValidatedAsset: async () => {
          throw new AiVideoAnalysisError("AI_BUSY", "The local AI service is busy.");
        },
      });

      const response = new Response(res.body);
      const results: any[] = [];
      const errors: any[] = [];
      await parseAnalysisStream(response, {
        onResult(result) {
          results.push(result);
        },
        onError(err) {
          errors.push(err);
        },
      });

      assert.strictEqual(results.length, 0);
      assert.strictEqual(errors.length, 1);
      assert.strictEqual(errors[0].error, "AI_BUSY");
      assert.strictEqual(errors[0].message, "The local AI service is busy. Please try again.");
      console.log("✓ Test 6: An expected AI error emits one safe error event and no result event.");
    }

    // Test 7: An unexpected exception emits INTERNAL_SERVER_ERROR without leaking the original exception message.
    {
      const loggedArgs: any[][] = [];
      const originalConsoleError = console.error;
      console.error = (...args: any[]) => {
        loggedArgs.push(args);
      };

      try {
        const req = new NextRequest("http://localhost/api/uploads/asset-1/analyze-stream", { method: "POST" });
        const res = await handleAnalyzeStreamRequest(req, { id: "asset-1" }, {
          verifySession: mockUserSession,
          analyzeValidatedAsset: async () => {
            throw new Error("Secret database credentials!");
          },
        });

        const response = new Response(res.body);
        const errors: any[] = [];
        await parseAnalysisStream(response, {
          onError(err) {
            errors.push(err);
          },
        });

        assert.strictEqual(errors.length, 1);
        assert.strictEqual(errors[0].error, "INTERNAL_SERVER_ERROR");
        assert.strictEqual(errors[0].message, "An unexpected error occurred while analyzing the media file.");

        // Assert console logging sanitization
        assert.strictEqual(loggedArgs.length, 1);
        const firstCall = loggedArgs[0];
        assert.strictEqual(firstCall.length, 1);
        assert.strictEqual(firstCall[0], "AI_ANALYSIS_STREAM_UNEXPECTED_ERROR");

        // Verify "Secret database credentials!" is not in any argumen
        const joinedArgs = firstCall.map(a => String(a)).join(" ");
        assert.ok(!joinedArgs.includes("Secret database credentials!"));
        assert.ok(!joinedArgs.includes("Error:")); // No raw exception/stack details
      } finally {
        console.error = originalConsoleError;
      }
      console.log("✓ Test 7: An unexpected exception emits INTERNAL_SERVER_ERROR without leaking secrets.");
    }

    // Test 8: The heartbeat timer is cleared and the stream closes after success.
    {
      let intervalCleared = false;
      const originalClearInterval = global.clearInterval;
      global.clearInterval = (id: any) => {
        intervalCleared = true;
        originalClearInterval(id);
      };

      const req = new NextRequest("http://localhost/api/uploads/asset-1/analyze-stream", { method: "POST" });
      const res = await handleAnalyzeStreamRequest(req, { id: "asset-1" }, {
        verifySession: mockUserSession,
        analyzeValidatedAsset: async () => ({
          title: "T",
          caption: "C",
          hashtags: ["#a", "#b", "#c", "#d", "#e"],
          thumbnailTimestampSeconds: 0,
        }),
        heartbeatIntervalMs: 50,
      });

      const response = new Response(res.body);
      await parseAnalysisStream(response, {});
      assert.ok(intervalCleared);

      global.clearInterval = originalClearInterval;
      console.log("✓ Test 8: The heartbeat timer is cleared and the stream closes after success.");
    }

    // Test 9: The heartbeat timer is cleared when the request is aborted.
    {
      let intervalCleared = false;
      const originalClearInterval = global.clearInterval;
      global.clearInterval = (id: any) => {
        intervalCleared = true;
        originalClearInterval(id);
      };

      const abortController = new AbortController();
      const req = new NextRequest("http://localhost/api/uploads/asset-1/analyze-stream", {
        method: "POST",
        signal: abortController.signal,
      });

      const res = await handleAnalyzeStreamRequest(req, { id: "asset-1" }, {
        verifySession: mockUserSession,
        analyzeValidatedAsset: async () => {
          return new Promise(() => {});
        },
        heartbeatIntervalMs: 50,
      });

      abortController.abort();

      await new Promise((resolve) => setTimeout(resolve, 10));

      assert.ok(intervalCleared);
      global.clearInterval = originalClearInterval;
      console.log("✓ Test 9: The heartbeat timer is cleared when the request is aborted.");
    }

    // Test 10: The client parser handles an SSE event divided across multiple arbitrary chunks.
    {
      const chunks = [
        "event: result\n",
        "data: {\"success\":true,",
        "\"analysis\":{\"title\":\"Hello\"",
        ",\"caption\":\"Caption\",\"hashtags\":[\"#a\",\"#b\",\"#c\",\"#d\",\"#e\"],\"thumbnailTimestampSeconds\":3,\"thumbnailReason\":\"reason\"}}\n\n",
      ];

      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          chunks.forEach((c) => controller.enqueue(encoder.encode(c)));
          controller.close();
        },
      });

      const response = new Response(stream);
      const results: any[] = [];
      await parseAnalysisStream(response, {
        onResult(res) {
          results.push(res);
        },
      });

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].analysis.title, "Hello");
      console.log("✓ Test 10: The client parser handles an SSE event divided across multiple arbitrary chunks.");
    }

    // Test 11: The client parser ignores heartbeat comments.
    {
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(": heartbeat 2026-07-26T15:44:35.000Z\n\n"));
          controller.enqueue(
            encoder.encode(
              'event: result\ndata: {"success":true,"analysis":{"title":"T","caption":"C","hashtags":[],"thumbnailTimestampSeconds":0,"thumbnailReason":""}}\n\n'
            )
          );
          controller.close();
        },
      });

      const response = new Response(stream);
      const results: any[] = [];
      await parseAnalysisStream(response, {
        onResult(res) {
          results.push(res);
        },
      });

      assert.strictEqual(results.length, 1);
      console.log("✓ Test 11: The client parser ignores heartbeat comments.");
    }

    // Test 12: The client parser rejects malformed JSON safely.
    {
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode("event: result\ndata: {malformed_json_here}\n\n"));
          controller.close();
        },
      });

      const response = new Response(stream);
      await assert.rejects(parseAnalysisStream(response, {}), /Malformed JSON in stream data/);
      console.log("✓ Test 12: The client parser rejects malformed JSON safely.");
    }

    // Test 13: The client parser rejects a stream that ends without result or error.
    {
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('event: ready\ndata: {"status":"started"}\n\n'));
          controller.close();
        },
      });

      const response = new Response(stream);
      await assert.rejects(
        parseAnalysisStream(response, {}),
        /Stream connection ended before a result or error event was received/
      );
      console.log("✓ Test 13: The client parser rejects a stream that ends without result or error.");
    }

    // Test 14: The analysis dependency is called exactly once per stream request.
    {
      let analysisCalled = 0;
      const req = new NextRequest("http://localhost/api/uploads/asset-1/analyze-stream", { method: "POST" });
      const res = await handleAnalyzeStreamRequest(req, { id: "asset-1" }, {
        verifySession: mockUserSession,
        analyzeValidatedAsset: async () => {
          analysisCalled++;
          return {
            title: "T",
            caption: "C",
            hashtags: ["#a", "#b", "#c", "#d", "#e"],
            thumbnailTimestampSeconds: 0,
          };
        },
      });

      const response = new Response(res.body);
      await parseAnalysisStream(response, {});
      assert.strictEqual(analysisCalled, 1);
      console.log("✓ Test 14: The analysis dependency is called exactly once per stream request.");
    }

    // Test 15: No real network request occurs during the test.
    {
      assert.strictEqual(networkCallAttempted, false);
      console.log("✓ Test 15: No real network request occurs during the test.");
    }

    // --- NEW STRENGTHENED TEST SUITE CASES (A-G) ---

    // Test A: Recognized error sanitization
    {
      const { AiVideoAnalysisError } = require("../src/lib/ai");
      const loggedArgs: any[][] = [];
      const originalConsoleError = console.error;
      console.error = (...args: any[]) => {
        loggedArgs.push(args);
      };

      try {
        const req = new NextRequest("http://localhost/api/uploads/asset-1/analyze-stream", { method: "POST" });
        const res = await handleAnalyzeStreamRequest(req, { id: "asset-1" }, {
          verifySession: mockUserSession,
          analyzeValidatedAsset: async () => {
            throw new AiVideoAnalysisError(
              "VIDEO_DOWNLOAD_FAILED",
              "C:\\Users\\HP\\secret-video.tmp token=private-value"
            );
          },
        });

        const response = new Response(res.body);
        const errors: any[] = [];
        await parseAnalysisStream(response, {
          onError(err) {
            errors.push(err);
          },
        });

        assert.strictEqual(errors.length, 1);
        assert.strictEqual(errors[0].error, "VIDEO_DOWNLOAD_FAILED");
        assert.strictEqual(errors[0].message, "The video could not be prepared for AI analysis. Please try again.");

        // Safe mapper assertion
        assert.strictEqual(loggedArgs.length, 1);
        assert.strictEqual(loggedArgs[0][0], "AI_ANALYSIS_STREAM_EXPECTED_ERROR");
        assert.strictEqual(loggedArgs[0][1], "VIDEO_DOWNLOAD_FAILED");

        // Verify secret token & raw path or stack leak is entirely absent from logging args
        const joinedArgs = loggedArgs[0].map(a => String(a)).join(" ");
        assert.ok(!joinedArgs.includes("private-value"));
        assert.ok(!joinedArgs.includes("secret-video.tmp"));
      } finally {
        console.error = originalConsoleError;
      }
      console.log("✓ Test A: Recognized error sanitization enforces zero credential/path leaks.");
    }

    // Test B: Duplicate-request registration
    {
      const registry = new AnalysisRequestRegistry();
      const ctrl1 = new AbortController();
      const ctrl2 = new AbortController();

      // First succeeds
      assert.strictEqual(registry.register("job-1", ctrl1), true);
      // Second for same job fails
      assert.strictEqual(registry.register("job-1", ctrl2), false);

      // Releasing with matching ctrl succeeds
      registry.release("job-1", ctrl1);
      assert.strictEqual(registry.has("job-1"), false);

      // Releasing with different controller does not delete active
      registry.register("job-2", ctrl1);
      registry.release("job-2", ctrl2);
      assert.strictEqual(registry.has("job-2"), true);

      registry.release("job-2", ctrl1);
      assert.strictEqual(registry.has("job-2"), false);
      console.log("✓ Test B: Duplicate-request registry correctly blocks concurrent job requests.");
    }

    // Test C: Non-SSE response Content-Type check
    {
      const headers = new Headers();
      headers.set("Content-Type", "text/html; charset=utf-8");
      const fakeRes = new Response("<html>Internal Server Error</html>", {
        status: 200,
        headers,
      });

      assert.throws(
        () => validateStreamResponseContentType(fakeRes),
        /The AI analysis connection ended before completion. Please try again./
      );
      console.log("✓ Test C: Non-SSE Content-Type triggers clean validation exception.");
    }

    // Test D: Accumulated multi-line event limit check
    {
      const dataLine = "d".repeat(1024);
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode("event: result\n"));
          // Enqueue 1025 lines of 1 KB, exceeding 1 MB accumulated size limi
          for (let i = 0; i < 1025; i++) {
            controller.enqueue(encoder.encode(`data: ${dataLine}\n`));
          }
          controller.enqueue(encoder.encode("\n"));
          controller.close();
        },
      });

      const fakeRes = new Response(stream);
      await assert.rejects(
        parseAnalysisStream(fakeRes, {}),
        /Stream event size exceeded limit./
      );
      console.log("✓ Test D: Accumulated multi-line SSE event limit is successfully enforced.");
    }

    // Test E: Stream cancellation clears timer and cleans up
    {
      let intervalCleared = false;
      const originalClearInterval = global.clearInterval;
      global.clearInterval = (id: any) => {
        intervalCleared = true;
        originalClearInterval(id);
      };

      try {
        const req = new NextRequest("http://localhost/api/uploads/asset-1/analyze-stream", { method: "POST" });
        const res = await handleAnalyzeStreamRequest(req, { id: "asset-1" }, {
          verifySession: mockUserSession,
          analyzeValidatedAsset: async () => {
            return new Promise(() => {});
          },
          heartbeatIntervalMs: 50,
        });

        const reader = res.body!.getReader();
        await reader.cancel(); // reader-level stream cancel

        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.ok(intervalCleared);
      } finally {
        global.clearInterval = originalClearInterval;
      }
      console.log("✓ Test E: Stream cancellation successfully clears heartbeats and terminates cleanly.");
    }

    // Test F: Real request abort validation
    {
      let intervalCleared = false;
      const originalClearInterval = global.clearInterval;
      global.clearInterval = (id: any) => {
        intervalCleared = true;
        originalClearInterval(id);
      };

      try {
        const abortController = new AbortController();
        const req = new NextRequest("http://localhost/api/uploads/asset-1/analyze-stream", {
          method: "POST",
          signal: abortController.signal,
        });

        const res = await handleAnalyzeStreamRequest(req, { id: "asset-1" }, {
          verifySession: mockUserSession,
          analyzeValidatedAsset: async () => {
            return new Promise(() => {});
          },
          heartbeatIntervalMs: 50,
        });

        // Trigger real abor
        abortController.abort();

        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.ok(intervalCleared);
      } finally {
        global.clearInterval = originalClearInterval;
      }
      console.log("✓ Test F: Real abort signals propagate to active streams and trigger cleanup.");
    }

    // Test G: Parser reader cancellation on malformed even
    {
      let readerCancelled = false;
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode("event: result\ndata: {malformed}\n\n"));
          controller.close();
        },
      });

      const response = new Response(stream);
      const originalGetReader = (response.body as any).getReader;
      (response.body as any).getReader = function () {
        const reader = originalGetReader.call(response.body);
        const originalCancel = reader.cancel;
        reader.cancel = async function (reason?: any) {
          readerCancelled = true;
          return originalCancel.call(reader, reason);
        };
        return reader;
      };

      await assert.rejects(parseAnalysisStream(response, {}));
      assert.ok(readerCancelled);
      console.log("✓ Test G: Parser reader is automatically cancelled on parsing failures.");
    }

    console.log("\n======================================================");
    console.log("ALL STREAMING TESTS PASSED SUCCESSFULLY");
    console.log("======================================================");
  } finally {
    global.fetch = originalFetch;
  }
}

runTests().catch((err) => {
  console.error("Streaming Tests FAILED:", err);
  process.exit(1);
});
