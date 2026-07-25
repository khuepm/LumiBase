import type { StorageProvider, StorageObject } from '../../interfaces';

/**
 * Cloudflare R2 types (declared locally to avoid requiring @cloudflare/workers-types as a dependency).
 */
interface R2ObjectBody {
  key: string;
  size: number;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
  body: ReadableStream;
}

interface R2ListOptions {
  prefix?: string;
  limit?: number;
  cursor?: string;
}

interface R2ListResult {
  objects: Array<{ key: string }>;
  truncated: boolean;
  cursor?: string;
}

interface R2PutOptions {
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

export interface R2Bucket {
  put(key: string, value: ReadableStream | ArrayBuffer | string | null, options?: R2PutOptions): Promise<unknown>;
  get(key: string): Promise<R2ObjectBody | null>;
  delete(key: string | string[]): Promise<void>;
  list(options?: R2ListOptions): Promise<R2ListResult>;
}

/**
 * Cloudflare R2-backed StorageProvider implementation.
 *
 * Wraps an R2Bucket binding to satisfy the StorageProvider interface,
 * enabling the CMS to use R2 for object/blob storage on Cloudflare Workers.
 */
export class CloudflareStorageProvider implements StorageProvider {
  constructor(private bucket: R2Bucket) {}

  async put(key: string, data: ReadableStream | Buffer, metadata?: Record<string, string>): Promise<void> {
    const options: R2PutOptions = {};
    if (metadata) {
      options.customMetadata = metadata;
      // Map the logical content type onto R2's native `httpMetadata` so
      // `get()` (which reads `httpMetadata.contentType`) round-trips it. Left
      // only in `customMetadata`, the served Content-Type would come back
      // undefined.
      if (metadata.contentType) {
        options.httpMetadata = { contentType: metadata.contentType };
      }
    }
    // Convert Buffer to ArrayBuffer for R2 compatibility
    const body = Buffer.isBuffer(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer : data;
    await this.bucket.put(key, body, options);
  }

  async get(key: string): Promise<StorageObject | null> {
    const object = await this.bucket.get(key);
    if (!object) {
      return null;
    }

    return {
      key: object.key,
      body: object.body,
      contentType: object.httpMetadata?.contentType,
      size: object.size,
      metadata: object.customMetadata,
    };
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }

  async list(prefix?: string): Promise<{ keys: string[] }> {
    const keys: string[] = [];
    let cursor: string | undefined;
    let truncated = true;

    while (truncated) {
      const result = await this.bucket.list({
        prefix,
        cursor,
        limit: 1000,
      });

      for (const object of result.objects) {
        keys.push(object.key);
      }

      truncated = result.truncated;
      cursor = result.cursor;
    }

    return { keys };
  }
}
