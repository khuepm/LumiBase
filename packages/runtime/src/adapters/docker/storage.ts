import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import type { StorageProvider, StorageObject } from '../../interfaces';

export interface S3StorageConfig {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region?: string;
}

/**
 * S3/MinIO-backed StorageProvider implementation for Docker environments.
 *
 * Uses @aws-sdk/client-s3 with forcePathStyle enabled for MinIO compatibility.
 */
export class S3StorageProvider implements StorageProvider {
  private client: S3Client;
  private bucket: string;

  constructor(config: S3StorageConfig) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region ?? 'us-east-1',
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: true,
    });
  }

  async put(key: string, data: ReadableStream | Buffer, metadata?: Record<string, string>): Promise<void> {
    const body = Buffer.isBuffer(data) ? data : Buffer.from(await this.streamToBuffer(data as ReadableStream));

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        Metadata: metadata,
        // Map the logical content type onto S3's native `ContentType` so
        // `get()` (which reads `response.ContentType`) round-trips it. S3
        // lowercases user-metadata keys, so relying on `Metadata.contentType`
        // alone would not survive the round-trip.
        ...(metadata?.contentType ? { ContentType: metadata.contentType } : {}),
      }),
    );
  }

  async get(key: string): Promise<StorageObject | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );

      if (!response.Body) {
        return null;
      }

      const body = Buffer.from(await response.Body.transformToByteArray());

      return {
        key,
        body,
        contentType: response.ContentType,
        size: response.ContentLength,
        metadata: response.Metadata,
      };
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'NoSuchKey') {
        return null;
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );
  }

  async list(prefix?: string): Promise<{ keys: string[] }> {
    const keys: string[] = [];
    let continuationToken: string | undefined;

    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );

      if (response.Contents) {
        for (const object of response.Contents) {
          if (object.Key) {
            keys.push(object.Key);
          }
        }
      }

      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);

    return { keys };
  }

  private async streamToBuffer(stream: ReadableStream): Promise<Uint8Array> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    return result;
  }
}
