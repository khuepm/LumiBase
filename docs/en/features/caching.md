---
title: Caching
description: Edge HTTP cache, application CacheProvider, and cache-penetration defences
---

# Caching

LumiBase caches on three layers: HTTP/edge (`Cache-Control` + ETag on the Delivery API), application cache (`CacheProvider` — Workers KV or Redis), and short-lived process caches. Invalidation is tag-oriented where the provider supports it (see [ADR-004](../architecture/decisions/adr-004-tag-based-cache-invalidation.md)).

## Cache penetration

*Cache penetration* is the case where a key exists in neither cache nor database — every request falls through to Postgres. It is distinct from *cache breakdown* (a hot key that *does* have data expires and stampedes the origin) and from the general authenticated API rate limiter.

Three defences are stacked on public read paths (`GET /api/v1/deliver/*`, schema/collection lookup):

1. **Shape guard** — regex/length checks on `site_id`, `slug`, and collection names. Bad shape returns **404** (not 400) with zero DB queries so the endpoint cannot be used as an oracle for “this shape is valid”. The `X-Lumi-Site` header is the exception: malformed values return `400 TENANT_INVALID` because the client set the header explicitly.
2. **Negative cache (tombstone)** — when the DB confirms absence, a short-lived tombstone is written under `neg:${siteId}:${kind}:${id}` (TTL `LUMIBASE_NEGATIVE_CACHE_TTL`, default 30s, with ±20% jitter). Repeated probes for the same missing key are answered from cache. Credentialed / preview requests never read tombstones. Creating the resource deletes the matching tombstone immediately (TTL is a safety net, not the primary invalidate path).
3. **Delivery IP rate limit** — `LUMIBASE_DELIVER_RATE_LIMIT` (default 1200 req/min/IP, `0` = off) on `/api/v1/deliver/*`, keyed `rl:deliver:${ip}` (no `siteId` — one IP attacking N sites shares one budget). Exceeded → `429` + `Retry-After` + `Cache-Control: no-store`. Rate-limited requests do not write tombstones.

### Why not a Bloom filter?

Deferred for P0/P1:

- Dual-runtime: RedisBloom has no Cloudflare KV equivalent; a KV bitmap would be read-modify-write and eventually consistent (~60s), which can produce correctness bugs (false “absent” for a just-created resource).
- Deletes force a full filter rebuild (standard Bloom filters cannot remove members).
- With the IP rate limit and 30s TTL, per-IP live tombstone memory is small.

**Re-open when:** measured tombstone memory exceeds 5% of Redis `maxmemory`, or a Docker-only deployment drops the KV constraint, or a lookup set exceeds ~10⁷ keys.

### Observability

Prometheus counters:

- `lumibase_cache_negative_hits_total` — reads served from a tombstone
- `lumibase_cache_negative_writes_total` — tombstones written after a confirmed miss

Keep these separate from positive hit/miss so operators can tell “cache hit because we have the data” from “cache hit because we already know it is missing”.

### Environment knobs

| Variable | Default | Meaning |
|----------|---------|---------|
| `LUMIBASE_NEGATIVE_CACHE_TTL` | `30` | Tombstone TTL in seconds before ±20% jitter. `0` disables tombstones. |
| `LUMIBASE_DELIVER_RATE_LIMIT` | `1200` | Max Delivery API requests per minute per client IP. `0` disables. |

Trade-off: a short tombstone TTL means a newly created page can still 404 for up to ~TTL if the write path fails to `forget` the tombstone. Prefer fixing the forget hook over raising TTL. Page create / slug rename go through `POST|PATCH /api/v1/pages` (`PageService`), which calls `forgetNegative` for the new slug and the previous slug on rename.

## Multi-tenancy

Cache penetration keys follow the same shared-vs-isolated split as the rest of the cache stack (design §17):

| Resource | Scope | Key / behaviour | Why |
|----------|-------|-----------------|-----|
| Page / collection / item tombstones | **Isolated** | `neg:${siteId}:page:${slug}`, `neg:${siteId}:collection:${name}`, `neg:${siteId}:item:${collection}:${id}` | Tenant data — Property P20 asserts site A tombstone never affects site B |
| Site-level tombstone (llms.txt) | **Isolated (flat)** | `neg:site:${siteId}` | The key *is* the site id; no parent tenant to nest under |
| Delivery rate limit | **Shared by IP** | `rl:deliver:${ip}` | Public, unauthenticated. Deliberately **not** split by site so one IP attacking N sites shares one budget (same precedent as `rl:recovery:${ip}`) |
| Shape guard | n/a | Pure regex, no storage | Same 404 body/headers as a real miss — never an oracle for valid shapes |

**How to verify:** unit/integration Properties P17–P20 in `apps/cms/src/__tests__/cache-penetration.test.ts` (two-site tombstone isolation + credential bypass); wiring tripwire for `withDeliverRateLimit` in `security-guards.wiring.test.ts`.
