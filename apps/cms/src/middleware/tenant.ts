import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env';
import { getHostMapping } from '../services/domains/host-cache';

/**
 * Resolve the active `site_id` for the request and pin it on the context.
 *
 * Resolution order (highest priority first):
 *   1. Explicit `X-Lumi-Site` header (used by Studio + SDK).
 *   2. Exact host mapping: full `Host` header → `site-host:<fqdn>` KV lookup.
 *      Serves custom domains (`cms.acme.com`) and free `*.lumibase.dev`
 *      subdomains registered via `site_domains`.
 *   3. Legacy subdomain mapping: `<slug>.api.lumibase.dev` → `site-domain:<slug>`.
 *   4. Query string `?site=` (only when `LUMIBASE_DEV_AUTH=true`).
 *
 * Once resolved, every downstream service MUST scope queries by this id
 * (Strict Rule #2: multi-tenancy at the ORM/query layer).
 */
export const withTenant = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const path = c.req.path;
  if (path.startsWith('/api/v1/files/upload/')) {
    return next();
  }

  const headerSite = c.req.header('x-lumi-site');
  if (headerSite) {
    c.set('siteId', headerSite);
    return next();
  }

  // Strip the port (`acme.com:8787` → `acme.com`) and lowercase for the lookup.
  const host = (c.req.header('host') ?? '').split(':')[0]?.toLowerCase() ?? '';

  // (2) Exact host → site mapping (custom domains + free subdomains).
  const cache = c.get('runtime')?.cache;
  if (host && cache) {
    const byHost = await getHostMapping(cache, host);
    if (byHost) {
      c.set('siteId', byHost);
      return next();
    }
  }

  // (3) Legacy first-label subdomain mapping.
  const sub = host.split('.')[0];
  if (sub && sub !== 'api' && sub !== 'localhost' && sub !== '127') {
    // Resolve via CacheProvider: `site-domain:<subdomain>` -> siteId.
    if (cache) {
      const mapped = await cache.get<string>(`site-domain:${sub}`);
      if (mapped) {
        c.set('siteId', mapped);
        return next();
      }
    }
  }

  if (c.env.LUMIBASE_DEV_AUTH === 'true') {
    const fromQuery = c.req.query('site');
    if (fromQuery) {
      c.set('siteId', fromQuery);
      return next();
    }
  }

  return c.json(
    { errors: [{ code: 'TENANT_REQUIRED', message: 'X-Lumi-Site header is required.' }] },
    400,
  );
};
