import { inferSupportedMimeType } from './media-file-types';

export type BrowserUploadState =
  | 'idle'
  | 'selected'
  | 'initiating'
  | 'uploading'
  | 'paused'
  | 'retrying'
  | 'completing'
  | 'validating'
  | 'validated'
  | 'failed'
  | 'aborting'
  | 'aborted';

export interface MediaMetadata {
  durationMs?: number | null;
  width?: number | null;
  height?: number | null;
  frameRate?: number | null;
  videoCodec?: string | null;
  audioCodec?: string | null;
  containerFormat?: string | null;
  detectedMimeType?: string | null;
}

// Backward-compatible name used by the existing video tests and call sites.
export type VideoMetadata = MediaMetadata;

export interface BrowserUploaderStatus {
  state: BrowserUploadState;
  progressPercent: number;
  uploadedBytes: number;
  totalBytes: number;
  assetId?: string;
  error?: string;
  retryAttempt?: number;
  metadata?: MediaMetadata;
  provider?: 'R2' | 'GOOGLE_DRIVE';
}

export interface UploadFileLike {
  readonly name: string;
  readonly size: number;
  readonly type: string;
  readonly lastModified: number;
  slice(start?: number, end?: number, contentType?: string): Blob;
}

export function getUploadFileMimeType(file: Pick<UploadFileLike, 'name' | 'type'>): string {
  return inferSupportedMimeType(file.name, file.type);
}
