---
version: 1
lastUpdated: 2026-07-25T08:17:41.116Z
sourceLang: vi
translatedFrom: vi
sourceHash: c61cc42cd8d3e734
mtEngine: claude
syncStatus: machine-translated
codeVerified: 2026-07-25T08:17:41.116Z
codeVerifiedHash: c61cc42cd8d3e734
codeVerifiedClaims: 8
---

# Materialized Collections

POST-GA6: optimise the hot read path by caching a pre-computed projection of a collection into its own denormalized table.

## When to use it

By default LumiBase stores items as JSONB in the shared `items` table and queries them dynamically through Drizzle. That is flexible, but:

- JSONB queries carry real overhead at high RPS (the public Delivery API).
- A GIN index does not cover every possible filter.
- Aggregations and full table scans can be slow.

A materialized collection denormalizes the hot-path collections:

- Pre-flatten the frequently queried fields.
- Create conventional B-tree indexes.
- Refresh on a schedule (cron) or manually.

## Table

`materialized_collections` (see `data-model.md`):

| Column | Description |
|--------|-------------|
| `collection` | Source collection name |
| `target` | Target table name (machine-readable) |
| `refreshStrategy` | `auto` (after every write) / `cron` / `manual` |
| `refreshCron` | Cron expression when `refreshStrategy='cron'` |
| `projection` | `{ fields: ['*'] \| ['id', 'title', 'slug'], orderBy?: 'createdAt desc' }` |
| `filter` | Subset filter (materialize only a subset of items) |
| `lastRefreshedAt` | Timestamp of the last successful refresh |
| `rowCount` | Number of materialized rows |
| `status` | `idle` / `refreshing` / `error` |
| `error` | Error message when `status='error'` |

Unique constraint on `(siteId, collection, target)`.

## API endpoints

```
GET    /api/v1/materialize             List materializations
POST   /api/v1/materialize             Register a materialization
POST   /api/v1/materialize/:id/refresh Refresh now (manual)
DELETE /api/v1/materialize/:id         Drop a materialization
```

Implementation: `apps/cms/src/routes/materialize.ts`.

## Physical table strategy

LumiBase dynamically compiles logical collections into physical database tables for maximum read performance:

### 1. DDL operations (`materialize-service.ts`)
- **`createPhysicalTable()`**: generates and executes `CREATE TABLE IF NOT EXISTS mat_{target}` with the columns `id`, `status`, `data` (JSONB), `created_at`, and `updated_at`.
- **`refreshPhysicalTable()`**: performs a `TRUNCATE` followed by `INSERT INTO ... SELECT` from the main `items` table, applying the configured projection and filters to flatten the JSONB structure.
- **`dropPhysicalTable()`**: runs `DROP TABLE IF EXISTS mat_{target}` when a materialization is deleted.
- **`installAutoRefreshTrigger()`**: attaches a PostgreSQL trigger on the `items` table that notifies the system of changes so it can refresh automatically.

### 2. Auto-refresh integration
`ItemService` carries a post-write trigger:
- Whenever an item is created, updated, or deleted, `ItemService.commit()` consults the materialization registry.
- If the collection is materialized with the `auto` strategy, it enqueues a refresh task to keep the physical table in step.

## Querying materialized data

The Delivery API can read straight from the materialized physical tables via the `/api/v1/materialize/:id/data` endpoint, skipping JSONB parsing entirely.

Once the feature is complete, `/items/:collection` will detect and route through the materialized table automatically when:

- The materialization has `status='idle'` and a `lastRefreshedAt` inside an acceptable threshold.
- The query does not exceed the projection (it only selects materialized fields).

If neither holds → it falls back to the JSONB `items` path.

## Multi-tenancy

There is an index on `(siteId, collection)` and every query scopes `siteId`. The target table name is namespaced by `siteId` to avoid collisions.
