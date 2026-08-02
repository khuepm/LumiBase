import type { MiddlewareHandler } from 'hono';
import { apiKeys, users, userSites } from '@lumibase/database';
import { and, eq, sql } from 'drizzle-orm';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { AppEnv, AuthPrincipal } from '../env';
import { runDetached } from '../lib/detached';
import { AuditLogger } from '../modules/audit/logger';
import { tryExternalJwt } from '../modules/external-auth/adapter';
import { formatSafeError } from '@lumibase/shared/utils';
import { TOKEN_AUDIENCE, audienceValues } from '../services/auth/token-audience';
import { resolvePublicRoleIdCached } from '../services/auth/public-role';
import {
  checkOrigin,
  isPublishablePrefix,
  readAllowedOrigins,
} from '../services/api-key-publishable';
import { mergeRequestContext } from './request-context';

const JWKS_CACHE = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/**
 * Debounce window (seconds) for the API-key `lastUsedAt` touch
 * (high-load-cache-readiness Req 3). Under read load, every API-key request
 * previously issued an `UPDATE api_keys` — turning a read into a write and
 * hammering the row. We now only touch when the stored `lastUsedAt` is older
 * than this interval, and the write is scheduled OFF the response path.
 */
const DEFAULT_APIKEY_TOUCH_INTERVAL_SECONDS = 60;

export function apiKeyTouchIntervalMs(env: Partial<AppEnv['Bindings']> | undefined): number {
  const raw = env?.LUMIBASE_APIKEY_TOUCH_INTERVAL ?? process.env.LUMIBASE_APIKEY_TOUCH_INTERVAL;
  const seconds = Number(raw);
  const resolved = Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_APIKEY_TOUCH_INTERVAL_SECONDS;
  return resolved * 1000;
}

/** True when the key's last touch is stale enough to warrant a fresh write. */
export function shouldTouchApiKey(lastUsedAt: Date | null | undefined, now: Date, intervalMs: number): boolean {
  if (intervalMs === 0) return true;
  if (!lastUsedAt) return true;
  return now.getTime() - lastUsedAt.getTime() >= intervalMs;
}

const getJwks = (certsUrl: string) => {
  let jwks = JWKS_CACHE.get(certsUrl);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(certsUrl));
    JWKS_CACHE.set(certsUrl, jwks);
  }
  return jwks;
};

// Verify Custom JWT (HS256).
//
// The `audience` is pinned to the two SESSION realms (M5): a single-purpose
// `email-verify` / `password-reset` JWT — signed with the same JWT_SECRET —
// therefore cannot be replayed as a session token even if its claim shape
// later changes. Tokens with no `aud` (minted before per-realm audiences
// existed) are rejected here and the holder simply re-authenticates.
async function verifyCustomJwt(token: string, secret: string): Promise<any> {
  const encoder = new TextEncoder();
  const secretKey = encoder.encode(secret);
  const { payload } = await jwtVerify(token, secretKey, {
    algorithms: ['HS256'],
    audience: [TOKEN_AUDIENCE.studio, TOKEN_AUDIENCE.frontend],
  });
  return payload;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function apiKeySnapshot(row: typeof apiKeys.$inferSelect): Record<string, unknown> {
  return {
    id: row.id,
    siteId: row.siteId,
    name: row.name,
    prefix: row.prefix,
    description: row.description,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    rotatedAt: row.rotatedAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    metadata: row.metadata,
  };
}

async function auditApiKeyUseDenied(
  c: Parameters<MiddlewareHandler<AppEnv>>[0],
  row: typeof apiKeys.$inferSelect,
  reason: 'site_mismatch' | 'revoked' | 'expired' | 'origin_not_allowed',
): Promise<void> {
  await new AuditLogger({ db: c.get('db'), siteId: c.get('siteId') }).write({
    event: 'api_key_use_denied',
    actorEmail: null,
    ip: c.get('ip') ?? c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? null,
    userAgent: c.get('userAgent') ?? c.req.header('user-agent') ?? null,
    requestId: c.get('requestId') ?? null,
    metadata: {
      apiKeyId: row.id,
      apiKeyName: row.name,
      prefix: row.prefix,
      siteId: row.siteId,
      requestedSiteId: c.get('siteId'),
      reason,
    },
  });
}

/**
 * Auth Middleware supporting Cloudflare Access JWT (for Admin Studio)
 * and Custom JWT (for Frontend Users).
 *
 * Dev mode (`LUMIBASE_DEV_AUTH=true`): accepts tokens starting with `dev:`.
 * E.g., `Bearer dev:admin@lumibase.dev:admin`
 */
export const withAuth = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const path = c.req.path;
  // Public, self-authenticating auth routes. These carry their own
  // credential (login body, refresh token, or a single-purpose emailed
  // JWT) and MUST NOT require a prior session — `withAuth` skips them.
  // `/register` is public self-service (ADR-010): safe because the role is
  // resolved server-side to a zero-privilege `subscriber` and the account
  // starts `invited` until email verification. See `routes/auth.ts`.
  if (
    path === '/api/v1/auth/register' ||
    path === '/api/v1/auth/verify-email' ||
    path === '/api/v1/auth/resend-verification' ||
    path === '/api/v1/auth/forgot-password' ||
    path === '/api/v1/auth/reset-password' ||
    path === '/api/v1/auth/refresh' ||
    path === '/api/v1/auth/logout' ||
    path === '/api/v1/auth/login' ||
    path === '/api/v1/realtime' ||
    path.startsWith('/api/v1/files/upload/') ||
    // Flow webhook trigger authenticates with a per-flow token inside the
    // route (constant-time compare) — external callers have no CMS session.
    /^\/api\/v1\/flows\/[^/]+\/trigger$/.test(path)
  ) {
    return next();
  }

  const authHeader = c.req.header('authorization') ?? '';
  const [scheme, token] = authHeader.split(' ');

  // 1. Dev Mode Auth (local development only).
  // Fall back to process.env so the Node.js / Docker serve path works
  // (c.env is only populated in Cloudflare Workers mode). The bypass must
  // also be gated to an explicit development runtime so an inherited
  // LUMIBASE_DEV_AUTH flag cannot enable forged principals in production.
  const devAuthFlagEnabled =
    c.env?.LUMIBASE_DEV_AUTH === 'true' || process.env.LUMIBASE_DEV_AUTH === 'true';
  const developmentRuntime =
    c.env?.LUMIBASE_ENV === 'development' ||
    process.env.LUMIBASE_ENV === 'development' ||
    process.env.NODE_ENV === 'development';
  const productionRuntime =
    c.env?.LUMIBASE_ENV === 'production' ||
    process.env.LUMIBASE_ENV === 'production' ||
    process.env.NODE_ENV === 'production';
  const devAuthEnabled = devAuthFlagEnabled && developmentRuntime && !productionRuntime;
  if (devAuthEnabled) {
    const devToken = token || authHeader;
    if (devToken && devToken.startsWith('dev:')) {
      const parts = devToken.slice(4).split(':'); // dev:<email>:<role>
      const email = parts[0] || 'dev@lumibase.dev';
      const role = parts[1] || 'admin';
      const principal: AuthPrincipal = {
        email,
        externalId: `dev_${email}`,
        roles: [role],
        raw: { dev: true },
      };
      c.set('auth', principal);
      return next();
    }
  }

  // 2. Cloudflare Access Assertion (Admin flow)
  const cfAccessAssertion = c.req.header('cf-access-jwt-assertion');
  if (cfAccessAssertion) {
    const certsUrl = c.env.CF_ACCESS_CERTS_URL;
    const audience = c.env.CF_ACCESS_AUDIENCE;

    if (!certsUrl || !audience) {
      return c.json(
        { errors: [{ code: 'AUTH_NOT_CONFIGURED', message: 'CF_ACCESS_CERTS_URL/AUDIENCE missing.' }] },
        500,
      );
    }

    try {
      const { payload } = await jwtVerify(cfAccessAssertion, getJwks(certsUrl), {
        audience,
        algorithms: ['RS256'],
      });

      const email = typeof payload.email === 'string' ? payload.email : undefined;
      const requestSiteId = c.get('siteId');

      // Map the Access identity to a real user + site role from the DB instead
      // of trusting the edge assertion for authorization (CWE-302). A verified
      // Access token proves identity; it does NOT grant admin. The user must
      // exist, be active, and either be the bootstrap admin or hold a membership
      // in the requested site — the role comes from that membership.
      if (!email) {
        return c.json(
          { errors: [{ code: 'UNAUTHENTICATED', message: 'Cloudflare Access token has no email.' }] },
          401,
        );
      }

      const [user] = await c
        .get('db')
        .select({
          id: users.id,
          status: users.status,
          isBootstrap: users.isBootstrap,
        })
        .from(users)
        .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
        .limit(1);

      if (!user || user.status !== 'active') {
        return c.json(
          { errors: [{ code: 'UNAUTHENTICATED', message: 'Cloudflare Access user is not provisioned.' }] },
          401,
        );
      }

      const [membership] = await c
        .get('db')
        .select({ roleId: userSites.roleId })
        .from(userSites)
        .where(and(eq(userSites.userId, user.id), eq(userSites.siteId, requestSiteId)))
        .limit(1);

      if (!membership && !user.isBootstrap) {
        return c.json(
          { errors: [{ code: 'UNAUTHENTICATED', message: 'Cloudflare Access user is not a member of the selected site.' }] },
          401,
        );
      }

      mergeRequestContext(c, {
        user: {
          id: user.id,
          externalId: String(payload.sub),
          email,
          isBootstrap: user.isBootstrap,
        },
        membership: membership?.roleId ? { roleId: membership.roleId } : null,
      });

      const principal: AuthPrincipal = {
        userId: user.id,
        externalId: String(payload.sub),
        email,
        roles: user.isBootstrap ? ['admin'] : [membership?.roleId ?? 'member'],
        raw: payload as Record<string, unknown>,
      };
      c.set('auth', principal);
      return next();
    } catch (err) {
      console.warn('[withAuth] CF Access verification failed:', formatSafeError(err));
      return c.json(
        { errors: [{ code: 'UNAUTHENTICATED', message: 'Invalid Cloudflare Access token.' }] },
        401,
      );
    }
  }

  // 3. Custom JWT Auth (Frontend Users flow)
  const bearerToken =
    scheme?.toLowerCase() === 'bearer' && token ? token : undefined;

  if (bearerToken) {
    const tokenHash = await sha256Hex(bearerToken);
    const [apiKey] = await c
      .get('db')
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.tokenHash, tokenHash))
      .limit(1);

    if (apiKey) {
      const now = new Date();
      // Fail-closed tenant scoping: a token that belongs to another site is
      // never accepted here. We fetch by token hash (a 256-bit unguessable
      // value) and then reject + audit any cross-tenant use before the key
      // can yield a principal.
      if (apiKey.siteId !== c.get('siteId')) {
        await auditApiKeyUseDenied(c, apiKey, 'site_mismatch');
        return c.json(
          { errors: [{ code: 'UNAUTHENTICATED', message: 'Invalid bearer token.' }] },
          401,
        );
      }
      if (apiKey.revokedAt) {
        await auditApiKeyUseDenied(c, apiKey, 'revoked');
        return c.json(
          { errors: [{ code: 'UNAUTHENTICATED', message: 'API key is expired or revoked.' }] },
          401,
        );
      }
      if (apiKey.expiresAt && apiKey.expiresAt <= now) {
        await auditApiKeyUseDenied(c, apiKey, 'expired');
        return c.json(
          { errors: [{ code: 'UNAUTHENTICATED', message: 'API key is expired or revoked.' }] },
          401,
        );
      }

      // Origin allowlist for publishable (client-embeddable) keys. Scoped to
      // publishable keys only: a secret key is used server-to-server where no
      // `Origin` exists, so applying this there would reject every caller.
      //
      // This is not a confidentiality control — a publishable key is public by
      // construction. It stops another *website* from using the key in a
      // browser, which is the failure mode operators actually hit. See
      // `services/api-key-publishable.ts` for the full verdict semantics.
      if (isPublishablePrefix(apiKey.prefix)) {
        const verdict = checkOrigin(
          c.req.header('origin'),
          c.req.header('referer'),
          readAllowedOrigins(apiKey.metadata),
        );
        if (verdict === 'denied') {
          await auditApiKeyUseDenied(c, apiKey, 'origin_not_allowed');
          return c.json(
            {
              errors: [
                {
                  code: 'ORIGIN_NOT_ALLOWED',
                  message: 'This key is not allowed for the requesting origin.',
                },
              ],
            },
            403,
          );
        }
      }

      // Debounced, off-path last-used touch (Req 3): skip the write entirely
      // when the stored timestamp is still within the interval, and never let
      // it block the response. Last-write-wins on these stats columns makes a
      // race between concurrent instances harmless.
      if (shouldTouchApiKey(apiKey.lastUsedAt, now, apiKeyTouchIntervalMs(c.env))) {
        const db = c.get('db');
        const touch = Promise.resolve(
          db
            .update(apiKeys)
            .set({
              lastUsedAt: now,
              lastUsedIp: c.get('ip') ?? c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? null,
              lastUsedUserAgent: c.get('userAgent') ?? c.req.header('user-agent') ?? null,
            })
            .where(eq(apiKeys.id, apiKey.id)),
        ).then(
          () => undefined,
          (err: unknown) => {
            console.warn('[withAuth] api-key lastUsed touch failed', formatSafeError(err));
          },
        );
        runDetached(c, touch);
      }

      const snapshot = apiKeySnapshot({ ...apiKey, lastUsedAt: now });
      const principal: AuthPrincipal = {
        type: 'api_key',
        apiKeyId: apiKey.id,
        apiKey: snapshot,
        roles: [],
        raw: { apiKey: snapshot },
      };
      c.set('auth', principal);
      return next();
    }

    // 3b. External JWT (trusted issuer JWKS). Sits between API-key and the
    // internal custom JWT. `skip` → the token isn't for any trusted issuer of
    // this site, so fall through to the custom-JWT branch; `rejected` →
    // fail-closed (the issuer matched but the token is invalid / unauthorized).
    const ext = await tryExternalJwt(c, bearerToken);
    if (ext.kind === 'authenticated') {
      const principal: AuthPrincipal = {
        type: 'user',
        userId: ext.userId,
        externalId: ext.externalId,
        email: ext.email,
        roles: ext.roleIds,
        raw: ext.payload as Record<string, unknown>,
      };
      c.set('auth', principal);
      return next();
    }
    if (ext.kind === 'rejected') {
      // Generic outward code; the specific reason is for server logs only.
      const outward = ext.status === 403 ? 'FORBIDDEN' : 'UNAUTHENTICATED';
      console.warn('[withAuth] external JWT rejected:', ext.code, ext.reason);
      // Audit the denial with the classification code only — never the token,
      // claims, or the server-side reason string (best-effort; never throws).
      await new AuditLogger({ db: c.get('db'), siteId: c.get('siteId') }).write({
        event: 'external_auth_denied',
        actorEmail: null,
        ip: c.get('ip') ?? null,
        userAgent: c.get('userAgent') ?? null,
        requestId: c.get('requestId') ?? null,
        metadata: { code: ext.code, status: ext.status },
      });
      return c.json({ errors: [{ code: outward, message: ext.status === 403 ? 'Access denied.' : 'Authentication required.' }] }, ext.status);
    }
    // ext.kind === 'skip' → continue to custom JWT below.

    // Fall back to process.env for Node.js / Docker serve mode.
    const jwtSecret = c.env.JWT_SECRET || process.env.JWT_SECRET;
    if (!jwtSecret) {
      return c.json(
        { errors: [{ code: 'AUTH_NOT_CONFIGURED', message: 'JWT_SECRET configuration missing.' }] },
        500,
      );
    }

    try {
      const payload = await verifyCustomJwt(bearerToken, jwtSecret);
      const tokenSiteId = typeof payload.siteId === 'string' ? payload.siteId : null;
      const requestSiteId = c.get('siteId');
      if (!tokenSiteId || tokenSiteId !== requestSiteId) {
        return c.json(
          { errors: [{ code: 'UNAUTHENTICATED', message: 'Invalid bearer token.' }] },
          401,
        );
      }

      const userId = String(payload.userId);
      const [user] = await c
        .get('db')
        .select({
          id: users.id,
          status: users.status,
          isBootstrap: users.isBootstrap,
          tokenVersion: users.tokenVersion,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!user || user.status !== 'active') {
        return c.json(
          { errors: [{ code: 'UNAUTHENTICATED', message: 'Invalid bearer token.' }] },
          401,
        );
      }

      // Token revocation (CWE-613/620): a token is only valid while its embedded
      // tokenVersion matches the user's current one. A password change/reset
      // bumps the stored version, instantly invalidating every prior token.
      const tokenVersion = typeof payload.tokenVersion === 'number' ? payload.tokenVersion : 0;
      if (tokenVersion !== (user.tokenVersion ?? 0)) {
        return c.json(
          { errors: [{ code: 'UNAUTHENTICATED', message: 'Session expired. Please sign in again.' }] },
          401,
        );
      }

      const [membership] = await c
        .get('db')
        .select({ roleId: userSites.roleId })
        .from(userSites)
        .where(and(eq(userSites.userId, userId), eq(userSites.siteId, requestSiteId)))
        .limit(1);
      if (!membership && !user.isBootstrap) {
        return c.json(
          { errors: [{ code: 'UNAUTHENTICATED', message: 'Invalid bearer token.' }] },
          401,
        );
      }

      // The `aud` claim records the realm the token was minted for
      // (`studio` vs `frontend`). `isFrontendUser` tracks it for the
      // `/me` surface; `withStudioAccess` enforces the hard wall using
      // the same claim carried on `raw`.
      mergeRequestContext(c, {
        user: {
          id: user.id,
          externalId: null,
          email: typeof payload.email === 'string' ? payload.email : user.id,
          isBootstrap: user.isBootstrap,
        },
        membership: membership?.roleId ? { roleId: membership.roleId } : null,
      });

      const principal: AuthPrincipal = {
        userId,
        email: typeof payload.email === 'string' ? payload.email : undefined,
        roles: user.isBootstrap ? ['admin'] : [membership?.roleId ?? 'member'],
        isFrontendUser: !audienceValues(payload.aud).includes(TOKEN_AUDIENCE.studio),
        raw: payload as Record<string, unknown>,
      };
      c.set('auth', principal);
      return next();
    } catch (err) {
      console.warn('[withAuth] Custom JWT verification failed:', formatSafeError(err));
      return c.json(
        { errors: [{ code: 'UNAUTHENTICATED', message: 'Invalid bearer token.' }] },
        401,
      );
    }
  }

  // 4. Anonymous (`public` realm). No credential was presented at all.
  //
  // Historically this was an unconditional 401. It still is unless BOTH hold:
  // the request is a read on an allow-listed content path, AND the site has
  // explicitly enabled public access (which is what creates the `public`
  // role). Resolving to a real role — rather than skipping the permission
  // layer — keeps row filters and field masks in force for anonymous callers.
  if (await allowsAnonymous(c)) {
    const publicRoleId = await resolvePublicRoleIdCached(
      c.get('db'),
      c.get('siteId'),
      c.get('runtime')?.cache,
    );
    if (publicRoleId) {
      const principal: AuthPrincipal = {
        type: 'anonymous',
        roleId: publicRoleId,
        roles: [publicRoleId],
        raw: { anonymous: true },
      };
      c.set('auth', principal);
      return next();
    }
  }

  return c.json(
    { errors: [{ code: 'UNAUTHENTICATED', message: 'Authentication required.' }] },
    401,
  );
};

/**
 * Content paths an unauthenticated caller may reach once a site enables
 * public access.
 *
 * Deliberately an allowlist, not a denylist: every other route keeps its
 * pre-existing 401. Studio management paths are excluded here AND blocked
 * again by `withStudioAccess` (an anonymous principal has no `userId`), so
 * neither guard is load-bearing alone.
 *
 * `/graphql` is absent on purpose — its operations arrive over POST, so it
 * cannot be covered by the read-method rule below. Opening it to anonymous
 * callers needs read-only operation validation alongside the cost limiter and
 * is a separate change.
 */
const ANONYMOUS_ALLOWED_PREFIXES = [
  '/api/v1/items',
  '/api/v1/search',
  '/api/v1/media',
  '/api/v1/files',
];

/** Only side-effect-free methods are ever eligible for the anonymous realm. */
const ANONYMOUS_ALLOWED_METHODS = new Set(['GET', 'HEAD']);

async function allowsAnonymous(c: Parameters<MiddlewareHandler<AppEnv>>[0]): Promise<boolean> {
  if (!ANONYMOUS_ALLOWED_METHODS.has(c.req.method.toUpperCase())) return false;
  if (!c.get('siteId') || !c.get('db')) return false;
  const path = c.req.path;
  return ANONYMOUS_ALLOWED_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}
