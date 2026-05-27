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

## Refresh strategies

- **`manual`** — chỉ refresh khi admin trigger qua API hoặc Studio.
- **`cron`** — scheduled job theo `refreshCron` expression.
- **`auto`** — refresh sau mỗi write trên source collection (delay vài giây để batch).

## Implementation status

> **Lưu ý:** Phiên bản hiện tại trong `apps/cms/src/routes/materialize.ts` thực hiện **logical refresh** — chỉ count items + cập nhật `lastRefreshedAt` và `rowCount`. Việc tạo bảng vật lý + write denormalized rows còn nằm trong roadmap.

API surface, schema và run book đã sẵn sàng cho work hoàn thiện sau.

## Truy vấn materialized data

Khi feature đầy đủ, route `/items/:collection` sẽ tự động detect và route qua materialized table nếu:

- Materialization có `status='idle'` và `lastRefreshedAt` trong threshold acceptable.
- Query không vượt quá projection (chỉ select field đã materialize).

Nếu không match → fallback về items JSONB.

## Multi-tenancy

Index `(siteId, collection)`, query luôn scope `siteId`. Target table name namespace theo `siteId` để tránh collision.
