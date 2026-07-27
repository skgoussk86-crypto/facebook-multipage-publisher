const UNSAFE_CONTROL_CHARACTER_PATTERN =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;

const LINE_BREAK_PATTERN =
  /[\r\n\u2028\u2029]/u;

export function countUnicodeCharacters(value: string): number {
  return Array.from(value).length;
}

export function containsUnsafeControlCharacters(
  value: string,
): boolean {
  return UNSAFE_CONTROL_CHARACTER_PATTERN.test(value);
}

export function isSingleLineMetadataText(
  value: string,
): boolean {
  return !LINE_BREAK_PATTERN.test(value);
}

export function isMetadataTextSafe(
  value: string,
): boolean {
  return !containsUnsafeControlCharacters(value);
}

export function validateJobInput(data: {
  englishTitle: string;
  englishCaption?: string;
  hashtags?: string;
  scheduledTimeUTC: string;
  pageId: string;
}): string[] {
  const errors: string[] = [];

  if (
    typeof data.englishTitle !== 'string' ||
    data.englishTitle.trim() === ''
  ) {
    errors.push('Title is required.');
  } else {
    if (countUnicodeCharacters(data.englishTitle) > 255) {
      errors.push('Title must not exceed 255 Unicode characters.');
    }

    if (!isSingleLineMetadataText(data.englishTitle)) {
      errors.push('Title must be a single line.');
    }

    if (!isMetadataTextSafe(data.englishTitle)) {
      errors.push('Title contains unsupported control characters.');
    }
  }

  if (
    data.englishCaption !== undefined &&
    typeof data.englishCaption !== 'string'
  ) {
    errors.push('Caption must be text.');
  } else if (
    data.englishCaption &&
    !isMetadataTextSafe(data.englishCaption)
  ) {
    errors.push('Caption contains unsupported control characters.');
  }

  if (
    data.hashtags !== undefined &&
    typeof data.hashtags !== 'string'
  ) {
    errors.push('Hashtags must be text.');
  } else if (
    data.hashtags &&
    !isMetadataTextSafe(data.hashtags)
  ) {
    errors.push('Hashtags contain unsupported control characters.');
  }

  const date = new Date(data.scheduledTimeUTC);
  if (isNaN(date.getTime())) {
    errors.push('Invalid scheduled publishing time format.');
  } else if (date.getTime() <= Date.now()) {
    errors.push('Scheduled publishing time must be in the future.');
  }

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!data.pageId || !uuidRegex.test(data.pageId)) {
    errors.push('Invalid target Facebook Page ID.');
  }

  return errors;
}

import { MockScenario } from '@prisma/client';

export function normalizeMockScenario(val: unknown): MockScenario {
  if (val === undefined || val === null || val === '') {
    return MockScenario.SUCCESS;
  }
  if (typeof val !== 'string') {
    throw new Error('Invalid mockScenario format.');
  }

  const normalized = val.trim().toUpperCase();

  // Check if it's already a canonical value
  if (Object.values(MockScenario).includes(normalized as MockScenario)) {
    return normalized as MockScenario;
  }

  // Handle case-insensitive legacy UI variants
  switch (val.trim().toLowerCase()) {
    case 'success':
      return MockScenario.SUCCESS;
    case 'network_failure':
    case 'temporary_network_failure':
      return MockScenario.TEMPORARY_NETWORK_FAILURE;
    case 'meta_processing_delay':
      return MockScenario.META_PROCESSING_DELAY;
    case 'rate_limit':
    case 'meta_rate_limit':
      return MockScenario.META_RATE_LIMIT;
    case 'invalid_format':
    case 'invalid_media_format':
      return MockScenario.INVALID_MEDIA_FORMAT;
    case 'revoked_token':
    case 'revoked_facebook_token':
      return MockScenario.REVOKED_FACEBOOK_TOKEN;
    case 'missing_permission':
    case 'missing_facebook_permission':
      return MockScenario.MISSING_FACEBOOK_PERMISSION;
    case 'permanent_publishing_failure':
      return MockScenario.PERMANENT_PUBLISHING_FAILURE;
    default:
      throw new Error('Unsupported or malformed simulation scenario.');
  }
}

export interface NormalizedDashboardJob {
  id: string;
  fileName: string;
  fileSize: string;
  fileSizeBytes: number;
  durationSeconds: number;
  uploadProgress: number;
  pageId: string;
  pageName?: string;
  contentType: 'VIDEO' | 'REEL' | 'PHOTO';
  englishTitle: string;
  englishCaption: string;
  hashtags: string;
  scheduledTimeKolkata: string;
  scheduledTimeUTC: string;
  status: string;
  metaPostId?: string;
  retryCount: number;
  errorLog?: string;
  thumbnailMode: 'auto' | 'custom' | 'captured';
  attempts: unknown[];
  mockScenario?: string;
  uploadAssetId?: string;
  thumbnailAssetId?: string;
  createdAt?: string;
  updatedAt?: string;
}

export function normalizeDashboardJobs(data: unknown): NormalizedDashboardJob[] {
  if (data === undefined || data === null) {
    return [];
  }

  let rawList: unknown[] = [];
  if (Array.isArray(data)) {
    rawList = data;
  } else if (typeof data === 'object' && data !== null && 'jobs' in data) {
    const wrappedJobs = (data as Record<string, unknown>).jobs;
    if (Array.isArray(wrappedJobs)) {
      rawList = wrappedJobs;
    } else {
      throw new Error('Invalid response format: expected a jobs list array or wrapped jobs property.');
    }
  } else {
    throw new Error('Invalid response format: expected a jobs list array or wrapped jobs property.');
  }

  return rawList.map((item: unknown) => {
    if (!item || typeof item !== 'object') {
      throw new Error('Invalid job record in response list.');
    }

    const j = item as Record<string, unknown>;

    if (typeof j.id !== 'string') {
      throw new Error('Job id is missing or invalid.');
    }
    if (typeof j.pageId !== 'string') {
      throw new Error('Job pageId is missing or invalid.');
    }
    if (typeof j.englishTitle !== 'string') {
      throw new Error('Job englishTitle is missing or invalid.');
    }

    const rawStatus = String(j.status || '').toUpperCase();
    let normalizedStatus = 'DRAFT';
    if (rawStatus === 'SCHEDULED') {
      normalizedStatus = 'SCHEDULED';
    } else if (rawStatus === 'PENDING') {
      normalizedStatus = 'PENDING';
    } else if (rawStatus === 'PREPARING') {
      normalizedStatus = 'PREPARING';
    } else if (rawStatus === 'PROCESSING') {
      normalizedStatus = 'PROCESSING';
    } else if (rawStatus === 'UPLOADING_TO_META') {
      normalizedStatus = 'UPLOADING_TO_META';
    } else if (rawStatus === 'META_PROCESSING') {
      normalizedStatus = 'META_PROCESSING';
    } else if (rawStatus === 'PUBLISHING') {
      normalizedStatus = 'PUBLISHING';
    } else if (rawStatus === 'PUBLISHED') {
      normalizedStatus = 'PUBLISHED';
    } else if (rawStatus === 'FAILED_RETRYABLE') {
      normalizedStatus = 'FAILED_RETRYABLE';
    } else if (rawStatus === 'FAILED_PERMANENT') {
      normalizedStatus = 'FAILED_PERMANENT';
    } else if (rawStatus === 'FAILED') {
      normalizedStatus = 'FAILED';
    } else if (rawStatus === 'CANCELLED') {
      normalizedStatus = 'CANCELLED';
    } else if (rawStatus === 'FACEBOOK_RECONNECT_REQUIRED') {
      normalizedStatus = 'FACEBOOK_RECONNECT_REQUIRED';
    }

    let scheduledTimeKolkata = '';
    if (typeof j.scheduledTimeUTC === 'string') {
      const utcDate = new Date(j.scheduledTimeUTC);
      if (!isNaN(utcDate.getTime())) {
        const pad = (n: number) => String(n).padStart(2, '0');
        const kolkataDate = new Date(utcDate.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
        scheduledTimeKolkata = `${kolkataDate.getFullYear()}-${pad(kolkataDate.getMonth() + 1)}-${pad(kolkataDate.getDate())}T${pad(kolkataDate.getHours())}:${pad(kolkataDate.getMinutes())}`;
      }
    }

    const normalizedContentType =
      j.contentType === 'PHOTO'
        ? ('PHOTO' as const)
        : j.contentType === 'REEL'
          ? ('REEL' as const)
          : ('VIDEO' as const);

    return {
      id: j.id,
      fileName:
        typeof j.fileName === 'string'
          ? j.fileName
          : normalizedContentType === 'PHOTO'
            ? 'image.jpg'
            : 'video.mp4',
      fileSize: typeof j.fileSize === 'string' ? j.fileSize : 'N/A',
      fileSizeBytes: typeof j.fileSizeBytes === 'number' ? j.fileSizeBytes : 0,
      durationSeconds: typeof j.durationSeconds === 'number' ? j.durationSeconds : 0,
      uploadProgress: typeof j.uploadProgress === 'number' ? j.uploadProgress : 100,
      pageId: j.pageId,
      pageName: typeof j.pageName === 'string' ? j.pageName : undefined,
      contentType: normalizedContentType,
      englishTitle: j.englishTitle,
      englishCaption: typeof j.englishCaption === 'string' ? j.englishCaption : '',
      hashtags: typeof j.hashtags === 'string' ? j.hashtags : '',
      scheduledTimeKolkata,
      scheduledTimeUTC: typeof j.scheduledTimeUTC === 'string' ? j.scheduledTimeUTC : '',
      status: normalizedStatus,
      metaPostId: typeof j.metaPostId === 'string' ? j.metaPostId : undefined,
      retryCount: typeof j.attemptCount === 'number' ? j.attemptCount : (typeof j.retryCount === 'number' ? j.retryCount : 0),
      errorLog: typeof j.lastErrorMessage === 'string' ? j.lastErrorMessage : (typeof j.errorLog === 'string' ? j.errorLog : undefined),
      thumbnailMode:
        typeof j.thumbnailAssetId === 'string'
          ? ('captured' as const)
          : ('auto' as const),
      attempts: Array.isArray(j.attempts) ? j.attempts : [],
      mockScenario: typeof j.mockScenario === 'string' ? j.mockScenario : undefined,
      uploadAssetId: typeof j.uploadAssetId === 'string' ? j.uploadAssetId : undefined,
      thumbnailAssetId: typeof j.thumbnailAssetId === 'string' ? j.thumbnailAssetId : undefined,
      createdAt: typeof j.createdAt === 'string' ? j.createdAt : undefined,
      updatedAt: typeof j.updatedAt === 'string' ? j.updatedAt : undefined
    };
  });
}
