import type { CacheProvider } from '@lumibase/runtime';

/**
 * Hostname → siteId map used by the tenant middleware to resolve a request by
 * its full `Host` header. Written when a `site_domains` row reaches `active`
 * (custom domains after SSL is live; free subdomains immediately), deleted when
 * the domain is removed.
 *
 * Keyed by the exact lowercased FQDN so both `acme.com` and `blog.lumibase.dev`
 * resolve the same way — this is the source of truth for host routing, distinct
 * from the legacy `site-domain:<label>` subdomain map.
 */

const PREFIX = 'site-host:';

/** Cache TTL (seconds). Long-lived; entries are explicitly invalidated. */
const TTL_SECONDS = 60 * 60 * 24; // 24h

export function hostKey(hostname: string): string {
  return `${PREFIX}${hostname.trim().toLowerCase()}`;
}

export async function putHostMapping(
  cache: CacheProvider,
  hostname: string,
  siteId: string,
): Promise<void> {
  await cache.set(hostKey(hostname), siteId, { ttl: TTL_SECONDS });
}

export async function getHostMapping(
  cache: CacheProvider,
  hostname: string,
): Promise<string | null> {
  return cache.get<string>(hostKey(hostname));
}

export async function deleteHostMapping(cache: CacheProvider, hostname: string): Promise<void> {
  await cache.delete(hostKey(hostname));
}
