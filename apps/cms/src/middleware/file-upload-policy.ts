import type { MiddlewareHandler } from 'hono';
import type { AppEnv, AuthPrincipal } from '../env';
import { auditSecurityGuardDenied } from './security-audit';

const DEFAULT_FILE_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_FILE_UPLOAD_MIME_ALLOWLIST = [
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/svg+xml',
  'image/webp',
  'application/pdf',
  'text/csv',
  'text/plain',
] as const;

const MIME_EXTENSIONS: Record<string, string[]> = {
  'image/avif': ['.avif'],
  'image/gif': ['.gif'],
  'image/jpeg': ['.jpeg', '.jpg'],
  'image/png': ['.png'],
  'image/svg+xml': ['.svg'],
  'image/webp': ['.webp'],
  'application/pdf': ['.pdf'],
  'text/csv': ['.csv'],
  'text/plain': ['.txt', '.text', '.log', '.md'],
};

/**
 * Enforce storage safety at the upload boundary. File metadata creation and
 * signed upload PUTs are checked before route handlers can create metadata or
 * write object bytes into storage.
 */
export const withFileUploadPolicy = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const path = c.req.path;
  const method = c.req.method.toUpperCase();
  const isMetadataCreate = path === '/api/v1/files' && method === 'POST';
  const isSignedUpload = path.startsWith('/api/v1/files/upload/') && method === 'PUT';

  if (!isMetadataCreate && !isSignedUpload) return next();

  const auth = safeGetAuth(c);
  if (isMetadataCreate && isPublicUploadPrincipal(auth)) {
    await auditSecurityGuardDenied(c, 'file_upload_policy_denied', {
      path,
      method,
      reason: 'public_metadata_create',
      roles: auth?.roles ?? [],
      principalType: auth?.type ?? 'user',
    });
    return c.json(
      { errors: [{ code: 'PUBLIC_UPLOAD_FORBIDDEN', message: 'Public role is not allowed to upload files.' }] },
      403,
    );
  }

  const contentLength = parseContentLength(c.req.header('content-length'));
  const env = c.env as Partial<AppEnv['Bindings']> | undefined;
  const maxBytes = resolveFileUploadMaxBytes(env?.FILE_UPLOAD_MAX_BYTES ?? process.env.FILE_UPLOAD_MAX_BYTES);
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

  const allowedMimes = resolveFileUploadMimeAllowlist(
    env?.FILE_UPLOAD_ALLOWED_MIME_TYPES ?? process.env.FILE_UPLOAD_ALLOWED_MIME_TYPES,
  );
  const metadata = isMetadataCreate ? await peekMetadata(c.req.raw.clone()) : null;
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
  const fileName = metadata?.filenameDownload ?? metadata?.filenameDisk ?? (isSignedUpload ? path.split('/').pop() : undefined);
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

  if (isSignedUpload && !(await isFileContentCompatibleWithMime(c.req.raw.clone(), normalizedMime))) {
    await auditSecurityGuardDenied(c, 'file_upload_policy_denied', {
      path,
      method,
      reason: 'content_mime_mismatch',
      mime: normalizedMime,
    });
    return c.json(
      { errors: [{ code: 'UPLOAD_CONTENT_MISMATCH', message: `File content does not match MIME type "${normalizedMime}".` }] },
      415,
    );
  }

  return next();
};

export function isPublicUploadPrincipal(auth: AuthPrincipal | undefined): boolean {
  if (!auth) return true;
  if (auth.type === 'api_key') return false;
  const roles = auth.roles ?? [];
  return roles.length === 0 || roles.some((role) => role === 'public' || role === '$public');
}

export function resolveFileUploadMaxBytes(raw: string | undefined): number {
  if (!raw) return DEFAULT_FILE_UPLOAD_MAX_BYTES;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_FILE_UPLOAD_MAX_BYTES;
  return parsed;
}

export function resolveFileUploadMimeAllowlist(raw: string | undefined): string[] {
  if (!raw) return [...DEFAULT_FILE_UPLOAD_MIME_ALLOWLIST];
  const parsed = raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : [...DEFAULT_FILE_UPLOAD_MIME_ALLOWLIST];
}

export function isFileUploadMimeAllowed(
  mime: string | undefined,
  allowlist = resolveFileUploadMimeAllowlist(undefined),
): boolean {
  if (!mime) return false;
  const normalized = mime.split(';', 1)[0]?.trim().toLowerCase();
  if (!normalized) return false;
  return allowlist.some((allowed) => {
    const lower = allowed.toLowerCase();
    if (lower.endsWith('/*')) return normalized.startsWith(lower.slice(0, -1));
    return normalized === lower;
  });
}

export function isFileExtensionCompatibleWithMime(fileName: string, mime: string | undefined): boolean {
  if (!mime) return false;
  const extensions = MIME_EXTENSIONS[mime];
  if (!extensions) return true;
  const normalizedName = fileName.trim().toLowerCase();
  return extensions.some((extension) => normalizedName.endsWith(extension));
}

export async function isFileContentCompatibleWithMime(request: Request, mime: string | undefined): Promise<boolean> {
  if (!mime) return false;
  const bytes = new Uint8Array(await request.arrayBuffer());
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
      return looksLikeSvg(bytes);
    case 'text/csv':
    case 'text/plain':
      return looksLikeText(bytes);
    default:
      return true;
  }
}

function safeGetAuth(c: Parameters<MiddlewareHandler<AppEnv>>[0]): AuthPrincipal | undefined {
  try {
    return c.get('auth');
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
  return mime?.split(';', 1)[0]?.trim().toLowerCase() || undefined;
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
