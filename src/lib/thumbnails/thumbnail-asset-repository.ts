import "server-only";
import {
  createHash,
} from "node:crypto";
import type {
  StoredGoogleDriveThumbnail,
} from "../google-drive/google-drive-thumbnail-storage";
import type {
  GoogleDriveThumbnailSource,
} from "../google-drive/google-drive-thumbnail-client";

export interface OwnedThumbnailSourceAsset {
  readonly id: string;
  readonly userId: string;
  readonly status: string;
  readonly objectDeletedAt: Date | null;
}

export interface ThumbnailAssetRecord {
  readonly id: string;
  readonly userId: string;
  readonly sourceUploadAssetId: string;
  readonly provider: string;
  readonly bucket: string;
  readonly objectKey: string;
  readonly storageUri: string;
  readonly originalName: string;
  readonly mimeType: string;
  readonly sizeBytes: bigint;
  readonly checksum: string;
  readonly source: GoogleDriveThumbnailSource;
  readonly timestampMs: number | null;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateThumbnailAssetRecordInput {
  readonly userId: string;
  readonly sourceUploadAssetId: string;
  readonly provider: "GOOGLE_DRIVE";
  readonly bucket: string;
  readonly objectKey: string;
  readonly storageUri: string;
  readonly originalName: string;
  readonly mimeType: string;
  readonly sizeBytes: bigint;
  readonly checksum: string;
  readonly source: GoogleDriveThumbnailSource;
  readonly timestampMs: number | null;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
}

export interface ThumbnailAssetPersistence {
  readonly findValidatedOwnedSourceAsset: (
    ownerUserId: string,
    sourceUploadAssetId: string,
  ) => Promise<OwnedThumbnailSourceAsset | null>;
  readonly findByOwnerAndIdempotencyKey: (
    ownerUserId: string,
    idempotencyKey: string,
  ) => Promise<ThumbnailAssetRecord | null>;
  readonly create: (
    input: CreateThumbnailAssetRecordInput,
  ) => Promise<ThumbnailAssetRecord>;
}

export interface PersistStoredThumbnailAssetInput {
  readonly ownerUserId: string;
  readonly sourceUploadAssetId: string;
  readonly storedThumbnail: StoredGoogleDriveThumbnail;
}

export interface PersistStoredThumbnailAssetResult {
  readonly thumbnailAsset: ThumbnailAssetRecord;
  readonly isReused: boolean;
}

function requireNonEmpty(
  value: string,
  name: string,
  maxLength: number,
): string {
  const trimmed = value.trim();

  if (!trimmed) {
    throw new Error(`${name} is required.`);
  }

  if (/[\x00-\x1F\x7F]/.test(trimmed)) {
    throw new Error(
      `${name} contains control characters.`,
    );
  }

  if (trimmed.length > maxLength) {
    throw new Error(
      `${name} exceeds ${maxLength} characters.`,
    );
  }

  return trimmed;
}

function validateSourceAndTimestamp(
  source: GoogleDriveThumbnailSource,
  timestampMs: number | null,
): void {
  if (
    source !== "GEMINI_FRAME" &&
    source !== "MANUAL_FRAME" &&
    source !== "CUSTOM_UPLOAD"
  ) {
    throw new Error(
      "Unsupported thumbnail source.",
    );
  }

  if (
    timestampMs !== null &&
    (
      !Number.isSafeInteger(timestampMs) ||
      timestampMs < 0
    )
  ) {
    throw new Error(
      "Thumbnail timestamp must be a non-negative safe integer or null.",
    );
  }

  if (
    source === "CUSTOM_UPLOAD" &&
    timestampMs !== null
  ) {
    throw new Error(
      "Custom-upload thumbnails must not have a video timestamp.",
    );
  }

  if (
    source !== "CUSTOM_UPLOAD" &&
    timestampMs === null
  ) {
    throw new Error(
      "Frame thumbnails require a video timestamp.",
    );
  }
}

function createRequestFingerprint(
  input: {
    readonly sourceUploadAssetId: string;
    readonly mimeType: string;
    readonly sizeBytes: number;
    readonly checksum: string;
    readonly source: GoogleDriveThumbnailSource;
    readonly timestampMs: number | null;
  },
): string {
  const canonical = JSON.stringify({
    sourceUploadAssetId:
      input.sourceUploadAssetId,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    checksum: input.checksum,
    source: input.source,
    timestampMs: input.timestampMs,
  });

  return createHash("sha256")
    .update(canonical, "utf8")
    .digest("hex");
}

function isUniqueConstraintError(
  error: unknown,
): boolean {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error)
  ) {
    return false;
  }

  return (
    (error as { code?: unknown }).code === "P2002"
  );
}

async function getDefaultPersistence():
  Promise<ThumbnailAssetPersistence> {
  const {
    prisma,
  } = await import("@/lib/prisma-client");

  const thumbnailAssetDelegate =
    (
      prisma as unknown as {
        readonly thumbnailAsset: {
          readonly findUnique: (
            args: {
              readonly where: {
                readonly userId_idempotencyKey: {
                  readonly userId: string;
                  readonly idempotencyKey: string;
                };
              };
            },
          ) => Promise<ThumbnailAssetRecord | null>;
          readonly create: (
            args: {
              readonly data:
                CreateThumbnailAssetRecordInput;
            },
          ) => Promise<ThumbnailAssetRecord>;
        };
      }
    ).thumbnailAsset;

  return {
    findValidatedOwnedSourceAsset: async (
      ownerUserId,
      sourceUploadAssetId,
    ) => {
      return await prisma.uploadAsset.findFirst({
        where: {
          id: sourceUploadAssetId,
          userId: ownerUserId,
          status: "VALIDATED",
          objectDeletedAt: null,
        },
        select: {
          id: true,
          userId: true,
          status: true,
          objectDeletedAt: true,
        },
      });
    },
    findByOwnerAndIdempotencyKey: async (
      ownerUserId,
      idempotencyKey,
    ) => {
      return await thumbnailAssetDelegate.findUnique({
        where: {
          userId_idempotencyKey: {
            userId: ownerUserId,
            idempotencyKey,
          },
        },
      });
    },
    create: async (input) => {
      return await thumbnailAssetDelegate.create({
        data: input,
      });
    },
  };
}

export async function persistStoredThumbnailAsset(
  input: PersistStoredThumbnailAssetInput,
  persistence?: ThumbnailAssetPersistence,
): Promise<PersistStoredThumbnailAssetResult> {
  const ownerUserId =
    requireNonEmpty(
      input.ownerUserId,
      "Owner user ID",
      255,
    );

  const sourceUploadAssetId =
    requireNonEmpty(
      input.sourceUploadAssetId,
      "Source upload asset ID",
      255,
    );

  const stored =
    input.storedThumbnail;

  const fileId =
    requireNonEmpty(
      stored.fileId,
      "Google Drive file ID",
      512,
    );

  const folderId =
    requireNonEmpty(
      stored.folderId,
      "Google Drive folder ID",
      255,
    );

  const fileName =
    requireNonEmpty(
      stored.fileName,
      "Thumbnail file name",
      255,
    );

  const storageUri =
    requireNonEmpty(
      stored.storageUri,
      "Thumbnail storage URI",
      2048,
    );

  if (storageUri !== `gdrive://${fileId}`) {
    throw new Error(
      "Thumbnail storage URI does not match the Google Drive file ID.",
    );
  }

  if (
    stored.mimeType !== "image/jpeg" &&
    stored.mimeType !== "image/png"
  ) {
    throw new Error(
      "Thumbnail MIME type must be image/jpeg or image/png.",
    );
  }

  if (
    !Number.isSafeInteger(stored.sizeBytes) ||
    stored.sizeBytes <= 0
  ) {
    throw new Error(
      "Thumbnail size must be a positive safe integer.",
    );
  }

  const checksum =
    requireNonEmpty(
      stored.md5Checksum ?? "",
      "Thumbnail checksum",
      255,
    );

  validateSourceAndTimestamp(
    stored.source,
    stored.timestampMs,
  );

  const activePersistence =
    persistence ??
    await getDefaultPersistence();

  const sourceAsset =
    await activePersistence
      .findValidatedOwnedSourceAsset(
        ownerUserId,
        sourceUploadAssetId,
      );

  if (!sourceAsset) {
    throw new Error(
      "Validated owned source upload asset was not found.",
    );
  }

  if (
    sourceAsset.id !== sourceUploadAssetId ||
    sourceAsset.userId !== ownerUserId ||
    sourceAsset.status !== "VALIDATED" ||
    sourceAsset.objectDeletedAt !== null
  ) {
    throw new Error(
      "Source upload asset ownership or state is invalid.",
    );
  }

  const requestFingerprint =
    createRequestFingerprint({
      sourceUploadAssetId,
      mimeType: stored.mimeType,
      sizeBytes: stored.sizeBytes,
      checksum,
      source: stored.source,
      timestampMs: stored.timestampMs,
    });

  const idempotencyKey =
    `thumbnail:${requestFingerprint}`;

  const existing =
    await activePersistence
      .findByOwnerAndIdempotencyKey(
        ownerUserId,
        idempotencyKey,
      );

  if (existing) {
    if (
      existing.requestFingerprint !==
      requestFingerprint
    ) {
      throw new Error(
        "THUMBNAIL_IDEMPOTENCY_CONFLICT",
      );
    }

    return {
      thumbnailAsset: existing,
      isReused: true,
    };
  }

  const createInput:
    CreateThumbnailAssetRecordInput = {
      userId: ownerUserId,
      sourceUploadAssetId,
      provider: "GOOGLE_DRIVE",
      bucket: folderId,
      objectKey: fileId,
      storageUri,
      originalName: fileName,
      mimeType: stored.mimeType,
      sizeBytes: BigInt(stored.sizeBytes),
      checksum,
      source: stored.source,
      timestampMs: stored.timestampMs,
      idempotencyKey,
      requestFingerprint,
    };

  try {
    const created =
      await activePersistence.create(
        createInput,
      );

    return {
      thumbnailAsset: created,
      isReused: false,
    };
  } catch (error: unknown) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }

    const racedExisting =
      await activePersistence
        .findByOwnerAndIdempotencyKey(
          ownerUserId,
          idempotencyKey,
        );

    if (
      !racedExisting ||
      racedExisting.requestFingerprint !==
        requestFingerprint
    ) {
      throw new Error(
        "THUMBNAIL_IDEMPOTENCY_CONFLICT",
      );
    }

    return {
      thumbnailAsset: racedExisting,
      isReused: true,
    };
  }
}
