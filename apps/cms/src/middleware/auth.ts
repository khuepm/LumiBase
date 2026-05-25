import type { MiddlewareHandler } from 'hono';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { AppEnv, AuthPrincipal } from '../env';

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
  const { payload } = await jwtVerify(token, secretKey);
  return payload;
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
    path.startsWith('/api/v1/files/upload/')
  ) {
    return next();
  }

  const authHeader = c.req.header('authorization') ?? '';
  const [scheme, token] = authHeader.split(' ');

  // 1. Dev Mode Auth (Only check if enabled in env)
  if (c.env.LUMIBASE_DEV_AUTH === 'true') {
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
  if (scheme?.toLowerCase() === 'bearer' && token) {
    const jwtSecret = c.env.JWT_SECRET;
    if (!jwtSecret) {
      return c.json(
        { errors: [{ code: 'AUTH_NOT_CONFIGURED', message: 'JWT_SECRET configuration missing.' }] },
        500,
      );
    }

    try {
      const payload = await verifyCustomJwt(token, jwtSecret);
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
