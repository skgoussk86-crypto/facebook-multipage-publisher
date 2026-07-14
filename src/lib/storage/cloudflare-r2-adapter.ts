import { Readable } from 'stream';
import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  ListPartsCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { StorageAdapter, CompletedPart, ObjectMetadata } from './storage-adapter';
import { StorageConfig, validateR2Config } from './storage-config';

export class CloudflareR2StorageAdapter implements StorageAdapter {
  private s3Client: S3Client | null = null;
  private config: StorageConfig;

  constructor(config: StorageConfig) {
    this.config = config;
  }

  private get s3(): S3Client {
    if (!this.s3Client) {
      // Validate configuration lazily on first access
      validateR2Config(this.config);

      this.s3Client = new S3Client({
        region: this.config.r2.region || 'auto',
        endpoint: this.config.r2.endpoint,
        credentials: {
          accessKeyId: this.config.r2.accessKeyId,
          secretAccessKey: this.config.r2.secretAccessKey,
        },
      });
    }
    return this.s3Client;
  }

  private validateBucket(bucket: string) {
    if (bucket !== this.config.r2.bucketName) {
      throw new Error('Access denied: Unauthorized bucket access.');
    }
  }

  async createMultipartUpload(bucket: string, key: string, contentType: string): Promise<string> {
    this.validateBucket(bucket);
    const command = new CreateMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
    });
    const response = await this.s3.send(command);
    if (!response.UploadId) {
      throw new Error('Failed to initiate R2 multipart upload.');
    }
    return response.UploadId;
  }

  async createPresignedUploadPartUrl(
    bucket: string,
    key: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds?: number
  ): Promise<string> {
    this.validateBucket(bucket);
    if (partNumber < 1 || partNumber > 10000) {
      throw new Error('Invalid part number: Part number must be between 1 and 10000.');
    }
    const command = new UploadPartCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
    });
    const ttl = expiresInSeconds || this.config.r2.presignedUrlTtlSeconds;
    return await getSignedUrl(this.s3, command, { expiresIn: ttl });
  }

  async listMultipartParts(
    bucket: string,
    key: string,
    uploadId: string
  ): Promise<CompletedPart[]> {
    this.validateBucket(bucket);
    const command = new ListPartsCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
    });
    const response = await this.s3.send(command);
    return (response.Parts || []).map(p => ({
      partNumber: p.PartNumber || 0,
      etag: p.ETag || '',
      size: p.Size,
    }));
  }

  async completeMultipartUpload(
    bucket: string,
    key: string,
    uploadId: string,
    parts: CompletedPart[]
  ): Promise<ObjectMetadata> {
    this.validateBucket(bucket);
    const command = new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: parts.map(p => ({
          PartNumber: p.partNumber,
          ETag: p.etag,
        })),
      },
    });
    await this.s3.send(command);

    // R2 complete upload returns Location/Bucket/Key/ETag.
    // Fetch head of the object to get accurate size and MIME details.
    const head = await this.headObject(bucket, key);
    if (!head) {
      throw new Error('Failed to retrieve metadata for completed upload.');
    }
    return head;
  }

  async abortMultipartUpload(
    bucket: string,
    key: string,
    uploadId: string
  ): Promise<void> {
    this.validateBucket(bucket);
    const command = new AbortMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
    });
    await this.s3.send(command);
  }

  async headObject(bucket: string, key: string): Promise<ObjectMetadata | null> {
    this.validateBucket(bucket);
    try {
      const command = new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
      });
      const response = await this.s3.send(command);
      return {
        bucket,
        objectKey: key,
        size: response.ContentLength || 0,
        etag: response.ETag || '',
        contentType: response.ContentType || 'binary/octet-stream',
        lastModified: response.LastModified,
      };
    } catch (error: unknown) {
      const err = error as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (err?.name === 'NotFound' || err?.$metadata?.httpStatusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  async createReadStream(bucket: string, key: string): Promise<Readable> {
    this.validateBucket(bucket);
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    });
    const response = await this.s3.send(command);
    if (!response.Body) {
      throw new Error('No body returned from GCS stream.');
    }
    return response.Body as Readable;
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    this.validateBucket(bucket);
    const command = new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    });
    await this.s3.send(command);
  }
}
