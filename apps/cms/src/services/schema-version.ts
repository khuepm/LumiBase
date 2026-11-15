import type { CacheProvider } from '@lumibase/runtime';

/**
 * Site-wide schema version pointer (#745).
 *
 * Derived artefacts that depend on the WHOLE site schema (the live OpenAPI
 * document) key their cache entries on this number. `SchemaService.invalidate`
 * bumps it on every collection / field / relation mutation, which orphans
 * every cached document for the site in ONE write — Workers KV has no
 * list-by-prefix, so per-entry deletes are not an option.
 *
 * Best-effort by design, like `PermissionService.bumpVersion`: a cache outage
 * must never fail a schema write. Entries keyed on the pointer carry their own
 * TTL, which bounds staleness when a bump is lost.
 */
const schemaVersionKey = (siteId: string) => `schema-ver:${siteId}`;

export async function readSchemaVersion(
  cache: CacheProvider | null | undefined,
  siteId: string,
): Promise<number> {
  if (!cache || !siteId) return 0;
  try {
    const raw = await cache.get<number | string>(schemaVersionKey(siteId));
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  } catch {
    return 0;
  }
}

export async function bumpSchemaVersion(
  cache: CacheProvider | null | undefined,
  siteId: string,
): Promise<void> {
  if (!cache || !siteId) return;
  try {
    if (typeof cache.increment === 'function') {
      await cache.increment(schemaVersionKey(siteId));
      return;
    }
    const current = await readSchemaVersion(cache, siteId);
    await cache.set(schemaVersionKey(siteId), String(current + 1));
  } catch (error) {
    console.warn('[schema-version] bump failed; relying on TTL expiry', error);
  }
}
