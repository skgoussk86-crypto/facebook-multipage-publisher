export interface MultiPageMediaSlot {
  id: string;
  fileName: string;
  scheduledTimeKolkata: string;
  scheduledTimeUTC: string;
}

export interface MultiPageRandomAssignment {
  roundIndex: number;
  pageId: string;
  pagePosition: number;
  mediaIndex: number;
  mediaId: string;
  fileName: string;
  scheduledTimeKolkata: string;
  scheduledTimeUTC: string;
}

export interface MultiPageRandomizationPlan {
  assignments: MultiPageRandomAssignment[];
  errors: string[];
  mediaCount: number;
  pageCount: number;
  totalJobs: number;
  sourceSignature: string;
}

export interface BuildMultiPageRandomizationPlanInput {
  media: MultiPageMediaSlot[];
  pageIds: string[];
  randomInteger?: (maxExclusive: number) => number;
}

function defaultRandomInteger(maxExclusive: number): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) return 0;

  const webCrypto =
    typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (webCrypto?.getRandomValues) {
    const maximumUint32 = 0x100000000;
    const rejectionLimit =
      Math.floor(maximumUint32 / maxExclusive) * maxExclusive;
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

function shuffle(
  values: number[],
  randomInteger: (maxExclusive: number) => number,
): number[] {
  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const target = getRandomInteger(index + 1, randomInteger);
    [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
  }
  return shuffled;
}

export function buildMultiPageRandomizationSignature(
  media: MultiPageMediaSlot[],
  pageIds: string[],
): string {
  const mediaSignature = media
    .map((item) =>
      [
        item.id,
        item.fileName,
        item.scheduledTimeKolkata,
        item.scheduledTimeUTC,
      ].join("\u001f"),
    )
    .join("\u001e");

  return `${pageIds.join("\u001f")}\u001d${mediaSignature}`;
}

export function buildMultiPageRandomizationPlan(
  input: BuildMultiPageRandomizationPlanInput,
): MultiPageRandomizationPlan {
  const mediaCount = input.media.length;
  const pageCount = input.pageIds.length;
  const sourceSignature = buildMultiPageRandomizationSignature(
    input.media,
    input.pageIds,
  );
  const errors: string[] = [];

  if (mediaCount === 0) {
    errors.push("No uploaded media cards are available for multi-page publishing.");
  }
  if (pageCount < 2) {
    errors.push("Select at least two Facebook Pages for multi-page publishing.");
  }

  const normalizedPageIds = input.pageIds.map((pageId) => pageId.trim());
  if (normalizedPageIds.some((pageId) => pageId.length === 0)) {
    errors.push("Every selected Facebook Page must have a valid ID.");
  }
  if (new Set(normalizedPageIds).size !== normalizedPageIds.length) {
    errors.push("The selected Facebook Pages contain duplicates.");
  }
  if (pageCount > mediaCount && mediaCount > 0) {
    errors.push(
      `Select no more than ${mediaCount} pages for this ${mediaCount}-item batch so every publishing round can use different media on every page.`,
    );
  }

  const mediaIds = input.media.map((item) => item.id);
  if (new Set(mediaIds).size !== mediaIds.length) {
    errors.push("The upload queue contains duplicate media card IDs.");
  }

  const missingSchedule = input.media.find(
    (item) =>
      !item.scheduledTimeKolkata.trim() || !item.scheduledTimeUTC.trim(),
  );
  if (missingSchedule) {
    errors.push(
      `Media card "${missingSchedule.fileName}" is missing its publishing time.`,
    );
  }

  const scheduledTimes = input.media
    .map((item) => item.scheduledTimeUTC.trim())
    .filter(Boolean);
  if (new Set(scheduledTimes).size !== scheduledTimes.length) {
    errors.push(
      "Multi-page randomized publishing requires a different publishing time on every upload card. Generate random-time windows or edit duplicate times first.",
    );
  }

  if (errors.length > 0) {
    return {
      assignments: [],
      errors,
      mediaCount,
      pageCount,
      totalJobs: 0,
      sourceSignature,
    };
  }

  const randomInteger = input.randomInteger || defaultRandomInteger;
  const indices = Array.from({ length: mediaCount }, (_, index) => index);
  const randomizedMediaOrder = shuffle(indices, randomInteger);
  const pageOffsets = shuffle(indices, randomInteger).slice(0, pageCount);
  const assignments: MultiPageRandomAssignment[] = [];

  // Each page receives the entire media set exactly once. Unique page offsets
  // form a randomized Latin-square row, so the same publishing round never
  // assigns the same media item to two selected pages.
  for (let roundIndex = 0; roundIndex < mediaCount; roundIndex++) {
    const scheduleSlot = input.media[roundIndex];

    for (let pagePosition = 0; pagePosition < pageCount; pagePosition++) {
      const orderIndex = (roundIndex + pageOffsets[pagePosition]) % mediaCount;
      const mediaIndex = randomizedMediaOrder[orderIndex];
      const media = input.media[mediaIndex];

      assignments.push({
        roundIndex,
        pageId: normalizedPageIds[pagePosition],
        pagePosition,
        mediaIndex,
        mediaId: media.id,
        fileName: media.fileName,
        scheduledTimeKolkata: scheduleSlot.scheduledTimeKolkata,
        scheduledTimeUTC: scheduleSlot.scheduledTimeUTC,
      });
    }
  }

  return {
    assignments,
    errors: [],
    mediaCount,
    pageCount,
    totalJobs: assignments.length,
    sourceSignature,
  };
}
