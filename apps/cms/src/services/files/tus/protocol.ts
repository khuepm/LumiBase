/**
 * TUS 1.0 protocol helpers (#704): https://tus.io/protocols/resumable-upload
 *
 * Implemented: core protocol, `creation`, `termination`, `expiration`.
 * Not implemented: `creation-defer-length`, `concatenation`, `checksum`
 * (clients fall back to the core protocol, which is all tus-js-client needs).
 */

export const TUS_VERSION = '1.0.0';
export const TUS_EXTENSIONS = 'creation,termination,expiration';

/**
 * Fixed multipart part size. R2 requires every non-final part to have the same
 * size and both R2 and S3 require at least 5 MiB, so bytes are cut into 8 MiB
 * parts and the remainder waits in a tail object for the next PATCH.
 */
export const PART_SIZE = 8 * 1024 * 1024;

/**
 * Largest PATCH body accepted. Workers cap request bodies (100 MB on the paid
 * plan), so clients send chunks; Studio uses 16 MiB.
 */
export const MAX_PATCH_BYTES = 64 * 1024 * 1024;

/** An unfinished upload expires 24 hours after its last progress. */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export const TUS_HEADERS = {
  'Tus-Resumable': TUS_VERSION,
} as const;

/** Request/response headers the browser must be allowed to send/read (CORS). */
export const TUS_REQUEST_HEADERS = ['Tus-Resumable', 'Upload-Length', 'Upload-Offset', 'Upload-Metadata'] as const;
export const TUS_EXPOSE_HEADERS = [
  'Location',
  'Tus-Resumable',
  'Tus-Version',
  'Tus-Extension',
  'Tus-Max-Size',
  'Upload-Offset',
  'Upload-Length',
  'Upload-Expires',
] as const;

function decodeBase64Utf8(value: string): string | null {
  try {
    const bin = atob(value);
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Parse `Upload-Metadata`: comma-separated `key base64value` pairs (value
 * optional). Returns null on a malformed header (duplicate key, bad base64,
 * invalid key) so the caller answers 400 rather than guessing.
 */
export function parseUploadMetadata(header: string | undefined | null): Record<string, string> | null {
  const out: Record<string, string> = {};
  if (!header || header.trim() === '') return out;
  for (const pair of header.split(',')) {
    const [key, value, ...rest] = pair.trim().split(' ');
    if (!key || rest.length > 0 || !/^[A-Za-z0-9_.-]{1,64}$/.test(key) || key in out) return null;
    if (value === undefined || value === '') {
      out[key] = '';
      continue;
    }
    const decoded = decodeBase64Utf8(value);
    if (decoded === null) return null;
    out[key] = decoded;
  }
  return out;
}

/** Encode metadata the way clients send it (used by tests and the Studio client). */
export function encodeUploadMetadata(meta: Record<string, string>): string {
  return Object.entries(meta)
    .map(([k, v]) => {
      const bytes = new TextEncoder().encode(v);
      let bin = '';
      for (const b of bytes) bin += String.fromCharCode(b);
      return `${k} ${btoa(bin)}`;
    })
    .join(',');
}

/** Non-negative integer header (`Upload-Length`, `Upload-Offset`), else null. */
export function parseNonNegativeInt(value: string | undefined | null): number | null {
  if (value === undefined || value === null || !/^\d{1,16}$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return Number.isSafeInteger(n) ? n : null;
}

/** The two metadata keys every client sends (tus-js-client: `filename`, `filetype`). */
export interface UploadDeclaration {
  filename: string;
  mime: string;
  folder: string | null;
}

export function declarationFrom(meta: Record<string, string>): UploadDeclaration | null {
  const filename = meta.filename ?? meta.name;
  const mime = meta.filetype ?? meta.type ?? meta.contentType;
  if (!filename || !mime) return null;
  return { filename, mime: mime.split(';')[0]!.trim().toLowerCase(), folder: meta.folder ? meta.folder : null };
}
