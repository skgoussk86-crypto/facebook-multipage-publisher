import "server-only";

import type {
  StoredGoogleDriveThumbnail,
} from "../google-drive/google-drive-thumbnail-storage";
import {
  deleteGoogleDriveFile,
} from "../google-drive/google-drive-media-client";
import {
  getActiveConnectionForOwner,
} from "../google-drive/google-drive-connection-repository";
import {
  getGoogleDriveConfig,
} from "../google-drive/google-drive-config";
import {
  decryptRefreshToken,
} from "../google-drive/google-drive-token-crypto";
import {
  getAccessTokenFromRefreshToken,
} from "../google-drive/google-drive-oauth-client";
import {
  findPersistedThumbnailAssetByRequest,
  persistStoredThumbnailAsset,
  type PersistStoredThumbnailAssetResult,
  type ThumbnailAssetRecord,
} from "./thumbnail-asset-repository";
import {
  resolveEffectiveThumbnailTimestamp,
  VideoThumbnailService,
  type GeneratedVideoThumbnail,
  type ThumbnailSourceVideoAsset,
} from "./video-thumbnail-service";

export type FrameThumbnailSource =
  | "GEMINI_FRAME"
  | "MANUAL_FRAME";

export type ThumbnailGenerationErrorCode =
  | "INVALID_REQUEST"
  | "UPLOAD_ASSET_NOT_FOUND"
  | "UPLOAD_ASSET_NOT_VALIDATED"
  | "UPLOAD_ASSET_DELETED"
  | "UNSUPPORTED_STORAGE_PROVIDER"
  | "VIDEO_DURATION_MISSING"
  | "INVALID_THUMBNAIL_TIMESTAMP"
  | "THUMBNAIL_TIMESTAMP_OUT_OF_RANGE"
  | "THUMBNAIL_SOURCE_TOO_LARGE"
  | "SOURCE_VIDEO_UNAVAILABLE"
  | "GOOGLE_DRIVE_NOT_CONNECTED"
  | "FFMPEG_NOT_AVAILABLE"
  | "THUMBNAIL_GENERATION_FAILED"
  | "THUMBNAIL_PERSISTENCE_FAILED";

export class ThumbnailGenerationError extends Error {
  constructor(
    public readonly code:
      ThumbnailGenerationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ThumbnailGenerationError";
  }
}

export type ThumbnailGenerationAsset =
  ThumbnailSourceVideoAsset;

export interface GeneratePersistedThumbnailInput {
  readonly userId: string;
  readonly assetId: string;
  readonly timestampSeconds: number;
  readonly source: FrameThumbnailSource;
}

export interface PublicThumbnailAsset {
  readonly id: string;
  readonly sourceUploadAssetId: string;
  readonly source: FrameThumbnailSource;
  readonly timestampSeconds: number;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
}

export interface GeneratePersistedThumbnailResult {
  readonly thumbnail: PublicThumbnailAsset;
  readonly isReused: boolean;
}

export interface ThumbnailGenerationDependencies {
  readonly findAsset?: (
    assetId: string,
  ) => Promise<ThumbnailGenerationAsset | null>;
  readonly findExistingThumbnail?: (
    input: {
      ownerUserId: string;
      sourceUploadAssetId: string;
      source: FrameThumbnailSource;
      timestampMs: number;
    },
  ) => Promise<ThumbnailAssetRecord | null>;
  readonly generateAndStore?: (
    input: {
      userId: string;
      asset: ThumbnailGenerationAsset;
      timestampSeconds: number;
      source: FrameThumbnailSource;
    },
  ) => Promise<GeneratedVideoThumbnail>;
  readonly persistThumbnail?: (
    input: {
      ownerUserId: string;
      sourceUploadAssetId: string;
      storedThumbnail:
        StoredGoogleDriveThumbnail;
    },
  ) => Promise<PersistStoredThumbnailAssetResult>;
  readonly deleteStoredThumbnail?: (
    userId: string,
    fileId: string,
  ) => Promise<void>;
}

function requireNonEmpty(
  value: string,
  code: ThumbnailGenerationErrorCode,
  message: string,
): string {
  const trimmed = value.trim();

  if (!trimmed) {
    throw new ThumbnailGenerationError(
      code,
      message,
    );
  }

  return trimmed;
}

function getErrorMessage(
  error: unknown,
): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function mapInternalError(
  error: unknown,
  stage: "lookup" | "generate" | "persist",
): ThumbnailGenerationError {
  if (error instanceof ThumbnailGenerationError) {
    return error;
  }

  const message = getErrorMessage(error);

  switch (message) {
    case "UPLOAD_ASSET_NOT_FOUND":
    case "Validated owned source upload asset was not found.":
      return new ThumbnailGenerationError(
        "UPLOAD_ASSET_NOT_FOUND",
        "The upload asset was not found.",
      );

    case "UPLOAD_ASSET_NOT_VALIDATED":
      return new ThumbnailGenerationError(
        "UPLOAD_ASSET_NOT_VALIDATED",
        "The upload must be validated before generating a thumbnail.",
      );

    case "UPLOAD_ASSET_DELETED":
      return new ThumbnailGenerationError(
        "UPLOAD_ASSET_DELETED",
        "The upload media is no longer available.",
      );

    case "UNSUPPORTED_STORAGE_PROVIDER":
      return new ThumbnailGenerationError(
        "UNSUPPORTED_STORAGE_PROVIDER",
        "Thumbnail generation is not supported for this storage provider.",
      );

    case "VIDEO_DURATION_MISSING":
      return new ThumbnailGenerationError(
        "VIDEO_DURATION_MISSING",
        "Validated video duration is missing.",
      );

    case "INVALID_THUMBNAIL_TIMESTAMP":
      return new ThumbnailGenerationError(
        "INVALID_THUMBNAIL_TIMESTAMP",
        "Thumbnail timestamp must be a non-negative finite number.",
      );

    case "THUMBNAIL_TIMESTAMP_OUT_OF_RANGE":
      return new ThumbnailGenerationError(
        "THUMBNAIL_TIMESTAMP_OUT_OF_RANGE",
        "Thumbnail timestamp is outside the video duration.",
      );

    case "THUMBNAIL_SOURCE_TOO_LARGE":
      return new ThumbnailGenerationError(
        "THUMBNAIL_SOURCE_TOO_LARGE",
        "The source video is too large for thumbnail generation.",
      );

    case "GOOGLE_DRIVE_CONNECTION_REVOKED":
    case "GOOGLE_DRIVE_FOLDER_MISSING":
    case "GOOGLE_DRIVE_DECRYPTION_FAILED":
      return new ThumbnailGenerationError(
        "GOOGLE_DRIVE_NOT_CONNECTED",
        "A working Google Drive connection is required.",
      );

    case "GOOGLE_DRIVE_FILE_NOT_FOUND":
    case "INVALID_STORAGE_URI":
      return new ThumbnailGenerationError(
        "SOURCE_VIDEO_UNAVAILABLE",
        "The stored source video is unavailable.",
      );

    case "FFMPEG_NOT_FOUND":
      return new ThumbnailGenerationError(
        "FFMPEG_NOT_AVAILABLE",
        "The thumbnail extraction service is unavailable.",
      );

    case "THUMBNAIL_ASSET_DELETED":
    case "THUMBNAIL_IDEMPOTENCY_CONFLICT":
      return new ThumbnailGenerationError(
        "THUMBNAIL_PERSISTENCE_FAILED",
        "The thumbnail could not be saved safely.",
      );
  }

  if (
    message.startsWith(
      "THUMBNAIL_EXTRACTION_",
    ) ||
    message.startsWith(
      "THUMBNAIL_OUTPUT_",
    )
  ) {
    return new ThumbnailGenerationError(
      "THUMBNAIL_GENERATION_FAILED",
      "The thumbnail frame could not be generated.",
    );
  }

  if (stage === "persist") {
    return new ThumbnailGenerationError(
      "THUMBNAIL_PERSISTENCE_FAILED",
      "The thumbnail could not be saved safely.",
    );
  }

  if (stage === "lookup") {
    return new ThumbnailGenerationError(
      "THUMBNAIL_PERSISTENCE_FAILED",
      "The thumbnail request could not be checked safely.",
    );
  }

  return new ThumbnailGenerationError(
    "THUMBNAIL_GENERATION_FAILED",
    "The thumbnail could not be generated.",
  );
}

async function findAssetById(
  assetId: string,
): Promise<ThumbnailGenerationAsset | null> {
  const {
    prisma,
  } = await import("../prisma-client");

  return await prisma.uploadAsset.findUnique({
    where: {
      id: assetId,
    },
    select: {
      id: true,
      userId: true,
      provider: true,
      status: true,
      originalName: true,
      expectedSize: true,
      actualSize: true,
      durationMs: true,
      objectDeletedAt: true,
    },
  });
}

async function defaultFindExistingThumbnail(
  input: {
    ownerUserId: string;
    sourceUploadAssetId: string;
    source: FrameThumbnailSource;
    timestampMs: number;
  },
): Promise<ThumbnailAssetRecord | null> {
  return await findPersistedThumbnailAssetByRequest(
    input,
  );
}

async function defaultGenerateAndStore(
  input: {
    userId: string;
    asset: ThumbnailGenerationAsset;
    timestampSeconds: number;
    source: FrameThumbnailSource;
  },
): Promise<GeneratedVideoThumbnail> {
  return await VideoThumbnailService
    .generateAndStore(input);
}

async function defaultPersistThumbnail(
  input: {
    ownerUserId: string;
    sourceUploadAssetId: string;
    storedThumbnail:
      StoredGoogleDriveThumbnail;
  },
): Promise<PersistStoredThumbnailAssetResult> {
  return await persistStoredThumbnailAsset(
    input,
  );
}

async function defaultDeleteStoredThumbnail(
  userId: string,
  fileId: string,
): Promise<void> {
  const connection =
    await getActiveConnectionForOwner(userId);

  if (
    !connection ||
    connection.revokedAt !== null
  ) {
    return;
  }

  const config =
    getGoogleDriveConfig();

  const refreshToken =
    decryptRefreshToken(
      connection.encryptedRefreshToken,
      config.encryptionKey,
    );

  const accessToken =
    await getAccessTokenFromRefreshToken(
      refreshToken,
    );

  await deleteGoogleDriveFile(
    accessToken,
    fileId,
  );
}

async function cleanupUploadedThumbnail(
  userId: string,
  fileId: string,
  deleteStoredThumbnail: (
    userId: string,
    fileId: string,
  ) => Promise<void>,
): Promise<void> {
  try {
    await deleteStoredThumbnail(
      userId,
      fileId,
    );
  } catch {
    console.error(
      "Uploaded thumbnail cleanup failed.",
    );
  }
}

function toPublicThumbnail(
  record: ThumbnailAssetRecord,
): PublicThumbnailAsset {
  if (
    record.timestampMs === null ||
    record.timestampMs < 0
  ) {
    throw new ThumbnailGenerationError(
      "THUMBNAIL_PERSISTENCE_FAILED",
      "The saved thumbnail metadata is invalid.",
    );
  }

  const sizeBytes =
    Number(record.sizeBytes);

  if (
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes <= 0
  ) {
    throw new ThumbnailGenerationError(
      "THUMBNAIL_PERSISTENCE_FAILED",
      "The saved thumbnail metadata is invalid.",
    );
  }

  if (
    record.source !== "GEMINI_FRAME" &&
    record.source !== "MANUAL_FRAME"
  ) {
    throw new ThumbnailGenerationError(
      "THUMBNAIL_PERSISTENCE_FAILED",
      "The saved thumbnail metadata is invalid.",
    );
  }

  return {
    id: record.id,
    sourceUploadAssetId:
      record.sourceUploadAssetId,
    source: record.source,
    timestampSeconds:
      record.timestampMs / 1000,
    mimeType: record.mimeType,
    sizeBytes,
    createdAt:
      record.createdAt.toISOString(),
  };
}

export class ThumbnailGenerationService {
  static async generatePersistedThumbnail(
    input: GeneratePersistedThumbnailInput,
    dependencies: ThumbnailGenerationDependencies = {},
  ): Promise<GeneratePersistedThumbnailResult> {
    const userId =
      requireNonEmpty(
        input.userId,
        "INVALID_REQUEST",
        "Authenticated user ID is required.",
      );

    const assetId =
      requireNonEmpty(
        input.assetId,
        "INVALID_REQUEST",
        "Upload asset ID is required.",
      );

    if (
      input.source !== "GEMINI_FRAME" &&
      input.source !== "MANUAL_FRAME"
    ) {
      throw new ThumbnailGenerationError(
        "INVALID_REQUEST",
        "Thumbnail source is invalid.",
      );
    }

    if (
      typeof input.timestampSeconds !==
        "number" ||
      !Number.isFinite(
        input.timestampSeconds,
      ) ||
      input.timestampSeconds < 0
    ) {
      throw new ThumbnailGenerationError(
        "INVALID_THUMBNAIL_TIMESTAMP",
        "Thumbnail timestamp must be a non-negative finite number.",
      );
    }

    const findAsset =
      dependencies.findAsset ??
      findAssetById;

    const asset =
      await findAsset(assetId);

    if (
      !asset ||
      asset.userId !== userId
    ) {
      throw new ThumbnailGenerationError(
        "UPLOAD_ASSET_NOT_FOUND",
        "The upload asset was not found.",
      );
    }

    if (asset.status !== "VALIDATED") {
      throw new ThumbnailGenerationError(
        "UPLOAD_ASSET_NOT_VALIDATED",
        "The upload must be validated before generating a thumbnail.",
      );
    }

    if (
      asset.objectDeletedAt !== null
    ) {
      throw new ThumbnailGenerationError(
        "UPLOAD_ASSET_DELETED",
        "The upload media is no longer available.",
      );
    }

    if (
      asset.provider !== "GOOGLE_DRIVE"
    ) {
      throw new ThumbnailGenerationError(
        "UNSUPPORTED_STORAGE_PROVIDER",
        "Thumbnail generation is not supported for this storage provider.",
      );
    }

    if (
      asset.durationMs === null ||
      asset.durationMs <= 0
    ) {
      throw new ThumbnailGenerationError(
        "VIDEO_DURATION_MISSING",
        "Validated video duration is missing.",
      );
    }

    let effectiveTimestampSeconds:
      number;

    try {
      effectiveTimestampSeconds =
        resolveEffectiveThumbnailTimestamp(
          input.timestampSeconds,
          asset.durationMs,
        );
    } catch (error: unknown) {
      throw mapInternalError(
        error,
        "generate",
      );
    }

    const timestampMs =
      Math.round(
        effectiveTimestampSeconds * 1000,
      );

    const findExistingThumbnail =
      dependencies.findExistingThumbnail ??
      defaultFindExistingThumbnail;

    let existing:
      ThumbnailAssetRecord | null;

    try {
      existing =
        await findExistingThumbnail({
          ownerUserId: userId,
          sourceUploadAssetId: asset.id,
          source: input.source,
          timestampMs,
        });
    } catch (error: unknown) {
      throw mapInternalError(
        error,
        "lookup",
      );
    }

    if (existing) {
      return {
        thumbnail:
          toPublicThumbnail(existing),
        isReused: true,
      };
    }

    const generateAndStore =
      dependencies.generateAndStore ??
      defaultGenerateAndStore;

    let stored:
      GeneratedVideoThumbnail;

    try {
      stored =
        await generateAndStore({
          userId,
          asset,
          timestampSeconds:
            effectiveTimestampSeconds,
          source: input.source,
        });
    } catch (error: unknown) {
      throw mapInternalError(
        error,
        "generate",
      );
    }

    const persistThumbnail =
      dependencies.persistThumbnail ??
      defaultPersistThumbnail;

    const deleteStoredThumbnail =
      dependencies.deleteStoredThumbnail ??
      defaultDeleteStoredThumbnail;

    let persisted:
      PersistStoredThumbnailAssetResult;

    try {
      persisted =
        await persistThumbnail({
          ownerUserId: userId,
          sourceUploadAssetId: asset.id,
          storedThumbnail: stored,
        });
    } catch (error: unknown) {
      let recovered:
        ThumbnailAssetRecord | null =
        null;

      try {
        recovered =
          await findExistingThumbnail({
            ownerUserId: userId,
            sourceUploadAssetId:
              asset.id,
            source: input.source,
            timestampMs,
          });
      } catch {
        recovered = null;
      }

      if (recovered) {
        if (
          recovered.objectKey !==
            stored.fileId
        ) {
          await cleanupUploadedThumbnail(
            userId,
            stored.fileId,
            deleteStoredThumbnail,
          );
        }

        return {
          thumbnail:
            toPublicThumbnail(
              recovered,
            ),
          isReused: true,
        };
      }

      await cleanupUploadedThumbnail(
        userId,
        stored.fileId,
        deleteStoredThumbnail,
      );

      throw mapInternalError(
        error,
        "persist",
      );
    }

    if (
      persisted.isReused &&
      persisted.thumbnailAsset.objectKey !==
        stored.fileId
    ) {
      await cleanupUploadedThumbnail(
        userId,
        stored.fileId,
        deleteStoredThumbnail,
      );
    }

    return {
      thumbnail:
        toPublicThumbnail(
          persisted.thumbnailAsset,
        ),
      isReused: persisted.isReused,
    };
  }
}
