import {
  Readable,
} from "node:stream";
import {
  readFileSync,
} from "node:fs";
import {
  FACEBOOK_THUMBNAIL_PUBLISHING_EXPERIMENTAL_ACK,
  FACEBOOK_THUMBNAIL_PUBLISHING_MODE_EXPERIMENTAL_REGULAR_VIDEO_THUMB,
  getFacebookThumbnailPublishingCapability,
} from "../src/lib/facebook/facebook-thumbnail-publishing-capability";
import {
  FacebookPublishingService,
} from "../src/lib/facebook/facebook-publishing-service";
import {
  resolvePublishingThumbnailSource,
  type PublishingThumbnailDatabaseRecord,
  type ResolvePublishingThumbnailDependencies,
} from "../src/lib/thumbnails/thumbnail-publishing-source";

function assert(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) {
    throw new Error(
      `Test Assertion Failed: ${message}`,
    );
  }
}

async function assertRejects(
  operation: () => Promise<unknown>,
  expectedMessage: string,
): Promise<void> {
  let thrown: unknown;

  try {
    await operation();
  } catch (error) {
    thrown = error;
  }

  assert(
    thrown instanceof Error,
    `Expected rejection containing ${expectedMessage}.`,
  );

  assert(
    thrown.message.includes(expectedMessage),
    `Expected ${JSON.stringify(expectedMessage)}, received ${JSON.stringify(thrown.message)}.`,
  );
}

function createThumbnailRecord(
  overrides:
    Partial<PublishingThumbnailDatabaseRecord> = {},
): PublishingThumbnailDatabaseRecord {
  return {
    id: "thumbnail-asset-id",
    userId: "owner-user-id",
    sourceUploadAssetId: "source-upload-id",
    provider: "GOOGLE_DRIVE",
    bucket: "thumbnail-folder-id",
    objectKey: "thumbnail-drive-file-id",
    storageUri:
      "gdrive://thumbnail-drive-file-id",
    originalName: "thumbnail.jpg",
    mimeType: "image/jpeg",
    sizeBytes: BigInt(4),
    deletedAt: null,
    ...overrides,
  };
}

function createResolverDependencies(
  record:
    PublishingThumbnailDatabaseRecord | null,
  bytes = Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xd9,
  ]),
): {
  readonly dependencies:
    ResolvePublishingThumbnailDependencies;
  readonly calls: {
    find: number;
    stream: number;
  };
} {
  const calls = {
    find: 0,
    stream: 0,
  };

  return {
    calls,
    dependencies: {
      findThumbnailAsset: async (input) => {
        calls.find += 1;

        assert(
          input.ownerUserId ===
            "owner-user-id",
          "Resolver must search by owner.",
        );

        assert(
          input.sourceUploadAssetId ===
            "source-upload-id",
          "Resolver must search by source upload.",
        );

        assert(
          input.thumbnailAssetId ===
            "thumbnail-asset-id",
          "Resolver must search by thumbnail ID.",
        );

        return record;
      },
      createDownloadStream: async (
        ownerUserId,
        thumbnail,
      ) => {
        calls.stream += 1;

        assert(
          ownerUserId === "owner-user-id",
          "Download must remain owner scoped.",
        );

        assert(
          thumbnail.objectKey ===
            "thumbnail-drive-file-id",
          "The server must resolve the Drive file ID.",
        );

        return Readable.from(bytes);
      },
      maxBytes: 10 * 1024 * 1024,
    },
  };
}

async function runCapabilityTests():
  Promise<void> {
  console.log(
    "Facebook thumbnail capability tests...",
  );

  const defaultCapability =
    getFacebookThumbnailPublishingCapability(
      {},
    );

  assert(
    defaultCapability.enabled === false,
    "Thumbnail publishing must be disabled by default.",
  );

  assert(
    defaultCapability.regularVideoSupported ===
      false,
    "Disabled mode must not support regular videos.",
  );

  assert(
    defaultCapability.reelSupported === false,
    "Reel thumbnail publishing must remain unsupported.",
  );

  const missingAcknowledgement =
    getFacebookThumbnailPublishingCapability({
      FACEBOOK_VIDEO_THUMBNAIL_PUBLISHING_MODE:
        FACEBOOK_THUMBNAIL_PUBLISHING_MODE_EXPERIMENTAL_REGULAR_VIDEO_THUMB,
    });

  assert(
    missingAcknowledgement.enabled === false,
    "The experimental mode must require a separate acknowledgement.",
  );

  assert(
    missingAcknowledgement.reason ===
      "MISSING_EXPERIMENTAL_ACKNOWLEDGEMENT",
    "Missing acknowledgement must be explicit.",
  );

  const enabled =
    getFacebookThumbnailPublishingCapability({
      FACEBOOK_VIDEO_THUMBNAIL_PUBLISHING_MODE:
        FACEBOOK_THUMBNAIL_PUBLISHING_MODE_EXPERIMENTAL_REGULAR_VIDEO_THUMB,
      FACEBOOK_VIDEO_THUMBNAIL_PUBLISHING_ACK:
        FACEBOOK_THUMBNAIL_PUBLISHING_EXPERIMENTAL_ACK,
    });

  assert(
    enabled.enabled === true,
    "The exact mode and acknowledgement should enable the experimental adapter.",
  );

  assert(
    enabled.regularVideoSupported === true,
    "The experimental adapter should be regular-video-only.",
  );

  assert(
    enabled.reelSupported === false,
    "The experimental adapter must not claim Reel support.",
  );

  console.log(
    "  ✓ default-off and two-part acknowledgement gate verified",
  );
}

async function runResolverTests():
  Promise<void> {
  console.log(
    "Server-side thumbnail resolver tests...",
  );

  {
    const setup =
      createResolverDependencies(
        createThumbnailRecord(),
      );

    const result =
      await resolvePublishingThumbnailSource(
        {
          ownerUserId: "owner-user-id",
          sourceUploadAssetId:
            "source-upload-id",
          thumbnailAssetId:
            "thumbnail-asset-id",
        },
        setup.dependencies,
      );

    assert(
      setup.calls.find === 1 &&
        setup.calls.stream === 1,
      "Valid resolution must perform one scoped lookup and one download.",
    );

    assert(
      result.fileName ===
        "thumbnail.jpg" &&
        result.mimeType ===
          "image/jpeg" &&
        result.sizeBytes === 4,
      "Resolver must return validated publishing metadata.",
    );

    assert(
      JSON.stringify(
        Object.keys(result).sort(),
      ) ===
        JSON.stringify([
          "fileName",
          "mimeType",
          "sizeBytes",
          "stream",
        ]),
      "Resolver output must not expose storage URI, Drive ID, bucket, or ownership fields.",
    );

    result.stream.destroy();
  }

  {
    const setup =
      createResolverDependencies(null);

    await assertRejects(
      async () => {
        await resolvePublishingThumbnailSource(
          {
            ownerUserId: "owner-user-id",
            sourceUploadAssetId:
              "source-upload-id",
            thumbnailAssetId:
              "thumbnail-asset-id",
          },
          setup.dependencies,
        );
      },
      "THUMBNAIL_PUBLISHING_ASSET_NOT_FOUND",
    );

    assert(
      setup.calls.stream === 0,
      "Missing thumbnails must fail before download.",
    );
  }

  const invalidCases:
    ReadonlyArray<{
      readonly record:
        PublishingThumbnailDatabaseRecord;
      readonly expected: string;
    }> = [
      {
        record: createThumbnailRecord({
          userId: "other-user-id",
        }),
        expected:
          "THUMBNAIL_PUBLISHING_OWNERSHIP_MISMATCH",
      },
      {
        record: createThumbnailRecord({
          sourceUploadAssetId:
            "other-source-upload-id",
        }),
        expected:
          "THUMBNAIL_PUBLISHING_SOURCE_MISMATCH",
      },
      {
        record: createThumbnailRecord({
          deletedAt: new Date(),
        }),
        expected:
          "THUMBNAIL_PUBLISHING_ASSET_DELETED",
      },
      {
        record: createThumbnailRecord({
          provider: "R2",
        }),
        expected:
          "THUMBNAIL_PUBLISHING_UNSUPPORTED_PROVIDER",
      },
      {
        record: createThumbnailRecord({
          storageUri:
            "gdrive://different-file-id",
        }),
        expected:
          "THUMBNAIL_PUBLISHING_INVALID_STORAGE_REFERENCE",
      },
      {
        record: createThumbnailRecord({
          mimeType: "image/png",
        }),
        expected:
          "THUMBNAIL_PUBLISHING_UNSUPPORTED_MIME_TYPE",
      },
      {
        record: createThumbnailRecord({
          sizeBytes:
            BigInt(11 * 1024 * 1024),
        }),
        expected:
          "THUMBNAIL_PUBLISHING_INVALID_SIZE",
      },
    ];

  for (const invalidCase of invalidCases) {
    const setup =
      createResolverDependencies(
        invalidCase.record,
      );

    await assertRejects(
      async () => {
        await resolvePublishingThumbnailSource(
          {
            ownerUserId: "owner-user-id",
            sourceUploadAssetId:
              "source-upload-id",
            thumbnailAssetId:
              "thumbnail-asset-id",
          },
          setup.dependencies,
        );
      },
      invalidCase.expected,
    );

    assert(
      setup.calls.stream === 0,
      `${invalidCase.expected} must fail before download.`,
    );
  }

  console.log(
    "  ✓ ownership, source, deletion, provider, MIME, size, and storage-reference checks verified",
  );
}

async function runExperimentalAdapterTests():
  Promise<void> {
  console.log(
    "Experimental Meta adapter tests...",
  );

  const originalFetch =
    globalThis.fetch;

  try {
    {
      const thumbnailBytes =
        Buffer.from([
          0xff,
          0xd8,
          0x00,
          0xff,
          0xd9,
        ]);

      let requestUrl = "";
      let requestInit:
        RequestInit | undefined;

      globalThis.fetch =
        async (
          input:
            string | URL | Request,
          init?: RequestInit,
        ) => {
          requestUrl =
            input.toString();
          requestInit = init;

          return new Response(
            JSON.stringify({
              success: true,
            }),
            {
              status: 200,
              headers: {
                "content-type":
                  "application/json",
              },
            },
          );
        };

      await FacebookPublishingService
        .finishUploadSessionWithExperimentalThumbnail(
          "page-id",
          "secret-page-token",
          "upload-session-id",
          "Video title",
          "Video caption",
          "#one #two",
          {
            fileName:
              "thumbnail.jpg",
            mimeType:
              "image/jpeg",
            sizeBytes:
              thumbnailBytes.length,
            stream:
              Readable.from(
                thumbnailBytes,
              ),
          },
        );

      assert(
        requestUrl.endsWith(
          "/page-id/videos",
        ),
        "Experimental adapter must use the existing Page videos endpoint.",
      );

      assert(
        requestInit?.method === "POST",
        "Experimental adapter must use POST.",
      );

      const headers =
        requestInit?.headers as
          Record<string, string>;

      assert(
        headers[
          "Content-Type"
        ]?.startsWith(
          "multipart/form-data; boundary=",
        ),
        "Experimental adapter must send multipart data.",
      );

      assert(
        Buffer.isBuffer(
          requestInit?.body,
        ),
        "Experimental adapter must build an exact binary request body.",
      );

      const body =
        requestInit?.body as Buffer;

      const bodyText =
        body.toString(
          "latin1",
        );

      assert(
        bodyText.includes(
          'name="upload_phase"',
        ) &&
          bodyText.includes(
            "finish",
          ),
        "Finish phase must remain present.",
      );

      assert(
        bodyText.includes(
          'name="upload_session_id"',
        ) &&
          bodyText.includes(
            "upload-session-id",
          ),
        "Upload session ID must remain present.",
      );

      assert(
        bodyText.includes(
          'name="thumb"; filename="thumbnail.jpg"',
        ) &&
          bodyText.includes(
            "Content-Type: image/jpeg",
          ),
        "The experimental historical thumb field must contain a JPEG file part.",
      );

      assert(
        body.indexOf(
          thumbnailBytes,
        ) >= 0,
        "Thumbnail raw bytes must be present without base64 conversion.",
      );

      assert(
        !bodyText.includes(
          thumbnailBytes.toString(
            "base64",
          ),
        ),
        "Thumbnail bytes must not be base64 encoded.",
      );
    }

    {
      let fetchCalled = false;

      globalThis.fetch =
        async () => {
          fetchCalled = true;

          return new Response(
            "{}",
            {
              status: 200,
            },
          );
        };

      await assertRejects(
        async () => {
          await FacebookPublishingService
            .finishUploadSessionWithExperimentalThumbnail(
              "page-id",
              "secret-page-token",
              "upload-session-id",
              "Title",
              "Caption",
              null,
              {
                fileName:
                  "thumbnail.jpg",
                mimeType:
                  "image/jpeg",
                sizeBytes:
                  5,
                stream:
                  Readable.from(
                    Buffer.from([
                      1,
                      2,
                      3,
                      4,
                    ]),
                  ),
              },
            );
        },
        "META_THUMBNAIL_SIZE_MISMATCH",
      );

      assert(
        fetchCalled === false,
        "Size mismatch must fail before any Meta request.",
      );
    }

    {
      const token =
        "do-not-leak-this-token";

      globalThis.fetch =
        async () => {
          return new Response(
            JSON.stringify({
              error: {
                message:
                  "Unsupported parameter",
                code: 100,
              },
            }),
            {
              status: 400,
              headers: {
                "content-type":
                  "application/json",
              },
            },
          );
        };

      let thrown: unknown;

      try {
        await FacebookPublishingService
          .finishUploadSessionWithExperimentalThumbnail(
            "page-id",
            token,
            "upload-session-id",
            "Title",
            "Caption",
            null,
            {
              fileName:
                "thumbnail.jpg",
              mimeType:
                "image/jpeg",
              sizeBytes:
                4,
              stream:
                Readable.from(
                  Buffer.from([
                    1,
                    2,
                    3,
                    4,
                  ]),
                ),
            },
          );
      } catch (error) {
        thrown = error;
      }

      assert(
        thrown instanceof Error,
        "Meta failure must throw.",
      );

      assert(
        !thrown.message.includes(
          token,
        ),
        "Meta errors must not expose the Page token.",
      );
    }
  } finally {
    globalThis.fetch =
      originalFetch;
  }

  console.log(
    "  ✓ multipart raw JPEG adapter, pre-request validation, and token-safe errors verified",
  );
}

function runWorkerBoundaryTests():
  void {
  console.log(
    "Worker capability-boundary checks...",
  );

  const workerSource =
    readFileSync(
      "src/lib/job-worker.ts",
      "utf8",
    );

  const capabilityIndex =
    workerSource.indexOf(
      "getFacebookThumbnailPublishingCapability",
    );

  const resolverIndex =
    workerSource.indexOf(
      "resolvePublishingThumbnailSource",
    );

  assert(
    capabilityIndex >= 0 &&
      resolverIndex >
        capabilityIndex,
    "The worker must evaluate the capability before resolving or downloading a thumbnail.",
  );

  assert(
    workerSource.includes(
      "!thumbnailCapability.enabled",
    ) &&
      workerSource.includes(
        "finishUploadSessionWithExperimentalThumbnail",
      ),
    "The worker must preserve a disabled fallback and isolate the experimental adapter.",
  );

  assert(
    workerSource.includes(
      "current Meta Reel publishing flow has no enabled thumbnail capability",
    ),
    "The worker must not claim Reel thumbnail support.",
  );

  assert(
    workerSource.includes(
      "THUMBNAIL_PUBLISHING_FAILED",
    ),
    "Invalid experimental thumbnail failures must be classified explicitly.",
  );

  console.log(
    "  ✓ capability-first resolution, default fallback, Reel exclusion, and failure classification verified",
  );
}

async function main():
  Promise<void> {
  await runCapabilityTests();
  await runResolverTests();
  await runExperimentalAdapterTests();
  runWorkerBoundaryTests();

  console.log(
    "PHASE6I_FACEBOOK_THUMBNAIL_PUBLISHING_FOUNDATION_TESTS=PASSED",
  );

  console.log(
    "No real database, Google Drive, Meta, Gemini, FFmpeg, or production call occurred.",
  );
}

main().catch(
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
