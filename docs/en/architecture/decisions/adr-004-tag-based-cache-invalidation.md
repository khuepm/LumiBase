# ADR-004: Tag-based Cache Invalidation

**Date:** 2024-04-05
**Status:** Accepted

## Context

LumiBase caches several kinds of computed data:
- **Schema cache** — the "virtual schema" built from `collections` + `fields` + `relations` tables, used by every item query to build dynamic Drizzle queries
- **Permission cache** — the evaluated permission matrix for each `(site, role, collection)` tuple
- **Settings cache** — site-wide settings read on every request
- **Delivery cache** — page hydration responses from `/api/v1/deliver/page/:slug` (served to Next.js consumer with tag-based revalidation)

Cache keys alone are insufficient for invalidation:
- A schema change to collection `articles` should invalidate ALL cache entries that depend on `articles` — including nested relation caches
- An item update in `articles` should invalidate the specific item cache AND any list caches that might contain it

Options considered:
1. **TTL-based expiry** — simple but stale for up to N seconds; unacceptable for schema changes that need instant propagation
2. **Event-driven key enumeration** — delete every known key on mutation; fragile, requires tracking all emitted keys
3. **Tag-based invalidation** — each cache entry is tagged with its dependencies; a tag invalidation removes all entries sharing that tag

## Decision

Use **tag-based cache invalidation** via the `CacheProvider` interface:

```typescript
interface CacheProvider {
  get(key: string): Promise<string | null>
  set(key: string, value: string, options?: { tags?: string[]; ttl?: number }): Promise<void>
  invalidateByTag(tag: string): Promise<void>
}
```

**Tag naming conventions:**

| Tag | Invalidated when |
|-----|-----------------|
| `schema:{siteId}` | Any collection/field/relation changes |
| `schema:{siteId}:{collection}` | A specific collection's schema changes |
| `perm:{siteId}:{roleId}` | Permissions for a role change |
| `item:{siteId}:{collection}:{id}` | A specific item is updated/deleted |
| `list:{siteId}:{collection}` | Any item in a collection is created/updated/deleted |
| `settings:{siteId}` | Any site setting changes |
| `page:{siteId}:{slug}` | A page or its content dependencies change |

**Cloudflare adapter:** Uses KV + a secondary "tag index" stored under `tag:{tagName}` key, which holds a set of cache keys with that tag. On `invalidateByTag`, reads the index, deletes all listed keys, then deletes the index entry itself.

**Docker adapter:** Uses Redis with `SADD tag:{tagName} cacheKey` and `SMEMBERS` + `DEL` pattern.

## Consequences

**Positive:**
- Instant cache invalidation on mutation — no stale windows
- Granular — changing one item doesn't flush the entire site's cache
- Decoupled — services don't need to know which cache keys exist; they just publish a tag
- Works identically across Cloudflare KV and Redis via the abstraction layer

**Negative:**
- Tag index itself is a cache miss vector — if the index is stale, some entries may not be invalidated (eventually consistent)
- Cloudflare KV has eventual consistency (~60s propagation globally) — a schema change may take up to 60s to invalidate across all PoPs
- Higher write overhead: each `set` also writes to the tag index (2 KV writes instead of 1)

**Mitigation:**
- Schema cache uses a short TTL (60s) as a backstop against missed invalidations
- For critical schema changes, the Studio forces a cache-bust via an explicit `POST /utils/cache/purge` call
