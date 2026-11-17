---
version: 3
lastUpdated: 2026-11-16T15:30:25.203Z
sourceLang: vi
contentHash: 12a79164d9af0cae
codeVerified: 2026-11-16T15:30:25.203Z
codeVerifiedHash: 12a79164d9af0cae
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
| `projection` | `{ fields: ['*'] \| ['id', 'title', 'slug'], orderBy?: 'createdAt desc' }` |
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

## Chiến lược bảng vật lý

LumiBase biên dịch động các collection logic thành bảng database vật lý để đạt hiệu năng đọc cao nhất:

### 1. Thao tác DDL (`materialize-service.ts`)
- **`createPhysicalTable()`**: Sinh và thực thi `CREATE TABLE IF NOT EXISTS mat_{target}` với các cột: `id`, `status`, `data` (JSONB), `created_at` và `updated_at`.
- **`refreshPhysicalTable()`**: Thực hiện `TRUNCATE` rồi `INSERT INTO ... SELECT` từ bảng chính `items`, áp dụng projection và filter đã cấu hình để làm phẳng cấu trúc JSONB.
- **`dropPhysicalTable()`**: Chạy `DROP TABLE IF EXISTS mat_{target}` khi một materialization bị xoá.
- **`installAutoRefreshTrigger()`**: Gắn một PostgreSQL trigger lên bảng `items` để báo cho hệ thống khi có thay đổi, phục vụ refresh tự động.

### 2. Tích hợp auto-refresh
`ItemService` có một trigger chạy sau khi ghi:
- Mỗi khi một item được tạo, cập nhật hoặc xoá, `ItemService.commit()` truy vấn registry của materialization.
- Nếu collection được materialize với strategy `auto`, nó đưa một tác vụ refresh vào hàng đợi để giữ bảng vật lý đồng bộ.

## Truy vấn materialized data
Delivery API hỗ trợ đọc trực tiếp từ các bảng vật lý đã materialize qua endpoint `/api/v1/materialize/:id/data`, bỏ qua hoàn toàn bước parse JSONB.

Khi feature đầy đủ, route `/items/:collection` sẽ tự động detect và route qua materialized table nếu:

- Materialization có `status='idle'` và `lastRefreshedAt` trong threshold acceptable.
- Query không vượt quá projection (chỉ select field đã materialize).

Nếu không match → fallback về `items` JSONB.

## Multi-tenancy

Index `(siteId, collection)`, query luôn scope `siteId`. Target table name namespace theo `siteId` để tránh collision.
