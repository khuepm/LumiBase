import { hasBidiControl, normalizeMimeType } from '@lumibase/contracts/schemas';

/**
 * Serving policy for user-uploaded bytes (#740, epic #674 S11).
 *
 * Inline rendering is an allow-list: only passive raster images and media
 * whose bytes the upload guard sniffed are served `inline`. Everything else —
 * SVG, PDF, HTML, text, unknown/missing types — is served as an `attachment`.
 * Every response also carries `nosniff` and a sandboxing CSP, so even a file
 * that slipped past the upload guard (or predates it) cannot run script under
 * this origin when opened top-level.
 */

/** Types a browser may render in place: passive, non-scriptable media. */
export const INLINE_SAFE_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'video/mp4',
  'video/webm',
]);

/**
 * CSP for user content. `sandbox` (no `allow-scripts`, no same-origin) makes
 * any document an opaque-origin, script-less page; `default-src 'none'`
 * blocks every fetch except the media element's own bytes.
 */
export const USER_CONTENT_CSP =
  "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox";

export type DispositionType = 'inline' | 'attachment';

export function dispositionTypeFor(mime: string | undefined | null): DispositionType {
  const normalized = normalizeMimeType(mime ?? undefined);
  return normalized && INLINE_SAFE_MIME_TYPES.has(normalized) ? 'inline' : 'attachment';
}

/**
 * Build an RFC 6266 `Content-Disposition` value with an ASCII `filename`
 * fallback and an RFC 5987 `filename*` for the UTF-8 name. Directory parts,
 * control characters, quotes, backslashes and bidi controls (RTL-override
 * filename spoofing) are removed.
 */
export function contentDispositionFor(mime: string | undefined | null, key: string): string {
  const name = safeDownloadFilename(key);
  const ascii = asciiFallback(name);
  const type = dispositionTypeFor(mime);
  return ascii === name
    ? `${type}; filename="${ascii}"`
    : `${type}; filename="${ascii}"; filename*=UTF-8''${encodeRfc5987(name)}`;
}

/** Headers to attach to any response that carries user-uploaded bytes. */
export function userContentHeaders(mime: string | undefined | null, key: string): Record<string, string> {
  return {
    'Content-Disposition': contentDispositionFor(mime, key),
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': USER_CONTENT_CSP,
  };
}

export function safeDownloadFilename(key: string): string {
  const base = key.split('/').pop() ?? '';
  let cleaned = '';
  for (const ch of base) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || ch === '"' || ch === '\\') cleaned += '_';
    else if (hasBidiControl(ch)) continue;
    else cleaned += ch;
  }
  cleaned = cleaned.trim();
  return cleaned.length > 0 ? cleaned : 'download';
}

function asciiFallback(name: string): string {
  let out = '';
  for (const ch of name) out += ch.charCodeAt(0) > 0x7e ? '_' : ch;
  return out;
}

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
