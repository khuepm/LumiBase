/**
 * Studio subscription grant — computes the collection allowlist embedded in a
 * studio realtime ticket.
 *
 * Mirrors `audience-grant.ts`: the authz decision is made at TICKET ISSUANCE
 * (the HTTP route has DB + PermissionService context), and the hub — SiteRoom
 * DO on Cloudflare, in-process hub on Docker — enforces the SIGNED allowlist
 * on every `subscribe` without needing a database connection. Tickets live
 * 1 minute, so permission changes propagate within that window (same staleness
 * bound as the permission KV cache).
 */

import type { PermissionBundle } from '../services/permission-service';

/**
 * Collections the principal may subscribe to. Admin-bypass principals get the
 * `*` wildcard; everyone else gets the exact set of collections their compiled
 * bundle grants `read` on. An empty result means "no subscriptions allowed"
 * (fail-closed at the hub).
 */
export function readableCollections(bundle: Pick<PermissionBundle, 'admin' | 'byKey'>): string[] {
  if (bundle.admin) return ['*'];
  const out = new Set<string>();
  for (const key of Object.keys(bundle.byKey)) {
    // Keys are `${collection}::${action}` — match the exact `read` action
    // ("read_decrypted" must not grant a subscription by itself).
    if (key.endsWith('::read')) out.add(key.slice(0, -'::read'.length));
  }
  return [...out].sort();
}
