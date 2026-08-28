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

export interface DashboardThumbnailGenerationRequestResult
  extends DashboardThumbnailGenerationResult {
  readonly attempts: number;
}

export interface ThumbnailGenerationRetryNotice {
  readonly attempt: number;
  readonly nextAttempt: number;
  readonly maxAttempts: number;
  readonly status?: number;
  readonly message: string;
}

export interface ThumbnailGenerationRequestDependencies {
  readonly fetchImplementation?: typeof fetch;
  readonly wait?: (delayMs: number) => Promise<void>;
  readonly onRetry?: (
    notice: ThumbnailGenerationRetryNotice,
  ) => void;
}

const THUMBNAIL_GENERATION_MAX_ATTEMPTS = 3;
const THUMBNAIL_GENERATION_RETRY_DELAYS_MS = [
  1_000,
  2_500,
] as const;
const RETRYABLE_THUMBNAIL_STATUSES = new Set([
  408,
  425,
  429,
  500,
  502,
  503,
  504,
]);

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
    case 504:
      return 'Thumbnail generation timed out before the server responded.';
    case 429:
      return 'Thumbnail generation is temporarily rate-limited.';
    case 500:
      return 'The server temporarily could not complete thumbnail generation.';
    default:
      return 'Thumbnail generation failed unexpectedly.';
  }
}

function getRetryDelayMs(
  response: Response | null,
  attempt: number,
): number {
  const retryAfter =
    response?.headers.get('retry-after');

  if (retryAfter) {
    const seconds = Number(retryAfter);

    if (
      Number.isFinite(seconds) &&
      seconds >= 0
    ) {
      return Math.min(
        Math.round(seconds * 1_000),
        10_000,
      );
    }
  }

  return THUMBNAIL_GENERATION_RETRY_DELAYS_MS[
    Math.min(
      attempt - 1,
      THUMBNAIL_GENERATION_RETRY_DELAYS_MS.length - 1,
    )
  ];
}

async function defaultWait(
  delayMs: number,
): Promise<void> {
  await new Promise<void>((resolve) => {
    window.setTimeout(resolve, delayMs);
  });
}

export async function requestPersistedThumbnailWithRetry(
  input: {
    assetId: string;
    timestampSeconds: number;
    source: DashboardThumbnailSource;
  },
  dependencies: ThumbnailGenerationRequestDependencies = {},
): Promise<DashboardThumbnailGenerationRequestResult> {
  const fetchImplementation =
    dependencies.fetchImplementation ?? fetch;
  const wait = dependencies.wait ?? defaultWait;
  const url = buildThumbnailGenerationUrl(
    input.assetId,
  );

  for (
    let attempt = 1;
    attempt <= THUMBNAIL_GENERATION_MAX_ATTEMPTS;
    attempt += 1
  ) {
    let response: Response;

    try {
      response = await fetchImplementation(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          timestampSeconds:
            input.timestampSeconds,
          source: input.source,
        }),
      });
    } catch {
      const message =
        'The connection was interrupted while generating the thumbnail.';

      if (
        attempt >=
        THUMBNAIL_GENERATION_MAX_ATTEMPTS
      ) {
        throw new Error(message);
      }

      dependencies.onRetry?.({
        attempt,
        nextAttempt: attempt + 1,
        maxAttempts:
          THUMBNAIL_GENERATION_MAX_ATTEMPTS,
        message,
      });

      await wait(
        getRetryDelayMs(null, attempt),
      );
      continue;
    }

    let payload: unknown = null;

    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (response.ok) {
      return {
        ...parseThumbnailGenerationResponse(
          payload,
          input.assetId,
        ),
        attempts: attempt,
      };
    }

    const message =
      getThumbnailGenerationErrorMessage(
        response.status,
        payload,
      );
    const canRetry =
      attempt <
        THUMBNAIL_GENERATION_MAX_ATTEMPTS &&
      RETRYABLE_THUMBNAIL_STATUSES.has(
        response.status,
      );

    if (!canRetry) {
      throw new Error(message);
    }

    dependencies.onRetry?.({
      attempt,
      nextAttempt: attempt + 1,
      maxAttempts:
        THUMBNAIL_GENERATION_MAX_ATTEMPTS,
      status: response.status,
      message,
    });

    await wait(
      getRetryDelayMs(response, attempt),
    );
  }

  throw new Error(
    'Thumbnail generation failed after automatic retries.',
  );
}
