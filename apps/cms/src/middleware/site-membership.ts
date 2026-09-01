import type { MiddlewareHandler } from 'hono';
import { and, eq } from 'drizzle-orm';
import { userSites, users } from '@lumibase/database';
import type { AppEnv, AuthPrincipal } from '../env';
import { PermissionService } from '../services/permission-service';
import { getRequestContext, mergeRequestContext } from './request-context';

// `/api/v1/auth/register` is NOT public: it is an admin-only user-creation
// endpoint, so the caller must also be bound to the selected site.
const PUBLIC_AUTH_PATHS = new Set([
  '/api/v1/auth/login',
  '/api/v1/auth/verify-totp',
]);

/**
 * Bind the authenticated principal to the caller-selected tenant.
 *
 * `withTenant` resolves the active site from request-controlled inputs (most
 * commonly `X-Lumi-Site`). This middleware is the authorization bridge that
 * makes that value safe: user principals must have a `user_sites` membership
 * for the selected site, and API-key principals are allowed only after
 * `withAuth` has already matched the key to the same site.
 */
export const withSiteMembership = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  if (PUBLIC_AUTH_PATHS.has(c.req.path) || c.req.path.startsWith('/api/v1/files/upload/')) {
    return next();
  }

  const auth = c.get('auth');
  const siteId = c.get('siteId');

  // Paths that `withAuth` intentionally skips (e.g. `/api/v1/realtime`, which
  // authenticates inside its own router) reach this middleware without a
  // principal. Membership is a property of an authenticated principal, so
  // there is nothing to bind yet — authentication remains `withAuth`'s job.
  if (!auth) {
    return next();
  }

  // `withAuth` already rejects API keys whose stored site_id does not match
  // the selected tenant, so there is no user_sites membership to check here.
  if (auth.type === 'api_key') {
    await attachAccessBundle(c, auth);
    return next();
  }

  // Anonymous principals have no identity to bind — `withAuth` resolved them
  // to the site's `public` role, which is per-site by construction. Compile
  // the bundle from that role so downstream handlers enforce its row filters
  // and field masks exactly as they do for a logged-in principal.
  if (auth.type === 'anonymous') {
    await attachAccessBundle(c, auth);
    return next();
  }

  // Dev auth is explicitly local-only and historically allowed operators to
  // exercise any tenant. Keep that behaviour for local development while the
  // production paths below require a persisted user/site relationship.
  if (auth.raw?.dev === true && auth.roles?.includes('admin')) {
    return next();
  }

  const ctx = getRequestContext(c);
  const resolved =
    ctx.user ??
    (await resolveUser(c.get('db'), auth));
  if (!resolved) {
    // Cloudflare Access principals authenticate via a trusted CF Access JWT
    // (see `withAuth`'s "Cloudflare Access Assertion" branch) and are not
    // guaranteed to have a matching `users` row — there is no CF Access
    // JIT-provisioning flow in this codebase. `requireSiteAdmin` already
    // carries this same carve-out (`middleware/site-admin.ts`) to avoid
    // locking out that flow; mirror it here instead of hard-failing every
    // CF Access request with TENANT_FORBIDDEN.
    if (!auth.userId && !auth.apiKeyId && auth.roles?.includes('admin')) {
      await attachAccessBundle(c, auth);
      return next();
    }

    return c.json(
      { errors: [{ code: 'TENANT_FORBIDDEN', message: 'Authenticated user is not known to this instance.' }] },
      403,
    );
  }

  if (!ctx.user) {
    mergeRequestContext(c, { user: resolved });
  }

  const nextAuth: AuthPrincipal = {
    ...auth,
    userId: resolved.id,
    externalId: auth.externalId ?? resolved.externalId ?? undefined,
    email: auth.email ?? resolved.email,
    raw: { ...auth.raw, isBootstrap: resolved.isBootstrap },
  };
  c.set('auth', nextAuth);

  if (resolved.isBootstrap) {
    await attachAccessBundle(c, nextAuth);
    return next();
  }

  const membershipKnown = ctx.membership !== undefined;
  const membership = ctx.membership
    ?? (await loadMembership(c.get('db'), resolved.id, siteId));

  if (!membershipKnown && membership) {
    mergeRequestContext(c, { membership });
  }

  if (!membership) {
    return c.json(
      { errors: [{ code: 'TENANT_FORBIDDEN', message: 'Authenticated user is not a member of the selected site.' }] },
      403,
    );
  }

  await attachAccessBundle(c, nextAuth);
  return next();
};

async function resolveUser(
  db: AppEnv['Variables']['db'],
  auth: AuthPrincipal,
): Promise<{ id: string; externalId: string | null; email: string; isBootstrap: boolean } | null> {
  if (auth.userId) {
    const [row] = await db
      .select({ id: users.id, externalId: users.externalId, email: users.email, isBootstrap: users.isBootstrap })
      .from(users)
      .where(eq(users.id, auth.userId))
      .limit(1);
    return row ?? null;
  }

  if (auth.externalId) {
    const [row] = await db
      .select({ id: users.id, externalId: users.externalId, email: users.email, isBootstrap: users.isBootstrap })
      .from(users)
      .where(eq(users.externalId, auth.externalId))
      .limit(1);
    return row ?? null;
  }

  return null;
}

async function loadMembership(
  db: AppEnv['Variables']['db'],
  userId: string,
  siteId: string,
): Promise<{ roleId: string | null } | null> {
  const [row] = await db
    .select({ roleId: userSites.roleId })
    .from(userSites)
    .where(and(eq(userSites.userId, userId), eq(userSites.siteId, siteId)))
    .limit(1);
  // Membership is the ROW, not the role. `user_sites.role_id` is nullable and
  // SCIM provisioning inserts membership without one, so gating on `roleId`
  // would 403 a real member out of the whole tenant — a lockout, not a
  // permission decision. Role resolution is `PermissionService`'s job.
  return row ? { roleId: row.roleId ?? null } : null;
}

async function attachAccessBundle(
  c: Parameters<MiddlewareHandler<AppEnv>>[0],
  auth: AuthPrincipal,
): Promise<void> {
  const existingAccess = c.get('access');
  const ctx = getRequestContext(c);
  if (existingAccess) {
    if (!ctx.accessBundle) {
      mergeRequestContext(c, { accessBundle: existingAccess });
    }
    return;
  }

  if (ctx.accessBundle) {
    c.set('access', ctx.accessBundle);
    return;
  }

  const runtime = c.get('runtime');
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  const bundle = await new PermissionService({
    db: c.get('db'),
    cache: runtime.cache,
    ctx: {
      userId: auth.userId ?? null,
      siteId: c.get('siteId'),
      // Anonymous principals carry their role directly (no membership row).
      roleId: auth.roleId ?? null,
      user: auth ? { id: auth.userId ?? null, email: auth.email ?? null, roles: auth.roles ?? [], ...(auth.raw ?? {}) } : null,
      ip: c.get('ip') ?? c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? null,
      headers,
      apiKey: auth.apiKey ?? null,
    },
  }).bundle();

  c.set('access', bundle);
  mergeRequestContext(c, { accessBundle: bundle });
}
