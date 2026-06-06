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
  const mime = isMetadataCreate
    ? await peekMetadataMime(c.req.raw.clone())
    : c.req.header('content-type') ?? 'application/octet-stream';
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

async function peekMetadataMime(request: Request): Promise<string> {
  try {
    const body = (await request.json()) as { mime?: unknown };
    return typeof body.mime === 'string' ? body.mime : 'application/octet-stream';
  } catch {
    return 'application/octet-stream';
  }
}
