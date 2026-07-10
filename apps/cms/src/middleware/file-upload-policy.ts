import type { MiddlewareHandler } from 'hono';
import {
  extensionMatchesMime,
  isMimeAllowed,
  normalizeMimeType,
  resolveMaxBytes,
  resolveMimeAllowlist,
} from '@lumibase/shared/schemas';
import type { AppEnv, AuthPrincipal } from '../env';
import { resolveUploadPolicy } from '../services/upload-policy-service';
import { auditSecurityGuardDenied } from './security-audit';

/**
 * Enforce storage safety at the upload boundary. Every path that can create
 * file metadata or push raw object bytes into storage is checked here BEFORE
 * the route handler runs, so the guarantee holds no matter what the route
 * handler does. Three surfaces are covered:
 *
 *   - `POST /api/v1/files`            — metadata creation (JSON body)
 *   - `PUT  /api/v1/files/upload/:key`— signed raw-byte upload (JWT-authorized)
 *   - `POST /api/v1/media/:key`       — raw-byte media upload (RBAC-authorized)
 *
 * Adding a new byte-accepting upload route without wiring it in here is caught
 * by the `upload-surface-coverage` regression test, which asserts this guard
 * matches every known upload path.
 */
export const withFileUploadPolicy = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const path = c.req.path;
  const method = c.req.method.toUpperCase();
  const surface = classifyUploadSurface(path, method);
  if (!surface) return next();

  const { isMetadataCreate, isSignedUpload, isMediaUpload } = surface;
  // Raw-byte surfaces carry the file itself in the request body.
  const isRawUpload = isSignedUpload || isMediaUpload;

  const auth = safeGetAuth(c);
  // Public callers may never create upload metadata nor push raw media bytes.
  // Signed uploads are deliberately excluded: `withAuth` skips
  // `/api/v1/files/upload/*`, so `auth` is undefined by design there and
  // authorization is proven by the signed JWT the route handler verifies —
  // applying the public block would reject every legitimate signed upload.
  if ((isMetadataCreate || isMediaUpload) && isPublicUploadPrincipal(auth)) {
    await auditSecurityGuardDenied(c, 'file_upload_policy_denied', {
      path,
      method,
      reason: isMediaUpload ? 'public_media_upload' : 'public_metadata_create',
      roles: auth?.roles ?? [],
      principalType: auth?.type ?? 'user',
    });
    return c.json(
      { errors: [{ code: 'PUBLIC_UPLOAD_FORBIDDEN', message: 'Public role is not allowed to upload files.' }] },
      403,
    );
  }

  // Effective policy: per-site DB config → env override → default. Resolution
  // is fail-safe (falls back to env/default if the DB/cache are unavailable),
  // so the guard keeps working even when mounted without a DB context.
  const policy = await resolveUploadPolicy({
    db: safeGet(c, 'db'),
    cache: safeGet(c, 'runtime')?.cache,
    siteId: safeGet(c, 'siteId'),
    env: c.env as Partial<AppEnv['Bindings']> | undefined,
  });
  const maxBytes = policy.maxBytes;
  const allowedMimes = policy.allowedMimeTypes;

  const contentLength = parseContentLength(c.req.header('content-length'));
  if (contentLength !== null && contentLength > maxBytes) {
    await auditSecurityGuardDenied(c, 'file_upload_policy_denied', {
      path,
      method,
      reason: 'content_length_exceeded',
      contentLength,
      maxBytes,
    });
    return c.json(
      {
        errors: [
          {
            code: 'UPLOAD_TOO_LARGE',
            message: `Upload exceeds the configured ${maxBytes} byte limit.`,
          },
        ],
      },
      413,
    );
  }

  const metadata = isMetadataCreate
    ? await peekMetadata(c.req.raw.clone() as Parameters<typeof peekMetadata>[0])
    : null;
  const mime = metadata?.mime ?? c.req.header('content-type') ?? 'application/octet-stream';
  if (!isFileUploadMimeAllowed(mime, allowedMimes)) {
    await auditSecurityGuardDenied(c, 'file_upload_policy_denied', {
      path,
      method,
      reason: 'mime_forbidden',
      mime,
      allowedMimes,
    });
    return c.json(
      { errors: [{ code: 'UPLOAD_MIME_FORBIDDEN', message: `MIME type "${mime}" is not allowed.` }] },
      415,
    );
  }

  const normalizedMime = normalizeMime(mime);
  const fileName = metadata?.filenameDownload ?? metadata?.filenameDisk ?? (isRawUpload ? path.split('/').pop() : undefined);
  if (fileName && !isFileExtensionCompatibleWithMime(fileName, normalizedMime)) {
    await auditSecurityGuardDenied(c, 'file_upload_policy_denied', {
      path,
      method,
      reason: 'extension_mime_mismatch',
      fileName,
      mime: normalizedMime,
    });
    return c.json(
      { errors: [{ code: 'UPLOAD_EXTENSION_MISMATCH', message: `File extension does not match MIME type "${normalizedMime}".` }] },
      415,
    );
  }

  // Raw-byte surfaces are the only place the actual file is present, so the
  // deepest checks (true size + content sniffing) live here.
  if (isRawUpload) {
    const bytes = new Uint8Array(
      await (c.req.raw.clone() as Request).arrayBuffer(),
    );

    // Enforce the REAL body size, not the client-declared Content-Length. A
    // request that omits or understates Content-Length cannot slip past the cap.
    if (bytes.length > maxBytes) {
      await auditSecurityGuardDenied(c, 'file_upload_policy_denied', {
        path,
        method,
        reason: 'body_bytes_exceeded',
        byteLength: bytes.length,
        maxBytes,
      });
      return c.json(
        {
          errors: [
            { code: 'UPLOAD_TOO_LARGE', message: `Upload exceeds the configured ${maxBytes} byte limit.` },
          ],
        },
        413,
      );
    }

    if (!isFileContentCompatibleWithBytes(bytes, normalizedMime)) {
      // Give unsafe SVGs (script / event-handler / external-entity payloads) a
      // distinct code so operators can tell "image with a shell in it" apart
      // from a plain type mismatch.
      const unsafeSvg =
        normalizedMime === 'image/svg+xml' && looksLikeSvg(bytes) && svgHasActiveContent(bytes);
      await auditSecurityGuardDenied(c, 'file_upload_policy_denied', {
        path,
        method,
        reason: unsafeSvg ? 'unsafe_svg' : 'content_mime_mismatch',
        mime: normalizedMime,
      });
      return c.json(
        {
          errors: [
            unsafeSvg
              ? { code: 'UPLOAD_UNSAFE_SVG', message: 'SVG contains script or active content and is not allowed.' }
              : { code: 'UPLOAD_CONTENT_MISMATCH', message: `File content does not match MIME type "${normalizedMime}".` },
          ],
        },
        415,
      );
    }

    // Polyglot defense: a file can have valid image magic bytes AND carry an
    // executable/script payload appended or embedded (the classic "image with a
    // shell in it"). The prefix magic-byte check above cannot see that. Scan the
    // full bytes of raster images for high-signal script/PHP/HTML openings and
    // reject. This runs synchronously before the storage write (no async
    // window) on both runtimes. The stronger, false-positive-free fix is to
    // re-encode the image to strip everything but the pixels — tracked as a
    // follow-up that depends on the image adapter from image-transform-dsl (see
    // .kiro/specs/upload-file-controls/tasks.md).
    if (RASTER_IMAGE_MIMES.has(normalizedMime ?? '') && imageHasEmbeddedActivePayload(bytes)) {
      await auditSecurityGuardDenied(c, 'file_upload_policy_denied', {
        path,
        method,
        reason: 'embedded_payload',
        mime: normalizedMime,
      });
      return c.json(
        {
          errors: [
            {
              code: 'UPLOAD_EMBEDDED_PAYLOAD',
              message: 'Image contains an embedded script or executable payload and is not allowed.',
            },
          ],
        },
        415,
      );
    }
  }

  return next();
};

/** Raster image types whose bytes are opaque binary — no markup should appear. */
const RASTER_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);

// Openings that turn a valid image into a functional polyglot: a PHP shell,
// an HTML/JS document, or an inline script. None legitimately occur as literal
// ASCII in a raster image, so their presence anywhere in the bytes is treated
// as an embedded payload. (SVG/text are handled by their own checks.)
const EMBEDDED_PAYLOAD_MARKERS = ['<?php', '<script', '<html', '<!doctype html'] as const;

/**
 * Scan raw image bytes for an embedded script/executable payload (polyglot).
 * Case-insensitive byte search — no full-string allocation.
 */
export function imageHasEmbeddedActivePayload(bytes: Uint8Array): boolean {
  return EMBEDDED_PAYLOAD_MARKERS.some((marker) => bytesContainAsciiCI(bytes, marker));
}

/**
 * Single source of truth for which requests are upload surfaces. Kept as a pure
 * function so the coverage regression test can enumerate the exact set the
 * guard protects (and fail if a new byte-accepting route is added without being
 * classified here).
 */
export function classifyUploadSurface(
  path: string,
  method: string,
): { isMetadataCreate: boolean; isSignedUpload: boolean; isMediaUpload: boolean } | null {
  const upper = method.toUpperCase();
  const isMetadataCreate = path === '/api/v1/files' && upper === 'POST';
  const isSignedUpload = path.startsWith('/api/v1/files/upload/') && upper === 'PUT';
  const isMediaUpload = path.startsWith('/api/v1/media/') && upper === 'POST';
  if (!isMetadataCreate && !isSignedUpload && !isMediaUpload) return null;
  return { isMetadataCreate, isSignedUpload, isMediaUpload };
}

export function isPublicUploadPrincipal(auth: AuthPrincipal | undefined): boolean {
  if (!auth) return true;
  if (auth.type === 'api_key') return false;
  const roles = auth.roles ?? [];
  return roles.length === 0 || roles.some((role) => role === 'public' || role === '$public');
}

// These thin wrappers preserve the middleware's historical helper API while
// delegating to the shared upload-policy module — the single source of truth
// shared with the Studio client so the server allowlist and the client file
// picker cannot drift.
export function resolveFileUploadMaxBytes(raw: string | undefined): number {
  return resolveMaxBytes(raw);
}

export function resolveFileUploadMimeAllowlist(raw: string | undefined): string[] {
  return resolveMimeAllowlist(raw);
}

export function isFileUploadMimeAllowed(
  mime: string | undefined,
  allowlist = resolveMimeAllowlist(undefined),
): boolean {
  return isMimeAllowed(mime, allowlist);
}

export function isFileExtensionCompatibleWithMime(fileName: string, mime: string | undefined): boolean {
  return extensionMatchesMime(fileName, mime);
}

export async function isFileContentCompatibleWithMime(request: Request, mime: string | undefined): Promise<boolean> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  return isFileContentCompatibleWithBytes(bytes, mime);
}

/**
 * Synchronous content sniffing over already-read bytes. Verifies that the
 * payload's magic bytes match the declared MIME type, rejects anything carrying
 * an executable signature, and rejects SVGs that embed script / active content
 * (the classic "image that is really a shell/XSS payload"). This is a
 * best-effort structural check at the edge — it is NOT a malware scanner and
 * does not re-encode the file; see the serving hardening in `routes/media.ts`
 * (Content-Disposition: attachment) and the global CSP for the layers that
 * contain anything this misses.
 */
export function isFileContentCompatibleWithBytes(bytes: Uint8Array, mime: string | undefined): boolean {
  if (!mime) return false;
  if (bytes.length === 0) return false;

  if (hasExecutableSignature(bytes)) return false;

  switch (mime) {
    case 'image/png':
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/jpeg':
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case 'image/gif':
      return startsWithAscii(bytes, 'GIF87a') || startsWithAscii(bytes, 'GIF89a');
    case 'image/webp':
      return startsWithAscii(bytes, 'RIFF') && asciiAt(bytes, 8, 'WEBP');
    case 'image/avif':
      return asciiAt(bytes, 4, 'ftyp') && (asciiAt(bytes, 8, 'avif') || asciiAt(bytes, 8, 'avis'));
    case 'application/pdf':
      return startsWithAscii(bytes, '%PDF-');
    case 'image/svg+xml':
      // An SVG must look like an SVG AND carry no active content. This is the
      // check that stops an "image" from smuggling a script payload.
      return looksLikeSvg(bytes) && !svgHasActiveContent(bytes);
    case 'text/csv':
    case 'text/plain':
      return looksLikeText(bytes);
    default:
      return true;
  }
}

function safeGetAuth(c: Parameters<MiddlewareHandler<AppEnv>>[0]): AuthPrincipal | undefined {
  return safeGet(c, 'auth');
}

// `c.get` can throw in some test harnesses when a variable was never set;
// callers here treat "unset" as "unavailable", not an error.
function safeGet<K extends keyof AppEnv['Variables']>(
  c: Parameters<MiddlewareHandler<AppEnv>>[0],
  key: K,
): AppEnv['Variables'][K] | undefined {
  try {
    return c.get(key);
  } catch {
    return undefined;
  }
}

function parseContentLength(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

async function peekMetadata(request: Request): Promise<{ mime: string; filenameDisk?: string; filenameDownload?: string }> {
  try {
    const body = (await request.json()) as { filenameDisk?: unknown; filenameDownload?: unknown; mime?: unknown };
    return {
      mime: typeof body.mime === 'string' ? body.mime : 'application/octet-stream',
      filenameDisk: typeof body.filenameDisk === 'string' ? body.filenameDisk : undefined,
      filenameDownload: typeof body.filenameDownload === 'string' ? body.filenameDownload : undefined,
    };
  } catch {
    return { mime: 'application/octet-stream' };
  }
}

function normalizeMime(mime: string | undefined): string | undefined {
  return normalizeMimeType(mime);
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

function startsWithAscii(bytes: Uint8Array, signature: string): boolean {
  return asciiAt(bytes, 0, signature);
}

function asciiAt(bytes: Uint8Array, offset: number, signature: string): boolean {
  if (bytes.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (bytes[offset + i] !== signature.charCodeAt(i)) return false;
  }
  return true;
}

function hasExecutableSignature(bytes: Uint8Array): boolean {
  return startsWithAscii(bytes, 'MZ') || startsWith(bytes, [0x7f, 0x45, 0x4c, 0x46]) || startsWith(bytes, [0xca, 0xfe, 0xba, 0xbe]);
}

function looksLikeSvg(bytes: Uint8Array): boolean {
  const text = decodeAsciiPrefix(bytes, 512).trimStart().toLowerCase();
  return text.startsWith('<svg') || (text.startsWith('<?xml') && text.includes('<svg'));
}

/**
 * Detect script / active content in an SVG. SVG is XML and browsers will
 * execute `<script>`, inline `on*=` event handlers, `javascript:` URLs, and
 * nested browsing contexts when an SVG is rendered as a top-level document —
 * so an attacker can dress a script payload up as an "image". We reject on the
 * clear-danger tokens. The full (already size-capped) document is scanned so a
 * payload cannot hide past a fixed prefix. Intentionally conservative: a false
 * positive rejects an unusual-but-benign SVG rather than let an executable one
 * through.
 */
export function svgHasActiveContent(bytes: Uint8Array): boolean {
  const text = decodeUtf8(bytes).toLowerCase();
  return (
    text.includes('<script') ||
    text.includes('javascript:') ||
    text.includes('<foreignobject') || // hosts arbitrary HTML (incl. scripts)
    text.includes('<iframe') ||
    text.includes('<embed') ||
    text.includes('<!entity') || // XXE via entity declarations
    text.includes('<!doctype') || // DOCTYPE is what enables entity declarations
    /\son[a-z]+\s*=/.test(text) // inline event handlers: onload=, onclick=, ...
  );
}

function looksLikeText(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 1024);
  for (let i = 0; i < limit; i++) {
    const byte = bytes[i]!;
    if (byte === 0) return false;
    if (byte < 0x09) return false;
    if (byte > 0x0d && byte < 0x20) return false;
  }
  return true;
}

function decodeAsciiPrefix(bytes: Uint8Array, maxBytes: number): string {
  let output = '';
  const limit = Math.min(bytes.length, maxBytes);
  for (let i = 0; i < limit; i++) {
    output += String.fromCharCode(bytes[i]!);
  }
  return output;
}

function decodeUtf8(bytes: Uint8Array): string {
  // `TextDecoder` is available on both the Workers and Node runtimes.
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/**
 * Case-insensitive search for an ASCII substring inside raw bytes, comparing
 * byte-by-byte (no full-buffer string allocation). `needle` must be lowercase
 * ASCII. Used to detect embedded markup in otherwise-binary image payloads.
 */
function bytesContainAsciiCI(bytes: Uint8Array, needle: string): boolean {
  const n = needle.length;
  if (n === 0 || bytes.length < n) return false;
  const first = needle.charCodeAt(0);
  const firstUpper = toUpperAsciiCode(first);
  for (let i = 0; i <= bytes.length - n; i++) {
    const b = bytes[i]!;
    if (b !== first && b !== firstUpper) continue;
    let matched = true;
    for (let j = 1; j < n; j++) {
      const nc = needle.charCodeAt(j);
      const bc = bytes[i + j]!;
      if (bc !== nc && bc !== toUpperAsciiCode(nc)) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

function toUpperAsciiCode(code: number): number {
  // Only lowercase a–z map to an uppercase counterpart.
  return code >= 0x61 && code <= 0x7a ? code - 0x20 : code;
}
