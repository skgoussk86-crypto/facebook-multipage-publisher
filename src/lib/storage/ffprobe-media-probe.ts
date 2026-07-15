import { execFile } from 'child_process';
import { MediaProbe, MediaMetadata, MediaValidationError } from './media-probe';

export class FfprobeMediaProbe implements MediaProbe {
  async probe(filePath: string): Promise<MediaMetadata> {
    const ffprobePath = process.env.FFPROBE_PATH || 'ffprobe';
    const args = [
      '-v', 'error',
      '-show_format',
      '-show_streams',
      '-of', 'json',
      filePath
    ];

    return new Promise<MediaMetadata>((resolve, reject) => {
      const maxBuffer = 1024 * 1024; // 1 MB buffer limit
      const timeout = 10000; // 10-second hard timeout

      execFile(
        ffprobePath,
        args,
        {
          shell: false,
          maxBuffer,
          timeout,
          killSignal: 'SIGKILL'
        },
        (error, stdout) => {
          if (error) {
            const isKilled = (error as { killed?: boolean }).killed;
            if (isKilled) {
              return reject(new Error('ffprobe process timed out.'));
            }
            if ((error as unknown as Record<string, unknown>).code === 'ENOENT') {
              return reject(new Error('FFPROBE_NOT_FOUND'));
            }
            return reject(new Error(`ffprobe failed: ${error.message}`));
          }

          try {
            const trimmed = stdout.trim();
            if (!trimmed) {
              throw new Error('ffprobe output is empty.');
            }
            if (trimmed.length > 500 * 1024) {
              throw new Error('ffprobe output is too large.');
            }

            const data = JSON.parse(trimmed);
            const metadata = this.parseFfprobeOutput(data);
            resolve(metadata);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            reject(new Error(`Failed to parse ffprobe output: ${msg}`));
          }
        }
      );
    });
  }

  private parseFfprobeOutput(data: unknown): MediaMetadata {
    if (!data || typeof data !== 'object') {
      throw new Error('Invalid JSON format.');
    }

    const typedData = data as Record<string, unknown>;

    const format = typedData.format;
    if (!format || typeof format !== 'object') {
      throw new Error('Format section is missing in ffprobe output.');
    }
    const typedFormat = format as Record<string, unknown>;

    const containerFormat = typedFormat.format_name;
    if (typeof containerFormat !== 'string' || !containerFormat.trim()) {
      throw new Error('Missing or invalid container format.');
    }

    const durationSecStr = typedFormat.duration;
    if (typeof durationSecStr !== 'string' && typeof durationSecStr !== 'number') {
      throw new Error('Missing or invalid duration field.');
    }
    const durationSec = parseFloat(String(durationSecStr));
    if (isNaN(durationSec) || durationSec <= 0) {
      throw new Error('Invalid duration value.');
    }
    const durationMs = Math.round(durationSec * 1000);

    const streams = typedData.streams;
    if (!Array.isArray(streams)) {
      throw new Error('Streams section is missing or invalid.');
    }

    // Find first video stream
    const videoStream = streams.find((s) => s && typeof s === 'object' && s.codec_type === 'video');
    if (!videoStream) {
      throw new MediaValidationError('MISSING_VIDEO_STREAM', 'No video stream found in media.');
    }
    const typedVideoStream = videoStream as Record<string, unknown>;

    const videoCodec = typedVideoStream.codec_name;
    if (typeof videoCodec !== 'string' || !videoCodec.trim()) {
      throw new Error('Missing or invalid video codec.');
    }

    const width = parseInt(String(typedVideoStream.width), 10);
    const height = parseInt(String(typedVideoStream.height), 10);
    if (isNaN(width) || width <= 0 || isNaN(height) || height <= 0) {
      throw new Error('Invalid video dimensions.');
    }

    const frameRateStr = typedVideoStream.r_frame_rate;
    if (typeof frameRateStr !== 'string' || !frameRateStr.trim()) {
      throw new Error('Missing or invalid frame rate.');
    }
    const [numStr, denStr] = frameRateStr.split('/');
    const num = parseFloat(numStr);
    const den = parseFloat(denStr || '1');
    if (isNaN(num) || isNaN(den) || den === 0) {
      throw new Error('Invalid frame rate format.');
    }
    const frameRate = num / den;
    if (frameRate <= 0) {
      throw new Error('Frame rate must be positive.');
    }

    // Find audio codec if an audio stream exists
    const audioStream = streams.find((s) => s && typeof s === 'object' && s.codec_type === 'audio');
    const audioCodec = audioStream && typeof (audioStream as Record<string, unknown>).codec_name === 'string'
      ? ((audioStream as Record<string, unknown>).codec_name as string)
      : null;

    // Detect MIME type where determinable
    let detectedMimeType: string | null = null;
    const formats = containerFormat.split(',');
    if (formats.includes('mp4')) {
      detectedMimeType = 'video/mp4';
    } else if (formats.includes('mov') || formats.includes('quicktime') || formats.includes('qt')) {
      detectedMimeType = 'video/quicktime';
    }

    return {
      containerFormat,
      durationMs,
      videoCodec,
      audioCodec,
      width,
      height,
      frameRate,
      detectedMimeType
    };
  }
}
