---
version: 1
lastUpdated: 2026-08-02T19:02:55.280Z
sourceLang: en
contentHash: 0bbce68a2aca2873
codeVerified: 2026-08-02T19:02:55.280Z
codeVerifiedHash: 0bbce68a2aca2873
codeVerifiedClaims: 2
---

# ADR-012: Remove CDC CacheInvalidator

<!-- verify-code-refs: planned apps/cms/src/modules/cdc/cache-invalidator.ts -->

**Date:** 2026-08-02  
**Status:** Accepted

## Context

The ClickHouse CDC spec introduced `CacheInvalidator` (`apps/cms/src/modules/cdc/cache-invalidator.ts`) to mirror Postgres row changes into Redis (`config:${table}:${recordId}`). It was never wired into a production CDC pipeline.

Problems if enabled as-is:

1. **Key namespace mismatch** — CMS read paths use tag-based keys (`schema:`, `perm:`, `deliver:`, etc.), not `config:${table}:${recordId}`.
2. **Multi-tenancy violation (DoD 2b)** — keys omitted `siteId`, so enabling the module could cross-invalidate tenants.
3. **Superseded write path** — item/schema mutations through the API now invalidate via `CacheProvider.invalidateByTag` at commit (high-load-cache-readiness Req 8).

## Decision

**Remove** `CacheInvalidator` and its property tests. Do not wire CDC row events into application cache keys.

CDC change-feed dispatch (webhooks, extensions) remains; only the unused Redis mirror layer is deleted.

## Consequences

### Positive

- No dead code implying a second, conflicting invalidation path.
- Eliminates the siteId-less key design before it could ship.
- Operators rely on one documented invalidation model (tag purge + HTTP cache TTL).

### Negative

- Direct database writes that bypass the CMS API will not auto-invalidate app cache until something else purges tags or TTL expires.

## Reopen conditions

Reintroduce a CDC-driven invalidator only if **all** are true:

1. A supported connector delivers row events from outside the API write path in production.
2. Keys are derived as `…:${siteId}:…` and match real `CacheProvider` readers.
3. Contract tests cover two-site isolation and tag-namespace alignment.

Until then, prefer operational purge (`POST /api/v1/utils/cache/purge`) or fixing writers to go through the API.

## References

- high-load-cache-readiness design §4.5, §21.1 (method B)
- ADR-004 tag-based cache invalidation
