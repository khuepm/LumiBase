import type { MiddlewareHandler } from 'hono';
import type { AppEnv, AuthPrincipal } from '../env';

const DEFAULT_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_UPLOAD_MIME_ALLOWLIST = [
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

const CORE_RBAC_PATHS = [
  '/api/v1/access',
  '/api/v1/api-keys',
  '/api/v1/admin',
  '/api/v1/cdc',
  '/api/v1/permissions',
  '/api/v1/policies',
  '/api/v1/roles',
  '/api/v1/settings',
  '/api/v1/teams',
  '/api/v1/users',
] as const;

const CSP_DIRECTIVES: Record<string, string[]> = {
  'default-src': ["'none'"],
  'base-uri': ["'none'"],
  'frame-ancestors': ["'none'"],
  'form-action': ["'none'"],
  'img-src': ["'self'", 'data:', 'blob:'],
  'media-src': ["'self'", 'blob:'],
  'font-src': ["'self'", 'data:'],
  'object-src': ["'none'"],
  'script-src': ["'self'"],
  'style-src': ["'self'", "'unsafe-inline'"],
  'connect-src': ["'self'", 'https:', 'wss:'],
};

/**
 * Apply baseline browser security headers to every response. API clients ignore
 * these headers, while any HTML/error surface gets a safe-by-default CSP,
 * clickjacking protection, nosniff, and conservative browser feature policy.
 */
export const withSecurityHeaders = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  await next();
  c.header('Content-Security-Policy', serializeCsp(CSP_DIRECTIVES));
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  c.header('Cross-Origin-Opener-Policy', 'same-origin');
  c.header('Cross-Origin-Resource-Policy', 'same-site');
};

/**
 * Core RBAC guard for system-control surfaces. Harness-generated code can add
 * feature routes later, but access-management and operational tables stay
 * behind an admin principal regardless of route-level omissions.
 */
export const withCoreRbacGuard = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  if (!isCoreRbacPath(c.req.path)) return next();

  const auth = c.get('auth');
  if (isAdminPrincipal(auth)) return next();

  return c.json(
    {
      errors: [
        {
          code: 'CORE_RBAC_FORBIDDEN',
          message: 'System administration endpoints require an admin principal.',
        },
      ],
    },
    403,
  );
};

/**
 * File upload guard. Metadata creation and signed upload PUTs are checked here
 * so storage cannot be abused as a malware/dropbox sink even if future route
 * code forgets to validate content type, size, or public-role access.
 */
export const withUploadGuard = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const path = c.req.path;
  const method = c.req.method.toUpperCase();
  const isMetadataCreate = path === '/api/v1/files' && method === 'POST';
  const isSignedUpload = path.startsWith('/api/v1/files/upload/') && method === 'PUT';

  if (!isMetadataCreate && !isSignedUpload) return next();

  const auth = safeGetAuth(c);
  if (isMetadataCreate && isPublicPrincipal(auth)) {
    return c.json(
      { errors: [{ code: 'PUBLIC_UPLOAD_FORBIDDEN', message: 'Public role is not allowed to upload files.' }] },
      403,
    );
  }

  const contentLength = parseContentLength(c.req.header('content-length'));
  const env = c.env as Partial<AppEnv['Bindings']> | undefined;
  const maxBytes = resolveUploadMaxBytes(env?.TRADITIONAL_UPLOAD_MAX_BYTES ?? process.env.TRADITIONAL_UPLOAD_MAX_BYTES);
  if (contentLength !== null && contentLength > maxBytes) {
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

  const allowedMimes = resolveUploadMimeAllowlist(env?.TRADITIONAL_UPLOAD_ALLOWED_MIME ?? process.env.TRADITIONAL_UPLOAD_ALLOWED_MIME);
  const mime = isMetadataCreate
    ? await peekMetadataMime(c.req.raw.clone())
    : c.req.header('content-type') ?? 'application/octet-stream';
  if (!isMimeAllowed(mime, allowedMimes)) {
    return c.json(
      { errors: [{ code: 'UPLOAD_MIME_FORBIDDEN', message: `MIME type "${mime}" is not allowed.` }] },
      415,
    );
  }

  return next();
};

export function isCoreRbacPath(path: string): boolean {
  return CORE_RBAC_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export function isAdminPrincipal(auth: AuthPrincipal | undefined): boolean {
  if (!auth) return false;
  if (auth.raw?.dev === true && auth.roles?.includes('admin')) return true;
  return auth.roles?.some((role) => role === 'admin' || role === 'administrator') ?? false;
}

export function isPublicPrincipal(auth: AuthPrincipal | undefined): boolean {
  if (!auth) return true;
  if (auth.type === 'api_key') return false;
  const roles = auth.roles ?? [];
  return roles.length === 0 || roles.some((role) => role === 'public' || role === '$public');
}

export function resolveUploadMaxBytes(raw: string | undefined): number {
  if (!raw) return DEFAULT_UPLOAD_MAX_BYTES;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_UPLOAD_MAX_BYTES;
  return parsed;
}

export function resolveUploadMimeAllowlist(raw: string | undefined): string[] {
  if (!raw) return [...DEFAULT_UPLOAD_MIME_ALLOWLIST];
  const parsed = raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : [...DEFAULT_UPLOAD_MIME_ALLOWLIST];
}

export function isMimeAllowed(mime: string | undefined, allowlist = resolveUploadMimeAllowlist(undefined)): boolean {
  if (!mime) return false;
  const normalized = mime.split(';', 1)[0]?.trim().toLowerCase();
  if (!normalized) return false;
  return allowlist.some((allowed) => {
    const lower = allowed.toLowerCase();
    if (lower.endsWith('/*')) return normalized.startsWith(lower.slice(0, -1));
    return normalized === lower;
  });
}

export function serializeCsp(directives: Record<string, string[]>): string {
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ');
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
