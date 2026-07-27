export type UploadMediaKind = 'video' | 'image';
export type UploadContentType = 'VIDEO' | 'REEL' | 'PHOTO';

export interface SupportedMediaDescriptor {
  readonly kind: UploadMediaKind;
  readonly contentType: 'VIDEO' | 'PHOTO';
  readonly extension: string;
  readonly mimeType: string;
}

const EXTENSION_TO_DESCRIPTOR: Readonly<Record<string, SupportedMediaDescriptor>> = {
  '.mp4': {
    kind: 'video',
    contentType: 'VIDEO',
    extension: '.mp4',
    mimeType: 'video/mp4',
  },
  '.mov': {
    kind: 'video',
    contentType: 'VIDEO',
    extension: '.mov',
    mimeType: 'video/quicktime',
  },
  '.jpg': {
    kind: 'image',
    contentType: 'PHOTO',
    extension: '.jpg',
    mimeType: 'image/jpeg',
  },
  '.jpeg': {
    kind: 'image',
    contentType: 'PHOTO',
    extension: '.jpeg',
    mimeType: 'image/jpeg',
  },
  '.png': {
    kind: 'image',
    contentType: 'PHOTO',
    extension: '.png',
    mimeType: 'image/png',
  },
  '.webp': {
    kind: 'image',
    contentType: 'PHOTO',
    extension: '.webp',
    mimeType: 'image/webp',
  },
};

const MIME_TO_KIND: Readonly<Record<string, UploadMediaKind>> = {
  'video/mp4': 'video',
  'video/quicktime': 'video',
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
};

export const SUPPORTED_VIDEO_ACCEPT = 'video/mp4,video/quicktime,.mp4,.mov';
export const SUPPORTED_IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp';
export const SUPPORTED_MEDIA_ACCEPT = `${SUPPORTED_VIDEO_ACCEPT},${SUPPORTED_IMAGE_ACCEPT}`;

export function getFileExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  return lastDot >= 0 ? filename.slice(lastDot).toLowerCase() : '';
}

export function getSupportedMediaDescriptor(
  filename: string,
  declaredMimeType?: string | null,
): SupportedMediaDescriptor | null {
  const descriptor = EXTENSION_TO_DESCRIPTOR[getFileExtension(filename)];
  if (!descriptor) return null;

  const normalizedMime = declaredMimeType?.trim().toLowerCase() || '';
  if (!normalizedMime) return descriptor;

  if (normalizedMime !== descriptor.mimeType) {
    return null;
  }

  return descriptor;
}

export function inferSupportedMimeType(
  filename: string,
  declaredMimeType?: string | null,
): string {
  const descriptor = getSupportedMediaDescriptor(filename, declaredMimeType);
  if (descriptor) return descriptor.mimeType;

  const normalizedMime = declaredMimeType?.trim().toLowerCase() || '';
  if (MIME_TO_KIND[normalizedMime]) return normalizedMime;

  return 'application/octet-stream';
}

export function getMediaKindFromMimeType(
  mimeType?: string | null,
): UploadMediaKind | null {
  const normalizedMime = mimeType?.trim().toLowerCase() || '';
  return MIME_TO_KIND[normalizedMime] || null;
}

export function isPhotoContentType(contentType?: string | null): boolean {
  return contentType?.trim().toUpperCase() === 'PHOTO';
}

export function isVideoContentType(contentType?: string | null): boolean {
  const normalized = contentType?.trim().toUpperCase();
  return normalized === 'VIDEO' || normalized === 'REEL';
}
