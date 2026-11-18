import type { MultipartPart, StorageProvider, StorageObject } from '../../interfaces';

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

interface R2UploadedPart {
  partNumber: number;
  etag: string;
}

export interface R2MultipartUpload {
  readonly key: string;
  readonly uploadId: string;
  uploadPart(partNumber: number, value: ArrayBuffer | ReadableStream | string): Promise<R2UploadedPart>;
  complete(parts: R2UploadedPart[]): Promise<unknown>;
  abort(): Promise<void>;
}

export interface R2Bucket {
  put(key: string, value: ReadableStream | ArrayBuffer | string | null, options?: R2PutOptions): Promise<unknown>;
  get(key: string): Promise<R2ObjectBody | null>;
  delete(key: string | string[]): Promise<void>;
  list(options?: R2ListOptions): Promise<R2ListResult>;
  /** R2 multipart (resumable uploads, #704). Optional so older test doubles still type. */
  createMultipartUpload?(key: string, options?: R2PutOptions): Promise<R2MultipartUpload>;
  resumeMultipartUpload?(key: string, uploadId: string): R2MultipartUpload;
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
    // Convert Buffer to ArrayBuffer for R2 compatibility.
    // `Buffer.isBuffer` is typed `any` under @cloudflare/workers-types v5 (which
    // declares its own `Buffer: any` and is the only `types` entry for the Worker
    // build), so it no longer narrows. Test the view shape instead — that works
    // whichever `Buffer` type is in scope.
    const isBufferView = (v: unknown): v is Uint8Array =>
      typeof v === 'object' && v !== null && ArrayBuffer.isView(v as ArrayBufferView);
    const body = isBufferView(data)
      ? (data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer)
      : data;
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

  // ─── Multipart (resumable uploads, #704) ──────────────────────────────────

  private multipart(key: string, uploadId: string): R2MultipartUpload {
    if (!this.bucket.resumeMultipartUpload) throw new Error('R2 bucket binding does not support multipart uploads.');
    return this.bucket.resumeMultipartUpload(key, uploadId);
  }

  async createMultipart(key: string, metadata?: Record<string, string>): Promise<{ uploadId: string }> {
    if (!this.bucket.createMultipartUpload) throw new Error('R2 bucket binding does not support multipart uploads.');
    const options: R2PutOptions = {};
    if (metadata) {
      options.customMetadata = metadata;
      if (metadata.contentType) options.httpMetadata = { contentType: metadata.contentType };
    }
    const upload = await this.bucket.createMultipartUpload(key, options);
    return { uploadId: upload.uploadId };
  }

  async uploadPart(key: string, uploadId: string, partNumber: number, data: Uint8Array): Promise<MultipartPart> {
    // Copy into a standalone ArrayBuffer: a view into a larger buffer would
    // upload bytes that are not part of this chunk.
    const body = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    const part = await this.multipart(key, uploadId).uploadPart(partNumber, body);
    return { partNumber: part.partNumber, etag: part.etag };
  }

  async completeMultipart(key: string, uploadId: string, parts: MultipartPart[]): Promise<void> {
    await this.multipart(key, uploadId).complete([...parts].sort((a, b) => a.partNumber - b.partNumber));
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    await this.multipart(key, uploadId).abort();
  }
}
