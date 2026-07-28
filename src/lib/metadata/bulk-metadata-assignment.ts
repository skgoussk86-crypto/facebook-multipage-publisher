import {
  containsUnsafeControlCharacters,
  countUnicodeCharacters,
  isSingleLineMetadataText,
} from "../validation";

export type BulkMetadataMatchMode =
  | "upload_order"
  | "filename";

export interface BulkMetadataRow {
  sourceRow: number;
  filename?: string;
  title?: string;
  caption?: string;
}

export interface BulkMetadataTarget {
  id: string;
  fileName: string;
  title: string;
  caption: string;
}

export interface BulkMetadataAssignment {
  jobId: string;
  sourceRow: number;
  title?: string;
  caption?: string;
}

export interface BulkMetadataPreview {
  assignments: BulkMetadataAssignment[];
  previewRows: Array<{
    jobId?: string;
    fileName?: string;
    sourceRow: number;
    title?: string;
    caption?: string;
    status: "ready" | "skipped" | "invalid" | "unmatched";
    message: string;
  }>;
  targetCount: number;
  rowCount: number;
  matchedRows: number;
  willUpdate: number;
  skippedExisting: number;
  invalidRows: number;
  unmatchedRows: number;
  unusedRows: number;
  unassignedTargets: number;
  errors: string[];
}

export interface BuildBulkMetadataPreviewOptions {
  matchMode: BulkMetadataMatchMode;
  overwriteExisting: boolean;
}

function normalizeNewlines(value: string): string {
  return value
    .replace(/^\uFEFF/u, "")
    .replace(/\r\n?/gu, "\n");
}

function splitNonEmptyLines(value: string): string[] {
  return normalizeNewlines(value)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function normalizeFilename(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function derivePlaceholderTitle(
  fileName: string,
): string {
  return fileName
    .replace(/\.[^/.]+$/u, "")
    .replace(/[_-]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function isPlaceholderTitle(
  title: string,
  fileName: string,
): boolean {
  const normalizedTitle =
    title.trim().replace(/\s+/gu, " ");

  if (!normalizedTitle) {
    return true;
  }

  return (
    normalizedTitle.toLocaleLowerCase() ===
    derivePlaceholderTitle(fileName).toLocaleLowerCase()
  );
}

export function buildLineSeparatedMetadataRows(
  titlesText: string,
  captionsText: string,
): BulkMetadataRow[] {
  const titles = splitNonEmptyLines(titlesText);
  const captions = splitNonEmptyLines(captionsText);
  const rowCount = Math.max(titles.length, captions.length);

  return Array.from(
    { length: rowCount },
    (_, index): BulkMetadataRow => ({
      sourceRow: index + 1,
      title: titles[index],
      caption: captions[index],
    }),
  );
}

export function parseBulkMetadataCsvRows(
  text: string,
): string[][] {
  const rows: string[][] = [];
  let row = [""];
  let inQuotes = false;
  const input = normalizeNewlines(text);

  for (let index = 0; index < input.length; index++) {
    const character = input[index];
    const nextCharacter = input[index + 1];

    if (character === '"') {
      if (inQuotes && nextCharacter === '"') {
        row[row.length - 1] += '"';
        index++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (character === "," && !inQuotes) {
      row.push("");
    } else if (character === "\n" && !inQuotes) {
      rows.push(row);
      row = [""];
    } else {
      row[row.length - 1] += character;
    }
  }

  if (inQuotes) {
    throw new Error(
      "CSV contains an unterminated quoted field.",
    );
  }

  if (
    row.length > 1 ||
    row[0] !== ""
  ) {
    rows.push(row);
  }

  return rows;
}

export function parseBulkMetadataCsv(
  text: string,
): {
  rows: BulkMetadataRow[];
  errors: string[];
  hasFilenameColumn: boolean;
} {
  let parsedRows: string[][];

  try {
    parsedRows = parseBulkMetadataCsvRows(text);
  } catch (error) {
    return {
      rows: [],
      errors: [
        error instanceof Error
          ? error.message
          : "CSV could not be parsed.",
      ],
      hasFilenameColumn: false,
    };
  }

  if (parsedRows.length === 0) {
    return {
      rows: [],
      errors: ["CSV file is empty."],
      hasFilenameColumn: false,
    };
  }

  const headers = parsedRows[0].map((header) =>
    header
      .replace(/^\uFEFF/u, "")
      .trim()
      .toLocaleLowerCase(),
  );

  const filenameIndex = headers.findIndex((header) =>
    ["filename", "file_name", "file"].includes(header),
  );
  const titleIndex = headers.indexOf("title");
  const captionIndex = headers.findIndex((header) =>
    ["caption", "description"].includes(header),
  );

  if (
    titleIndex === -1 &&
    captionIndex === -1
  ) {
    return {
      rows: [],
      errors: [
        "CSV must include a title column, a caption column, or both.",
      ],
      hasFilenameColumn: filenameIndex !== -1,
    };
  }

  const rows: BulkMetadataRow[] = [];
  const errors: string[] = [];

  for (
    let rowIndex = 1;
    rowIndex < parsedRows.length;
    rowIndex++
  ) {
    const values = parsedRows[rowIndex];

    if (
      values.every(
        (value) => value.trim() === "",
      )
    ) {
      continue;
    }

    const sourceRow = rowIndex + 1;
    const filename =
      filenameIndex === -1
        ? undefined
        : values[filenameIndex]?.trim() || undefined;
    const title =
      titleIndex === -1
        ? undefined
        : values[titleIndex]?.trim() || undefined;
    const caption =
      captionIndex === -1
        ? undefined
        : values[captionIndex]?.trim() || undefined;

    if (!title && !caption) {
      errors.push(
        `Row ${sourceRow} does not contain a title or caption.`,
      );
      continue;
    }

    rows.push({
      sourceRow,
      filename,
      title,
      caption,
    });
  }

  if (
    rows.length === 0 &&
    errors.length === 0
  ) {
    errors.push(
      "CSV does not contain any metadata rows.",
    );
  }

  return {
    rows,
    errors,
    hasFilenameColumn: filenameIndex !== -1,
  };
}

function validateBulkMetadataRow(
  row: BulkMetadataRow,
): string[] {
  const errors: string[] = [];

  if (row.title !== undefined) {
    if (
      countUnicodeCharacters(row.title) >
      255
    ) {
      errors.push(
        "title exceeds 255 Unicode characters",
      );
    }

    if (
      !isSingleLineMetadataText(row.title)
    ) {
      errors.push(
        "title must be a single line",
      );
    }

    if (
      containsUnsafeControlCharacters(
        row.title,
      )
    ) {
      errors.push(
        "title contains unsupported control characters",
      );
    }
  }

  if (
    row.caption !== undefined &&
    containsUnsafeControlCharacters(
      row.caption,
    )
  ) {
    errors.push(
      "caption contains unsupported control characters",
    );
  }

  return errors;
}

export function buildBulkMetadataPreview(
  targets: BulkMetadataTarget[],
  rows: BulkMetadataRow[],
  options: BuildBulkMetadataPreviewOptions,
): BulkMetadataPreview {
  const assignments: BulkMetadataAssignment[] = [];
  const previewRows: BulkMetadataPreview["previewRows"] = [];
  const errors: string[] = [];
  const matchedTargetIds = new Set<string>();

  let matchedRows = 0;
  let skippedExisting = 0;
  let invalidRows = 0;
  let unmatchedRows = 0;
  let unusedRows = 0;

  const normalizedTargetMap =
    new Map<string, BulkMetadataTarget[]>();

  targets.forEach((target) => {
    const key = normalizeFilename(
      target.fileName,
    );
    const current =
      normalizedTargetMap.get(key) || [];

    current.push(target);
    normalizedTargetMap.set(
      key,
      current,
    );
  });

  rows.forEach((row, rowIndex) => {
    const rowErrors =
      validateBulkMetadataRow(row);

    if (rowErrors.length > 0) {
      invalidRows++;

      const message =
        `Row ${row.sourceRow}: ` +
        rowErrors.join("; ") +
        ".";

      errors.push(message);
      previewRows.push({
        sourceRow: row.sourceRow,
        title: row.title,
        caption: row.caption,
        status: "invalid",
        message,
      });
      return;
    }

    let target:
      | BulkMetadataTarget
      | undefined;

    if (
      options.matchMode ===
      "upload_order"
    ) {
      target = targets[rowIndex];

      if (!target) {
        unusedRows++;
        previewRows.push({
          sourceRow: row.sourceRow,
          title: row.title,
          caption: row.caption,
          status: "unmatched",
          message:
            "No upload card remains for this row.",
        });
        return;
      }
    } else {
      if (!row.filename) {
        unmatchedRows++;
        previewRows.push({
          sourceRow: row.sourceRow,
          title: row.title,
          caption: row.caption,
          status: "unmatched",
          message:
            "Filename is required for filename matching.",
        });
        return;
      }

      const matches =
        normalizedTargetMap.get(
          normalizeFilename(
            row.filename,
          ),
        ) || [];

      if (matches.length === 0) {
        unmatchedRows++;
        previewRows.push({
          sourceRow: row.sourceRow,
          title: row.title,
          caption: row.caption,
          status: "unmatched",
          message:
            `No upload card matches '${row.filename}'.`,
        });
        return;
      }

      if (matches.length > 1) {
        unmatchedRows++;
        previewRows.push({
          sourceRow: row.sourceRow,
          title: row.title,
          caption: row.caption,
          status: "unmatched",
          message:
            `Filename '${row.filename}' is ambiguous because multiple cards use it.`,
        });
        return;
      }

      target = matches[0];

      if (
        matchedTargetIds.has(
          target.id,
        )
      ) {
        unmatchedRows++;
        previewRows.push({
          sourceRow: row.sourceRow,
          fileName: target.fileName,
          title: row.title,
          caption: row.caption,
          status: "unmatched",
          message:
            `More than one metadata row targets '${target.fileName}'.`,
        });
        return;
      }
    }

    matchedRows++;
    matchedTargetIds.add(target.id);

    const assignment:
      BulkMetadataAssignment = {
        jobId: target.id,
        sourceRow: row.sourceRow,
      };

    if (
      row.title !== undefined &&
      (
        options.overwriteExisting ||
        isPlaceholderTitle(
          target.title,
          target.fileName,
        )
      )
    ) {
      assignment.title = row.title;
    }

    if (
      row.caption !== undefined &&
      (
        options.overwriteExisting ||
        target.caption.trim() === ""
      )
    ) {
      assignment.caption = row.caption;
    }

    if (
      assignment.title === undefined &&
      assignment.caption === undefined
    ) {
      skippedExisting++;
      previewRows.push({
        jobId: target.id,
        fileName: target.fileName,
        sourceRow: row.sourceRow,
        title: row.title,
        caption: row.caption,
        status: "skipped",
        message:
          "Existing non-placeholder metadata is protected.",
      });
      return;
    }

    assignments.push(assignment);
    previewRows.push({
      jobId: target.id,
      fileName: target.fileName,
      sourceRow: row.sourceRow,
      title: assignment.title,
      caption: assignment.caption,
      status: "ready",
      message:
        "Ready to assign.",
    });
  });

  return {
    assignments,
    previewRows,
    targetCount: targets.length,
    rowCount: rows.length,
    matchedRows,
    willUpdate: assignments.length,
    skippedExisting,
    invalidRows,
    unmatchedRows,
    unusedRows,
    unassignedTargets:
      Math.max(
        0,
        targets.length -
          matchedTargetIds.size,
      ),
    errors,
  };
}
