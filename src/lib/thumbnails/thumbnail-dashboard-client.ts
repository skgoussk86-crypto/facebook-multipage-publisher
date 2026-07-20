export type DashboardThumbnailSource =
  | 'GEMINI_FRAME'
  | 'MANUAL_FRAME';

export interface DashboardThumbnailAsset {
  readonly id: string;
  readonly sourceUploadAssetId: string;
  readonly source: DashboardThumbnailSource;
  readonly timestampSeconds: number;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
}

export interface DashboardThumbnailGenerationResult {
  readonly thumbnail: DashboardThumbnailAsset;
  readonly reused: boolean;
}

function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}

function isUuid(
  value: string,
): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function requireString(
  value: unknown,
  field: string,
): string {
  if (
    typeof value !== 'string' ||
    value.trim() === ''
  ) {
    throw new Error(
      `Thumbnail response ${field} is missing or invalid.`,
    );
  }

  return value;
}

export function buildThumbnailGenerationUrl(
  assetId: string,
): string {
  const normalized = assetId.trim();

  if (!normalized) {
    throw new Error(
      'Upload asset ID is required for thumbnail generation.',
    );
  }

  return `/api/uploads/${encodeURIComponent(normalized)}/thumbnail`;
}

export function parseThumbnailGenerationResponse(
  payload: unknown,
  expectedUploadAssetId: string,
): DashboardThumbnailGenerationResult {
  if (!isPlainRecord(payload)) {
    throw new Error(
      'Thumbnail service returned an invalid response.',
    );
  }

  if (payload.success !== true) {
    throw new Error(
      'Thumbnail service did not report success.',
    );
  }

  if (!isPlainRecord(payload.thumbnail)) {
    throw new Error(
      'Thumbnail service response is missing thumbnail metadata.',
    );
  }

  const thumbnail = payload.thumbnail;
  const id = requireString(
    thumbnail.id,
    'id',
  );
  const sourceUploadAssetId = requireString(
    thumbnail.sourceUploadAssetId,
    'sourceUploadAssetId',
  );
  if (!isUuid(id)) {
    throw new Error(
      'Thumbnail service returned an invalid asset ID.',
    );
  }

  if (!isUuid(sourceUploadAssetId)) {
    throw new Error(
      'Thumbnail service returned an invalid source upload ID.',
    );
  }

  const source = thumbnail.source;
  const timestampSeconds = thumbnail.timestampSeconds;
  const mimeType = requireString(
    thumbnail.mimeType,
    'mimeType',
  );
  const sizeBytes = thumbnail.sizeBytes;
  const createdAt = requireString(
    thumbnail.createdAt,
    'createdAt',
  );

  if (
    source !== 'GEMINI_FRAME' &&
    source !== 'MANUAL_FRAME'
  ) {
    throw new Error(
      'Thumbnail service returned an unsupported source.',
    );
  }

  if (
    typeof timestampSeconds !== 'number' ||
    !Number.isFinite(timestampSeconds) ||
    timestampSeconds < 0
  ) {
    throw new Error(
      'Thumbnail service returned an invalid timestamp.',
    );
  }

  if (
    typeof sizeBytes !== 'number' ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes <= 0
  ) {
    throw new Error(
      'Thumbnail service returned an invalid file size.',
    );
  }

  if (mimeType !== 'image/jpeg') {
    throw new Error(
      'Thumbnail service returned an unsupported media type.',
    );
  }

  if (
    sourceUploadAssetId !==
    expectedUploadAssetId.trim()
  ) {
    throw new Error(
      'Thumbnail service returned metadata for a different upload.',
    );
  }

  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new Error(
      'Thumbnail service returned an invalid creation time.',
    );
  }

  const forbiddenKeys = [
    'storageUri',
    'provider',
    'bucket',
    'objectKey',
    'fileId',
    'accessToken',
    'refreshToken',
    'sessionUri',
  ];

  if (
    forbiddenKeys.some(
      (key) => key in thumbnail,
    )
  ) {
    throw new Error(
      'Thumbnail service exposed unsupported storage metadata.',
    );
  }

  return {
    reused: payload.reused === true,
    thumbnail: {
      id,
      sourceUploadAssetId,
      source,
      timestampSeconds,
      mimeType,
      sizeBytes,
      createdAt,
    },
  };
}

export function getThumbnailGenerationErrorMessage(
  status: number,
  payload: unknown,
): string {
  if (isPlainRecord(payload)) {
    const message = payload.message;

    if (
      typeof message === 'string' &&
      message.trim() !== ''
    ) {
      return message;
    }
  }

  switch (status) {
    case 400:
      return 'The thumbnail timestamp or request is invalid.';
    case 401:
      return 'Your session has expired. Sign in again.';
    case 404:
      return 'The uploaded video could not be found.';
    case 409:
      return 'The uploaded video is not ready for thumbnail generation.';
    case 413:
      return 'The source video is too large for thumbnail generation.';
    case 422:
      return 'The selected frame cannot be generated from this video.';
    case 502:
      return 'The thumbnail could not be generated or stored.';
    case 503:
      return 'Google Drive or FFmpeg is not available for thumbnail generation.';
    default:
      return 'Thumbnail generation failed unexpectedly.';
  }
}
