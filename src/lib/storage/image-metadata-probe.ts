import "server-only";

import { open } from 'node:fs/promises';

import type { MediaMetadata } from './media-probe';
import { MediaValidationError } from './media-probe';

const MAX_HEADER_BYTES = 2 * 1024 * 1024;

function readUInt24LE(buffer: Buffer, offset: number): number {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

function parsePng(buffer: Buffer): MediaMetadata | null {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)) return null;
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') {
    throw new MediaValidationError('INVALID_IMAGE_STRUCTURE', 'PNG file is missing its IHDR header.');
  }

  return {
    containerFormat: 'png',
    durationMs: null,
    videoCodec: null,
    audioCodec: null,
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    frameRate: null,
    detectedMimeType: 'image/png',
  };
}

function parseJpeg(buffer: Buffer): MediaMetadata | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;

  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) break;

    const marker = buffer[offset];
    offset += 1;

    if (marker === 0xd8 || marker === 0xd9) continue;
    if (marker === 0xda) break;
    if (offset + 2 > buffer.length) break;

    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) break;

    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);

    if (isStartOfFrame) {
      if (segmentLength < 7) {
        throw new MediaValidationError('INVALID_IMAGE_STRUCTURE', 'JPEG start-of-frame header is incomplete.');
      }
      return {
        containerFormat: 'jpeg',
        durationMs: null,
        videoCodec: null,
        audioCodec: null,
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5),
        frameRate: null,
        detectedMimeType: 'image/jpeg',
      };
    }

    offset += segmentLength;
  }

  throw new MediaValidationError(
    'INVALID_IMAGE_STRUCTURE',
    'JPEG dimensions could not be read from the uploaded file.',
  );
}

function parseWebp(buffer: Buffer): MediaMetadata | null {
  if (
    buffer.length < 30 ||
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    return null;
  }

  const chunkType = buffer.toString('ascii', 12, 16);
  let width: number;
  let height: number;

  if (chunkType === 'VP8X') {
    width = 1 + readUInt24LE(buffer, 24);
    height = 1 + readUInt24LE(buffer, 27);
  } else if (chunkType === 'VP8L') {
    if (buffer[20] !== 0x2f) {
      throw new MediaValidationError('INVALID_IMAGE_STRUCTURE', 'WebP lossless header is invalid.');
    }
    const bits = buffer.readUInt32LE(21);
    width = (bits & 0x3fff) + 1;
    height = ((bits >> 14) & 0x3fff) + 1;
  } else if (chunkType === 'VP8 ') {
    let frameOffset = 20;
    while (
      frameOffset + 10 <= buffer.length &&
      !(buffer[frameOffset + 3] === 0x9d && buffer[frameOffset + 4] === 0x01 && buffer[frameOffset + 5] === 0x2a)
    ) {
      frameOffset += 1;
    }
    if (frameOffset + 10 > buffer.length) {
      throw new MediaValidationError('INVALID_IMAGE_STRUCTURE', 'WebP frame dimensions could not be read.');
    }
    width = buffer.readUInt16LE(frameOffset + 6) & 0x3fff;
    height = buffer.readUInt16LE(frameOffset + 8) & 0x3fff;
  } else {
    throw new MediaValidationError('INVALID_IMAGE_STRUCTURE', 'Unsupported WebP bitstream header.');
  }

  return {
    containerFormat: 'webp',
    durationMs: null,
    videoCodec: null,
    audioCodec: null,
    width,
    height,
    frameRate: null,
    detectedMimeType: 'image/webp',
  };
}

export class ImageMetadataProbe {
  static async probe(filePath: string): Promise<MediaMetadata> {
    const handle = await open(filePath, 'r');
    try {
      const stats = await handle.stat();
      const bytesToRead = Math.min(stats.size, MAX_HEADER_BYTES);
      if (bytesToRead <= 0) {
        throw new MediaValidationError('EMPTY_IMAGE', 'Uploaded image is empty.');
      }

      const buffer = Buffer.alloc(bytesToRead);
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
      const header = buffer.subarray(0, bytesRead);

      const metadata = parsePng(header) || parseJpeg(header) || parseWebp(header);
      if (!metadata) {
        throw new MediaValidationError(
          'UNSUPPORTED_IMAGE_FORMAT',
          'Image signature must be JPEG, PNG, or WebP.',
        );
      }

      if (metadata.width <= 0 || metadata.height <= 0) {
        throw new MediaValidationError('INVALID_DIMENSIONS', 'Image width and height must be positive.');
      }

      if (metadata.width > 32768 || metadata.height > 32768) {
        throw new MediaValidationError(
          'IMAGE_DIMENSIONS_EXCEEDED',
          'Image dimensions exceed the safe 32768-pixel limit.',
        );
      }

      if (metadata.width * metadata.height > 100_000_000) {
        throw new MediaValidationError(
          'IMAGE_PIXEL_LIMIT_EXCEEDED',
          'Image contains more than 100 million pixels.',
        );
      }

      return metadata;
    } finally {
      await handle.close();
    }
  }
}
