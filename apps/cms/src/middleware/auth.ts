import type { MiddlewareHandler } from 'hono';
import { apiKeys } from '@lumibase/database';
import { eq } from 'drizzle-orm';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { AppEnv, AuthPrincipal } from '../env';
import { AuditLogger } from '../modules/audit/logger';

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
  if (
    path === '/api/v1/auth/register' ||
    path === '/api/v1/auth/login' ||
    path === '/api/v1/realtime' ||
    path.startsWith('/api/v1/files/upload/')
  ) {
    return next();
  }

  const authHeader = c.req.header('authorization') ?? '';
  const [scheme, token] = authHeader.split(' ');

  // 1. Dev Mode Auth (Only check if enabled in env)
  // Fall back to process.env so the Node.js / Docker serve path works
  // (c.env is only populated in Cloudflare Workers mode).
  const devAuthEnabled =
    c.env.LUMIBASE_DEV_AUTH === 'true' || process.env.LUMIBASE_DEV_AUTH === 'true';
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

      const principal: AuthPrincipal = {
        externalId: String(payload.sub),
        email: typeof payload.email === 'string' ? payload.email : undefined,
        roles: ['admin'], // Defaults to admin for Access users, mapping will be done in db query
        raw: payload as Record<string, unknown>,
      };
      c.set('auth', principal);
      return next();
    } catch (err) {
      console.warn('[withAuth] CF Access verification failed:', err);
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
      const principal: AuthPrincipal = {
        userId: String(payload.userId),
        email: typeof payload.email === 'string' ? payload.email : undefined,
        roles: Array.isArray(payload.roles) ? (payload.roles as string[]) : ['member'],
        isFrontendUser: true,
        raw: payload as Record<string, unknown>,
      };
      c.set('auth', principal);
      return next();
    } catch (err) {
      console.warn('[withAuth] Custom JWT verification failed:', err);
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
