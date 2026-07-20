import "server-only";

import type {
  Readable,
} from "node:stream";

export interface PublishingThumbnailDatabaseRecord {
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
  readonly deletedAt: Date | null;
}

export interface PublishingThumbnailSource {
  readonly fileName: string;
  readonly mimeType: "image/jpeg";
  readonly sizeBytes: number;
  readonly stream: Readable;
}

export interface ResolvePublishingThumbnailInput {
  readonly ownerUserId: string;
  readonly sourceUploadAssetId: string;
  readonly thumbnailAssetId: string;
}

export interface ResolvePublishingThumbnailDependencies {
  readonly findThumbnailAsset: (
    input: {
      readonly ownerUserId: string;
      readonly sourceUploadAssetId: string;
      readonly thumbnailAssetId: string;
    },
  ) =>
    Promise<
      PublishingThumbnailDatabaseRecord | null
    >;
  readonly createDownloadStream: (
    ownerUserId: string,
    thumbnail:
      PublishingThumbnailDatabaseRecord,
  ) => Promise<Readable>;
  readonly maxBytes?: number;
}

function requireIdentifier(
  value: string,
  label: string,
): string {
  const trimmed =
    value.trim();

  if (
    !trimmed ||
    trimmed.length > 255 ||
    /[\x00-\x1F\x7F]/.test(trimmed)
  ) {
    throw new Error(
      `THUMBNAIL_PUBLISHING_INVALID_${label}`,
    );
  }

  return trimmed;
}

function getDefaultMaximumBytes(): number {
  const configured =
    process.env.THUMBNAIL_MAX_BYTES?.trim();

  if (!configured) {
    return 10 * 1024 * 1024;
  }

  const parsed =
    Number(configured);

  if (
    !Number.isSafeInteger(parsed) ||
    parsed <= 0
  ) {
    throw new Error(
      "THUMBNAIL_PUBLISHING_INVALID_MAX_BYTES",
    );
  }

  return parsed;
}

function sanitizeFileName(
  value: string,
): string {
  const trimmed =
    value.trim();

  if (
    !trimmed ||
    trimmed.length > 255 ||
    /[\x00-\x1F\x7F]/.test(trimmed) ||
    trimmed.includes("/") ||
    trimmed.includes("\\")
  ) {
    throw new Error(
      "THUMBNAIL_PUBLISHING_INVALID_FILE_NAME",
    );
  }

  return trimmed;
}

async function getDefaultDependencies():
  Promise<ResolvePublishingThumbnailDependencies> {
  const {
    prisma,
  } = await import("@/lib/prisma-client");

  const {
    GoogleDriveMediaReader,
  } = await import(
    "@/lib/google-drive/google-drive-media-reader"
  );

  return {
    findThumbnailAsset: async (input) => {
      return await prisma.thumbnailAsset.findFirst({
        where: {
          id: input.thumbnailAssetId,
          userId: input.ownerUserId,
          sourceUploadAssetId:
            input.sourceUploadAssetId,
          deletedAt: null,
        },
        select: {
          id: true,
          userId: true,
          sourceUploadAssetId: true,
          provider: true,
          bucket: true,
          objectKey: true,
          storageUri: true,
          originalName: true,
          mimeType: true,
          sizeBytes: true,
          deletedAt: true,
        },
      });
    },
    createDownloadStream: async (
      ownerUserId,
      thumbnail,
    ) => {
      return await GoogleDriveMediaReader
        .getDownloadStream(
          ownerUserId,
          thumbnail,
        );
    },
  };
}

export async function resolvePublishingThumbnailSource(
  input: ResolvePublishingThumbnailInput,
  dependencies?:
    ResolvePublishingThumbnailDependencies,
): Promise<PublishingThumbnailSource> {
  const ownerUserId =
    requireIdentifier(
      input.ownerUserId,
      "OWNER_ID",
    );

  const sourceUploadAssetId =
    requireIdentifier(
      input.sourceUploadAssetId,
      "SOURCE_UPLOAD_ID",
    );

  const thumbnailAssetId =
    requireIdentifier(
      input.thumbnailAssetId,
      "ASSET_ID",
    );

  const activeDependencies =
    dependencies ??
    await getDefaultDependencies();

  const maximumBytes =
    activeDependencies.maxBytes ??
    getDefaultMaximumBytes();

  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes <= 0
  ) {
    throw new Error(
      "THUMBNAIL_PUBLISHING_INVALID_MAX_BYTES",
    );
  }

  const thumbnail =
    await activeDependencies
      .findThumbnailAsset({
        ownerUserId,
        sourceUploadAssetId,
        thumbnailAssetId,
      });

  if (!thumbnail) {
    throw new Error(
      "THUMBNAIL_PUBLISHING_ASSET_NOT_FOUND",
    );
  }

  if (
    thumbnail.id !== thumbnailAssetId ||
    thumbnail.userId !== ownerUserId
  ) {
    throw new Error(
      "THUMBNAIL_PUBLISHING_OWNERSHIP_MISMATCH",
    );
  }

  if (
    thumbnail.sourceUploadAssetId !==
    sourceUploadAssetId
  ) {
    throw new Error(
      "THUMBNAIL_PUBLISHING_SOURCE_MISMATCH",
    );
  }

  if (thumbnail.deletedAt !== null) {
    throw new Error(
      "THUMBNAIL_PUBLISHING_ASSET_DELETED",
    );
  }

  if (thumbnail.provider !== "GOOGLE_DRIVE") {
    throw new Error(
      "THUMBNAIL_PUBLISHING_UNSUPPORTED_PROVIDER",
    );
  }

  const objectKey =
    requireIdentifier(
      thumbnail.objectKey,
      "OBJECT_KEY",
    );

  if (
    thumbnail.storageUri !==
    `gdrive://${objectKey}`
  ) {
    throw new Error(
      "THUMBNAIL_PUBLISHING_INVALID_STORAGE_REFERENCE",
    );
  }

  if (thumbnail.mimeType !== "image/jpeg") {
    throw new Error(
      "THUMBNAIL_PUBLISHING_UNSUPPORTED_MIME_TYPE",
    );
  }

  const numericSize =
    Number(thumbnail.sizeBytes);

  if (
    !Number.isSafeInteger(numericSize) ||
    numericSize <= 0 ||
    numericSize > maximumBytes
  ) {
    throw new Error(
      "THUMBNAIL_PUBLISHING_INVALID_SIZE",
    );
  }

  const stream =
    await activeDependencies
      .createDownloadStream(
        ownerUserId,
        thumbnail,
      );

  if (
    !stream ||
    typeof stream.destroy !== "function"
  ) {
    throw new Error(
      "THUMBNAIL_PUBLISHING_STREAM_UNAVAILABLE",
    );
  }

  return Object.freeze({
    fileName:
      sanitizeFileName(
        thumbnail.originalName,
      ),
    mimeType: "image/jpeg",
    sizeBytes: numericSize,
    stream,
  });
}
