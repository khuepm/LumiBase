import type { MiddlewareHandler } from 'hono';
import { apiKeys, users, userSites } from '@lumibase/database';
import { and, eq, sql } from 'drizzle-orm';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { AppEnv, AuthPrincipal } from '../env';
import { AuditLogger } from '../modules/audit/logger';
import { tryExternalJwt } from '../modules/external-auth/adapter';
import { formatSafeError } from '@lumibase/shared/utils';

const JWKS_CACHE = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

const getJwks = (certsUrl: string) => {
  let jwks = JWKS_CACHE.get(certsUrl);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(certsUrl));
    JWKS_CACHE.set(certsUrl, jwks);
  }
  return jwks;
};

// Verify Custom JWT (HS256)
async function verifyCustomJwt(token: string, secret: string): Promise<any> {
  const encoder = new TextEncoder();
  const secretKey = encoder.encode(secret);
  const { payload } = await jwtVerify(token, secretKey, {
    algorithms: ['HS256'],
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
  reason: 'site_mismatch' | 'revoked' | 'expired',
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
  // NOTE: `/api/v1/auth/register` is intentionally NOT bypassed — the route
  // handler requires an admin principal, so it must run through withAuth.
  if (
    path === '/api/v1/auth/login' ||
    path === '/api/v1/rah5/auth/guest' ||
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

      await c
        .get('db')
        .update(apiKeys)
        .set({
          lastUsedAt: now,
          lastUsedIp: c.get('ip') ?? c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? null,
          lastUsedUserAgent: c.get('userAgent') ?? c.req.header('user-agent') ?? null,
        })
        .where(eq(apiKeys.id, apiKey.id));

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

      const principal: AuthPrincipal = {
        userId,
        email: typeof payload.email === 'string' ? payload.email : undefined,
        roles: user.isBootstrap ? ['admin'] : [membership?.roleId ?? 'member'],
        isFrontendUser: true,
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

  return c.json(
    { errors: [{ code: 'UNAUTHENTICATED', message: 'Authentication required.' }] },
    401,
  );
};
