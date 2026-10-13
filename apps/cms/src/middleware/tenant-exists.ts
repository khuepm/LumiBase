import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env';
import { siteExists } from '../services/domains/site-exists-cache';

/**
 * Reject a request whose resolved `siteId` does not name a real tenant.
 *
 * Runs after `withDb` (it needs a DB handle) and BEFORE `withAuth`, which is
 * the first middleware that writes audit rows carrying `siteId`. Without this
 * guard an arbitrary `X-Lumi-Site` value — shape-checked but never verified by
 * `withTenant` — reaches `audit_log.site_id` and violates its FK to `sites.id`.
 *
 * 404, not 400: the shape was valid, the tenant simply does not exist. It also
 * matches how an unknown site behaves on every other surface, so this middleware
 * does not become a tenant-enumeration oracle that behaves differently from the
 * routes behind it.
 */
export const withTenantExists = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const siteId = c.get('siteId');
  if (!siteId) return next();

  const db = c.get('db');
  if (!db) return next();

  if (await siteExists(db, c.get('runtime')?.cache, siteId)) {
    return next();
  }

  return c.json(
    { errors: [{ code: 'TENANT_NOT_FOUND', message: 'Unknown site.' }] },
    404,
  );
};
