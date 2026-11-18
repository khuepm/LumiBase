export interface StorageObject {
  key: string;
  body: ReadableStream | Buffer;
  contentType?: string;
  size?: number;
  metadata?: Record<string, string>;
}

export interface MultipartPart {
  partNumber: number;
  etag: string;
}

/**
 * Server-side multipart upload (#704, resumable uploads). Both backends that
 * implement it (R2, S3/MinIO) require every part except the last to be at
 * least 5 MiB; R2 also requires all non-final parts to be the same size, so
 * callers use one fixed part size.
 */
export interface MultipartStorage {
  createMultipart(key: string, metadata?: Record<string, string>): Promise<{ uploadId: string }>;
  uploadPart(key: string, uploadId: string, partNumber: number, data: Uint8Array): Promise<MultipartPart>;
  completeMultipart(key: string, uploadId: string, parts: MultipartPart[]): Promise<void>;
  abortMultipart(key: string, uploadId: string): Promise<void>;
}

export interface StorageProvider extends Partial<MultipartStorage> {
  put(key: string, data: ReadableStream | Buffer, metadata?: Record<string, string>): Promise<void>;
  get(key: string): Promise<StorageObject | null>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<{ keys: string[] }>;
}

/** Whether a storage provider supports server-side multipart uploads. */
export function supportsMultipart(storage: StorageProvider): storage is StorageProvider & MultipartStorage {
  return (
    typeof storage.createMultipart === 'function' &&
    typeof storage.uploadPart === 'function' &&
    typeof storage.completeMultipart === 'function' &&
    typeof storage.abortMultipart === 'function'
  );
}
