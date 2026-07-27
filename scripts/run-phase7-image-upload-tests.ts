import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SUPPORTED_IMAGE_ACCEPT,
  SUPPORTED_VIDEO_ACCEPT,
  getSupportedMediaDescriptor,
  inferSupportedMimeType,
} from '../src/lib/uploads/media-file-types';
import { UploadQueueController } from '../src/lib/uploads/upload-queue-controller';
import { ImageMetadataProbe } from '../src/lib/storage/image-metadata-probe';

function fakeFile(
  name: string,
  type: string,
  size = 1024,
  lastModified = 1,
): File {
  return {
    name,
    type,
    size,
    lastModified,
    slice: () => new Blob(),
  } as File;
}

function makePng(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function makeJpeg(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(23);
  buffer.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08], 0);
  buffer.writeUInt16BE(height, 7);
  buffer.writeUInt16BE(width, 9);
  buffer.set([0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9], 11);
  return buffer;
}

function makeWebp(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(30);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(22, 4);
  buffer.write('WEBP', 8, 'ascii');
  buffer.write('VP8X', 12, 'ascii');
  buffer.writeUInt32LE(10, 16);
  const w = width - 1;
  const h = height - 1;
  buffer[24] = w & 0xff;
  buffer[25] = (w >> 8) & 0xff;
  buffer[26] = (w >> 16) & 0xff;
  buffer[27] = h & 0xff;
  buffer[28] = (h >> 8) & 0xff;
  buffer[29] = (h >> 16) & 0xff;
  return buffer;
}

async function main(): Promise<void> {
  assert.equal(getSupportedMediaDescriptor('clip.mp4', 'video/mp4')?.contentType, 'VIDEO');
  assert.equal(getSupportedMediaDescriptor('clip.mov', 'video/quicktime')?.kind, 'video');
  assert.equal(getSupportedMediaDescriptor('photo.jpg', 'image/jpeg')?.contentType, 'PHOTO');
  assert.equal(getSupportedMediaDescriptor('photo.jpeg', 'image/jpeg')?.contentType, 'PHOTO');
  assert.equal(getSupportedMediaDescriptor('photo.png', 'image/png')?.kind, 'image');
  assert.equal(getSupportedMediaDescriptor('photo.webp', 'image/webp')?.kind, 'image');
  assert.equal(getSupportedMediaDescriptor('photo.png', 'image/jpeg'), null);
  assert.equal(inferSupportedMimeType('photo.jpg', ''), 'image/jpeg');
  assert.match(SUPPORTED_VIDEO_ACCEPT, /video\/mp4/);
  assert.match(SUPPORTED_IMAGE_ACCEPT, /image\/webp/);

  const queue = new UploadQueueController({ maxConcurrency: 0 });
  queue.addFiles(
    [
      fakeFile('one.mp4', 'video/mp4', 2048, 11),
      fakeFile('two.png', 'image/png', 4096, 12),
      fakeFile('bad.jpg', 'image/png', 1024, 13),
    ],
    'page-selected-before-upload',
    500,
  );
  const items = queue.getItems();
  assert.equal(items.length, 3);
  assert.equal(items[0]?.pageId, 'page-selected-before-upload');
  assert.equal(items[0]?.contentType, 'VIDEO');
  assert.equal(items[1]?.pageId, 'page-selected-before-upload');
  assert.equal(items[1]?.contentType, 'PHOTO');
  assert.equal(items[1]?.status, 'QUEUED');
  assert.equal(items[2]?.status, 'FAILED');
  assert.match(items[2]?.error || '', /MIME type does not match/i);

  const folder = await mkdtemp(join(tmpdir(), 'phase7-image-probe-'));
  try {
    const pngPath = join(folder, 'test.png');
    const jpgPath = join(folder, 'test.jpg');
    const webpPath = join(folder, 'test.webp');
    await writeFile(pngPath, makePng(1200, 630));
    await writeFile(jpgPath, makeJpeg(1080, 1350));
    await writeFile(webpPath, makeWebp(1920, 1080));

    const png = await ImageMetadataProbe.probe(pngPath);
    const jpg = await ImageMetadataProbe.probe(jpgPath);
    const webp = await ImageMetadataProbe.probe(webpPath);

    assert.deepEqual([png.detectedMimeType, png.width, png.height], ['image/png', 1200, 630]);
    assert.deepEqual([jpg.detectedMimeType, jpg.width, jpg.height], ['image/jpeg', 1080, 1350]);
    assert.deepEqual([webp.detectedMimeType, webp.width, webp.height], ['image/webp', 1920, 1080]);
    assert.equal(png.durationMs, null);
    assert.equal(jpg.videoCodec, null);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }

  const dashboard = readFileSync('src/app/DashboardClient.tsx', 'utf8');
  const uploader = readFileSync('src/components/uploads/video-uploader.tsx', 'utf8');
  const validation = readFileSync('src/lib/storage/video-validation-service.ts', 'utf8');
  const initiate = readFileSync('src/lib/google-drive/google-drive-upload-initiation-service.ts', 'utf8');

  assert.match(dashboard, />\s*Upload Videos\s*</);
  assert.match(dashboard, />\s*Upload Images\s*</);
  assert.match(dashboard, /contentType === "PHOTO"/);
  assert.match(dashboard, /localMediaUrl/);
  assert.match(uploader, /SUPPORTED_IMAGE_ACCEPT/);
  assert.match(uploader, /Image[\s\S]*Verified[\s\S]*Validated/);
  assert.match(validation, /ImageMetadataProbe\.probe/);
  assert.match(validation, /declaredKind === 'image'/);
  assert.match(initiate, /getSupportedMediaDescriptor/);

  console.log('PHASE7_IMAGE_UPLOAD_FOUNDATION_TESTS=PASSED');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
