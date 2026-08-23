---
version: 1
lastUpdated: 2026-08-02T19:04:04.473Z
sourceLang: en
translatedFrom: en
sourceHash: b0bd87080db91fc0
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-08-02T19:04:04.473Z
codeVerifiedHash: b0bd87080db91fc0
codeVerifiedClaims: 6
---

# Tinh chỉnh hiệu năng — Hướng dẫn cho nhà vận hành

High-load-cache-readiness (Req 16.6): chiến lược chỉ mục (index) và triển khai an toàn cho các phiên bản Postgres trên production.

## Các index được tích hợp sẵn (migration `0013_high_load_flow_runs_items_idx`)

| Index | Mục đích |
|-------|---------|
| `items_site_coll_updated_idx` | Sắp xếp danh sách mặc định `(site_id, collection_id, updated_at)` |
| `items_deliver_idx` | Bộ lọc cửa sổ xuất bản deliver một phần (`deleted_at IS NULL`) |
| `flow_runs_site_flow_created_idx` | Lịch sử chạy flow theo site + flow |

### Triển khai trên instance lớn (`CONCURRENTLY`)

Các migration của Drizzle chạy trong một transaction. **`CREATE INDEX CONCURRENTLY` không thể chạy trong một transaction.** Đối với các bảng có hàng triệu dòng:

1. Áp dụng migration trên bản sao staging và ghi lại thời gian tạo index.
2. Trên production, chạy DDL tạo index thủ công **bên ngoài** bộ chạy migration:

```sql
-- Mỗi đợt bảo trì tạo một index; theo dõi dung lượng ổ đĩa và `pg_stat_progress_create_index`.
CREATE INDEX CONCURRENTLY IF NOT EXISTS items_site_coll_updated_idx
  ON lumibase_items (site_id, collection_id, updated_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS items_deliver_idx
  ON lumibase_items (site_id, collection_id, status, publish_at, unpublish_at)
  WHERE deleted_at IS NULL;
```

3. Nếu bộ chạy migration đã tạo các index thường (non-concurrent), bỏ qua bước 2.

## Expression index cho các trường JSON hay truy vấn

LumiBase lưu trữ các trường của mục trong `lumibase_items.data` (JSONB). Các bộ lọc so sánh bằng trên một trường được truy vấn thường xuyên sẽ được hưởng lợi từ một expression index **cho từng khối lượng công việc của site** (nhà vận hành thêm thủ công các index này — không được gửi kèm trong các migration cốt lõi).

### Xác định các trường ứng viên

```sql
-- Ví dụ: tìm các bộ lọc chậm (yêu cầu pg_stat_statements)
SELECT query, calls, mean_exec_time
FROM pg_stat_statements
WHERE query ILIKE '%lumibase_items%'
ORDER BY mean_exec_time DESC
LIMIT 20;
```

### Mẫu: tạo index cho một trường chuỗi hay dùng

Thay thế `posts` / `slug` / `site_id` bằng tên bộ sưu tập và tên trường của bạn.

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS items_site_posts_slug_idx
  ON lumibase_items (site_id, (data->>'slug'))
  WHERE deleted_at IS NULL;
```

### Mẫu: key sắp xếp dạng số bên trong JSON

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS items_site_products_price_idx
  ON lumibase_items (site_id, ((data->>'price')::numeric))
  WHERE deleted_at IS NULL;
```

### An toàn Đa thuê bao (Multi-tenant)

Luôn đưa `site_id` làm cột dẫn đầu để index hỗ trợ các truy vấn trong phạm vi tenant và giữ dung lượng nhỏ hơn cho mỗi site.

### Xác minh bằng EXPLAIN

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

Tìm dòng `Index Scan` có sử dụng expression index của bạn, thay vì `Seq Scan` trên partition.

## Tùy chỉnh biến môi trường (P2)

| Biến | Mặc định | Tác dụng |
|------|----------|----------|
| `LUMIBASE_BULK_MAX` | `500` | Số item tối đa cho mỗi `POST /items/:collection/bulk` |
| `LUMIBASE_FLOW_SYNC_TIMEOUT` | `30000` | Giới hạn thời gian chạy flow đồng bộ (ms) khi không có worker hàng đợi |

Xem `docs/en/deployment/environment-variables.md` để biết danh sách đầy đủ.
