---
version: 1
lastUpdated: 2026-07-28T10:17:03.297Z
sourceLang: en
contentHash: 152cf39aee864f38
codeVerified: 2026-07-28T10:17:03.297Z
codeVerifiedHash: 152cf39aee864f38
codeVerifiedClaims: 4
---

# Data import

Bulk-loading many items — a migration, a seed, a one-off backfill — goes through
the **bulk items endpoint**, not one request per row. This page covers the
endpoint, the rate limit that trips large imports, and a recommended batching
approach.

## Bulk endpoint

```
POST /api/v1/items/{collection}/bulk
```

The body is an object with an operation and an array of items:

```json
{
  "op": "create",
  "items": [
    { "title": "First",  "slug": "first" },
    { "title": "Second", "slug": "second" }
  ]
}
```

| Field | Type | Notes |
|-------|------|-------|
| `op` | `"create" \| "update" \| "delete"` | Required. |
| `items` | array of objects | For `update` and `delete`, each item must include its `id`. |

Response is `{ "data": [...] }` — an array of per-item results in input order.
A malformed body returns `400` with a `VALIDATION` envelope. Standard tenant
(`X-Lumi-Site`) and auth headers apply, and row-level permissions are enforced
per item.

> `op: "delete"` performs a **soft delete**, not a hard delete.

### Batching

The endpoint does **not** impose a hard cap on `items` — the array length is not
validated and the service iterates the whole payload. However, `bulk` is **not
transactional**: items are applied sequentially, and a failure part-way leaves
the earlier items committed. For large imports, send items in batches (e.g.
500–1000 per call) so you can retry a failed batch without re-sending everything
and keep each request well under the rate-limit window. Pick a batch size that
balances throughput against request duration for your data.

## Rate limit

The authenticated API is throttled to **300 requests per 60 seconds** per
principal by default (see [Rate limiting](../deployment/environment-variables.md#rate-limiting)).
A naïve import that issues one request per row will hit `429` mid-run. Two
levers:

1. **Use the bulk endpoint** — one request moves a whole batch, so the same
   import costs far fewer requests.
2. **Raise the budget for the import** — set `LUMIBASE_RATE_LIMIT_MAX` higher
   (or `LUMIBASE_RATE_LIMIT_DISABLED=true` on a trusted, isolated import host)
   while the job runs, then restore it.

On `429`, the response carries `Retry-After` and `X-RateLimit-Reset`; a client
that honours them will pace itself automatically.

## Related

- [Environment Variables → Rate limiting](../deployment/environment-variables.md#rate-limiting)
- [Data model](../data-model.md)
