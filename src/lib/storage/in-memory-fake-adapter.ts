import { Readable } from 'stream';
import { StorageAdapter, CompletedPart, ObjectMetadata, MultipartUploadNotFoundError } from './storage-adapter';

interface FakeUpload {
  bucket: string;
  key: string;
  contentType: string;
  parts: Map<number, CompletedPart & { data: Buffer }>;
}

interface FakeObject {
  size: number;
  etag: string;
  contentType: string;
  content: Buffer;
  lastModified: Date;
}

export class InMemoryFakeStorageAdapter implements StorageAdapter {
  private activeUploads = new Map<string, FakeUpload>();
  private storedObjects = new Map<string, FakeObject>();

  public completeCallsCount = 0;
  public abortCallsCount = 0;
  public simulateDelayMs = 0;
  public simulateGenericFailure = false;
  public simulateMultipartNotFound = false;

  constructor() {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Security Error: InMemoryFakeStorageAdapter cannot be instantiated in production.');
    }
  }

  private getObjectPath(bucket: string, key: string): string {
    return `${bucket}/${key}`;
  }

  // Helper method for unit tests to write mock part data directly
  public simulateUploadPart(uploadId: string, partNumber: number, data: Buffer, etag: string) {
    const upload = this.activeUploads.get(uploadId);
    if (!upload) {
      throw new Error(`Upload session ${uploadId} not found.`);
    }
    if (partNumber < 1 || partNumber > 10000) {
      throw new Error('Part number must be between 1 and 10000.');
    }
    upload.parts.set(partNumber, {
      partNumber,
      etag,
      size: data.length,
      data,
    });
  }

  async createMultipartUpload(bucket: string, key: string, contentType: string): Promise<string> {
    const uploadId = Math.random().toString(36).substring(2, 15);
    this.activeUploads.set(uploadId, {
      bucket,
      key,
      contentType,
      parts: new Map(),
    });
    return uploadId;
  }

  async createPresignedUploadPartUrl(
    bucket: string,
    key: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds?: number
  ): Promise<string> {
    const upload = this.activeUploads.get(uploadId);
    if (!upload) {
      throw new Error('Upload session not found.');
    }
    if (partNumber < 1 || partNumber > 10000) {
      throw new Error('Invalid part number: Part number must be between 1 and 10000.');
    }
    const ttl = expiresInSeconds || 900;
    return `https://fake-r2.local/${bucket}/${key}?uploadId=${uploadId}&partNumber=${partNumber}&expires=${ttl}`;
  }

  async listMultipartParts(
    bucket: string,
    key: string,
    uploadId: string
  ): Promise<CompletedPart[]> {
    const upload = this.activeUploads.get(uploadId);
    if (!upload) {
      throw new Error('Upload session not found.');
    }
    return Array.from(upload.parts.values())
      .map(({ partNumber, etag, size }) => ({ partNumber, etag, size }))
      .sort((a, b) => a.partNumber - b.partNumber);
  }

  async completeMultipartUpload(
    bucket: string,
    key: string,
    uploadId: string,
    parts: CompletedPart[]
  ): Promise<ObjectMetadata> {
    this.completeCallsCount++;

    if (this.simulateDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.simulateDelayMs));
    }

    if (this.simulateGenericFailure) {
      throw new Error('Fake generic provider complete failure.');
    }

    if (this.simulateMultipartNotFound) {
      throw new MultipartUploadNotFoundError();
    }

    const upload = this.activeUploads.get(uploadId);
    if (!upload) {
      throw new MultipartUploadNotFoundError();
    }

    // Verify parts matches the input parts list
    const sortedParts = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const buffers: Buffer[] = [];
    let totalSize = 0;

    for (let i = 0; i < sortedParts.length; i++) {
      const p = sortedParts[i];
      const recorded = upload.parts.get(p.partNumber);
      if (!recorded || recorded.etag !== p.etag) {
        throw new Error(`Part ${p.partNumber} is missing or has incorrect etag.`);
      }

      // Multipart size rule check: non-final parts must be at least 5 MiB (5242880 bytes)
      const isFinal = i === sortedParts.length - 1;
      if (!isFinal && recorded.size && recorded.size < 5242880) {
        throw new Error(`Part size validation error: Part ${p.partNumber} is less than 5 MiB limit.`);
      }

      buffers.push(recorded.data);
      totalSize += recorded.data.length;
    }

    const finalBuffer = Buffer.concat(buffers);
    const path = this.getObjectPath(bucket, key);

    const etag = `"${Math.random().toString(36).substring(2, 15)}"`;

    this.storedObjects.set(path, {
      size: totalSize,
      etag,
      contentType: upload.contentType,
      content: finalBuffer,
      lastModified: new Date(),
    });

    this.activeUploads.delete(uploadId);

    return {
      bucket,
      objectKey: key,
      size: totalSize,
      etag,
      contentType: upload.contentType,
      lastModified: new Date(),
    };
  }

  async abortMultipartUpload(
    bucket: string,
    key: string,
    uploadId: string
  ): Promise<void> {
    this.abortCallsCount++;

    if (this.simulateDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.simulateDelayMs));
    }

    if (this.simulateGenericFailure) {
      throw new Error('Fake generic provider abort failure.');
    }

    if (this.simulateMultipartNotFound) {
      throw new MultipartUploadNotFoundError();
    }

    const upload = this.activeUploads.get(uploadId);
    if (!upload) {
      throw new MultipartUploadNotFoundError();
    }
    this.activeUploads.delete(uploadId);
  }

  async headObject(bucket: string, key: string): Promise<ObjectMetadata | null> {
    const path = this.getObjectPath(bucket, key);
    const obj = this.storedObjects.get(path);
    if (!obj) {
      return null;
    }
    return {
      bucket,
      objectKey: key,
      size: obj.size,
      etag: obj.etag,
      contentType: obj.contentType,
      lastModified: obj.lastModified,
    };
  }

  async createReadStream(bucket: string, key: string): Promise<Readable> {
    const path = this.getObjectPath(bucket, key);
    const obj = this.storedObjects.get(path);
    if (!obj) {
      throw new Error(`Object ${key} not found in bucket ${bucket}.`);
    }
    const stream = new Readable();
    stream.push(obj.content);
    stream.push(null);
    return stream;
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    const path = this.getObjectPath(bucket, key);
    this.storedObjects.delete(path);
  }
}
