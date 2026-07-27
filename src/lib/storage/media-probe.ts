export interface MediaMetadata {
  containerFormat: string;
  durationMs: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  width: number;
  height: number;
  frameRate: number | null;
  detectedMimeType: string | null;
}

export interface MediaProbe {
  probe(filePath: string): Promise<MediaMetadata>;
}

export class MediaValidationError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'MediaValidationError';
  }
}
