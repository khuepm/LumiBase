---
version: 3
lastUpdated: 2026-11-12T18:45:08.116Z
sourceLang: en
contentHash: 98aaa3b267d1bf6f
codeVerified: 2026-11-12T18:45:08.116Z
codeVerifiedHash: 98aaa3b267d1bf6f
codeVerifiedClaims: 12
---

# Data import

Bulk-loading many items — a migration, a seed, a one-off backfill — goes through
the **bulk items endpoint** or, for a whole file, a **background import job**,
never one request per row. This page covers both, the rate limit that trips
large imports, and a recommended batching approach.

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

## Background import jobs

For a file — a [CSV or JSON export](./data-export.md), a migration dump, a
100k-row spreadsheet — upload it as an **import job** instead of batching
`bulk` calls yourself. The server stores the file, answers `202` at once, and
writes the rows in the background in chunks, so the size of the file never
hits a request timeout.

```
POST /api/v1/imports?collection={collection}&format=csv|json&mode=create|upsert
```

- **Body:** the file. Send it as multipart (`file` field; the format is taken
  from a `.csv` / `.json` name) or as a raw body (`text/csv`,
  `application/octet-stream`). A raw `application/json` body is capped by the
  1 MiB JSON body limit, so send JSON files as multipart or
  `application/octet-stream`.
- **Format:** the layout of [Data export](./data-export.md) — CSV with
  `field.locale` columns for translatable fields, or the JSON envelope (or a
  bare array of `{ id?, status?, sort?, data }`). Columns that are not fields
  of the collection are rejected with `400` before any row is written.
- **Mode:** `create` (default) always creates new items. `upsert` updates the
  item whose `id` matches and creates the rest; it needs `update` permission too.
- **Permissions:** checked up front (`create`, plus `update` for `upsert`) and
  again on every row, as the user or API key that uploaded the file. If that
  principal loses access while the job runs, the job stops as `failed`.

The response is the job:

```json
{
  "data": {
    "id": "Vb3…",
    "collection": "products",
    "format": "csv",
    "mode": "create",
    "status": "queued",
    "totalRows": 100000,
    "processedRows": 0,
    "createdRows": 0,
    "updatedRows": 0,
    "failedRows": 0,
    "errorsTruncated": 0,
    "message": null,
    "cancelRequested": false
  }
}
```

| Endpoint | Purpose |
|----------|---------|
| `GET /api/v1/imports/{id}` | Progress: `status`, `processedRows` of `totalRows`, counters. |
| `GET /api/v1/imports?collection=&status=&limit=` | Recent jobs. You see your own; site admins see all. |
| `GET /api/v1/imports/{id}/errors` | Row errors `{ row, id?, message }`. Add `?format=csv` for a download. |
| `POST /api/v1/imports/{id}/cancel` | Stop the job. A queued job stops at once; a running one after its current chunk. |

`status` moves `queued` → `running` → `succeeded`, `failed`, `cancelled` or
`timed_out`. A row that fails (validation, permission, hook) is recorded with
its 1-based row number and the job continues; the job is `failed` only when
every row failed. The first 1,000 row errors are kept and the rest counted in
`errorsTruncated`. Rows written before a cancel or timeout stay.

Studio has the same flow under **Content → collection → Import**, with a
progress bar, **Cancel import** and **Download error report**. Studio also
receives an `import.progress` realtime event for the uploader.

**How it runs.** The upload request starts the job and works on it for up to
about 20 seconds. After that, a one-minute cron (Workers Cron Trigger, or the
Node scheduler on Docker) resumes it. Each chunk is one database transaction:
the rows and the progress counter commit together, so a worker that dies
mid-chunk leaves nothing behind and the chunk is replayed from the last
committed row, with no duplicates. The transaction locks the job, so a second
worker waits instead of writing the same rows, and takes over once the first
worker's lease expires. Measured locally on Postgres 16, a
row goes through the full item pipeline (validation, revisions, change feed) at
about 90 rows per second per job, so a 100k-row file takes about 20 minutes.
Limits and chunk size are set with [`IMPORT_*` variables](../deployment/environment-variables.md#imports).

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

- [Data export](./data-export.md)
- [Environment Variables → Imports](../deployment/environment-variables.md#imports)
- [Environment Variables → Rate limiting](../deployment/environment-variables.md#rate-limiting)
- [Data model](../data-model.md)
