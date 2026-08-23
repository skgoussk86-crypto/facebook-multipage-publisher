import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  buildMultiPageRandomizationPlan,
  buildMultiPageRandomizationSignature,
  type MultiPageMediaSlot,
} from "../src/lib/scheduling/multi-page-randomization";

function makeMedia(count: number): MultiPageMediaSlot[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `media-${index + 1}`,
    fileName: `media-${String(index + 1).padStart(3, "0")}.mp4`,
    scheduledTimeKolkata: `2026-09-${String(Math.floor(index / 24) + 1).padStart(2, "0")}T${String(index % 24).padStart(2, "0")}:00`,
    scheduledTimeUTC: new Date(
      Date.UTC(2026, 7, 31 + Math.floor(index / 24), index % 24, 30),
    ).toISOString(),
  }));
}

function makeSeededRandom(seed: number) {
  let state = seed >>> 0;
  return (maxExclusive: number) => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state % maxExclusive;
  };
}

console.log("Running Phase 7G multi-page randomization tests...");

const media = makeMedia(500);
const pageIds = ["page-1", "page-2", "page-3"];
const plan = buildMultiPageRandomizationPlan({
  media,
  pageIds,
  randomInteger: makeSeededRandom(71),
});

assert.deepEqual(plan.errors, []);
assert.equal(plan.mediaCount, 500);
assert.equal(plan.pageCount, 3);
assert.equal(plan.totalJobs, 1500);
assert.equal(plan.assignments.length, 1500);

for (let roundIndex = 0; roundIndex < media.length; roundIndex++) {
  const round = plan.assignments.filter(
    (assignment) => assignment.roundIndex === roundIndex,
  );
  assert.equal(round.length, pageIds.length);
  assert.equal(
    new Set(round.map((assignment) => assignment.mediaId)).size,
    pageIds.length,
  );
  assert.equal(
    new Set(round.map((assignment) => assignment.scheduledTimeUTC)).size,
    1,
  );
}
console.log("PASS distinct media on every page in each publishing round");

for (const pageId of pageIds) {
  const pageAssignments = plan.assignments.filter(
    (assignment) => assignment.pageId === pageId,
  );
  assert.equal(pageAssignments.length, media.length);
  assert.equal(
    new Set(pageAssignments.map((assignment) => assignment.mediaId)).size,
    media.length,
  );
}
console.log("PASS every selected page receives the complete media set exactly once");

const repeatPlan = buildMultiPageRandomizationPlan({
  media,
  pageIds,
  randomInteger: makeSeededRandom(71),
});
assert.deepEqual(repeatPlan.assignments, plan.assignments);
console.log("PASS generated preview remains stable when the random source is fixed");

const tooManyPages = buildMultiPageRandomizationPlan({
  media: makeMedia(2),
  pageIds: ["page-1", "page-2", "page-3"],
  randomInteger: makeSeededRandom(1),
});
assert.ok(tooManyPages.errors.some((error) => error.includes("no more than 2 pages")));
assert.equal(tooManyPages.assignments.length, 0);
console.log("PASS impossible collision-free page count is rejected");

const duplicateTimes = makeMedia(3);
duplicateTimes[1].scheduledTimeKolkata = duplicateTimes[0].scheduledTimeKolkata;
duplicateTimes[1].scheduledTimeUTC = duplicateTimes[0].scheduledTimeUTC;
const duplicateTimePlan = buildMultiPageRandomizationPlan({
  media: duplicateTimes,
  pageIds: ["page-1", "page-2"],
  randomInteger: makeSeededRandom(1),
});
assert.ok(
  duplicateTimePlan.errors.some((error) =>
    error.includes("different publishing time"),
  ),
);
console.log("PASS duplicate time slots are rejected before scheduling");

const signatureBefore = buildMultiPageRandomizationSignature(
  makeMedia(2),
  ["page-1", "page-2"],
);
const changedMedia = makeMedia(2);
changedMedia[1].scheduledTimeUTC = "2026-10-01T00:00:00.000Z";
const signatureAfter = buildMultiPageRandomizationSignature(
  changedMedia,
  ["page-1", "page-2"],
);
assert.notEqual(signatureBefore, signatureAfter);
console.log("PASS stale multi-page preview signature detection");

const repoRoot = process.cwd();
const dashboardSource = fs.readFileSync(
  path.join(repoRoot, "src/app/DashboardClient.tsx"),
  "utf8",
);
const jobsRouteSource = fs.readFileSync(
  path.join(repoRoot, "src/app/api/facebook/jobs/route.ts"),
  "utf8",
);
const packageJson = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
) as { scripts?: Record<string, string> };

for (const requiredBoundary of [
  "Multi-page Randomized Publishing",
  "Select All Pages",
  "Different media on every page per publishing round",
  "buildMultiPageRandomizationPlan",
  "buildMultiPageRandomizationSignature",
]) {
  assert.ok(
    dashboardSource.includes(requiredBoundary),
    `Dashboard is missing required Phase 7G boundary: ${requiredBoundary}`,
  );
}
assert.equal(
  packageJson.scripts?.["test:phase7g-multi-page-randomization"],
  "node --conditions=react-server --import tsx scripts/run-phase7g-multi-page-randomization-tests.ts",
);
assert.ok(dashboardSource.includes("atomic: Boolean(multiPagePlan)"));
assert.ok(jobsRouteSource.includes("Atomic batch validation failed"));
assert.ok(jobsRouteSource.includes("uploadAssetCache"));
assert.ok(jobsRouteSource.includes("thumbnailAssetCache"));
console.log("PASS dashboard wiring and package regression boundary");

console.log("All Phase 7G multi-page randomization tests passed.");
