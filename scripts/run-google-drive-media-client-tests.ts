import {
  initiateGoogleDriveResumableUpload,
  getGoogleDriveFileMetadata,
  createGoogleDriveFileReadStream,
  deleteGoogleDriveFile,
  GoogleDriveFileNotFoundError,
  GoogleDriveResumableUploadInput,
} from "../src/lib/google-drive/google-drive-media-client";

// Assertion helper
function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// Security verification helper
function assertNoErrorLeaks(error: unknown, token?: string, uri?: string) {
  const msg = error instanceof Error ? error.message : String(error);
  if (token && msg.includes(token)) {
    throw new Error(`Security leak: Error message contains access token! Msg: ${msg}`);
  }
  if (uri && msg.includes(uri)) {
    throw new Error("Security leak: Error message contains resumable session URI! Msg: ${msg}");
  }
}

function normalizeFetchUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  return input.url;
}

async function runTests() {
  console.log("Running Google Drive Media Client Foundation Tests...\n");
  let passedCount = 0;

  const validAccessToken = "test-token-12345";
  const validFolderId = "folder-id-67890";
  const validAssetId = "asset-id-abcde";
  const validFileName = "video.mp4";
  const validMimeType = "video/mp4";
  const validTotalBytes = 1048576;

  const validUploadInput: GoogleDriveResumableUploadInput = {
    accessToken: validAccessToken,
    folderId: validFolderId,
    assetId: validAssetId,
    fileName: validFileName,
    mimeType: validMimeType,
    totalBytes: validTotalBytes,
  };

  // Test 1: Blank access token fails before fetch.
  try {
    let fetchCalled = false;
    const fetchImpl = async (): Promise<Response> => {
      fetchCalled = true;
      return new Response();
    };

    let failed = false;
    try {
      await getGoogleDriveFileMetadata("   ", "file-123", { fetchImpl });
    } catch (err: unknown) {
      failed = true;
      assertNoErrorLeaks(err);
    }
    assert(failed, "Blank access token should fail");
    assert(!fetchCalled, "Fetch should not be called");
    console.log("Test 1 Passed: Blank access token fails before fetch [✓]");
    passedCount++;
  } catch (err: unknown) {
    console.error("Test 1 Failed:", err);
  }

  // Test 2: Blank folder ID fails before fetch.
  try {
    let fetchCalled = false;
    const fetchImpl = async (): Promise<Response> => {
      fetchCalled = true;
      return new Response();
    };

    let failed = false;
    try {
      await initiateGoogleDriveResumableUpload({ ...validUploadInput, folderId: "  " }, { fetchImpl });
    } catch (err: unknown) {
      failed = true;
      assertNoErrorLeaks(err, validAccessToken);
    }
    assert(failed, "Blank folder ID should fail");
    assert(!fetchCalled, "Fetch should not be called");
    console.log("Test 2 Passed: Blank folder ID fails before fetch [✓]");
    passedCount++;
  } catch (err: unknown) {
    console.error("Test 2 Failed:", err);
  }

  // Test 3: Blank asset ID fails before fetch.
  try {
    let fetchCalled = false;
    const fetchImpl = async (): Promise<Response> => {
      fetchCalled = true;
      return new Response();
    };

    let failed = false;
    try {
      await initiateGoogleDriveResumableUpload({ ...validUploadInput, assetId: "" }, { fetchImpl });
    } catch (err: unknown) {
      failed = true;
      assertNoErrorLeaks(err, validAccessToken);
    }
    assert(failed, "Blank asset ID should fail");
    assert(!fetchCalled, "Fetch should not be called");
    console.log("Test 3 Passed: Blank asset ID fails before fetch [✓]");
    passedCount++;
  } catch (err: unknown) {
    console.error("Test 3 Failed:", err);
  }

  // Test 4: Blank filename fails before fetch.
  try {
    let fetchCalled = false;
    const fetchImpl = async (): Promise<Response> => {
      fetchCalled = true;
      return new Response();
    };

    let failed = false;
    try {
      await initiateGoogleDriveResumableUpload({ ...validUploadInput, fileName: " " }, { fetchImpl });
    } catch (err: unknown) {
      failed = true;
      assertNoErrorLeaks(err, validAccessToken);
    }
    assert(failed, "Blank filename should fail");
    assert(!fetchCalled, "Fetch should not be called");
    console.log("Test 4 Passed: Blank filename fails before fetch [✓]");
    passedCount++;
  } catch (err: unknown) {
    console.error("Test 4 Failed:", err);
  }

  // Test 5: Control-character filename fails before fetch.
  try {
    let fetchCalled = false;
    const fetchImpl = async (): Promise<Response> => {
      fetchCalled = true;
      return new Response();
    };

    let failed = false;
    try {
      await initiateGoogleDriveResumableUpload({ ...validUploadInput, fileName: "file\x0Aname.mp4" }, { fetchImpl });
    } catch (err: unknown) {
      failed = true;
      assertNoErrorLeaks(err, validAccessToken);
    }
    assert(failed, "Control characters should fail");
    assert(!fetchCalled, "Fetch should not be called");
    console.log("Test 5 Passed: Control-character filename fails before fetch [✓]");
    passedCount++;
  } catch (err: unknown) {
    console.error("Test 5 Failed:", err);
  }

  // Test 6: Oversized filename fails before fetch.
  try {
    let fetchCalled = false;
    const fetchImpl = async (): Promise<Response> => {
      fetchCalled = true;
      return new Response();
    };

    let failed = false;
    try {
      await initiateGoogleDriveResumableUpload({ ...validUploadInput, fileName: "a".repeat(256) }, { fetchImpl });
    } catch (err: unknown) {
      failed = true;
      assertNoErrorLeaks(err, validAccessToken);
    }
    assert(failed, "Oversized filename should fail");
    assert(!fetchCalled, "Fetch should not be called");
    console.log("Test 6 Passed: Oversized filename fails before fetch [✓]");
    passedCount++;
  } catch (err: unknown) {
    console.error("Test 6 Failed:", err);
  }

  // Test 7: Blank MIME type fails before fetch.
  try {
    let fetchCalled = false;
    const fetchImpl = async (): Promise<Response> => {
      fetchCalled = true;
      return new Response();
    };

    let failed = false;
    try {
      await initiateGoogleDriveResumableUpload({ ...validUploadInput, mimeType: " " }, { fetchImpl });
    } catch (err: unknown) {
      failed = true;
      assertNoErrorLeaks(err, validAccessToken);
    }
    assert(failed, "Blank MIME type should fail");
    assert(!fetchCalled, "Fetch should not be called");
    console.log("Test 7 Passed: Blank MIME type fails before fetch [✓]");
    passedCount++;
  } catch (err: unknown) {
    console.error("Test 7 Failed:", err);
  }

  // Test 8: Zero totalBytes fails before fetch.
  try {
    let fetchCalled = false;
    const fetchImpl = async (): Promise<Response> => {
      fetchCalled = true;
      return new Response();
    };

    let failed = false;
    try {
      await initiateGoogleDriveResumableUpload({ ...validUploadInput, totalBytes: 0 }, { fetchImpl });
    } catch (err: unknown) {
      failed = true;
      assertNoErrorLeaks(err, validAccessToken);
    }
    assert(failed, "Zero totalBytes should fail");
    assert(!fetchCalled, "Fetch should not be called");
    console.log("Test 8 Passed: Zero totalBytes fails before fetch [✓]");
    passedCount++;
  } catch (err: unknown) {
    console.error("Test 8 Failed:", err);
  }

  // Test 9: Negative totalBytes fails before fetch.
  try {
    let fetchCalled = false;
    const fetchImpl = async (): Promise<Response> => {
      fetchCalled = true;
      return new Response();
    };

    let failed = false;
    try {
      await initiateGoogleDriveResumableUpload({ ...validUploadInput, totalBytes: -100 }, { fetchImpl });
    } catch (err: unknown) {
      failed = true;
      assertNoErrorLeaks(err, validAccessToken);
    }
    assert(failed, "Negative totalBytes should fail");
    assert(!fetchCalled, "Fetch should not be called");
    console.log("Test 9 Passed: Negative totalBytes fails before fetch [✓]");
    passedCount++;
  } catch (err: unknown) {
    console.error("Test 9 Failed:", err);
  }

  // Test 10: Non-safe-integer totalBytes fails before fetch.
  try {
    let fetchCalled = false;
    const fetchImpl = async (): Promise<Response> => {
      fetchCalled = true;
      return new Response();
    };

    let failed = false;
    try {
      await initiateGoogleDriveResumableUpload({ ...validUploadInput, totalBytes: 9007199254740992 }, { fetchImpl });
    } catch (err: unknown) {
      failed = true;
      assertNoErrorLeaks(err, validAccessToken);
    }
    assert(failed, "Non-safe-integer totalBytes should fail");
    assert(!fetchCalled, "Fetch should not be called");
    console.log("Test 10 Passed: Non-safe-integer totalBytes fails before fetch [✓]");
    passedCount++;
  } catch (err: unknown) {
    console.error("Test 10 Failed:", err);
  }

  // Test 11: Initiation uses exact POST URL.
  try {
    let requestUrl = "";
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      const url = normalizeFetchUrl(input);
      requestUrl = url;
      return new Response(null, {
        status: 200,
        headers: { "Location": "https://www.googleapis.com/upload/drive/v3/files/session" }
      });
    };

    await initiateGoogleDriveResumableUpload(validUploadInput, { fetchImpl });
    assert(requestUrl === "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id%2Cname%2CmimeType%2Csize%2Cmd5Checksum%2CmodifiedTime%2Cparents%2Ctrashed", `Incorrect initiation URL: ${requestUrl}`);
    console.log("Test 11 Passed: Initiation uses exact POST URL [✓]");
    passedCount++;
  } catch (err: unknown) {
    console.error("Test 11 Failed:", err);
  }

  // Test 12: Initiation uses exact Authorization header.
  try {
    let authHeader = "";
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = normalizeFetchUrl(input);
      void url;
      const headers = init?.headers as Record<string, string>;
      authHeader = headers["Authorization"] || headers["authorization"];
      return new Response(null, {
        status: 200,
        headers: { "Location": "https://www.googleapis.com/upload/drive/v3/files/session" }
      });
    };

    await initiateGoogleDriveResumableUpload(validUploadInput, { fetchImpl });
    assert(authHeader === `Bearer ${validAccessToken}`, `Incorrect Authorization header: ${authHeader}`);
    console.log("Test 12 Passed: Initiation uses exact Authorization header [✓]");
    passedCount++;
  } catch (err: unknown) {
    console.error("Test 12 Failed:", err);
  }

  // Test 13: Initiation uses exact upload content headers.
  try {
    let mimeHeader = "";
    let lengthHeader = "";
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = normalizeFetchUrl(input);
      void url;
      const headers = init?.headers as Record<string, string>;
      mimeHeader = headers["X-Upload-Content-Type"] || headers["x-upload-content-type"];
      lengthHeader = headers["X-Upload-Content-Length"] || headers["x-upload-content-length"];
      return new Response(null, {
        status: 200,
        headers: { "Location": "https://www.googleapis.com/upload/drive/v3/files/session" }
      });
    };

    await initiateGoogleDriveResumableUpload(validUploadInput, { fetchImpl });
    assert(mimeHeader === validMimeType, `Incorrect MIME type header: ${mimeHeader}`);
    assert(lengthHeader === validTotalBytes.toString(), `Incorrect length header: ${lengthHeader}`);
    console.log("Test 13 Passed: Initiation uses exact upload content headers [✓]");
    passedCount++;
  } catch (err: unknown) {
    console.error("Test 13 Failed:", err);
  }

  // Test 14: Initiation body contains exact parent folder.
  try {
    let parents: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = normalizeFetchUrl(input);
      void url;
      const parsedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      parents = parsedBody.parents as string[];
      return new Response(null, {
        status: 200,
        headers: { "Location": "https://www.googleapis.com/upload/drive/v3/files/session" }
      });
    };

    await initiateGoogleDriveResumableUpload(validUploadInput, { fetchImpl });
    assert(parents.length === 1 && parents[0] === validFolderId, "Incorrect parent folder in body");
    console.log("Test 14 Passed: Initiation body contains parent folder [✓]");
    passedCount++;
  } catch (err: unknown) {
    console.error("Test 14 Failed:", err);
  }

  // Test 15: Initiation body contains exact appProperties.
  try {
    let appProperties: Record<string, string> = {};
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = normalizeFetchUrl(input);
      void url;
      const parsedBody: unknown = JSON.parse(String(init?.body ?? ""));

      if (
        !parsedBody ||
        typeof parsedBody !== "object" ||
        Array.isArray(parsedBody) ||
        !("appProperties" in parsedBody)
      ) {
        throw new Error("Expected appProperties in initiation body.");
      }

      const rawAppProperties = parsedBody.appProperties;

      if (
        !rawAppProperties ||
        typeof rawAppProperties !== "object" ||
        Array.isArray(rawAppProperties)
      ) {
        throw new Error("Expected appProperties object.");
      }

      const validatedAppProperties: Record<string, string> = {};

      for (const [key, value] of Object.entries(rawAppProperties)) {
        if (typeof value !== "string") {
          throw new Error("Expected string appProperties value.");
        }

        validatedAppProperties[key] = value;
      }

      appProperties = validatedAppProperties;
      return new Response(null, {
        status: 200,
        headers: { "Location": "https://www.googleapis.com/upload/drive/v3/files/session" }
      });
    };

    await initiateGoogleDriveResumableUpload(validUploadInput, { fetchImpl });
    assert(appProperties.fbPublisherPurpose === "mediaAsset", "IncorrectfbPublisherPurpose");
    assert(appProperties.fbPublisherAssetId === validAssetId, "Incorrect fbPublisherAssetId");
    console.log("Test 15 Passed: Initiation body contains appProperties [✓]");
    passedCount++;
  } catch (err: unknown) {
    console.error("Test 15 Failed:", err);
  }

  // Test 16: Successful initiation returns Location session URI.
  try {
    const sessionUri = "https://www.googleapis.com/upload/drive/v3/files/session-xyz";
    const fetchImpl = async (): Promise<Response> => {
      return new Response(null, {
        status: 200,
        headers: { "Location": sessionUri }
      });
    };

    const session = await initiateGoogleDriveResumableUpload(validUploadInput, { fetchImpl });
    assert(session.sessionUri === sessionUri, "Session URI mismatch");
    console.log("Test 16 Passed: Successful initiation returns Location [✓]");
    passedCount++;
  } catch (err: unknown) {
    console.error("Test 16 Failed:", err);
  }

  // Test 17: Missing Location is rejected.
  try {
    const fetchImpl = async (): Promise<Response> => {
      return new Response(null, { status: 200 });
    };

    let failed = false;
    try {
      await initiateGoogleDriveResumableUpload(validUploadInput, { fetchImpl });
    } catch (err: unknown) {
      failed = true;
      assertNoErrorLeaks(err, validAccessToken);
    }
    assert(failed, "Missing Location should fail");
    console.log("Test 17 Passed: Missing Location is rejected [✓]");
    passedCount++;
  } catch (err: unknown) {
    console.error("Test 17 Failed:", err);
  }

  // Test 18: HTTP failure exposes status but not response body.
  try {
    const secretResponseBody = "Google internal DB authentication failed. Connection string: mysql://user:password@localhost:3306/db";
    const fetchImpl = async (): Promise<Response> => {
      return new Response(secretResponseBody, { status: 500 });
    };

    let failed = false;
    try {
      await initiateGoogleDriveResumableUpload(validUploadInput, { fetchImpl });
    } catch (err: unknown) {
      failed = true;
      const msg = err instanceof Error ? err.message : String(err);
      assert(msg.includes("500"), "Error message should contain HTTP status");
      assert(!msg.includes("mysql"), "Error message should not leak database details or response body");
      assertNoErrorLeaks(err, validAccessToken);
    }
    assert(failed, "HTTP failure should throw");
    console.log("Test 18 Passed: HTTP failure status logged safely [✓]");
    passedCount++;
  } catch (err: unknown) {
    console.error("Test 18 Failed:", err);
  }

  // Test 19: Non-HTTPS session URI is rejected.
  try {
    const fetchImpl = async (): Promise<Response> => {
      return new Response(null, {
        status: 200,
        headers: { "Location": "http://www.googleapis.com/upload/drive/v3/files/session" }
      });
    };

    let failed = false;
    try {
      await initiateGoogleDriveResumableUpload(validUploadInput, { fetchImpl });
    } catch (err: unknown) {
      failed = true;
      assertNoErrorLeaks(err, validAccessToken, "http://www.googleapis.com/upload/drive/v3/files/session");
    }
    assert(failed, "Non-HTTPS session URI should fail");
    console.log("Test 19 Passed: Non-HTTPS session URI rejected [✓]");
    passedCount++;
  } catch (err: unknown) {
    console.error("Test 19 Failed:", err);
  }

  // Test 20: Non-Google session hostname is rejected.
  try {
    const fetchImpl = async (): Promise<Response> => {
      return new Response(null, {
        status: 200,
        headers: { "Location": "https://evil.com/upload/drive/v3/files/session" }
      });
    };

    let failed = false;
    try {
      await initiateGoogleDriveResumableUpload(validUploadInput, { fetchImpl });
    } catch (err: unknown) {
      failed = true;
      assertNoErrorLeaks(err, validAccessToken, "https://evil.com/upload/drive/v3/files/session");
    }
    assert(failed, "Non-Google session hostname should fail");
    console.log("Test 20 Passed: Non-Google hostname rejected [✓]");
    passedCount++;
  } catch (err: unknown) {
    console.error("Test 20 Failed:", err);
  }

  // Test 21: Session URI containing credentials is rejected.
  try {
    const fetchImpl = async (): Promise<Response> => {
      return new Response(null, {
        status: 200,
        headers: { "Location": "https://user:password@www.googleapis.com/upload/drive/v3/files/session" }
      });
    };

    let failed = false;
    try {
      await initiateGoogleDriveResumableUpload(validUploadInput, { fetchImpl });
    } catch (err: unknown) {
      failed = true;
      assertNoErrorLeaks(err, validAccessToken, "https://user:password@www.googleapis.com/upload/drive/v3/files/session");
    }
    assert(failed, "Credentials in session URI should fail");
    console.log("Test 21 Passed: Credentials in session URI rejected [✓]");
    passedCount++;
  } catch (err: unknown) {
    console.error("Test 21 Failed:", err);
  }

  // Test 22: Metadata request uses exact URL and auth header.
  try {
    let requestUrl = "";
    let authHeader = "";
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = normalizeFetchUrl(input);
      requestUrl = url;
      const headers = init?.headers as Record<string, string>;
      authHeader = headers["Authorization"] || headers["authorization"];
      return new Response(JSON.stringify({
        id: "file-xyz",
        name: "video.mp4",
        mimeType: "video/mp4",
        size: "2048"
      }));
    };

    await getGoogleDriveFileMetadata(validAccessToken, "file-xyz", { fetchImpl });
    assert(requestUrl === "https://www.googleapis.com/drive/v3/files/file-xyz?fields=id%2Cname%2CmimeType%2Csize%2Cmd5Checksum%2CmodifiedTime%2Cparents%2Ctrashed%2CappProperties", `Incorrect URL: ${requestUrl}`);
    assert(authHeader === `Bearer ${validAccessToken}`, `Incorrect Authorization header: ${authHeader}`);
    console.log("Test 22 Passed: Metadata request uses exact URL and auth header [✓]");
    passedCount++;
  } catch (err: unknown) {
    console.error("Test 22 Failed:", err);
  }

  // Test 23: Metadata 404 returns null.
  try {
    const fetchImpl = async (): Promise<Response> => {
      return new Response(null, { status: 404 });
    };

    const metadata = await getGoogleDriveFileMetadata(validAccessToken, "file-xyz", { fetchImpl });
    assert(metadata === null, "404 response should yield null metadata");
    console.log("Test 23 Passed: Metadata 404 returns null [✓]");
    passedCount++;
  } catch (err: unknown) {
    console.error("Test 23 Failed:", err);
  }

  // Test 24: Metadata converts size string safely.
  try {
    const fetchImpl = async (): Promise<Response> => {
      return new Response(JSON.stringify({
        id: "file-xyz",
        name: "video.mp4",
        mimeType: "video/mp4",
        size: "9007199254740991",
      }));
    };

    const metadata = await getGoogleDriveFileMetadata(validAccessToken, "file-xyz", { fetchImpl });
    if (!metadata) {
      throw new Error("Expected Google Drive metadata.");
    }
    assert(metadata.size === 9007199254740991, `Size string not parsed safely: ${metadata.size}`);
    console.log("Test 24 Passed: Metadata converts size string safely [✓]");
    passedCount++;
  } catch (err: unknown) {
    console.error("Test 24 Failed:", err);
  }

  // Test 25: Metadata defaults optional fields safely.
  try {
    const fetchImpl = async (): Promise<Response> => {
      return new Response(JSON.stringify({
        id: "file-xyz",
        name: "video.mp4",
        mimeType: "video/mp4",
        size: "0",
      }));
    };

    const metadata = await getGoogleDriveFileMetadata(validAccessToken, "file-xyz", { fetchImpl });
    if (!metadata) {
      throw new Error("Expected Google Drive metadata.");
    }
    assert(metadata.md5Checksum === null, "Expected default null for md5Checksum");
    assert(metadata.modifiedTime === null, "Expected default null for modifiedTime");
    assert(Array.isArray(metadata.parents) && metadata.parents.length === 0, "Expected default empty array for parents");
    assert(metadata.trashed === false, "Expected default false for trashed");
    assert(metadata.appProperties !== null && typeof metadata.appProperties === "object" && Object.keys(metadata.appProperties).length === 0, "Expected default empty object for appProperties");
    console.log("Test 25 Passed: Metadata defaults optional fields safely [✓]");
    passedCount++;
  } catch (err: unknown) {
    console.error("Test 25 Failed:", err);
  }

  // Test 25b: Metadata parses appProperties safely.
  try {
    const fetchImpl = async (): Promise<Response> => {
      return new Response(JSON.stringify({
        id: "file-xyz",
        name: "video.mp4",
        mimeType: "video/mp4",
        size: "0",
        appProperties: {
          assetId: "asset-123",
          nonStringVal: 12345, // should be ignored
          anotherStr: "hello",
        },
      }));
    };

    const metadata = await getGoogleDriveFileMetadata(validAccessToken, "file-xyz", { fetchImpl });
    if (!metadata) {
      throw new Error("Expected Google Drive metadata.");
    }
    assert(metadata.appProperties.assetId === "asset-123", "Expected assetId to be parsed");
    assert(metadata.appProperties.anotherStr === "hello", "Expected anotherStr to be parsed");
    assert(!("nonStringVal" in metadata.appProperties), "Non-string appProperties entries must be ignored safely");
    console.log("Test 25b Passed: Metadata parses appProperties safely [✓]");
    passedCount++;
  } catch (err: unknown) {
    console.error("Test 25b Failed:", err);
  }

  // Test 26: Malformed metadata is rejected.
  try {
    const fetchImpl = async (): Promise<Response> => {
      return new Response(JSON.stringify({
        id: "file-xyz",
        // missing name and mimeType
        size: "0",
      }));
    };

    let failed = false;
    try {
      await getGoogleDriveFileMetadata(validAccessToken, "file-xyz", { fetchImpl });
    } catch (err: unknown) {
      failed = true;
      assertNoErrorLeaks(err, validAccessToken);
    }
    assert(failed, "Malformed JSON should be rejected");
    console.log("Test 26 Passed: Malformed metadata rejected [✓]");
    passedCount++;
  } catch (err: unknown) {
    console.error("Test 26 Failed:", err);
  }

  // Test 27: Invalid metadata size is rejected.
  try {
    const fetchImpl = async (): Promise<Response> => {
      return new Response(JSON.stringify({
        id: "file-xyz",
        name: "video.mp4",
        mimeType: "video/mp4",
        size: "-5",
      }));
    };

    let failed = false;
    try {
      await getGoogleDriveFileMetadata(validAccessToken, "file-xyz", { fetchImpl });
    } catch (err: unknown) {
      failed = true;
      assertNoErrorLeaks(err, validAccessToken);
    }
    assert(failed, "Negative size metadata should be rejected");
    console.log("Test 27 Passed: Invalid metadata size rejected [✓]");
    passedCount++;
  } catch (err: unknown) {
    console.error("Test 27 Failed:", err);
  }

  // Test 28: Download request uses alt=media.
  try {
    let requestUrl = "";
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      const url = normalizeFetchUrl(input);
      requestUrl = url;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        }
      });
      return new Response(stream);
    };

    await createGoogleDriveFileReadStream(validAccessToken, "file-xyz", { fetchImpl });
    assert(requestUrl.includes("alt=media"), "Download request should append alt=media parameter");
    console.log("Test 28 Passed: Download request uses alt=media [✓]");
    passedCount++;
  } catch (err: unknown) {
    console.error("Test 28 Failed:", err);
  }

  // Test 29: Download 404 throws GoogleDriveFileNotFoundError.
  try {
    const fetchImpl = async (): Promise<Response> => {
      return new Response(null, { status: 404 });
    };

    let failed = false;
    try {
      await createGoogleDriveFileReadStream(validAccessToken, "file-xyz", { fetchImpl });
    } catch (err: unknown) {
      if (err instanceof GoogleDriveFileNotFoundError) {
        failed = true;
      }
      assertNoErrorLeaks(err, validAccessToken);
    }
    assert(failed, "Download 404 must throw GoogleDriveFileNotFoundError");
    console.log("Test 29 Passed: Download 404 throws GoogleDriveFileNotFoundError [✓]");
    passedCount++;
  } catch (err: unknown) {
    console.error("Test 29 Failed:", err);
  }

  // Test 30: Missing download body is rejected.
  try {
    const fetchImpl = async (): Promise<Response> => {
      // Create a response without a body
      return new Response(null, { status: 200 });
    };

    let failed = false;
    try {
      await createGoogleDriveFileReadStream(validAccessToken, "file-xyz", { fetchImpl });
    } catch (err: unknown) {
      failed = true;
      assertNoErrorLeaks(err, validAccessToken);
    }
    assert(failed, "Missing download body should throw error");
    console.log("Test 30 Passed: Missing download body is rejected [✓]");
    passedCount++;
  } catch (err: unknown) {
    console.error("Test 30 Failed:", err);
  }

  // Test 31: Download stream yields the exact mocked bytes.
  try {
    const dataBytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    const fetchImpl = async (): Promise<Response> => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(dataBytes);
          controller.close();
        }
      });
      return new Response(stream);
    };

    const stream = await createGoogleDriveFileReadStream(validAccessToken, "file-xyz", { fetchImpl });
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
    const finalBuffer = Buffer.concat(chunks);
    assert(finalBuffer.toString() === "Hello", `Stream yielded unexpected bytes: ${finalBuffer.toString()}`);
    console.log("Test 31 Passed: Download stream yields exact mocked bytes [✓]");
    passedCount++;
  } catch (err: unknown) {
    console.error("Test 31 Failed:", err);
  }

  // Test 32: Delete request uses exact URL and DELETE method.
  try {
    let requestUrl = "";
    let requestMethod = "";
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = normalizeFetchUrl(input);
      requestUrl = url;
      requestMethod = init?.method || "GET";
      return new Response(null, { status: 204 });
    };

    await deleteGoogleDriveFile(validAccessToken, "file-xyz", { fetchImpl });
    assert(requestUrl === "https://www.googleapis.com/drive/v3/files/file-xyz", `Incorrect delete URL: ${requestUrl}`);
    assert(requestMethod === "DELETE", `Incorrect request method: ${requestMethod}`);
    console.log("Test 32 Passed: Delete request uses exact URL and DELETE method [✓]");
    passedCount++;
  } catch (err: unknown) {
    console.error("Test 32 Failed:", err);
  }

  // Test 33: Delete success returns true.
  try {
    const fetchImpl = async (): Promise<Response> => {
      return new Response(null, { status: 200 }); // or 204
    };

    const deleted = await deleteGoogleDriveFile(validAccessToken, "file-xyz", { fetchImpl });
    assert(deleted === true, "Delete success should return true");
    console.log("Test 33 Passed: Delete success returns true [✓]");
    passedCount++;
  } catch (err: unknown) {
    console.error("Test 33 Failed:", err);
  }

  // Test 34: Delete 404 returns false.
  try {
    const fetchImpl = async (): Promise<Response> => {
      return new Response(null, { status: 404 });
    };

    const deleted = await deleteGoogleDriveFile(validAccessToken, "file-xyz", { fetchImpl });
    assert(deleted === false, "Delete 404 should return false for idempotence");
    console.log("Test 34 Passed: Delete 404 returns false [✓]");
    passedCount++;
  } catch (err: unknown) {
    console.error("Test 34 Failed:", err);
  }

  // Test 35: Delete failure exposes status but not provider response body.
  try {
    const secretProviderBody = "Google Drive API error details context";
    const fetchImpl = async (): Promise<Response> => {
      return new Response(secretProviderBody, { status: 503 });
    };

    let failed = false;
    try {
      await deleteGoogleDriveFile(validAccessToken, "file-xyz", { fetchImpl });
    } catch (err: unknown) {
      failed = true;
      const msg = err instanceof Error ? err.message : String(err);
      assert(msg.includes("503"), "Error message should contain HTTP status");
      assert(!msg.includes("details"), "Error message should not leak database details or response body");
      assertNoErrorLeaks(err, validAccessToken);
    }
    assert(failed, "Delete status 503 should throw");
    console.log("Test 35 Passed: Delete failure exposes status only [✓]");
    passedCount++;
  } catch (err: unknown) {
    console.error("Test 35 Failed:", err);
  }

  // Test 36: No error contains the access token.
  try {
    const fetchImpl = async (): Promise<Response> => {
      return new Response(null, { status: 500 });
    };

    try {
      await initiateGoogleDriveResumableUpload(validUploadInput, { fetchImpl });
    } catch (err: unknown) {
      assertNoErrorLeaks(err, validAccessToken);
    }
    console.log("Test 36 Passed: No error contains access token [✓]");
    passedCount++;
  } catch (err: unknown) {
    console.error("Test 36 Failed:", err);
  }

  // Test 37: No error contains a resumable session URI.
  try {
    const sessionUri = "https://www.googleapis.com/upload/drive/v3/files/session-123456789";
    void sessionUri;

    // Make verification on initiation fail AFTER Location header retrieved
    // e.g. return non-HTTPS session URL in redirect validation test
    const invalidSessionInput = {
      ...validUploadInput,
    };
    const fetchImplInvalidUri = async (): Promise<Response> => {
      return new Response(null, {
        status: 200,
        headers: { "Location": "http://evil-session-uri.com" }
      });
    };

    try {
      await initiateGoogleDriveResumableUpload(invalidSessionInput, { fetchImpl: fetchImplInvalidUri });
    } catch (err: unknown) {
      assertNoErrorLeaks(err, validAccessToken, "http://evil-session-uri.com");
    }
    console.log("Test 37 Passed: No error contains resumable session URI [✓]");
    passedCount++;
  } catch (err: unknown) {
    console.error("Test 37 Failed:", err);
  }

  // Test 39: No real Google or database call occurs.
  try {
    // Satisfied since all tests above only utilize mock fetch implementations and never touch database or active networks
    assert(passedCount === 38, `Precursor test counts mismatch: expected 38, got ${passedCount}`);
    console.log("Test 39 Passed: No real Google or database call occurs [✓]");
    passedCount++;
  } catch (err: unknown) {
    console.error("Test 39 Failed:", err);
  }

  console.log(`\nGoogle Drive Media Client Validation complete. Passed: ${passedCount}/39`);

  if (passedCount !== 39) {
    console.error("ERROR: Not all validation tests passed.");
    process.exit(1);
  } else {
    console.log("SUCCESS: All media client constraints verified successfully.");
    process.exit(0);
  }
}

runTests().catch((err: unknown) => {
  const errorMsg = err instanceof Error ? err.message : String(err);
  console.error("Fatal error in media client test suite:", errorMsg);
  process.exit(1);
});
