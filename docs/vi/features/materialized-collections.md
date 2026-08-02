---
version: 1
lastUpdated: 2026-07-25T08:17:41.116Z
sourceLang: vi
contentHash: c61cc42cd8d3e734
codeVerified: 2026-07-25T08:17:41.116Z
codeVerifiedHash: c61cc42cd8d3e734
codeVerifiedClaims: 8
---

# Materialized Collections

POST-GA6: tối ưu hot read path bằng cách cache pre-computed projection của collection ra một denormalized table riêng.

## Khi nào dùng

LumiBase mặc định lưu items dạng JSONB trong bảng chung `items`, query động qua Drizzle. Cách này linh hoạt nhưng:

- JSONB query có overhead cao khi RPS lớn (Delivery API public).
- GIN index không cover hết mọi filter.
- Aggregation, full table scan có thể chậm.

Materialized collection giúp denormalize những collection hot-path:

- Pre-flatten field thường query.
- Tạo index B-tree truyền thống.
- Refresh định kỳ (cron) hoặc manual.

## Table

`materialized_collections` (xem `data-model.md`):

| Column | Mô tả |
|--------|-------|
| `collection` | Source collection name |
| `target` | Target table name (machine-readable) |
| `refreshStrategy` | `auto` (sau mỗi write) / `cron` / `manual` |
| `refreshCron` | Cron expression khi `refreshStrategy='cron'` |
| `projection` | `{ fields: ['*'] | ['id', 'title', 'slug'], orderBy?: 'createdAt desc' }` |
| `filter` | Subset filter (chỉ materialize subset items) |
| `lastRefreshedAt` | Timestamp lần refresh thành công gần nhất |
| `rowCount` | Số rows materialized |
| `status` | `idle` / `refreshing` / `error` |
| `error` | Error message khi `status='error'` |

Unique constraint trên `(siteId, collection, target)`.

## API endpoints

```
GET    /api/v1/materialize             List materializations
POST   /api/v1/materialize             Register một materialization
POST   /api/v1/materialize/:id/refresh Refresh now (manual)
DELETE /api/v1/materialize/:id         Drop materialization
```

Implementation: `apps/cms/src/routes/materialize.ts`.

## Physical Table Strategy

LumiBase dynamically compiles logical collections into physical database tables for maximum read performance:

### 1. DDL Operations (`materialize-service.ts`)
- **`createPhysicalTable()`**: Generates and executes `CREATE TABLE IF NOT EXISTS mat_{target}` containing columns: `id`, `status`, `data` (JSONB), `created_at`, and `updated_at`.
- **`refreshPhysicalTable()`**: Performs `TRUNCATE` and `INSERT INTO ... SELECT` from the main `items` table, applying the configured projection and filters to flatten the JSONB structure.
- **`dropPhysicalTable()`**: Runs `DROP TABLE IF EXISTS mat_{target}` when a materialization is deleted.
- **`installAutoRefreshTrigger()`**: Attaches a PostgreSQL trigger on the `items` table that notifies the system of changes for automatic refresh.

### 2. Auto-Refresh Integration
The `ItemService` includes a post-write trigger:
- Whenever an item is created, updated, or deleted, `ItemService.commit()` queries the materialization registry.
- If the collection is materialized with the `auto` strategy, it enqueues a refresh task to keep the physical table synchronized.

## Truy vấn materialized data
Delivery API supports reading directly from the materialized physical tables via the `/api/v1/materialize/:id/data` endpoint, bypassing JSONB parsing completely.

Khi feature đầy đủ, route `/items/:collection` sẽ tự động detect và route qua materialized table nếu:

- Materialization có `status='idle'` và `lastRefreshedAt` trong threshold acceptable.
- Query không vượt quá projection (chỉ select field đã materialize).

Nếu không match → fallback về items JSONB.

## Multi-tenancy

Index `(siteId, collection)`, query luôn scope `siteId`. Target table name namespace theo `siteId` để tránh collision.
