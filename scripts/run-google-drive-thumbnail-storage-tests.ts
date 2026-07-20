import assert from "node:assert/strict";
import {
  GoogleDriveThumbnailUploadInput,
  uploadGoogleDriveThumbnail,
} from "../src/lib/google-drive/google-drive-thumbnail-client";
import {
  GoogleDriveThumbnailStorage,
} from "../src/lib/google-drive/google-drive-thumbnail-storage";

async function main(): Promise<void> {
  const captured: Array<{
    url: string;
    init?: RequestInit;
  }> = [];

  const fakeFetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      input instanceof Request
        ? input.url
        : input.toString();

    captured.push({
      url,
      init,
    });

    return new Response(
      JSON.stringify({
        id: "drive-thumbnail-123",
        name: "thumbnail-video-123-2500.jpg",
        mimeType: "image/jpeg",
        size: "6",
        md5Checksum: "checksum-123",
        parents: ["folder-123"],
        trashed: false,
        appProperties: {
          fbPublisherPurpose:
            "thumbnailAsset",
          fbPublisherSourceVideoAssetId:
            "video-123",
          fbPublisherThumbnailSource:
            "GEMINI_FRAME",
          fbPublisherThumbnailTimestampMs:
            "2500",
        },
      }),
      {
        status: 200,
        headers: {
          "Content-Type":
            "application/json",
        },
      },
    );
  }) as typeof fetch;

  const jpegBytes =
    Buffer.from([
      0xff,
      0xd8,
      0x01,
      0x02,
      0xff,
      0xd9,
    ]);

  const uploaded =
    await uploadGoogleDriveThumbnail(
      {
        accessToken: "access-token",
        folderId: "folder-123",
        sourceVideoAssetId:
          "video-123",
        fileName:
          "thumbnail-video-123-2500.jpg",
        mimeType: "image/jpeg",
        bytes: jpegBytes,
        source: "GEMINI_FRAME",
        timestampMs: 2500,
      },
      {
        fetchImpl: fakeFetch,
      },
    );

  assert.equal(
    uploaded.id,
    "drive-thumbnail-123",
  );

  assert.equal(
    uploaded.size,
    6,
  );

  assert.equal(
    captured.length,
    1,
  );

  const request =
    captured[0];

  const requestUrl =
    new URL(request.url);

  assert.equal(
    requestUrl.hostname,
    "www.googleapis.com",
  );

  assert.equal(
    requestUrl.searchParams.get(
      "uploadType",
    ),
    "multipart",
  );

  const headers =
    new Headers(
      request.init?.headers,
    );

  assert.equal(
    headers.get("Authorization"),
    "Bearer access-token",
  );

  assert.match(
    headers.get("Content-Type") || "",
    /^multipart\/related; boundary=/,
  );

  const requestBody =
    request.init?.body;

  assert.ok(
    Buffer.isBuffer(requestBody),
  );

  const bodyText =
    (requestBody as Buffer).toString(
      "latin1",
    );

  assert.match(
    bodyText,
    /thumbnailAsset/,
  );

  assert.match(
    bodyText,
    /video-123/,
  );

  assert.match(
    bodyText,
    /GEMINI_FRAME/,
  );

  assert.match(
    bodyText,
    /2500/,
  );

  assert.equal(
    bodyText.includes(
      jpegBytes.toString("latin1"),
    ),
    true,
  );

  let capturedStorageUpload:
    | GoogleDriveThumbnailUploadInput
    | null = null;

  const stored =
    await GoogleDriveThumbnailStorage.store(
      "user-123",
      {
        sourceVideoAssetId:
          "video-123",
        jpegBytes,
        source: "GEMINI_FRAME",
        timestampMs: 2500,
      },
      {
        getActiveConnection:
          async () => ({
            id: "connection-123",
            userId: "user-123",
            encryptedRefreshToken:
              "encrypted-token",
            refreshTokenKeyVersion:
              "1",
            googleAccountEmail:
              "owner@example.com",
            driveFolderId:
              "folder-123",
            connectedAt: new Date(),
            updatedAt: new Date(),
            revokedAt: null,
          }),
        getGoogleDriveConfig:
          () => ({
            clientId: "client-id",
            clientSecret:
              "client-secret",
            redirectUri:
              "https://example.com/api/auth/google-drive/callback",
            encryptionKey:
              "a".repeat(64),
            ownerUserId:
              "user-123",
          }),
        decryptRefreshToken:
          () => "refresh-token",
        getAccessToken:
          async (refreshToken) => {
            assert.equal(
              refreshToken,
              "refresh-token",
            );

            return "access-token";
          },
        uploadThumbnail:
          async (input) => {
            capturedStorageUpload =
              input;

            return {
              id:
                "drive-thumbnail-456",
              name: input.fileName,
              mimeType:
                input.mimeType,
              size:
                input.bytes.length,
              md5Checksum:
                "checksum-456",
              parents: [
                input.folderId,
              ],
              trashed: false,
              appProperties: {},
            };
          },
      },
    );

  assert.equal(
    stored.fileId,
    "drive-thumbnail-456",
  );

  assert.equal(
    stored.storageUri,
    "gdrive://drive-thumbnail-456",
  );

  assert.equal(
    stored.folderId,
    "folder-123",
  );

  assert.equal(
    stored.timestampMs,
    2500,
  );

  assert.ok(capturedStorageUpload);

  const verifiedStorageUpload =
    capturedStorageUpload as GoogleDriveThumbnailUploadInput;

  assert.equal(
    verifiedStorageUpload.accessToken,
    "access-token",
  );

  assert.equal(
    verifiedStorageUpload.folderId,
    "folder-123",
  );

  assert.equal(
    verifiedStorageUpload.sourceVideoAssetId,
    "video-123",
  );

  await assert.rejects(
    async () =>
      await GoogleDriveThumbnailStorage.store(
        "user-123",
        {
          sourceVideoAssetId:
            "video-123",
          jpegBytes,
          source:
            "GEMINI_FRAME",
          timestampMs: 2500,
        },
        {
          getActiveConnection:
            async () => null,
        },
      ),
    /GOOGLE_DRIVE_CONNECTION_REVOKED/,
  );

  await assert.rejects(
    async () =>
      await GoogleDriveThumbnailStorage.store(
        "user-123",
        {
          sourceVideoAssetId:
            "video-123",
          jpegBytes,
          source:
            "GEMINI_FRAME",
          timestampMs: 2500,
        },
        {
          getActiveConnection:
            async () => ({
              id:
                "connection-123",
              userId: "user-123",
              encryptedRefreshToken:
                "encrypted-token",
              refreshTokenKeyVersion:
                "1",
              googleAccountEmail:
                null,
              driveFolderId: null,
              connectedAt:
                new Date(),
              updatedAt:
                new Date(),
              revokedAt: null,
            }),
        },
      ),
    /GOOGLE_DRIVE_FOLDER_MISSING/,
  );

  const invalidResponseFetch =
    (async () =>
      new Response(
        JSON.stringify({
          name: "missing-id.jpg",
        }),
        {
          status: 200,
          headers: {
            "Content-Type":
              "application/json",
          },
        },
      )) as typeof fetch;

  await assert.rejects(
    async () =>
      await uploadGoogleDriveThumbnail(
        {
          accessToken:
            "access-token",
          folderId:
            "folder-123",
          sourceVideoAssetId:
            "video-123",
          fileName:
            "thumbnail.jpg",
          mimeType:
            "image/jpeg",
          bytes:
            jpegBytes,
          source:
            "GEMINI_FRAME",
          timestampMs:
            2500,
        },
        {
          fetchImpl:
            invalidResponseFetch,
        },
      ),
    /missing the file ID/,
  );

  console.log(
    "PHASE6I_GOOGLE_DRIVE_THUMBNAIL_STORAGE_TESTS=PASSED",
  );
}

void main().catch(
  (error: unknown) => {
    console.error(
      "PHASE6I_GOOGLE_DRIVE_THUMBNAIL_STORAGE_TESTS=FAILED",
    );

    console.error(
      error instanceof Error
        ? error.message
        : String(error),
    );

    process.exitCode = 1;
  },
);
