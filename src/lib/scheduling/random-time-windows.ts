export interface RandomTimeWindow {
  id: string;
  startTime: string;
  endTime: string;
}

export interface RandomScheduleJob {
  id: string;
  fileName: string;
  scheduledTimeKolkata?: string;
  scheduledTimeUTC?: string;
}

export interface RandomSchedulePreviewItem {
  jobId: string;
  fileName: string;
  scheduledTimeKolkata: string;
  scheduledTimeUTC: string;
  windowId: string;
  windowLabel: string;
  dayOffset: number;
}

export interface RandomSchedulePreview {
  items: RandomSchedulePreviewItem[];
  errors: string[];
  protectedCount: number;
  eligibleCount: number;
  daysUsed: number;
  sourceSignature: string;
  overwriteExisting: boolean;
}

export interface BuildRandomSchedulePreviewInput {
  jobs: RandomScheduleJob[];
  startDate: string;
  windows: RandomTimeWindow[];
  postsPerWindow: number;
  minimumGapMinutes: number;
  overwriteExisting: boolean;
  now?: Date;
  randomInteger?: (maxExclusive: number) => number;
}

const KOLKATA_OFFSET_MINUTES = 330;
const MAX_WINDOWS = 24;
const MAX_POSTS_PER_WINDOW = 20;
const MAX_MINIMUM_GAP_MINUTES = 720;
const MAX_GENERATED_DAYS = 10000;

function parseTimeToMinutes(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function isValidDateString(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function addDays(dateString: string, days: number): string {
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));

  return [
    String(date.getUTCFullYear()).padStart(4, "0"),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function formatTimeFromMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(remainingMinutes).padStart(2, "0")}`;
}

function getKolkataDateParts(now: Date): { date: string; minuteOfDay: number } {
  const kolkata = new Date(now.getTime() + KOLKATA_OFFSET_MINUTES * 60 * 1000);
  const date = [
    String(kolkata.getUTCFullYear()).padStart(4, "0"),
    String(kolkata.getUTCMonth() + 1).padStart(2, "0"),
    String(kolkata.getUTCDate()).padStart(2, "0"),
  ].join("-");

  return {
    date,
    minuteOfDay: kolkata.getUTCHours() * 60 + kolkata.getUTCMinutes(),
  };
}

function defaultRandomInteger(maxExclusive: number): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) return 0;

  const webCrypto = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (webCrypto?.getRandomValues) {
    const maximumUint32 = 0x100000000;
    const rejectionLimit = Math.floor(maximumUint32 / maxExclusive) * maxExclusive;
    const values = new Uint32Array(1);

    do {
      webCrypto.getRandomValues(values);
    } while (values[0] >= rejectionLimit);

    return values[0] % maxExclusive;
  }

  return Math.floor(Math.random() * maxExclusive);
}

function getRandomInteger(
  maxExclusive: number,
  randomInteger: (maxExclusive: number) => number,
): number {
  const value = randomInteger(maxExclusive);
  if (!Number.isInteger(value) || value < 0 || value >= maxExclusive) {
    throw new Error("Random number source returned an out-of-range value.");
  }
  return value;
}

function generateBalancedMinutes(
  startMinute: number,
  endMinute: number,
  count: number,
  minimumGapMinutes: number,
  randomInteger: (maxExclusive: number) => number,
): number[] {
  if (count === 1) {
    return [
      startMinute + getRandomInteger(endMinute - startMinute + 1, randomInteger),
    ];
  }

  const requiredSpan = minimumGapMinutes * (count - 1);
  const availableSpan = endMinute - startMinute;
  if (requiredSpan > availableSpan) return [];

  const slack = availableSpan - requiredSpan;
  const offsets = Array.from(
    { length: count },
    () => getRandomInteger(slack + 1, randomInteger),
  ).sort((left, right) => left - right);

  return offsets.map(
    (offset, index) => startMinute + index * minimumGapMinutes + offset,
  );
}

function convertKolkataLocalToUTC(localDateTime: string): string {
  return new Date(`${localDateTime}:00+05:30`).toISOString();
}

export function getCurrentKolkataDateString(now: Date = new Date()): string {
  return getKolkataDateParts(now).date;
}

export function buildRandomScheduleQueueSignature(
  jobs: RandomScheduleJob[],
): string {
  return jobs
    .map((job) =>
      [job.id, job.scheduledTimeKolkata || "", job.scheduledTimeUTC || ""].join(
        "\u001f",
      ),
    )
    .join("\u001e");
}

export function buildRandomSchedulePreview(
  input: BuildRandomSchedulePreviewInput,
): RandomSchedulePreview {
  const errors: string[] = [];
  const sourceSignature = buildRandomScheduleQueueSignature(input.jobs);
  const postsPerWindow = Number(input.postsPerWindow);
  const minimumGapMinutes = Number(input.minimumGapMinutes);

  if (input.jobs.length === 0) {
    errors.push("No upload cards are available to schedule.");
  }
  if (!isValidDateString(input.startDate)) {
    errors.push("Choose a valid schedule start date.");
  }
  if (
    !Number.isInteger(postsPerWindow) ||
    postsPerWindow < 1 ||
    postsPerWindow > MAX_POSTS_PER_WINDOW
  ) {
    errors.push(`Videos per window must be between 1 and ${MAX_POSTS_PER_WINDOW}.`);
  }
  if (
    !Number.isInteger(minimumGapMinutes) ||
    minimumGapMinutes < 1 ||
    minimumGapMinutes > MAX_MINIMUM_GAP_MINUTES
  ) {
    errors.push(
      `Minimum gap must be between 1 and ${MAX_MINIMUM_GAP_MINUTES} minutes.`,
    );
  }
  if (input.windows.length < 1 || input.windows.length > MAX_WINDOWS) {
    errors.push(`Add between 1 and ${MAX_WINDOWS} random time windows.`);
  }

  const normalizedWindows = input.windows
    .map((window, index) => {
      const startMinute = parseTimeToMinutes(window.startTime);
      const endMinute = parseTimeToMinutes(window.endTime);

      if (startMinute === null || endMinute === null) {
        errors.push(`Window ${index + 1} must use 24-hour HH:MM times.`);
        return null;
      }
      if (startMinute >= endMinute) {
        errors.push(
          `Window ${index + 1} must end after it starts. Overnight windows are not supported.`,
        );
        return null;
      }
      if (
        Number.isInteger(postsPerWindow) &&
        Number.isInteger(minimumGapMinutes) &&
        postsPerWindow > 0 &&
        minimumGapMinutes > 0 &&
        minimumGapMinutes * (postsPerWindow - 1) > endMinute - startMinute
      ) {
        errors.push(
          `Window ${index + 1} is too short for ${postsPerWindow} videos with a ${minimumGapMinutes}-minute minimum gap.`,
        );
      }

      return { ...window, startMinute, endMinute, originalIndex: index };
    })
    .filter(
      (
        window,
      ): window is RandomTimeWindow & {
        startMinute: number;
        endMinute: number;
        originalIndex: number;
      } => window !== null,
    )
    .sort((left, right) => left.startMinute - right.startMinute);

  for (let index = 1; index < normalizedWindows.length; index++) {
    const previous = normalizedWindows[index - 1];
    const current = normalizedWindows[index];
    if (current.startMinute <= previous.endMinute) {
      errors.push(
        `Time windows ${previous.originalIndex + 1} and ${current.originalIndex + 1} overlap.`,
      );
    }
  }

  const eligibleJobs = input.jobs.filter(
    (job) => input.overwriteExisting || !job.scheduledTimeKolkata,
  );
  const protectedCount = input.jobs.length - eligibleJobs.length;

  if (input.jobs.length > 0 && eligibleJobs.length === 0) {
    errors.push(
      "Every upload card already has a publishing time. Enable overwrite to replace existing schedules.",
    );
  }

  if (errors.length > 0) {
    return {
      items: [],
      errors,
      protectedCount,
      eligibleCount: eligibleJobs.length,
      daysUsed: 0,
      sourceSignature,
      overwriteExisting: input.overwriteExisting,
    };
  }

  const now = input.now || new Date();
  const kolkataNow = getKolkataDateParts(now);
  const effectiveStartDate =
    input.startDate < kolkataNow.date ? kolkataNow.date : input.startDate;
  const randomInteger = input.randomInteger || defaultRandomInteger;

  const items: RandomSchedulePreviewItem[] = [];
  let jobIndex = 0;
  let dayOffset = 0;

  while (jobIndex < eligibleJobs.length && dayOffset < MAX_GENERATED_DAYS) {
    const targetDate = addDays(effectiveStartDate, dayOffset);

    for (const window of normalizedWindows) {
      if (jobIndex >= eligibleJobs.length) break;

      const effectiveWindowStart =
        targetDate === kolkataNow.date
          ? Math.max(window.startMinute, kolkataNow.minuteOfDay + 1)
          : window.startMinute;

      if (effectiveWindowStart > window.endMinute) continue;

      const remainingJobs = eligibleJobs.length - jobIndex;
      const targetCount = Math.min(postsPerWindow, remainingJobs);
      if (
        minimumGapMinutes * (targetCount - 1) >
        window.endMinute - effectiveWindowStart
      ) {
        continue;
      }

      const generatedMinutes = generateBalancedMinutes(
        effectiveWindowStart,
        window.endMinute,
        targetCount,
        minimumGapMinutes,
        randomInteger,
      );

      for (const minute of generatedMinutes) {
        const job = eligibleJobs[jobIndex];
        if (!job) break;

        const localDateTime = `${targetDate}T${formatTimeFromMinutes(minute)}`;
        items.push({
          jobId: job.id,
          fileName: job.fileName,
          scheduledTimeKolkata: localDateTime,
          scheduledTimeUTC: convertKolkataLocalToUTC(localDateTime),
          windowId: window.id,
          windowLabel: `${window.startTime}–${window.endTime}`,
          dayOffset,
        });
        jobIndex++;
      }
    }

    dayOffset++;
  }

  if (jobIndex < eligibleJobs.length) {
    errors.push(
      "The schedule could not be generated within the supported date range.",
    );
  }

  return {
    items: errors.length === 0 ? items : [],
    errors,
    protectedCount,
    eligibleCount: eligibleJobs.length,
    daysUsed: items.length > 0 ? items[items.length - 1].dayOffset + 1 : 0,
    sourceSignature,
    overwriteExisting: input.overwriteExisting,
  };
}
