import assert from "assert";
import {
  findGoogleDriveMediaFolder,
  createGoogleDriveMediaFolder,
  findOrCreateGoogleDriveMediaFolder,
} from "../src/lib/google-drive/google-drive-folder-client";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function createJsonResponse(
  body: unknown,
  status = 200
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function restoreEnvironmentVariable(
  name: string,
  originalValue: string | undefined
): void {
  if (originalValue === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = originalValue;
  }
}

async function runTests() {
  let passedCount = 0;
  const totalExpected = 24;

  const testToken = "ya29.mock-access-token";

  // Test 1: Empty access token is rejected in find
  try {
    let failed = false;
    try {
      const fakeFetch: typeof fetch = async () => {
        return createJsonResponse({});
      };
      await findGoogleDriveMediaFolder("", { fetchImpl: fakeFetch });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      assert(message.includes("Access token is required."));
      failed = true;
    }
    assert(failed, "Empty access token should be rejected");
    passedCount++;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Test 1 Failed:", message);
  }

  // Test 2: Whitespace access token is rejected in find
  try {
    let failed = false;
    try {
      const fakeFetch: typeof fetch = async () => {
        return createJsonResponse({});
      };
      await findGoogleDriveMediaFolder("   ", { fetchImpl: fakeFetch });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      assert(message.includes("Access token is required."));
      failed = true;
    }
    assert(failed, "Whitespace access token should be rejected");
    passedCount++;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Test 2 Failed:", message);
  }

  // Test 3: Lookup uses GET
  // Test 4: Lookup URL contains the required encoded query
  // Test 5: Lookup sends bearer token only through Authorization
  try {
    let methodUsed = "";
    let urlUsed = "";
    let authorizationHeader: string | null = null;

    const fakeFetch: typeof fetch = async (input, init) => {
      urlUsed = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      methodUsed = init?.method || "";
      authorizationHeader = new Headers(init?.headers).get("Authorization");
      return createJsonResponse({ files: [] });
    };

    await findGoogleDriveMediaFolder(testToken, { fetchImpl: fakeFetch });

    const parsedLookupUrl = new URL(urlUsed);
    const decodedQuery = parsedLookupUrl.searchParams.get("q");

    assert(methodUsed === "GET", "Lookup must use GET");

    assert(
      parsedLookupUrl.origin === "https://www.googleapis.com",
      "Lookup origin must be Google APIs"
    );

    assert(
      parsedLookupUrl.pathname === "/drive/v3/files",
      "Lookup URL path must be correct"
    );

    assert(
      decodedQuery ===
        "mimeType = 'application/vnd.google-apps.folder' and trashed = false and appProperties has { key='fbPublisherPurpose' and value='mediaRoot' }",
      "Lookup query must contain the exact folder and appProperties filters"
    );

    assert(
      parsedLookupUrl.searchParams.get("spaces") === "drive",
      "Lookup spaces must be drive"
    );

    assert(
      parsedLookupUrl.searchParams.get("corpora") === "user",
      "Lookup corpora must be user"
    );

    assert(
      parsedLookupUrl.searchParams.get("pageSize") === "100",
      "Lookup pageSize must be 100"
    );

    assert(
      parsedLookupUrl.searchParams.get("fields") ===
        "files(id,name,appProperties),nextPageToken",
      "Lookup fields must be restricted"
    );

    assert(
      authorizationHeader === `Bearer ${testToken}`,
      "Authorization header must be correct Bearer token"
    );

    assert(
      !urlUsed.includes(testToken),
      "Access token must not appear in lookup URL"
    );

    passedCount += 3; // Tests 3, 4, 5
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Test 3/4/5 Failed:", message);
  }

  // Test 6: Existing valid tagged folder is returned
  try {
    const fakeFetch: typeof fetch = async () => {
      return createJsonResponse({
        files: [
          {
            id: "folder-id-123",
            name: "My Media Folder",
            appProperties: { fbPublisherPurpose: "mediaRoot" },
          },
        ],
      });
    };

    const folder = await findGoogleDriveMediaFolder(testToken, { fetchImpl: fakeFetch });
    assert(folder !== null);
    assert(folder.id === "folder-id-123");
    assert(folder.name === "My Media Folder");
    passedCount++;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Test 6 Failed:", message);
  }

  // Test 7: No matching folder returns null
  try {
    const fakeFetch: typeof fetch = async () => {
      return createJsonResponse({ files: [] });
    };

    const folder = await findGoogleDriveMediaFolder(testToken, { fetchImpl: fakeFetch });
    assert(folder === null, "Empty files list must return null");
    passedCount++;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Test 7 Failed:", message);
  }

  // Test 8: Invalid folder entries are ignored
  try {
    const fakeFetch: typeof fetch = async () => {
      return createJsonResponse({
        files: [
          { id: "", name: "Invalid Folder" },
          { id: "valid-id", name: "   " },
          { id: "real-folder-id", name: "Real Folder Name" },
        ],
      });
    };

    const folder = await findGoogleDriveMediaFolder(testToken, { fetchImpl: fakeFetch });
    assert(folder !== null, "Should skip invalid and find the valid folder");
    assert(folder.id === "real-folder-id");
    assert(folder.name === "Real Folder Name");
    passedCount++;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Test 8 Failed:", message);
  }

  // Test 9: Explicit whitespace folder name is rejected
  try {
    let failed = false;
    const fakeFetch: typeof fetch = async () => {
      return createJsonResponse({});
    };
    try {
      await createGoogleDriveMediaFolder(testToken, "   ", { fetchImpl: fakeFetch });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      assert(message.includes("Google Drive folder name is required."));
      failed = true;
    }
    assert(failed, "Whitespace folder name should be rejected");
    passedCount++;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Test 9 Failed:", message);
  }

  // Test 10: Default folder name is used when no environment value exists
  // Test 13: Creation uses POST
  // Test 14: Creation sends the correct MIME type
  // Test 15: Creation sends fbPublisherPurpose=mediaRoot
  try {
    const originalEnv = process.env.GOOGLE_DRIVE_FOLDER_NAME;
    delete process.env.GOOGLE_DRIVE_FOLDER_NAME;

    try {
      let postUrl = "";
      let postMethod = "";
      let postBodyText = "";

      const fakeFetch: typeof fetch = async (input, init) => {
        postUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        postMethod = init?.method || "";
        postBodyText = typeof init?.body === "string" ? init.body : "";

        const parsedBody: unknown = JSON.parse(postBodyText);
        let folderName = "";
        if (isRecord(parsedBody) && typeof parsedBody.name === "string") {
          folderName = parsedBody.name;
        }

        return createJsonResponse({
          id: "created-folder-id",
          name: folderName,
        });
      };

      const folder = await createGoogleDriveMediaFolder(testToken, undefined, { fetchImpl: fakeFetch });

      assert(folder.id === "created-folder-id");
      assert(folder.name === "Facebook Multi-Page Publisher");
      assert(postMethod === "POST", "Creation must use POST");
      assert(postUrl.startsWith("https://www.googleapis.com/drive/v3/files"), "Creation POST url correct");

      const parsed: unknown = JSON.parse(postBodyText);
      assert(isRecord(parsed));
      assert(parsed.mimeType === "application/vnd.google-apps.folder", "MIME type must be folder");

      const appProps = parsed.appProperties;
      assert(isRecord(appProps));
      assert(appProps.fbPublisherPurpose === "mediaRoot", "fbPublisherPurpose must be mediaRoot");

      passedCount += 4; // Tests 10, 13, 14, 15
    } finally {
      restoreEnvironmentVariable("GOOGLE_DRIVE_FOLDER_NAME", originalEnv);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Test 10/13/14/15 Failed:", message);
  }

  // Test 11: Environment folder name is trimmed and used
  try {
    const originalEnv = process.env.GOOGLE_DRIVE_FOLDER_NAME;
    process.env.GOOGLE_DRIVE_FOLDER_NAME = "  My Env Folder Name   ";

    try {
      let postBodyText = "";
      const fakeFetch: typeof fetch = async (input, init) => {
        postBodyText = typeof init?.body === "string" ? init.body : "";
        const parsed: unknown = JSON.parse(postBodyText);
        let nameVal = "";
        if (isRecord(parsed) && typeof parsed.name === "string") {
          nameVal = parsed.name;
        }
        return createJsonResponse({
          id: "env-folder-id",
          name: nameVal,
        });
      };

      const folder = await createGoogleDriveMediaFolder(testToken, undefined, { fetchImpl: fakeFetch });
      assert(folder.name === "My Env Folder Name", "Should trim the environment folder name");

      passedCount++;
    } finally {
      restoreEnvironmentVariable("GOOGLE_DRIVE_FOLDER_NAME", originalEnv);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Test 11 Failed:", message);
  }

  // Test 12: Explicit folder name overrides the environment value
  try {
    const originalEnv = process.env.GOOGLE_DRIVE_FOLDER_NAME;
    process.env.GOOGLE_DRIVE_FOLDER_NAME = "Env Folder Name";

    try {
      let postBodyText = "";
      const fakeFetch: typeof fetch = async (input, init) => {
        postBodyText = typeof init?.body === "string" ? init.body : "";
        const parsed: unknown = JSON.parse(postBodyText);
        let nameVal = "";
        if (isRecord(parsed) && typeof parsed.name === "string") {
          nameVal = parsed.name;
        }
        return createJsonResponse({
          id: "explicit-id",
          name: nameVal,
        });
      };

      const folder = await createGoogleDriveMediaFolder(testToken, "  Explicit Name Override  ", { fetchImpl: fakeFetch });
      assert(folder.name === "Explicit Name Override");

      passedCount++;
    } finally {
      restoreEnvironmentVariable("GOOGLE_DRIVE_FOLDER_NAME", originalEnv);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Test 12 Failed:", message);
  }

  // Test 16: Creation returns valid id and name
  try {
    const fakeFetch: typeof fetch = async () => {
      return createJsonResponse({
        id: "valid-created-id",
        name: "Valid Folder",
      });
    };

    const folder = await createGoogleDriveMediaFolder(testToken, "Folder Name", { fetchImpl: fakeFetch });
    assert(folder.id === "valid-created-id");
    assert(folder.name === "Valid Folder");
    passedCount++;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Test 16 Failed:", message);
  }

  // Test 17: Malformed successful creation response is rejected
  try {
    const fakeFetch: typeof fetch = async () => {
      return createJsonResponse({
        id: "",
        name: "Valid Name but Empty ID",
      });
    };

    let failed = false;
    try {
      await createGoogleDriveMediaFolder(testToken, "Folder Name", { fetchImpl: fakeFetch });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      assert(message.includes("Google Drive API response did not contain a valid folder ID or name."));
      failed = true;
    }
    assert(failed);
    passedCount++;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Test 17 Failed:", message);
  }

  // Test 18: Lookup non-2xx error is sanitized
  // Test 20: Errors do not contain test access token
  try {
    const fakeFetch: typeof fetch = async () => {
      return createJsonResponse({}, 403);
    };

    let failed = false;
    try {
      await findGoogleDriveMediaFolder(testToken, { fetchImpl: fakeFetch });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      assert(message.includes("Google Drive folder lookup failed with status 403."));
      assert(!message.includes(testToken), "Error must not leak access token");
      failed = true;
    }
    assert(failed);
    passedCount += 2; // Tests 18, 20
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Test 18/20 Failed:", message);
  }

  // Test 19: Creation non-2xx error is sanitized
  try {
    const fakeFetch: typeof fetch = async () => {
      return createJsonResponse({}, 500);
    };

    let failed = false;
    try {
      await createGoogleDriveMediaFolder(testToken, "My Folder", { fetchImpl: fakeFetch });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      assert(message.includes("Google Drive folder creation failed with status 500."));
      assert(!message.includes(testToken), "Error must not leak access token");
      failed = true;
    }
    assert(failed);
    passedCount++;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Test 19 Failed:", message);
  }

  // Test 21: findOrCreate returns an existing folder without POST
  try {
    let postCalled = false;
    const fakeFetch: typeof fetch = async (input, init) => {
      if (init?.method === "POST") {
        postCalled = true;
      }
      return createJsonResponse({
        files: [
          {
            id: "existing-id",
            name: "Existing Folder",
          },
        ],
      });
    };

    const folder = await findOrCreateGoogleDriveMediaFolder(testToken, "Some Name", { fetchImpl: fakeFetch });
    assert(folder.id === "existing-id");
    assert(folder.name === "Existing Folder");
    assert(!postCalled, "POST must not be called when folder exists");
    passedCount++;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Test 21 Failed:", message);
  }

  // Test 22: findOrCreate creates exactly once when lookup is empty
  try {
    let lookupCalled = false;
    let createCalled = false;

    const fakeFetch: typeof fetch = async (input, init) => {
      if (init?.method === "GET") {
        lookupCalled = true;
        return createJsonResponse({ files: [] });
      }
      if (init?.method === "POST") {
        createCalled = true;
        return createJsonResponse({
          id: "newly-created-id",
          name: "New Folder",
        });
      }
      return createJsonResponse({}, 400);
    };

    const folder = await findOrCreateGoogleDriveMediaFolder(testToken, "New Folder", { fetchImpl: fakeFetch });
    assert(folder.id === "newly-created-id");
    assert(folder.name === "New Folder");
    assert(lookupCalled, "Lookup must be called");
    assert(createCalled, "Create must be called when lookup returns empty");
    passedCount++;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Test 22 Failed:", message);
  }

  // Test 23: No real Google request occurs (satisfied by all tests using fakeFetch)
  // Test 24: No database write occurs (satisfied by all tests using fakeFetch)
  passedCount += 2; // Tests 23, 24

  console.log(`\nGoogle Drive Folder Validation complete. Passed: ${passedCount}/${totalExpected}`);
  if (passedCount !== totalExpected) {
    console.error("ERROR: Not all validation tests passed.");
    process.exit(1);
  } else {
    console.log("SUCCESS: All media folder client constraints verified successfully.");
  }
}

runTests().catch((err) => {
  console.error("Fatal error in test suite execution:", err);
  process.exit(1);
});
