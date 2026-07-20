import assert from "node:assert/strict";

import {
  NextRequest,
} from "next/server";

import {
  handleGenerateThumbnailRequest,
  mapThumbnailGenerationError,
} from "../src/app/api/uploads/[id]/thumbnail/route";
import {
  ThumbnailGenerationError,
  type ThumbnailGenerationErrorCode,
} from "../src/lib/thumbnails/thumbnail-generation-service";

const assetId =
  "11111111-1111-4111-8111-111111111111";
const userId =
  "22222222-2222-4222-8222-222222222222";

function createRequest(
  body: string,
  contentType = "application/json",
): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/uploads/${assetId}/thumbnail`,
    {
      method: "POST",
      headers: {
        "content-type": contentType,
      },
      body,
    },
  );
}

async function readJson(
  response: Response,
): Promise<Record<string, unknown>> {
  return await response.json() as
    Record<string, unknown>;
}

async function testUnauthenticated():
  Promise<void> {
  let serviceCalls = 0;

  const response =
    await handleGenerateThumbnailRequest(
      createRequest(
        JSON.stringify({
          timestampSeconds: 2.5,
        }),
      ),
      {
        id: assetId,
      },
      {
        verifySession:
          async () => null,
        generateThumbnail:
          async () => {
            serviceCalls += 1;
            throw new Error(
              "Must not run.",
            );
          },
      },
    );

  assert.equal(response.status, 401);
  assert.equal(serviceCalls, 0);

  const body =
    await readJson(response);

  assert.equal(
    body.error,
    "UNAUTHENTICATED",
  );
}

async function testInvalidAssetId():
  Promise<void> {
  let serviceCalls = 0;

  const response =
    await handleGenerateThumbnailRequest(
      createRequest(
        JSON.stringify({
          timestampSeconds: 2.5,
        }),
      ),
      {
        id: "   ",
      },
      {
        verifySession:
          async () => ({
            id: userId,
          } as never),
        generateThumbnail:
          async () => {
            serviceCalls += 1;
            throw new Error(
              "Must not run.",
            );
          },
      },
    );

  assert.equal(response.status, 400);
  assert.equal(serviceCalls, 0);
}

async function testInvalidBodies():
  Promise<void> {
  const cases: Array<{
    request: NextRequest;
    expectedError: string;
  }> = [
    {
      request:
        createRequest(
          "not-json",
        ),
      expectedError:
        "INVALID_REQUEST",
    },
    {
      request:
        createRequest(
          JSON.stringify([]),
        ),
      expectedError:
        "INVALID_REQUEST",
    },
    {
      request:
        createRequest(
          JSON.stringify({
            timestampSeconds: -1,
          }),
        ),
      expectedError:
        "INVALID_THUMBNAIL_TIMESTAMP",
    },
    {
      request:
        createRequest(
          JSON.stringify({
            timestampSeconds: 2.5,
            source: "CUSTOM_UPLOAD",
          }),
        ),
      expectedError:
        "INVALID_REQUEST",
    },
    {
      request:
        createRequest(
          JSON.stringify({
            timestampSeconds: 2.5,
          }),
          "text/plain",
        ),
      expectedError:
        "INVALID_REQUEST",
    },
  ];

  for (const testCase of cases) {
    let serviceCalls = 0;

    const response =
      await handleGenerateThumbnailRequest(
        testCase.request,
        {
          id: assetId,
        },
        {
          verifySession:
            async () => ({
              id: userId,
            } as never),
          generateThumbnail:
            async () => {
              serviceCalls += 1;
              throw new Error(
                "Must not run.",
              );
            },
        },
      );

    assert.equal(
      response.status,
      400,
    );
    assert.equal(serviceCalls, 0);

    const body =
      await readJson(response);

    assert.equal(
      body.error,
      testCase.expectedError,
    );
  }
}

async function testBrowserInternalsRejected():
  Promise<void> {
  const forbiddenBodies = [
    {
      timestampSeconds: 2.5,
      userId,
    },
    {
      timestampSeconds: 2.5,
      storageUri:
        "gdrive://browser-value",
    },
    {
      timestampSeconds: 2.5,
      objectKey:
        "browser-drive-id",
    },
    {
      timestampSeconds: 2.5,
      bucket:
        "browser-folder-id",
    },
    {
      timestampSeconds: 2.5,
      idempotencyKey:
        "browser-key",
    },
  ];

  for (const bodyValue of
    forbiddenBodies) {
    let serviceCalls = 0;

    const response =
      await handleGenerateThumbnailRequest(
        createRequest(
          JSON.stringify(
            bodyValue,
          ),
        ),
        {
          id: assetId,
        },
        {
          verifySession:
            async () => ({
              id: userId,
            } as never),
          generateThumbnail:
            async () => {
              serviceCalls += 1;
              throw new Error(
                "Must not run.",
              );
            },
        },
      );

    assert.equal(response.status, 400);
    assert.equal(serviceCalls, 0);

    const responseBody =
      await readJson(response);

    assert.equal(
      responseBody.error,
      "INVALID_REQUEST",
    );
  }
}

async function testOversizedBody():
  Promise<void> {
  let serviceCalls = 0;

  const response =
    await handleGenerateThumbnailRequest(
      createRequest(
        JSON.stringify({
          timestampSeconds: 2.5,
          padding:
            "x".repeat(3000),
        }),
      ),
      {
        id: assetId,
      },
      {
        verifySession:
          async () => ({
            id: userId,
          } as never),
        generateThumbnail:
          async () => {
            serviceCalls += 1;
            throw new Error(
              "Must not run.",
            );
          },
      },
    );

  assert.equal(response.status, 400);
  assert.equal(serviceCalls, 0);
}

async function testSuccess():
  Promise<void> {
  let capturedInput:
    Record<string, unknown> | null =
    null;

  const response =
    await handleGenerateThumbnailRequest(
      createRequest(
        JSON.stringify({
          timestampSeconds: 2.5,
          source: "GEMINI_FRAME",
        }),
      ),
      {
        id: assetId,
      },
      {
        verifySession:
          async () => ({
            id: userId,
          } as never),
        generateThumbnail:
          async (input) => {
            capturedInput =
              input as unknown as
                Record<string, unknown>;

            return {
              isReused: false,
              thumbnail: {
                id:
                  "thumbnail-record",
                sourceUploadAssetId:
                  assetId,
                source:
                  "GEMINI_FRAME",
                timestampSeconds: 2.5,
                mimeType:
                  "image/jpeg",
                sizeBytes: 1234,
                createdAt:
                  "2026-07-20T10:00:00.000Z",
              },
            };
          },
      },
    );

  assert.equal(response.status, 201);
  assert.deepEqual(
    capturedInput,
    {
      userId,
      assetId,
      timestampSeconds: 2.5,
      source: "GEMINI_FRAME",
    },
  );

  const body =
    await readJson(response);

  assert.equal(body.success, true);
  assert.equal(body.reused, false);

  const thumbnail =
    body.thumbnail as
      Record<string, unknown>;

  assert.equal(
    thumbnail.id,
    "thumbnail-record",
  );
  assert.equal(
    thumbnail.source,
    "GEMINI_FRAME",
  );

  const serialized =
    JSON.stringify(body);

  for (const forbidden of [
    "storageUri",
    "objectKey",
    "bucket",
    "checksum",
    "fileId",
    "refreshToken",
    "accessToken",
    "resumable",
  ]) {
    assert.equal(
      serialized.includes(
        forbidden,
      ),
      false,
      forbidden,
    );
  }
}

async function testReusedResponse():
  Promise<void> {
  const response =
    await handleGenerateThumbnailRequest(
      createRequest(
        JSON.stringify({
          timestampSeconds: 2.5,
        }),
      ),
      {
        id: assetId,
      },
      {
        verifySession:
          async () => ({
            id: userId,
          } as never),
        generateThumbnail:
          async () => ({
            isReused: true,
            thumbnail: {
              id:
                "thumbnail-record",
              sourceUploadAssetId:
                assetId,
              source:
                "MANUAL_FRAME",
              timestampSeconds: 2.5,
              mimeType:
                "image/jpeg",
              sizeBytes: 1234,
              createdAt:
                "2026-07-20T10:00:00.000Z",
            },
          }),
      },
    );

  assert.equal(response.status, 200);

  const body =
    await readJson(response);

  assert.equal(body.reused, true);
}

async function testKnownErrorMapping():
  Promise<void> {
  const mappings: Array<[
    ThumbnailGenerationErrorCode,
    number,
  ]> = [
    ["INVALID_REQUEST", 400],
    ["UPLOAD_ASSET_NOT_FOUND", 404],
    ["UPLOAD_ASSET_NOT_VALIDATED", 409],
    ["UPLOAD_ASSET_DELETED", 409],
    ["UNSUPPORTED_STORAGE_PROVIDER", 422],
    ["VIDEO_DURATION_MISSING", 422],
    ["INVALID_THUMBNAIL_TIMESTAMP", 400],
    ["THUMBNAIL_TIMESTAMP_OUT_OF_RANGE", 422],
    ["THUMBNAIL_SOURCE_TOO_LARGE", 413],
    ["SOURCE_VIDEO_UNAVAILABLE", 409],
    ["GOOGLE_DRIVE_NOT_CONNECTED", 503],
    ["FFMPEG_NOT_AVAILABLE", 503],
    ["THUMBNAIL_GENERATION_FAILED", 502],
    ["THUMBNAIL_PERSISTENCE_FAILED", 500],
  ];

  for (const [
    code,
    expectedStatus,
  ] of mappings) {
    const response =
      await handleGenerateThumbnailRequest(
        createRequest(
          JSON.stringify({
            timestampSeconds: 2.5,
          }),
        ),
        {
          id: assetId,
        },
        {
          verifySession:
            async () => ({
              id: userId,
            } as never),
          generateThumbnail:
            async () => {
              throw new ThumbnailGenerationError(
                code,
                `Safe ${code} message.`,
              );
            },
        },
      );

    assert.equal(
      response.status,
      expectedStatus,
      code,
    );

    const body =
      await readJson(response);

    assert.equal(body.error, code);
    assert.equal(
      body.message,
      `Safe ${code} message.`,
    );
  }
}

async function testUnknownErrorSanitized():
  Promise<void> {
  const originalConsoleError =
    console.error;
  let consoleErrorCalls = 0;

  console.error = () => {
    consoleErrorCalls += 1;
  };

  try {
    const response =
      await handleGenerateThumbnailRequest(
        createRequest(
          JSON.stringify({
            timestampSeconds: 2.5,
          }),
        ),
        {
          id: assetId,
        },
        {
          verifySession:
            async () => ({
              id: userId,
            } as never),
          generateThumbnail:
            async () => {
              throw new Error(
                "Secret OAuth token detail.",
              );
            },
        },
      );

    assert.equal(response.status, 500);

    const body =
      await readJson(response);

    assert.equal(
      body.error,
      "INTERNAL_SERVER_ERROR",
    );
    assert.equal(
      JSON.stringify(body).includes(
        "OAuth",
      ),
      false,
    );
    assert.equal(consoleErrorCalls, 1);
  } finally {
    console.error =
      originalConsoleError;
  }
}

function testDirectMapping():
  void {
  const mapped =
    mapThumbnailGenerationError(
      new ThumbnailGenerationError(
        "GOOGLE_DRIVE_NOT_CONNECTED",
        "Drive is required.",
      ),
    );

  assert.equal(mapped.status, 503);
  assert.equal(
    mapped.body.error,
    "GOOGLE_DRIVE_NOT_CONNECTED",
  );
}

async function main(): Promise<void> {
  await testUnauthenticated();
  await testInvalidAssetId();
  await testInvalidBodies();
  await testBrowserInternalsRejected();
  await testOversizedBody();
  await testSuccess();
  await testReusedResponse();
  await testKnownErrorMapping();
  await testUnknownErrorSanitized();
  testDirectMapping();

  console.log(
    "PHASE6I_THUMBNAIL_GENERATION_API_TESTS=PASSED",
  );
}

void main().catch(
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  },
);
