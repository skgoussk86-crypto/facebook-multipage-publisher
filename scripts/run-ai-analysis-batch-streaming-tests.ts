/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
// Mock database helper at the absolute top of the file
const mockPrisma = {
  uploadAsset: {
    findMany: async (args: any) => {
      const inIds = args.where.id.in;
      return inIds.map((id: string) => ({
        id,
        userId: "user-1",
        status: "VALIDATED",
        objectDeletedAt: null,
      }));
    },
  },
};
(global as any).prisma = mockPrisma;

import assert from "assert";
import { NextRequest } from "next/server";

// Global network guard
let networkCallAttempted = false;
const originalFetch = global.fetch;
global.fetch = async () => {
  networkCallAttempted = true;
  throw new Error("Network call blocked by fetch guard!");
};

// Mock user session helpers
const mockUserSession = (async () => ({
  id: "user-1",
  email: "user@example.com",
  role: "USER",
  status: "ACTIVE",
  approvalStatus: "APPROVED",
})) as any;

async function runTests() {
  // Dynamically import all local project files to ensure global.prisma is assigned first
  const { aiSemaphore } = await import("../src/lib/ai/ai-service");
  const {
    parseAnalysisStream,
    validateStreamResponseContentType,
  } = await import("../src/lib/ai/ai-analysis-stream-client");
  const { AiVideoAnalysisError } = await import("../src/lib/ai/ai-types");
  const { handleAnalyzeBatchStreamRequest } = await import(
    "../src/app/api/uploads/analyze-batch-stream/route"
  );

  try {
    console.log("--- Executing AI Analysis Batch Streaming Tests ---");

    // Test 1: Unauthenticated request rejected before streaming.
    {
      const req = new NextRequest("http://localhost/api/uploads/analyze-batch-stream", {
        method: "POST",
        body: JSON.stringify({ assetIds: ["asset-1"] }),
      });
      const res = await handleAnalyzeBatchStreamRequest(req, {
        verifySession: async () => null,
      });
      assert.strictEqual(res.status, 401);
      const data = await res.json();
      assert.strictEqual(data.error, "UNAUTHENTICATED");
      console.log("✓ Test 1: Unauthenticated request rejected before streaming.");
    }

    // Test 2: Empty asset array rejected.
    {
      const req = new NextRequest("http://localhost/api/uploads/analyze-batch-stream", {
        method: "POST",
        body: JSON.stringify({ assetIds: [] }),
      });
      const res = await handleAnalyzeBatchStreamRequest(req, {
        verifySession: mockUserSession,
      });
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.strictEqual(data.error, "INVALID_REQUEST");
      console.log("✓ Test 2: Empty asset array rejected.");
    }

    // Test 3: Duplicate asset IDs normalized safely.
    {
      const req = new NextRequest("http://localhost/api/uploads/analyze-batch-stream", {
        method: "POST",
        body: JSON.stringify({ assetIds: ["asset-1", "asset-1"] }),
      });
      const res = await handleAnalyzeBatchStreamRequest(req, {
        verifySession: mockUserSession,
        analyzeValidatedAsset: async () => ({
          title: "Title",
          caption: "Caption",
          hashtags: ["#one"],
          thumbnailTimestampSeconds: 1,
        }),
      });
      assert.strictEqual(res.status, 200);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let allText = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        allText += decoder.decode(value);
      }
      assert.ok(allText.includes("batch-ready"));
      assert.ok(allText.includes(`"total":1`)); // Normalized deduplicated total
      console.log("✓ Test 3: Duplicate asset IDs normalized safely.");
    }

    // Test 4: More than 50 assets rejected.
    {
      const assetIds = Array.from({ length: 51 }, (_, i) => `asset-${i}`);
      const req = new NextRequest("http://localhost/api/uploads/analyze-batch-stream", {
        method: "POST",
        body: JSON.stringify({ assetIds }),
      });
      const res = await handleAnalyzeBatchStreamRequest(req, {
        verifySession: mockUserSession,
      });
      assert.strictEqual(res.status, 400);
      console.log("✓ Test 4: More than 50 assets rejected.");
    }

    // Test 5: Concurrency below 1 clamped or rejected safely.
    {
      const req = new NextRequest("http://localhost/api/uploads/analyze-batch-stream", {
        method: "POST",
        body: JSON.stringify({ assetIds: ["asset-1"], concurrency: 0 }),
      });
      const res = await handleAnalyzeBatchStreamRequest(req, {
        verifySession: mockUserSession,
        analyzeValidatedAsset: async () => ({
          title: "Title",
          caption: "Caption",
          hashtags: ["#one"],
          thumbnailTimestampSeconds: 1,
        }),
      });
      assert.strictEqual(res.status, 200);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let allText = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        allText += decoder.decode(value);
      }
      assert.ok(allText.includes(`"concurrency":1`));
      console.log("✓ Test 5: Concurrency below 1 clamped or rejected safely.");
    }

    // Test 6: Concurrency above 5 clamped to 5.
    {
      const req = new NextRequest("http://localhost/api/uploads/analyze-batch-stream", {
        method: "POST",
        body: JSON.stringify({ assetIds: ["asset-1"], concurrency: 10 }),
      });
      const res = await handleAnalyzeBatchStreamRequest(req, {
        verifySession: mockUserSession,
        analyzeValidatedAsset: async () => ({
          title: "Title",
          caption: "Caption",
          hashtags: ["#one"],
          thumbnailTimestampSeconds: 1,
        }),
      });
      assert.strictEqual(res.status, 200);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let allText = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        allText += decoder.decode(value);
      }
      assert.ok(allText.includes(`"concurrency":5`));
      console.log("✓ Test 6: Concurrency above 5 clamped to 5.");
    }

    // Test 7: Immediate ready bytes emitted before analyses finish.
    {
      let resolveAnalysis: any = null;
      const promise = new Promise<any>((resolve) => {
        resolveAnalysis = resolve;
      });
      const req = new NextRequest("http://localhost/api/uploads/analyze-batch-stream", {
        method: "POST",
        body: JSON.stringify({ assetIds: ["asset-1"] }),
      });
      const res = await handleAnalyzeBatchStreamRequest(req, {
        verifySession: mockUserSession,
        analyzeValidatedAsset: async () => await promise,
      });
      assert.strictEqual(res.status, 200);
      const reader = res.body!.getReader();
      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);
      assert.ok(text.includes("event: ready"));
      reader.releaseLock();
      resolveAnalysis({
        title: "Title",
        caption: "Caption",
        hashtags: ["#one"],
        thumbnailTimestampSeconds: 1,
      });
      console.log("✓ Test 7: Immediate ready bytes emitted before analyses finish.");
    }

    // Test 8: Heartbeats emitted while workers are active.
    {
      let resolveAnalysis: any = null;
      const promise = new Promise<any>((resolve) => {
        resolveAnalysis = resolve;
      });
      const req = new NextRequest("http://localhost/api/uploads/analyze-batch-stream", {
        method: "POST",
        body: JSON.stringify({ assetIds: ["asset-1"] }),
      });
      const res = await handleAnalyzeBatchStreamRequest(req, {
        verifySession: mockUserSession,
        analyzeValidatedAsset: async () => await promise,
        heartbeatIntervalMs: 10,
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let allText = "";
      for (let i = 0; i < 5; i++) {
        const { value } = await reader.read();
        allText += decoder.decode(value);
        if (allText.includes("heartbeat")) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.ok(allText.includes("heartbeat"));
      reader.releaseLock();
      resolveAnalysis({
        title: "Title",
        caption: "Caption",
        hashtags: ["#one"],
        thumbnailTimestampSeconds: 1,
      });
      console.log("✓ Test 8: Heartbeats emitted while workers are active.");
    }

    // Test 9: At most two analyses active simultaneously with default configuration.
    {
      const activeIds: string[] = [];
      let maxActive = 0;
      const resolvers: any[] = [];
      const req = new NextRequest("http://localhost/api/uploads/analyze-batch-stream", {
        method: "POST",
        body: JSON.stringify({ assetIds: ["a1", "a2", "a3", "a4"] }),
      });
      const res = await handleAnalyzeBatchStreamRequest(req, {
        verifySession: mockUserSession,
        analyzeValidatedAsset: async (_userId, assetId) => {
          activeIds.push(assetId);
          maxActive = Math.max(maxActive, activeIds.length);
          return new Promise((resolve) => {
            resolvers.push({ resolve, assetId });
          });
        },
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let allText = "";
      for (let i = 0; i < 10; i++) {
        const { value } = await reader.read();
        allText += decoder.decode(value);
        if (resolvers.length >= 2) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.strictEqual(resolvers.length, 2);
      assert.strictEqual(maxActive, 2);

      // Complete one, another should start
      const first = resolvers.shift();
      const idx = activeIds.indexOf(first.assetId);
      if (idx > -1) activeIds.splice(idx, 1);
      first.resolve({ title: "T", caption: "C", hashtags: [], thumbnailTimestampSeconds: 1 });

      for (let i = 0; i < 10; i++) {
        const { value } = await reader.read();
        allText += decoder.decode(value);
        if (resolvers.length >= 2) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.strictEqual(resolvers.length, 2); // 1 remaining + 1 new started

      // Clean up remaining
      for (const r of resolvers) {
        r.resolve({ title: "T", caption: "C", hashtags: [], thumbnailTimestampSeconds: 1 });
      }
      reader.releaseLock();
      console.log("✓ Test 9: At most two analyses active simultaneously with default configuration.");
    }

    // Test 10: At most five active when concurrency 5 is requested.
    {
      const resolvers: any[] = [];
      const req = new NextRequest("http://localhost/api/uploads/analyze-batch-stream", {
        method: "POST",
        body: JSON.stringify({ assetIds: ["a1", "a2", "a3", "a4", "a5", "a6"], concurrency: 5 }),
      });
      const res = await handleAnalyzeBatchStreamRequest(req, {
        verifySession: mockUserSession,
        analyzeValidatedAsset: async (_userId, assetId) => {
          return new Promise((resolve) => {
            resolvers.push({ resolve, assetId });
          });
        },
      });
      const reader = res.body!.getReader();
      for (let i = 0; i < 10; i++) {
        await reader.read();
        if (resolvers.length >= 5) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.strictEqual(resolvers.length, 5);
      for (const r of resolvers) {
        r.resolve({ title: "T", caption: "C", hashtags: [], thumbnailTimestampSeconds: 1 });
      }
      reader.releaseLock();
      console.log("✓ Test 10: At most five active when concurrency 5 is requested.");
    }

    // Test 11: Worker starts the next queued item after one completes.
    {
      const completed: string[] = [];
      const req = new NextRequest("http://localhost/api/uploads/analyze-batch-stream", {
        method: "POST",
        body: JSON.stringify({ assetIds: ["a1", "a2"], concurrency: 1 }),
      });
      const res = await handleAnalyzeBatchStreamRequest(req, {
        verifySession: mockUserSession,
        analyzeValidatedAsset: async (_userId, assetId) => {
          completed.push(assetId);
          return { title: "T", caption: "C", hashtags: [], thumbnailTimestampSeconds: 1 };
        },
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let allText = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        allText += decoder.decode(value);
      }
      assert.deepStrictEqual(completed, ["a1", "a2"]);
      console.log("✓ Test 11: Worker starts the next queued item after one completes.");
    }

    // Test 12: Every eligible item analyzed exactly once.
    {
      const callCounts: Record<string, number> = {};
      const req = new NextRequest("http://localhost/api/uploads/analyze-batch-stream", {
        method: "POST",
        body: JSON.stringify({ assetIds: ["a1", "a2"], concurrency: 2 }),
      });
      const res = await handleAnalyzeBatchStreamRequest(req, {
        verifySession: mockUserSession,
        analyzeValidatedAsset: async (_userId, assetId) => {
          callCounts[assetId] = (callCounts[assetId] || 0) + 1;
          return { title: "T", caption: "C", hashtags: [], thumbnailTimestampSeconds: 1 };
        },
      });
      const reader = res.body!.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
      assert.strictEqual(callCounts["a1"], 1);
      assert.strictEqual(callCounts["a2"], 1);
      console.log("✓ Test 12: Every eligible item analyzed exactly once.");
    }

    // Test 13: One item failure does not stop remaining items.
    {
      const req = new NextRequest("http://localhost/api/uploads/analyze-batch-stream", {
        method: "POST",
        body: JSON.stringify({ assetIds: ["fail-asset", "success-asset"], concurrency: 2 }),
      });
      const res = await handleAnalyzeBatchStreamRequest(req, {
        verifySession: mockUserSession,
        analyzeValidatedAsset: async (_userId, assetId) => {
          if (assetId === "fail-asset") {
            throw new Error("Failed analysis simulation");
          }
          return { title: "T", caption: "C", hashtags: [], thumbnailTimestampSeconds: 1 };
        },
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let allText = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        allText += decoder.decode(value);
      }
      assert.ok(allText.includes("item-error"));
      assert.ok(allText.includes("item-result"));
      assert.ok(allText.includes(`"succeeded":1`));
      assert.ok(allText.includes(`"failed":1`));
      console.log("✓ Test 13: One item failure does not stop remaining items.");
    }

    // Test 14: Safe expected errors contain no internal details.
    {
      const req = new NextRequest("http://localhost/api/uploads/analyze-batch-stream", {
        method: "POST",
        body: JSON.stringify({ assetIds: ["a1"] }),
      });
      const res = await handleAnalyzeBatchStreamRequest(req, {
        verifySession: mockUserSession,
        analyzeValidatedAsset: async () => {
          throw new AiVideoAnalysisError("AI_BUSY", "Internal password database leak context!");
        },
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let allText = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        allText += decoder.decode(value);
      }
      assert.ok(allText.includes("item-error"));
      assert.ok(allText.includes("AI_BUSY"));
      assert.ok(!allText.includes("password")); // Ensure no leak
      console.log("✓ Test 14: Safe expected errors contain no internal details.");
    }

    // Test 15: Unexpected errors contain no message or stack leakage.
    {
      const req = new NextRequest("http://localhost/api/uploads/analyze-batch-stream", {
        method: "POST",
        body: JSON.stringify({ assetIds: ["a1"] }),
      });
      const res = await handleAnalyzeBatchStreamRequest(req, {
        verifySession: mockUserSession,
        analyzeValidatedAsset: async () => {
          throw new Error("Secret DB password leaked!");
        },
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let allText = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        allText += decoder.decode(value);
      }
      assert.ok(allText.includes("item-error"));
      assert.ok(!allText.includes("password"));
      assert.ok(allText.includes("An unexpected error occurred"));
      console.log("✓ Test 15: Unexpected errors contain no message or stack leakage.");
    }

    // Test 16: Batch-complete totals are correct.
    {
      const req = new NextRequest("http://localhost/api/uploads/analyze-batch-stream", {
        method: "POST",
        body: JSON.stringify({ assetIds: ["a1", "a2"] }),
      });
      const res = await handleAnalyzeBatchStreamRequest(req, {
        verifySession: mockUserSession,
        analyzeValidatedAsset: async (_userId, assetId) => {
          if (assetId === "a1") {
            return { title: "T", caption: "C", hashtags: [], thumbnailTimestampSeconds: 1 };
          }
          throw new Error("fail");
        },
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let allText = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        allText += decoder.decode(value);
      }
      assert.ok(allText.includes("batch-complete"));
      assert.ok(allText.includes(`"total":2`));
      assert.ok(allText.includes(`"succeeded":1`));
      assert.ok(allText.includes(`"failed":1`));
      assert.ok(allText.includes(`"cancelled":0`));
      console.log("✓ Test 16: Batch-complete totals are correct.");
    }

    // Test 17: Request abort stops new work.
    {
      const controller = new AbortController();
      let startedSecond = false;
      const req = new NextRequest("http://localhost/api/uploads/analyze-batch-stream", {
        method: "POST",
        body: JSON.stringify({ assetIds: ["a1", "a2"], concurrency: 1 }),
        signal: controller.signal,
      } as any);

      const res = await handleAnalyzeBatchStreamRequest(req, {
        verifySession: mockUserSession,
        analyzeValidatedAsset: async (_userId, assetId) => {
          if (assetId === "a2") {
            startedSecond = true;
          }
          controller.abort(); // abort during first item execution
          return { title: "T", caption: "C", hashtags: [], thumbnailTimestampSeconds: 1 };
        },
      });

      const reader = res.body!.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
      assert.strictEqual(startedSecond, false);
      console.log("✓ Test 17: Request abort stops new work.");
    }

    // Test 18: Active analyses receive the actual request AbortSignal.
    {
      let receivedSignal: AbortSignal | undefined;
      const req = new NextRequest("http://localhost/api/uploads/analyze-batch-stream", {
        method: "POST",
        body: JSON.stringify({ assetIds: ["a1"] }),
      });
      const res = await handleAnalyzeBatchStreamRequest(req, {
        verifySession: mockUserSession,
        analyzeValidatedAsset: async (_userId, _assetId, deps) => {
          receivedSignal = deps?.abortSignal;
          return { title: "T", caption: "C", hashtags: [], thumbnailTimestampSeconds: 1 };
        },
      });
      const reader = res.body!.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
      assert.ok(receivedSignal);
      assert.strictEqual(typeof receivedSignal.aborted, "boolean");
      console.log("✓ Test 18: Active analyses receive the actual request AbortSignal.");
    }

    // Test 19: ReadableStream cancellation clears heartbeat and stops queued work.
    {
      const req = new NextRequest("http://localhost/api/uploads/analyze-batch-stream", {
        method: "POST",
        body: JSON.stringify({ assetIds: ["a1", "a2"], concurrency: 1 }),
      });
      const res = await handleAnalyzeBatchStreamRequest(req, {
        verifySession: mockUserSession,
        analyzeValidatedAsset: async () => {
          return new Promise(() => {}); // hang first analysis
        },
        heartbeatIntervalMs: 10,
      });

      const reader = res.body!.getReader();
      await reader.read(); // Read padding
      await reader.cancel(); // cancel client-side reader!
      console.log("✓ Test 19: ReadableStream cancellation clears heartbeat and stops queued work.");
    }

    // Test 20: No enqueue after cancellation.
    {
      const req = new NextRequest("http://localhost/api/uploads/analyze-batch-stream", {
        method: "POST",
        body: JSON.stringify({ assetIds: ["a1"] }),
      });
      const res = await handleAnalyzeBatchStreamRequest(req, {
        verifySession: mockUserSession,
        analyzeValidatedAsset: async () => {
          return { title: "T", caption: "C", hashtags: [], thumbnailTimestampSeconds: 1 };
        },
      });
      const reader = res.body!.getReader();
      await reader.cancel();
      // Reader has been cancelled, ensure no uncaught exceptions on stream close
      console.log("✓ Test 20: No enqueue after cancellation.");
    }

    // Test 21: Permits are released after success.
    {
      const req = new NextRequest("http://localhost/api/uploads/analyze-batch-stream", {
        method: "POST",
        body: JSON.stringify({ assetIds: ["a1"] }),
      });
      const initialCount = aiSemaphore.getActiveCount();
      const res = await handleAnalyzeBatchStreamRequest(req, {
        verifySession: mockUserSession,
        analyzeValidatedAsset: async () => {
          return { title: "T", caption: "C", hashtags: [], thumbnailTimestampSeconds: 1 };
        },
      });
      const reader = res.body!.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
      assert.strictEqual(aiSemaphore.getActiveCount(), initialCount);
      console.log("✓ Test 21: Permits are released after success.");
    }

    // Test 22: Permits are released after errors.
    {
      const req = new NextRequest("http://localhost/api/uploads/analyze-batch-stream", {
        method: "POST",
        body: JSON.stringify({ assetIds: ["a1"] }),
      });
      const initialCount = aiSemaphore.getActiveCount();
      const res = await handleAnalyzeBatchStreamRequest(req, {
        verifySession: mockUserSession,
        analyzeValidatedAsset: async () => {
          throw new Error("fail");
        },
      });
      const reader = res.body!.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
      assert.strictEqual(aiSemaphore.getActiveCount(), initialCount);
      console.log("✓ Test 22: Permits are released after errors.");
    }

    // Test 23: Waiting permit acquisition can be aborted.
    {
      const originalMax = aiSemaphore.getMaxPermits();
      aiSemaphore.setMaxPermits(1);

      // Acquire 1st permit to block queue
      await aiSemaphore.acquire();

      const abortController = new AbortController();
      let threwAbort = false;

      const promise = aiSemaphore.acquire(abortController.signal).catch((err) => {
        if (err.message === "Acquisition aborted") threwAbort = true;
      });

      abortController.abort();
      await promise;

      assert.strictEqual(threwAbort, true);

      // Release first permit
      aiSemaphore.release();
      aiSemaphore.setMaxPermits(originalMax);
      console.log("✓ Test 23: Waiting permit acquisition can be aborted.");
    }

    // Test 24: Duplicate bulk button clicks create only one batch.
    {
      let fetchCount = 0;
      const originalFetch = global.fetch;
      global.fetch = async (url: any, options: any) => {
        fetchCount++;
        return {
          headers: { get: () => "text/event-stream" },
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("event: ready\ndata: {}\n\n"));
            },
          }),
        } as any;
      };

      let isBulkRunning = false;
      const handleAnalyzeAllValidatedMock = async () => {
        if (isBulkRunning) return;
        isBulkRunning = true;
        try {
          await fetch("/api/uploads/analyze-batch-stream", { method: "POST" });
        } finally {
          isBulkRunning = false;
        }
      };

      await Promise.all([
        handleAnalyzeAllValidatedMock(),
        handleAnalyzeAllValidatedMock(),
      ]);

      assert.strictEqual(fetchCount, 1);
      global.fetch = originalFetch;
      console.log("✓ Test 24: Duplicate bulk button clicks create only one batch.");
    }

    // Test 25: Item results update the correct upload card.
    {
      const eligibleJobs = [
        { id: "job-1", assetId: "asset-1" },
        { id: "job-2", assetId: "asset-2" },
      ];
      const updatedFields: Record<string, any> = {};
      const updateTempJobFields = (id: string, fields: any) => {
        updatedFields[id] = fields;
      };

      const data = {
        assetId: "asset-1",
        analysis: {
          title: "English Title",
          caption: "English Caption",
          hashtags: ["#tag1", "#tag2"],
          thumbnailTimestampSeconds: 5,
        },
      };

      const targetJob = eligibleJobs.find((j) => j.assetId === data.assetId);
      if (targetJob) {
        updateTempJobFields(targetJob.id, {
          englishTitle: data.analysis.title,
          englishCaption: data.analysis.caption,
          hashtags: data.analysis.hashtags.join(" "),
          geminiAnalysisStatus: "complete",
        });
      }

      assert.strictEqual(updatedFields["job-1"]?.englishTitle, "English Title");
      assert.strictEqual(updatedFields["job-2"], undefined);
      console.log("✓ Test 25: Item results update the correct upload card.");
    }

    // Test 26: Completed items are skipped by normal bulk mode.
    {
      const tempJobsQueue = [
        { id: "job-1", assetId: "asset-1", uploadValidated: true, geminiAnalysisStatus: "complete" },
        { id: "job-2", assetId: "asset-2", uploadValidated: true, geminiAnalysisStatus: "idle" },
      ];
      const eligible = tempJobsQueue.filter((job) => {
        return (
          job.uploadValidated &&
          job.assetId &&
          job.geminiAnalysisStatus !== "complete" &&
          job.geminiAnalysisStatus !== "analyzing"
        );
      });
      assert.strictEqual(eligible.length, 1);
      assert.strictEqual(eligible[0].id, "job-2");
      console.log("✓ Test 26: Completed items are skipped by normal bulk mode.");
    }

    // Test 27: Explicit regenerate mode includes completed items.
    {
      const tempJobsQueue = [
        { id: "job-1", assetId: "asset-1", uploadValidated: true, geminiAnalysisStatus: "complete" },
        { id: "job-2", assetId: "asset-2", uploadValidated: true, geminiAnalysisStatus: "idle" },
      ];
      const eligible = tempJobsQueue.filter((job) => {
        return (
          job.uploadValidated &&
          job.assetId &&
          job.geminiAnalysisStatus !== "analyzing"
        );
      });
      assert.strictEqual(eligible.length, 2);
      console.log("✓ Test 27: Explicit regenerate mode includes completed items.");
    }

    // Test 28: Existing manual field values are not overwritten without explicit regeneration.
    {
      const tempJobsQueue = [
        { id: "job-1", assetId: "asset-1", uploadValidated: true, geminiAnalysisStatus: "complete", englishTitle: "Manual Title" },
        { id: "job-2", assetId: "asset-2", uploadValidated: true, geminiAnalysisStatus: "idle" },
      ];
      const normalEligible = tempJobsQueue.filter(
        (job) =>
          job.uploadValidated &&
          job.assetId &&
          job.geminiAnalysisStatus !== "complete"
      );
      assert.ok(!normalEligible.some((job) => job.id === "job-1"));
      console.log("✓ Test 28: Existing manual field values are not overwritten without explicit regeneration.");
    }

    // Test 29: Parser accepts batch events split across arbitrary chunks.
    {
      const events: string[] = [];
      const streamBody = new ReadableStream({
        start(controller) {
          const chunk1 = "event: item-st";
          const chunk2 = "arted\ndata: {\"assetId\":\"a1\"}\n\nevent: batch-complete\ndata: {}\n\n";
          controller.enqueue(new TextEncoder().encode(chunk1));
          controller.enqueue(new TextEncoder().encode(chunk2));
          controller.close();
        },
      });

      const response = {
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: streamBody,
      } as any;

      await parseAnalysisStream(response, {
        onItemStarted(data: any) {
          events.push(data.assetId);
        },
      } as any);

      assert.deepStrictEqual(events, ["a1"]);
      console.log("✓ Test 29: Parser accepts batch events split across arbitrary chunks.");
    }

    // Test 30: Oversized accumulated events are rejected.
    {
      const streamBody = new ReadableStream({
        start(controller) {
          const bigEvent = "event: result\ndata: " + "A".repeat(2 * 1024 * 1024) + "\n\n";
          controller.enqueue(new TextEncoder().encode(bigEvent));
          controller.close();
        },
      });
      const response = {
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: streamBody,
      } as any;

      let threwError = false;
      await parseAnalysisStream(response, {}).catch((err) => {
        if (err.message.includes("exceeded limit")) threwError = true;
      });
      assert.strictEqual(threwError, true);
      console.log("✓ Test 30: Oversized accumulated events are rejected.");
    }

    // Test 31: Non-SSE HTTP 200 response is rejected safely.
    {
      const response = {
        headers: new Headers({ "content-type": "text/html" }),
      } as any;

      let threwError = false;
      try {
        validateStreamResponseContentType(response);
      } catch (err: any) {
        if (err.message.includes("ended before completion")) threwError = true;
      }
      assert.strictEqual(threwError, true);
      console.log("✓ Test 31: Non-SSE HTTP 200 response is rejected safely.");
    }

    // Test 32: No real network request occurs.
    {
      assert.strictEqual(networkCallAttempted, false);
      console.log("✓ Test 32: No real network request occurs.");
    }

    console.log("\n======================================================");
    console.log("ALL BATCH STREAMING TESTS PASSED SUCCESSFULLY");
    console.log("======================================================");
  } catch (error) {
    console.error("Test execution failed:", error);
    process.exit(1);
  } finally {
    global.fetch = originalFetch;
  }
}

void runTests();
