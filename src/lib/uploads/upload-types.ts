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

export interface VideoMetadata {
  durationMs?: number;
  width?: number;
  height?: number;
  frameRate?: number;
  videoCodec?: string;
  audioCodec?: string;
  containerFormat?: string;
  detectedMimeType?: string;
}

export interface BrowserUploaderStatus {
  state: BrowserUploadState;
  progressPercent: number;
  uploadedBytes: number;
  totalBytes: number;
  assetId?: string;
  error?: string;
  retryAttempt?: number;
  metadata?: VideoMetadata;
}
