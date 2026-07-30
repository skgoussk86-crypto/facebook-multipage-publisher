import assert from "node:assert/strict";
import {
  isValidFilename,
  sanitizeFilename,
} from "../src/lib/storage/upload-initiation-service";

const accepted = [
  "panda-upload-test.jpg",
  "panda-upload-test.jpeg",
  "panda-upload-test.png",
  "ChatGPT Image Jul 30, 2026, 08_50_28 PM (1).png",
  "photo, copy (2).jpeg",
  "Panda family â€“ final.png",
];

for (const filename of accepted) {
  assert.equal(
    isValidFilename(filename),
    true,
    `Expected valid filename: ${filename}`,
  );
}

const rejected = [
  "",
  "   ",
  "../panda.png",
  "folder/panda.png",
  "folder\\panda.png",
  "panda..png",
  `bad${String.fromCharCode(0)}name.png`,
];

for (const filename of rejected) {
  assert.equal(
    isValidFilename(filename),
    false,
    `Expected invalid filename: ${JSON.stringify(filename)}`,
  );
}

const sanitized = sanitizeFilename(
  "ChatGPT Image Jul 30, 2026, 08_50_28 PM (1).png",
);

assert.equal(sanitized.includes(","), false);
assert.equal(sanitized.includes("("), false);
assert.equal(sanitized.includes(")"), false);
assert.equal(sanitized.endsWith(".png"), true);

console.log("IMAGE_FILENAME_POLICY_TESTS=PASSED");
console.log("JPG_FILENAME_ACCEPTED=YES");
console.log("JPEG_FILENAME_ACCEPTED=YES");
console.log("PNG_FILENAME_ACCEPTED=YES");
console.log("CHATGPT_STYLE_FILENAME_ACCEPTED=YES");
console.log("PATH_TRAVERSAL_REJECTED=YES");
console.log("STORAGE_KEY_SANITIZATION_PRESERVED=YES");
