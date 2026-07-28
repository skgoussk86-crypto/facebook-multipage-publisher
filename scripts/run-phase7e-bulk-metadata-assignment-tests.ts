import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  buildBulkMetadataPreview,
  buildLineSeparatedMetadataRows,
  derivePlaceholderTitle,
  isPlaceholderTitle,
  parseBulkMetadataCsv,
} from "../src/lib/metadata/bulk-metadata-assignment";

const root = process.cwd();
const dashboardPath = path.join(
  root,
  "src/app/DashboardClient.tsx",
);
const queueControllerPath = path.join(
  root,
  "src/lib/uploads/upload-queue-controller.ts",
);
const packagePath = path.join(
  root,
  "package.json",
);

const dashboard = fs.readFileSync(
  dashboardPath,
  "utf8",
);
const queueController = fs.readFileSync(
  queueControllerPath,
  "utf8",
);
const packageJson = JSON.parse(
  fs.readFileSync(
    packagePath,
    "utf8",
  ),
) as {
  scripts?: Record<string, string>;
};

console.log(
  "Running Phase 7E bulk metadata assignment tests...",
);

{
  const rows =
    buildLineSeparatedMetadataRows(
      [
        "First title",
        "",
        "दूसरा शीर्षक 😂",
        "Third title",
      ].join("\n"),
      [
        "First caption",
        "Second caption ❤️",
      ].join("\r\n"),
    );

  assert.deepEqual(rows, [
    {
      sourceRow: 1,
      title: "First title",
      caption: "First caption",
    },
    {
      sourceRow: 2,
      title: "दूसरा शीर्षक 😂",
      caption: "Second caption ❤️",
    },
    {
      sourceRow: 3,
      title: "Third title",
      caption: undefined,
    },
  ]);

  console.log(
    "PASS line-separated title and caption parsing",
  );
}

{
  const parsed = parseBulkMetadataCsv(
    [
      "\uFEFFfilename,title,caption",
      'video_001.mp4,"Storm, Waves & Rescue 🌊","First line',
      'Second line مرحبا"',
      'video_002.mp4,"दूसरा शीर्षक","Caption ❤️"',
    ].join("\n"),
  );

  assert.equal(
    parsed.errors.length,
    0,
  );
  assert.equal(
    parsed.hasFilenameColumn,
    true,
  );
  assert.equal(
    parsed.rows.length,
    2,
  );
  assert.equal(
    parsed.rows[0]?.title,
    "Storm, Waves & Rescue 🌊",
  );
  assert.equal(
    parsed.rows[0]?.caption,
    "First line\nSecond line مرحبا",
  );
  assert.equal(
    parsed.rows[1]?.title,
    "दूसरा शीर्षक",
  );

  console.log(
    "PASS quoted CSV, Unicode, emoji, and multiline caption parsing",
  );
}

{
  const parsed = parseBulkMetadataCsv(
    "filename,hashtags\nvideo.mp4,#test",
  );

  assert.equal(
    parsed.rows.length,
    0,
  );
  assert.match(
    parsed.errors[0] || "",
    /title column, a caption column, or both/i,
  );

  console.log(
    "PASS CSV header boundary validation",
  );
}

{
  assert.equal(
    derivePlaceholderTitle(
      "my_test-video.mp4",
    ),
    "my test video",
  );
  assert.equal(
    isPlaceholderTitle(
      "My Test Video",
      "my_test-video.mp4",
    ),
    true,
  );
  assert.equal(
    isPlaceholderTitle(
      "A manually written title",
      "my_test-video.mp4",
    ),
    false,
  );

  console.log(
    "PASS filename placeholder-title detection",
  );
}

{
  const targets = [
    {
      id: "job-1",
      fileName: "video_001.mp4",
      title: "video 001",
      caption: "",
    },
    {
      id: "job-2",
      fileName: "video_002.mp4",
      title: "Existing AI title",
      caption: "Existing caption",
    },
    {
      id: "job-3",
      fileName: "video_003.mp4",
      title: "video 003",
      caption: "",
    },
  ];

  const rows = [
    {
      sourceRow: 1,
      title: "New title 1 🔥",
      caption: "New caption 1",
    },
    {
      sourceRow: 2,
      title: "Protected title",
      caption: "Protected caption",
    },
    {
      sourceRow: 3,
      title: "New title 3",
    },
    {
      sourceRow: 4,
      title: "Unused title",
    },
  ];

  const preview =
    buildBulkMetadataPreview(
      targets,
      rows,
      {
        matchMode: "upload_order",
        overwriteExisting: false,
      },
    );

  assert.equal(
    preview.willUpdate,
    2,
  );
  assert.equal(
    preview.skippedExisting,
    1,
  );
  assert.equal(
    preview.unusedRows,
    1,
  );
  assert.deepEqual(
    preview.assignments[0],
    {
      jobId: "job-1",
      sourceRow: 1,
      title: "New title 1 🔥",
      caption: "New caption 1",
    },
  );
  assert.deepEqual(
    preview.assignments[1],
    {
      jobId: "job-3",
      sourceRow: 3,
      title: "New title 3",
    },
  );

  console.log(
    "PASS upload-order assignment and existing-metadata protection",
  );
}

{
  const preview =
    buildBulkMetadataPreview(
      [
        {
          id: "job-a",
          fileName: "Alpha.MP4",
          title: "Existing title",
          caption: "Existing caption",
        },
        {
          id: "job-b",
          fileName: "beta.mp4",
          title: "beta",
          caption: "",
        },
      ],
      [
        {
          sourceRow: 2,
          filename: "BETA.MP4",
          title: "Beta title",
          caption: "Beta caption",
        },
        {
          sourceRow: 3,
          filename: "alpha.mp4",
          title: "Alpha replacement",
          caption: "Alpha replacement caption",
        },
        {
          sourceRow: 4,
          filename: "missing.mp4",
          title: "Missing",
        },
      ],
      {
        matchMode: "filename",
        overwriteExisting: true,
      },
    );

  assert.equal(
    preview.willUpdate,
    2,
  );
  assert.equal(
    preview.unmatchedRows,
    1,
  );
  assert.equal(
    preview.assignments[0]?.jobId,
    "job-b",
  );
  assert.equal(
    preview.assignments[1]?.jobId,
    "job-a",
  );

  console.log(
    "PASS case-insensitive filename matching and overwrite mode",
  );
}

{
  const tooLong =
    "😀".repeat(256);

  const preview =
    buildBulkMetadataPreview(
      [
        {
          id: "job-1",
          fileName: "video.mp4",
          title: "video",
          caption: "",
        },
      ],
      [
        {
          sourceRow: 1,
          title: tooLong,
        },
        {
          sourceRow: 2,
          title: "Line one\nLine two",
        },
        {
          sourceRow: 3,
          caption: "Unsafe\u0007caption",
        },
      ],
      {
        matchMode: "upload_order",
        overwriteExisting: true,
      },
    );

  assert.equal(
    preview.invalidRows,
    3,
  );
  assert.equal(
    preview.assignments.length,
    0,
  );
  assert.equal(
    preview.errors.length,
    3,
  );

  console.log(
    "PASS Unicode title limit and unsafe metadata rejection",
  );
}

{
  const requiredDashboardBoundaries = [
    "Bulk Titles & Captions",
    "Paste / TXT Lists",
    "Upload Titles TXT",
    "Upload Captions TXT",
    "Preview Assignment",
    "Apply to Cards",
    "Undo Last Assignment",
    "Match by filename",
    "handleApplyBulkMetadata",
    "handleUndoBulkMetadata",
    "parseBulkMetadataCsv",
    "buildLineSeparatedMetadataRows",
    "updateManyJobFields",
  ];

  requiredDashboardBoundaries.forEach(
    (boundary) => {
      assert.match(
        dashboard,
        new RegExp(
          boundary.replace(
            /[.*+?^${}()|[\]\\]/g,
            "\\$&",
          ),
        ),
      );
    },
  );

  assert.match(
    dashboard,
    /accept="\.txt,text\/plain"/,
  );
  assert.match(
    dashboard,
    /accept="\.csv,text\/csv"/,
  );
  assert.match(
    dashboard,
    /filename placeholder titles are still replaceable/i,
  );

  console.log(
    "PASS Dashboard paste, TXT, CSV, preview, apply, and undo boundaries",
  );
}

{
  assert.match(
    queueController,
    /public updateManyJobFields\(/,
  );
  assert.match(
    queueController,
    /if \(updatedCount > 0\) \{\s*this\.saveToStorage\(\);\s*this\.notify\(\);/,
  );
  assert.match(
    dashboard,
    /englishCaption: item\.englishCaption \?\? existing\?\.englishCaption \?\? ""/,
  );

  console.log(
    "PASS one-save queue persistence and empty-caption restoration boundaries",
  );
}

{
  assert.equal(
    packageJson.scripts?.[
      "test:phase7e-bulk-metadata-assignment"
    ],
    "node --conditions=react-server --import tsx scripts/run-phase7e-bulk-metadata-assignment-tests.ts",
  );

  console.log(
    "PASS package test command boundary",
  );
}

console.log(
  "PHASE7E_BULK_METADATA_ASSIGNMENT_TESTS=PASSED",
);
