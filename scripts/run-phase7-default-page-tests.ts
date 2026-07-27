import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const dashboardPath = path.join(
  process.cwd(),
  'src/app/DashboardClient.tsx',
);
const source = fs.readFileSync(dashboardPath, 'utf8');

assert.match(
  source,
  /Default Facebook Page for New Uploads/,
  'The pre-upload default-page selector must be visible.',
);

assert.match(
  source,
  /queueControllerRef\.current\.addFiles\(\s*filesArray,\s*bulkPageId,\s*maxFileSizeMB,/,
  'Newly selected files must inherit bulkPageId.',
);

assert.doesNotMatch(
  source,
  /queueControllerRef\.current\.addFiles\(filesArray,\s*pages\[0\]\?\.id/,
  'New uploads must not silently fall back to the first connected page.',
);

assert.match(
  source,
  /Select a connected Facebook Page before adding files/,
  'File selection must be blocked until a valid page is selected.',
);

assert.match(
  source,
  /disabled=\{!bulkPageId \|\| !pages\.some\(\(page\) => page\.id === bulkPageId\)\}/,
  'The upload picker must be disabled when the selected page is unavailable.',
);

assert.match(
  source,
  /Existing cards remain unchanged unless you use Apply Page to All/,
  'The UI must explain that changing the default does not mutate existing cards.',
);

assert.match(
  source,
  /onClick=\{handleApplyPageToAll\}[\s\S]*?Apply All/,
  'The existing-card bulk reassignment action must remain available.',
);

console.log('PHASE7_DEFAULT_PAGE_TESTS=PASSED');
