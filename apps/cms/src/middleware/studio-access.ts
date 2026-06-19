import type { MiddlewareHandler } from 'hono';
import { eq } from 'drizzle-orm';
import { users } from '@lumibase/database';
import type { AppEnv, AuthPrincipal } from '../env';
import { PermissionService, type PermissionBundle } from '../services/permission-service';
import { isFrontendAudience } from '../services/auth/token-audience';

const STUDIO_CLIENT_HEADER = 'x-lumi-client';
const STUDIO_CLIENT_VALUE = 'studio';

const PUBLIC_AUTH_PATHS = new Set([
  '/api/v1/auth/login',
  '/api/v1/auth/register',
  '/api/v1/auth/verify-email',
  '/api/v1/auth/resend-verification',
  '/api/v1/auth/forgot-password',
  '/api/v1/auth/reset-password',
]);

const STUDIO_ACCESS_PATH_PREFIXES = [
  '/api/v1/access',
  '/api/v1/admin',
  '/api/v1/api-keys',
  '/api/v1/collections',
  '/api/v1/extensions',
  '/api/v1/permissions',
  '/api/v1/policies',
  '/api/v1/presets',
  '/api/v1/realtime',
  '/api/v1/relations',
  '/api/v1/roles',
  '/api/v1/settings',
  '/api/v1/teams',
  '/api/v1/translations',
  '/api/v1/typegen',
  '/api/v1/users',
  '/api/v1/webhooks',
];

/**
 * Enforce policy-level Studio access flags.
 *
 * Directus separates `app_access` from normal API permissions: a user can be
 * allowed to call APIs without being allowed into the Data Studio. LumiBase
 * mirrors that by gating both self-identified Studio clients and the
 * server-known Studio management API surface with `appAccess` and
 * `enforceTfa`. Regular content API calls continue to rely on
 * collection/action permissions.
 */
export const withStudioAccess = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const studioClient = isStudioClientRequest(c.req.header(STUDIO_CLIENT_HEADER), c.req.header('user-agent'));
  if (!studioClient && !isStudioAccessPath(c.req.path)) {
    return next();
  }

  if (PUBLIC_AUTH_PATHS.has(c.req.path)) {
    return next();
  }

  const auth = c.get('auth');
  if (auth?.raw?.dev === true && auth.roles?.includes('admin')) {
    return next();
  }

  // Hard wall: a `frontend` (subscriber) session token can NEVER reach the
  // Studio management surface, regardless of any `appAccess` policy. This
  // is the audience guardrail from ADR 0001 — defense-in-depth on top of
  // the `appAccess` bundle check below.
  if (isFrontendAudience(auth?.raw?.aud)) {
    return c.json(
      { errors: [{ code: 'APP_ACCESS_DENIED', message: 'This session is not allowed to use Studio.' }] },
      403,
    );
  }

  if (!auth?.userId) {
    return c.json(
      { errors: [{ code: 'APP_ACCESS_DENIED', message: 'Studio access requires a user principal.' }] },
      403,
    );
  }

  const bundle = await new PermissionService({
    db: c.get('db'),
    cache: c.get('runtime').cache,
    ctx: {
      userId: auth.userId,
      siteId: c.get('siteId'),
      roleId: null,
      user: { id: auth.userId, email: auth.email ?? null, roles: auth.roles ?? [], ...(auth.raw ?? {}) },
      ip: c.get('ip') ?? c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? null,
      headers: collectHeaders(c.req.raw.headers),
      apiKey: auth.apiKey ?? null,
    },
  }).bundle();

  if (!bundle.appAccess) {
    return c.json(
      { errors: [{ code: 'APP_ACCESS_DENIED', message: 'This account is not allowed to use Studio.' }] },
      403,
    );
  }

  if (bundle.tfaRequired) {
    const user = await loadUserTfaState(c.get('db'), auth.userId);
    if (!user.enrolled) {
      return c.json(
        { errors: [{ code: 'TFA_REQUIRED', message: 'Two-factor authentication enrollment is required for Studio access.' }] },
        403,
      );
    }
    if (!isSessionTfaVerified(auth)) {
      return c.json(
        { errors: [{ code: 'TFA_REQUIRED', message: 'A two-factor verified session is required for Studio access.' }] },
        403,
      );
    }
  }

  c.set('access', bundle);
  return next();
};

declare module '../env' {
  interface Variables {
    /** Effective access bundle resolved by the Studio access gate. */
    access?: PermissionBundle;
  }
}

function isStudioAccessPath(path: string): boolean {
  return STUDIO_ACCESS_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function isStudioClientRequest(clientHeader: string | undefined, userAgent: string | undefined): boolean {
  if (clientHeader?.toLowerCase() === STUDIO_CLIENT_VALUE) return true;
  return !!userAgent?.toLowerCase().includes('lumibase-studio');
}

function collectHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

async function loadUserTfaState(db: AppEnv['Variables']['db'], userId: string): Promise<{ enrolled: boolean }> {
  const [row] = await db.select({ tfa: users.tfa }).from(users).where(eq(users.id, userId)).limit(1);
  return { enrolled: isTfaEnrolled(row?.tfa) };
}

export function isTfaEnrolled(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const tfa = value as Record<string, unknown>;
  if (tfa.enabled === true || tfa.enrolled === true || tfa.verified === true) return true;
  if (typeof tfa.secret === 'string' && tfa.secret.length > 0) return true;
  if (typeof tfa.tfaSecret === 'string' && tfa.tfaSecret.length > 0) return true;
  return false;
}

export function isSessionTfaVerified(auth: AuthPrincipal): boolean {
  const raw = auth.raw ?? {};
  if (raw.tfaVerified === true || raw.mfa === true || raw.mfaVerified === true) return true;

  const amr = raw.amr;
  if (Array.isArray(amr) && amr.some((value) => ['mfa', 'otp', 'totp', 'webauthn'].includes(String(value)))) {
    return true;
  }

  const acr = raw.acr;
  return typeof acr === 'string' && acr.toLowerCase().includes('mfa');
}
