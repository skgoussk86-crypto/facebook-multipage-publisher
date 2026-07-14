import { Readable } from 'stream';

export interface CompletedPart {
  partNumber: number;
  etag: string;
  size?: number;
}

export interface ObjectMetadata {
  bucket: string;
  objectKey: string;
  size: number;
  etag: string;
  contentType: string;
  lastModified?: Date;
}

export interface StorageAdapter {
  createMultipartUpload(bucket: string, key: string, contentType: string): Promise<string>;

  createPresignedUploadPartUrl(
    bucket: string,
    key: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds?: number
  ): Promise<string>;

  listMultipartParts(
    bucket: string,
    key: string,
    uploadId: string
  ): Promise<CompletedPart[]>;

  completeMultipartUpload(
    bucket: string,
    key: string,
    uploadId: string,
    parts: CompletedPart[]
  ): Promise<ObjectMetadata>;

  abortMultipartUpload(
    bucket: string,
    key: string,
    uploadId: string
  ): Promise<void>;

  headObject(bucket: string, key: string): Promise<ObjectMetadata | null>;

  createReadStream(bucket: string, key: string): Promise<Readable>;

  deleteObject(bucket: string, key: string): Promise<void>;
}
