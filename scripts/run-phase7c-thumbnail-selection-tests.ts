import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  shouldApplyOllamaThumbnail,
} from "../src/lib/thumbnails/thumbnail-selection";

function runSelectionPolicyTests(): void {
  assert.equal(
    shouldApplyOllamaThumbnail({
      thumbnailMode: "auto",
    }),
    false,
    "Facebook Auto must remain protected from ordinary AI content generation.",
  );

  assert.equal(
    shouldApplyOllamaThumbnail({
      thumbnailMode: "custom",
    }),
    false,
    "Custom JPG must remain protected from ordinary AI content generation.",
  );

  assert.equal(
    shouldApplyOllamaThumbnail({
      thumbnailMode: "captured",
      thumbnailSource: "MANUAL_FRAME",
    }),
    false,
    "Manual Frame must remain protected from ordinary AI content generation.",
  );

  assert.equal(
    shouldApplyOllamaThumbnail({
      thumbnailMode: "captured",
      thumbnailSource: "GEMINI_FRAME",
    }),
    true,
    "Ollama-selected mode must apply the AI thumbnail.",
  );

  assert.equal(
    shouldApplyOllamaThumbnail({
      thumbnailMode: "captured",
      thumbnailSource: "MANUAL_FRAME",
      force: true,
    }),
    true,
    "An explicit Ollama Best action must be allowed to replace a previous manual frame.",
  );
}

function runSourceBoundaryTests(): void {
  const root = process.cwd();
  const dashboard = fs.readFileSync(
    path.join(root, "src/app/DashboardClient.tsx"),
    "utf8",
  );
  const ollamaClient = fs.readFileSync(
    path.join(root, "src/lib/ai/ollama/ollama-client.ts"),
    "utf8",
  );
  const envExample = fs.readFileSync(
    path.join(root, ".env.example"),
    "utf8",
  );

  assert.match(
    dashboard,
    /Ollama Best/,
    "Dashboard must expose an Ollama Best thumbnail action.",
  );
  assert.match(
    dashboard,
    /Manual Frame/,
    "Dashboard must expose a Manual Frame action.",
  );
  assert.match(
    dashboard,
    /forceThumbnailSelection:\s*true/,
    "Ollama Best must explicitly force thumbnail replacement.",
  );
  assert.match(
    dashboard,
    /job\.thumbnailSource === "MANUAL_FRAME"/,
    "Manual selections must be detected and preserved.",
  );
  assert.match(
    dashboard,
    /AI updated English content[\s\S]*preserved/,
    "AI content generation must log preserved thumbnail choices.",
  );
  assert.match(
    dashboard,
    /shouldApplyOllamaThumbnail/,
    "Single and bulk AI flows must use the shared thumbnail-selection policy.",
  );
  assert.match(
    ollamaClient,
    /Evaluate every candidate for sharpness, low motion blur, useful brightness/,
    "Ollama must receive explicit visual-quality scoring instructions.",
  );
  assert.match(
    ollamaClient,
    /Do not default to the same ordinal frame across videos/,
    "Ollama must be instructed not to reuse a fixed candidate position.",
  );
  assert.match(
    envExample,
    /^OLLAMA_FRAME_COUNT=10$/m,
    "The documented production frame sample count must be 10.",
  );
}

function main(): void {
  console.log("Running Phase 7C thumbnail selection tests...");
  runSelectionPolicyTests();
  console.log("✓ Ollama/manual selection policy");
  runSourceBoundaryTests();
  console.log("✓ Dashboard, Ollama prompt, and frame-count boundaries");
  console.log("PHASE7C_THUMBNAIL_SELECTION_TESTS=PASSED");
}

main();
