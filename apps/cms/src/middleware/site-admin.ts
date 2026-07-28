import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env';
import { PermissionService } from '../services/permission-service';

function collectHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/**
 * Require administrative access for the active tenant.
 *
 * The generic API stack authenticates the bearer token and resolves `siteId`,
 * but sensitive tenant-management APIs must additionally prove that the
 * principal has admin access in that specific site. This prevents callers from
 * selecting an arbitrary `X-Lumi-Site` value and operating on that tenant with
 * only a valid low-privilege token.
 */
export const requireSiteAdmin = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const auth = c.get('auth');
  const siteId = c.get('siteId');

  if (!siteId) {
    return c.json(
      { errors: [{ code: 'TENANT_REQUIRED', message: 'X-Lumi-Site header is required.' }] },
      400,
    );
  }

  // An anonymous principal can never be a site admin. Rejected explicitly so
  // the `public` role is never evaluated against the checks below — the
  // CF-Access carve-out at the end of this function keys off "no userId and no
  // apiKeyId", which an anonymous principal also satisfies.
  if (auth?.type === 'anonymous') {
    return c.json(
      { errors: [{ code: 'FORBIDDEN', message: 'Admin access for the requested site is required.' }] },
      403,
    );
  }

  // Preserve the existing local-development escape hatch for explicit admin
  // dev tokens while keeping non-admin dev tokens subject to the tenant gate.
  if (auth?.raw?.dev === true && auth.roles?.includes('admin')) {
    return next();
  }

  if (auth?.userId || auth?.apiKeyId) {
    const bundle = await new PermissionService({
      db: c.get('db'),
      cache: c.get('runtime').cache,
      ctx: {
        userId: auth.userId ?? null,
        siteId,
        // Always forward it — `ctx.roleId` is the only role source
        // `PermissionService` has for a principal with no user/API-key row.
        roleId: auth.roleId ?? null,
        user: auth.userId
          ? { id: auth.userId, email: auth.email ?? null, roles: auth.roles ?? [], ...(auth.raw ?? {}) }
          : undefined,
        ip: c.get('ip') ?? c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? null,
        headers: collectHeaders(c.req.raw.headers),
        apiKey: auth.apiKey ?? null,
      },
    }).bundle();

    if (bundle.admin) {
      return next();
    }
  }

  // Cloudflare Access principals are trusted administrator sessions in the
  // current auth model but may not have an internal users.id to resolve through
  // PermissionService. Keep them working while rejecting all non-admin roles.
  if (!auth?.userId && !auth?.apiKeyId && auth?.roles?.includes('admin')) {
    return next();
  }

  return c.json(
    { errors: [{ code: 'FORBIDDEN', message: 'Admin access for the requested site is required.' }] },
    403,
  );
};
