import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  buildRandomSchedulePreview,
  buildRandomScheduleQueueSignature,
  getCurrentKolkataDateString,
  type RandomScheduleJob,
  type RandomTimeWindow,
} from "../src/lib/scheduling/random-time-windows";

function makeJobs(count: number): RandomScheduleJob[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `job-${index + 1}`,
    fileName: `video-${String(index + 1).padStart(3, "0")}.mp4`,
    scheduledTimeKolkata: "",
    scheduledTimeUTC: "",
  }));
}

function makeSequenceRandom(values: number[]) {
  let index = 0;
  return (maxExclusive: number) => {
    const value = values[index % values.length] || 0;
    index++;
    return value % maxExclusive;
  };
}

const windows: RandomTimeWindow[] = [
  { id: "early", startTime: "04:00", endTime: "04:15" },
  { id: "morning", startTime: "07:00", endTime: "07:15" },
];

console.log("Running Phase 7F random time-window scheduling tests...");

assert.equal(
  getCurrentKolkataDateString(new Date("2026-07-31T20:00:00.000Z")),
  "2026-08-01",
);
console.log("PASS Kolkata calendar-date calculation");

const basic = buildRandomSchedulePreview({
  jobs: makeJobs(4),
  startDate: "2026-08-01",
  windows,
  postsPerWindow: 1,
  minimumGapMinutes: 5,
  overwriteExisting: false,
  now: new Date("2026-07-31T12:00:00.000Z"),
  randomInteger: makeSequenceRandom([7, 12, 2, 9]),
});

assert.deepEqual(basic.errors, []);
assert.deepEqual(
  basic.items.map((item) => item.scheduledTimeKolkata),
  [
    "2026-08-01T04:07",
    "2026-08-01T07:12",
    "2026-08-02T04:02",
    "2026-08-02T07:09",
  ],
);
assert.equal(basic.items[0].scheduledTimeUTC, "2026-07-31T22:37:00.000Z");
assert.equal(basic.daysUsed, 2);
console.log("PASS exact one-time random assignment inside multiple daily windows");

const largeBatch = buildRandomSchedulePreview({
  jobs: makeJobs(200),
  startDate: "2026-08-01",
  windows,
  postsPerWindow: 1,
  minimumGapMinutes: 5,
  overwriteExisting: false,
  now: new Date("2026-07-31T12:00:00.000Z"),
  randomInteger: () => 0,
});

assert.deepEqual(largeBatch.errors, []);
assert.equal(largeBatch.items.length, 200);
assert.equal(largeBatch.daysUsed, 100);
assert.equal(new Set(largeBatch.items.map((item) => item.scheduledTimeKolkata)).size, 200);
assert.equal(largeBatch.items[198].scheduledTimeKolkata, "2026-11-08T04:00");
assert.equal(largeBatch.items[199].scheduledTimeKolkata, "2026-11-08T07:00");
console.log("PASS 200-card distribution across 100 days");

const protectedJobs = makeJobs(3);
protectedJobs[0].scheduledTimeKolkata = "2026-08-20T12:00";
protectedJobs[0].scheduledTimeUTC = "2026-08-20T06:30:00.000Z";

const protectedPreview = buildRandomSchedulePreview({
  jobs: protectedJobs,
  startDate: "2026-08-01",
  windows,
  postsPerWindow: 1,
  minimumGapMinutes: 5,
  overwriteExisting: false,
  now: new Date("2026-07-31T12:00:00.000Z"),
  randomInteger: () => 0,
});

assert.deepEqual(protectedPreview.errors, []);
assert.equal(protectedPreview.protectedCount, 1);
assert.deepEqual(
  protectedPreview.items.map((item) => item.jobId),
  ["job-2", "job-3"],
);
console.log("PASS existing schedule protection");

const overwritePreview = buildRandomSchedulePreview({
  jobs: protectedJobs,
  startDate: "2026-08-01",
  windows,
  postsPerWindow: 1,
  minimumGapMinutes: 5,
  overwriteExisting: true,
  now: new Date("2026-07-31T12:00:00.000Z"),
  randomInteger: () => 0,
});

assert.deepEqual(overwritePreview.errors, []);
assert.equal(overwritePreview.protectedCount, 0);
assert.equal(overwritePreview.items.length, 3);
assert.equal(overwritePreview.items[0].jobId, "job-1");
console.log("PASS explicit overwrite mode");

const multiplePerWindow = buildRandomSchedulePreview({
  jobs: makeJobs(3),
  startDate: "2026-08-01",
  windows: [{ id: "wide", startTime: "10:00", endTime: "10:30" }],
  postsPerWindow: 3,
  minimumGapMinutes: 5,
  overwriteExisting: false,
  now: new Date("2026-07-31T12:00:00.000Z"),
  randomInteger: makeSequenceRandom([2, 8, 15]),
});

assert.deepEqual(multiplePerWindow.errors, []);
const minuteValues = multiplePerWindow.items.map((item) =>
  Number(item.scheduledTimeKolkata.slice(-2)),
);
assert.ok(minuteValues[1] - minuteValues[0] >= 5);
assert.ok(minuteValues[2] - minuteValues[1] >= 5);
console.log("PASS balanced multi-post spacing inside one window");

const overlap = buildRandomSchedulePreview({
  jobs: makeJobs(2),
  startDate: "2026-08-01",
  windows: [
    { id: "a", startTime: "04:00", endTime: "04:15" },
    { id: "b", startTime: "04:10", endTime: "04:30" },
  ],
  postsPerWindow: 1,
  minimumGapMinutes: 5,
  overwriteExisting: false,
  now: new Date("2026-07-31T12:00:00.000Z"),
  randomInteger: () => 0,
});
assert.ok(overlap.errors.some((error) => error.includes("overlap")));
console.log("PASS overlapping-window rejection");

const tooShort = buildRandomSchedulePreview({
  jobs: makeJobs(3),
  startDate: "2026-08-01",
  windows: [{ id: "short", startTime: "04:00", endTime: "04:05" }],
  postsPerWindow: 3,
  minimumGapMinutes: 5,
  overwriteExisting: false,
  now: new Date("2026-07-31T12:00:00.000Z"),
  randomInteger: () => 0,
});
assert.ok(tooShort.errors.some((error) => error.includes("too short")));
console.log("PASS impossible gap/window capacity rejection");

const expiredToday = buildRandomSchedulePreview({
  jobs: makeJobs(2),
  startDate: "2026-08-01",
  windows,
  postsPerWindow: 1,
  minimumGapMinutes: 5,
  overwriteExisting: false,
  now: new Date("2026-08-01T02:30:00.000Z"),
  randomInteger: () => 0,
});
assert.deepEqual(expiredToday.errors, []);
assert.deepEqual(
  expiredToday.items.map((item) => item.scheduledTimeKolkata),
  ["2026-08-02T04:00", "2026-08-02T07:00"],
);
console.log("PASS expired same-day windows move to the next valid day");

const signatureBefore = buildRandomScheduleQueueSignature(makeJobs(1));
const changedJob = makeJobs(1);
changedJob[0].scheduledTimeKolkata = "2026-08-01T04:07";
changedJob[0].scheduledTimeUTC = "2026-07-31T22:37:00.000Z";
const signatureAfter = buildRandomScheduleQueueSignature(changedJob);
assert.notEqual(signatureBefore, signatureAfter);
console.log("PASS stale-preview queue signature detection");

const repoRoot = process.cwd();
const dashboardSource = fs.readFileSync(
  path.join(repoRoot, "src/app/DashboardClient.tsx"),
  "utf8",
);
const queueSource = fs.readFileSync(
  path.join(repoRoot, "src/lib/uploads/upload-queue-controller.ts"),
  "utf8",
);
const packageJson = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
) as { scripts?: Record<string, string> };

for (const requiredBoundary of [
  '"random_windows"',
  "Random Time Windows",
  "Generate Exact Preview",
  "Apply Preview to Cards",
  "Undo Last Assignment",
  "buildRandomSchedulePreview",
  "buildRandomScheduleQueueSignature",
  "updateManyJobFields",
]) {
  assert.ok(
    dashboardSource.includes(requiredBoundary) ||
      queueSource.includes(requiredBoundary),
    `Missing Phase 7F boundary: ${requiredBoundary}`,
  );
}

assert.ok(
  dashboardSource.includes(
    "The preview will not change unless you regenerate it.",
  ),
);
assert.ok(
  dashboardSource.includes(
    "saved them to queue recovery",
  ),
);
assert.equal(
  packageJson.scripts?.["test:phase7f-random-time-windows"],
  "node --conditions=react-server --import tsx scripts/run-phase7f-random-time-windows-tests.ts",
);
console.log("PASS Dashboard preview/apply/undo and persistence boundaries");
console.log("PASS package test command boundary");

console.log("PHASE7F_RANDOM_TIME_WINDOWS_TESTS=PASSED");
