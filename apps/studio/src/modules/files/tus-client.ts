/**
 * Minimal TUS 1.0 client for the media library (#704): creation, chunked
 * PATCH, HEAD resync after a failure, and resume across page reloads.
 *
 * Protocol-compatible with any TUS server (tus-js-client works against the
 * CMS too); kept in-house so every request goes through the SDK's `rawFetch`,
 * which attaches the bearer and site headers the shell relies on (DoD §2d),
 * and so the upload queue owns retries.
 */
import { PermanentUploadError } from './upload-queue';

/** Studio's chunk size: well below the Workers request-body cap. */
export const TUS_CHUNK_SIZE = 16 * 1024 * 1024;

/** Files at or above this size use the resumable path. */
export const RESUMABLE_THRESHOLD = 32 * 1024 * 1024;

const STORE_PREFIX = 'lumibase:tus:';

/** `rawFetch`-shaped transport: resolves on 2xx, throws `{ status }` otherwise. */
export type TusTransport = (path: string, init: RequestInit) => Promise<Response>;

export interface TusUploadOptions {
  file: Blob & { name: string; type: string; lastModified?: number };
  /** Extra metadata (folder, alt…). `filename` / `filetype` are added from the file. */
  metadata?: Record<string, string>;
  transport: TusTransport;
  /** Scopes the resume key (site id); a different site never resumes this upload. */
  scope: string;
  chunkSize?: number;
  /** Delays between attempts after a network/5xx failure (ms). */
  retryDelays?: number[];
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /** Persists the upload URL so a reload resumes; defaults to localStorage when available. */
  store?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  sleep?: (ms: number) => Promise<void>;
}

function defaultStore(): TusUploadOptions['store'] {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function encodeMetadata(meta: Record<string, string>): string {
  return Object.entries(meta)
    .map(([k, v]) => {
      const bytes = new TextEncoder().encode(v);
      let bin = '';
      for (const b of bytes) bin += String.fromCharCode(b);
      return `${k} ${btoa(bin)}`;
    })
    .join(',');
}

function statusOf(err: unknown): number | null {
  const s = (err as { status?: unknown })?.status;
  return typeof s === 'number' ? s : null;
}

/** 4xx other than conflict/expired/locked are permanent: retrying will not help. */
function isRetryable(err: unknown): boolean {
  const s = statusOf(err);
  return s === null || s >= 500 || s === 409 || s === 423 || s === 429;
}

export function resumeKey(scope: string, file: TusUploadOptions['file']): string {
  return `${STORE_PREFIX}${scope}:${file.name}:${file.size}:${file.type}:${file.lastModified ?? 0}`;
}

function safeStore<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

/** Upload `file`; resolves with the created file id. */
export async function tusUpload(opts: TusUploadOptions): Promise<{ fileId: string; resumed: boolean }> {
  const { file, transport } = opts;
  const chunkSize = opts.chunkSize ?? TUS_CHUNK_SIZE;
  const delays = opts.retryDelays ?? [0, 1000, 3000, 5000, 10_000];
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const store = opts.store === undefined ? defaultStore() : opts.store;
  const key = resumeKey(opts.scope, file);
  const tusHeaders = { 'Tus-Resumable': '1.0.0' };

  const head = async (path: string) => {
    const res = await transport(path, { method: 'HEAD', headers: tusHeaders, signal: opts.signal });
    return {
      offset: Number(res.headers.get('Upload-Offset') ?? NaN),
      fileId: res.headers.get('X-Lumi-File-Id'),
    };
  };

  // 1. Resume a previous attempt (same site + same file) when the server still has it.
  let path: string | null = safeStore(() => store?.getItem(key) ?? null);
  let offset = 0;
  let resumed = false;
  if (path) {
    try {
      const probe = await head(path);
      if (probe.fileId) {
        safeStore(() => store?.removeItem(key));
        opts.onProgress?.(1);
        return { fileId: probe.fileId, resumed: true };
      }
      if (Number.isFinite(probe.offset)) {
        offset = probe.offset;
        resumed = true;
      } else path = null;
    } catch (err) {
      if (!isRetryable(err) || statusOf(err) === 409) path = null; // gone / expired / not ours
      else throw err;
    }
    if (!path) safeStore(() => store?.removeItem(key));
  }

  // 2. Create.
  if (!path) {
    const res = await transport('/api/v1/files/tus', {
      method: 'POST',
      headers: {
        ...tusHeaders,
        'Upload-Length': String(file.size),
        'Upload-Metadata': encodeMetadata({ filename: file.name, filetype: file.type || 'application/octet-stream', ...opts.metadata }),
      },
      signal: opts.signal,
    }).catch((err: unknown) => {
      throw statusOf(err) !== null && statusOf(err)! < 500 ? new PermanentUploadError((err as Error).message) : err;
    });
    const location = res.headers.get('Location');
    if (!location) throw new Error('Server did not return an upload Location.');
    path = new URL(location, 'http://placeholder').pathname;
    safeStore(() => store?.setItem(key, path!));
  }

  // 3. PATCH chunks; on failure HEAD to learn the committed offset and continue.
  let attempt = 0;
  for (;;) {
    if (opts.signal?.aborted) throw new Error('Cancelled');
    const end = Math.min(offset + chunkSize, file.size);
    try {
      const res = await transport(path, {
        method: 'PATCH',
        headers: { ...tusHeaders, 'Upload-Offset': String(offset), 'Content-Type': 'application/offset+octet-stream' },
        body: file.slice(offset, end),
        signal: opts.signal,
      });
      offset = Number(res.headers.get('Upload-Offset') ?? end);
      attempt = 0;
      opts.onProgress?.(file.size === 0 ? 1 : offset / file.size);
      if (offset >= file.size) {
        const fileId = res.headers.get('X-Lumi-File-Id');
        safeStore(() => store?.removeItem(key));
        if (!fileId) throw new Error('Upload finished but the server returned no file id.');
        return { fileId, resumed };
      }
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      if (!isRetryable(err) || attempt >= delays.length) {
        if (!isRetryable(err)) safeStore(() => store?.removeItem(key));
        throw isRetryable(err) ? err : new PermanentUploadError((err as Error).message ?? 'Upload refused');
      }
      await sleep(delays[attempt++]!);
      try {
        const probe = await head(path);
        if (probe.fileId) {
          safeStore(() => store?.removeItem(key));
          return { fileId: probe.fileId, resumed };
        }
        if (Number.isFinite(probe.offset)) offset = probe.offset;
      } catch (probeErr) {
        if (!isRetryable(probeErr)) {
          safeStore(() => store?.removeItem(key));
          throw new PermanentUploadError((probeErr as Error).message ?? 'Upload is gone');
        }
      }
    }
  }
}
