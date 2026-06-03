import type { MiddlewareHandler } from 'hono';
import { eq } from 'drizzle-orm';
import { users } from '@lumibase/database';
import type { AppEnv, AuthPrincipal } from '../env';
import { PermissionService, type PermissionBundle } from '../services/permission-service';

const STUDIO_CLIENT_HEADER = 'x-lumi-client';
const STUDIO_CLIENT_VALUE = 'studio';

const PUBLIC_AUTH_PATHS = new Set([
  '/api/v1/auth/login',
  '/api/v1/auth/register',
]);

/**
 * Enforce policy-level Studio access flags.
 *
 * Directus separates `app_access` from normal API permissions: a user can be
 * allowed to call APIs without being allowed into the Data Studio. LumiBase
 * mirrors that by requiring Studio clients to identify themselves with
 * `X-Lumi-Client: studio`; only those requests are gated by `appAccess` and
 * `enforceTfa`. Regular API calls continue to rely on collection/action
 * permissions.
 */
export const withStudioAccess = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  if (!isStudioClientRequest(c.req.header(STUDIO_CLIENT_HEADER), c.req.header('user-agent'))) {
    return next();
  }

  if (PUBLIC_AUTH_PATHS.has(c.req.path)) {
    return next();
  }

  const auth = c.get('auth');
  if (auth?.raw?.dev === true && auth.roles?.includes('admin')) {
    return next();
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
