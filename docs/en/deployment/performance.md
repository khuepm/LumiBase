---
version: 1
lastUpdated: 2026-08-02T19:04:04.473Z
sourceLang: en
contentHash: b0bd87080db91fc0
codeVerified: 2026-08-02T19:04:04.473Z
codeVerifiedHash: b0bd87080db91fc0
codeVerifiedClaims: 6
---

# Performance tuning — operator guide

High-load-cache-readiness (Req 16.6): index strategy and safe rollout for
production Postgres instances.

## Built-in indexes (migration `0013_high_load_flow_runs_items_idx`)

| Index | Purpose |
|-------|---------|
| `items_site_coll_updated_idx` | Default list sort `(site_id, collection_id, updated_at)` |
| `items_deliver_idx` | Partial deliver publish-window filter (`deleted_at IS NULL`) |
| `flow_runs_site_flow_created_idx` | Flow run history by site + flow |

### Large-instance rollout (`CONCURRENTLY`)

Drizzle migrations run inside a transaction. **`CREATE INDEX CONCURRENTLY` cannot
run in a transaction.** For tables with millions of rows:

1. Apply the migration on a staging clone and note build time.
2. On production, run the index DDL manually **outside** the migration runner:

```sql
-- One index per maintenance window; monitor disk and `pg_stat_progress_create_index`.
CREATE INDEX CONCURRENTLY IF NOT EXISTS items_site_coll_updated_idx
  ON lumibase_items (site_id, collection_id, updated_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS items_deliver_idx
  ON lumibase_items (site_id, collection_id, status, publish_at, unpublish_at)
  WHERE deleted_at IS NULL;
```

3. If the migration runner already created non-concurrent indexes, skip step 2.

## Hot JSON field expression indexes

LumiBase stores item fields in `lumibase_items.data` (JSONB). Equality filters on
a frequently queried field benefit from an expression index **per site workload**
(operators add these manually — not shipped in core migrations).

### Identify candidates

```sql
-- Example: find slow filters (requires pg_stat_statements)
SELECT query, calls, mean_exec_time
FROM pg_stat_statements
WHERE query ILIKE '%lumibase_items%'
ORDER BY mean_exec_time DESC
LIMIT 20;
```

### Sample: index a hot string field

Replace `posts` / `slug` / `site_id` with your collection and field names.

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS items_site_posts_slug_idx
  ON lumibase_items (site_id, (data->>'slug'))
  WHERE deleted_at IS NULL;
```

### Sample: numeric sort key inside JSON

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS items_site_products_price_idx
  ON lumibase_items (site_id, ((data->>'price')::numeric))
  WHERE deleted_at IS NULL;
```

### Multi-tenant safety

Always include `site_id` as the leading column so the index supports tenant-scoped
queries and stays smaller per site.

### Verify with EXPLAIN

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, data
FROM lumibase_items
WHERE site_id = 'YOUR_SITE_ID'
  AND collection_id = 'YOUR_COLLECTION_ID'
  AND deleted_at IS NULL
  AND data->>'slug' = 'hello-world'
LIMIT 20;
```

Look for `Index Scan` using your expression index, not `Seq Scan` on the partition.

## Env knobs (P2)

| Variable | Default | Effect |
|----------|---------|--------|
| `LUMIBASE_BULK_MAX` | `500` | Max items per `POST /items/:collection/bulk` |
| `LUMIBASE_FLOW_SYNC_TIMEOUT` | `30000` | Sync flow run ceiling (ms) when no queue worker |

See `docs/en/deployment/environment-variables.md` for the full list.
