import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  containsUnsafeControlCharacters,
  countUnicodeCharacters,
  isMetadataTextSafe,
  isSingleLineMetadataText,
  validateJobInput,
} from "../src/lib/validation";

const projectRoot = process.cwd();

function validJob(overrides: Record<string, unknown> = {}) {
  return {
    englishTitle: "Unicode title",
    englishCaption: "Unicode caption",
    hashtags: "#video #facebook",
    scheduledTimeUTC: "2099-01-01T00:00:00.000Z",
    pageId: "123e4567-e89b-12d3-a456-426614174000",
    ...overrides,
  };
}

function runUnicodeHelperTests(): void {
  assert.equal(countUnicodeCharacters("😀"), 1);
  assert.equal(countUnicodeCharacters("नमस्ते"), Array.from("नमस्ते").length);
  assert.equal(countUnicodeCharacters("a😀ب"), 3);

  assert.equal(isSingleLineMetadataText("Hello 🌍"), true);
  assert.equal(isSingleLineMetadataText("Hello\nWorld"), false);
  assert.equal(isSingleLineMetadataText("Hello\u2028World"), false);

  assert.equal(containsUnsafeControlCharacters("مرحبا ❤️"), false);
  assert.equal(containsUnsafeControlCharacters("नमस्ते 🔥"), false);
  assert.equal(containsUnsafeControlCharacters("safe\ncaption\ttext"), false);
  assert.equal(containsUnsafeControlCharacters("bad\u0000text"), true);
  assert.equal(containsUnsafeControlCharacters("bad\u009Ftext"), true);

  assert.equal(isMetadataTextSafe("日本語のタイトル ✨"), true);
  assert.equal(isMetadataTextSafe("unsafe\u0007"), false);
}

function runServerValidationTests(): void {
  const acceptedSamples = [
    validJob({
      englishTitle: "एक शानदार वीडियो 🔥",
      englishCaption: "यह कैप्शन हिन्दी में है।\nनई पंक्ति भी स्वीकार है ❤️",
    }),
    validJob({
      englishTitle: "عنوان رائع ✨",
      englishCaption: "هذا وصف باللغة العربية مع الرموز © ™ →",
    }),
    validJob({
      englishTitle: "ایک خوبصورت ویڈیو 🎉",
      englishCaption: "اردو کیپشن اور ایموجی 😂",
    }),
    validJob({
      englishTitle: "日本語タイトル 🌸",
      englishCaption: "日本語のキャプションです。",
    }),
    validJob({
      englishTitle: "Español — ¡Qué increíble! ❤️",
      englishCaption: "Símbolos: © ® ™ • → ✓",
    }),
  ];

  for (const sample of acceptedSamples) {
    assert.deepEqual(validateJobInput(sample as never), []);
  }

  assert.deepEqual(
    validateJobInput(
      validJob({
        englishTitle: "😀".repeat(255),
      }) as never,
    ),
    [],
  );

  assert.match(
    validateJobInput(
      validJob({
        englishTitle: "😀".repeat(256),
      }) as never,
    ).join(" "),
    /255 Unicode-character limit|255 Unicode characters/,
  );

  assert.match(
    validateJobInput(
      validJob({
        englishTitle: "Line one\nLine two",
      }) as never,
    ).join(" "),
    /single line/,
  );

  assert.match(
    validateJobInput(
      validJob({
        englishCaption: "Unsafe\u0000caption",
      }) as never,
    ).join(" "),
    /unsupported control characters/,
  );

  assert.match(
    validateJobInput(
      validJob({
        hashtags: "#safe\u0007",
      }) as never,
    ).join(" "),
    /unsupported control characters/,
  );
}

function runDashboardBoundaryTests(): void {
  const dashboard = readFileSync(
    join(projectRoot, "src/app/DashboardClient.tsx"),
    "utf8",
  );

  assert.doesNotMatch(dashboard, /const isEnglishOnly/);
  assert.doesNotMatch(dashboard, /English \(Fixed\)/);
  assert.doesNotMatch(dashboard, /Title must be in English characters/);
  assert.doesNotMatch(dashboard, /Caption must contain English text only/);
  assert.doesNotMatch(dashboard, />English Title<\/label>/);
  assert.doesNotMatch(dashboard, />English Caption<\/label>/);
  assert.doesNotMatch(dashboard, /Configure English Caption/);

  assert.match(dashboard, /Any language \+ emoji/);
  assert.match(dashboard, /Title in any language — emojis supported/);
  assert.match(dashboard, /Caption in any language — emojis supported/);
  assert.match(dashboard, /countUnicodeCharacters\(job\.englishTitle\)/);
  assert.match(dashboard, /containsUnsafeControlCharacters\(job\.englishCaption\)/);
  assert.match(dashboard, /countUnicodeCharacters\(title\)/);
}

function runPersistenceBoundaryTests(): void {
  const schema = readFileSync(
    join(projectRoot, "prisma/schema.prisma"),
    "utf8",
  );

  const jobsRoute = readFileSync(
    join(projectRoot, "src/app/api/facebook/jobs/route.ts"),
    "utf8",
  );

  const publishingService = readFileSync(
    join(projectRoot, "src/lib/facebook/facebook-publishing-service.ts"),
    "utf8",
  );

  assert.match(schema, /englishTitle\s+String\s+@db\.VarChar\(255\)/);
  assert.match(schema, /englishCaption\s+String\s+@db\.Text/);
  assert.match(jobsRoute, /validateJobInput\(\{/);
  assert.match(publishingService, /input\.title\.trim\(\)/);
  assert.match(publishingService, /input\.caption\.trim\(\)/);
}

function runPackageBoundaryTests(): void {
  const packageJson = JSON.parse(
    readFileSync(
      join(projectRoot, "package.json"),
      "utf8",
    ),
  ) as {
    scripts?: Record<string, string>;
  };

  assert.equal(
    packageJson.scripts?.["test:phase7d-unicode-metadata"],
    "node --conditions=react-server --import tsx scripts/run-phase7d-unicode-metadata-tests.ts",
  );
}

console.log("Running Phase 7D Unicode metadata tests...");

runUnicodeHelperTests();
console.log("✓ Unicode character counting and control-character safety");

runServerValidationTests();
console.log("✓ Multilingual title, caption, emoji, and symbol validation");

runDashboardBoundaryTests();
console.log("✓ Dashboard and CSV Unicode boundaries");

runPersistenceBoundaryTests();
console.log("✓ Scheduling and publishing persistence boundaries");

runPackageBoundaryTests();
console.log("✓ Package test command boundary");

console.log("PHASE7D_UNICODE_METADATA_TESTS=PASSED");
