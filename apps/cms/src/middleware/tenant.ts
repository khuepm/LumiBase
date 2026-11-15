import type { MiddlewareHandler } from 'hono';
import { isOrganizationPath, isMcpPath } from '../services/organization-access';
import type { AppEnv } from '../env';
import { getHostMapping } from '../services/domains/host-cache';
import { isValidSiteId } from '../services/identifier-guard';
import { mcpSiteIdFromPath } from '../services/mcp-oauth';
import { socialCallbackSiteId } from '../modules/social-auth/paths';

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
  if (isOrganizationPath(path) || path.startsWith('/api/v1/files/upload/')) {
    return next();
  }

  const headerSite = c.req.header('x-lumi-site');

  // Site-addressed MCP endpoint (#346): `/api/v1/mcp/sites/<id>` and its
  // `/.well-known/oauth-protected-resource/...` metadata. A hosted OAuth
  // connector only knows a URL, so the site rides in the path. The path is
  // authoritative; a contradicting `X-Lumi-Site` is a client bug, not a hint.
  const pathSite = mcpSiteIdFromPath(path);
  if (pathSite !== null) {
    if (!isValidSiteId(pathSite)) {
      return c.json({ errors: [{ code: 'TENANT_INVALID', message: 'Site id in the path has an invalid format.' }] }, 400);
    }
    if (headerSite && headerSite !== pathSite) {
      return c.json({ errors: [{ code: 'TENANT_MISMATCH', message: 'X-Lumi-Site does not match the site in the path.' }] }, 400);
    }
    c.set('siteId', pathSite);
    return next();
  }
  // Prefix is only a routing hint. withAuth MUST verify the key before org MCP runs.
  // Social login provider callback (#736): the browser returns from Google /
  // Apple / GitHub without our header, so the site is in the path. The
  // server-side state is bound to the same site and checked again there.
  const callbackSite = socialCallbackSiteId(path);
  if (callbackSite !== null) {
    if (!isValidSiteId(callbackSite) || (headerSite && headerSite !== callbackSite)) {
      return c.json({ errors: [{ code: 'TENANT_INVALID', message: 'Site id in the callback path is invalid.' }] }, 400);
    }
    c.set('siteId', callbackSite);
    return next();
  }
  if (!headerSite && isMcpPath(path) && /^Bearer\s+lbo_/.test(c.req.header('authorization') ?? '')) return next();
  if (headerSite) {
    // Req 19.2: shape-check the explicit header before it becomes context.
    // 400 (not 404) — this is a client-supplied header, not a resource probe.
    if (!isValidSiteId(headerSite)) {
      return c.json(
        {
          errors: [
            {
              code: 'TENANT_INVALID',
              message: 'X-Lumi-Site header has an invalid format.',
            },
          ],
        },
        400,
      );
    }
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
      if (!isValidSiteId(fromQuery)) {
        return c.json(
          {
            errors: [
              {
                code: 'TENANT_INVALID',
                message: 'site query parameter has an invalid format.',
              },
            ],
          },
          400,
        );
      }
      c.set('siteId', fromQuery);
      return next();
    }
  }

  return c.json(
    { errors: [{ code: 'TENANT_REQUIRED', message: 'X-Lumi-Site header is required.' }] },
    400,
  );
};
