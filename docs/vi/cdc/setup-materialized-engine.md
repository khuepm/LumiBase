---
title: Setup — Materialized Engine
version: 1
lastUpdated: 2026-07-28T10:30:24.871Z
sourceLang: en
translatedFrom: en
sourceHash: e6d11afc17895892
mtEngine: claude
syncStatus: machine-translated
codeVerified: 2026-07-28T10:30:24.871Z
codeVerifiedHash: e6d11afc17895892
codeVerifiedClaims: 16
---

# Hướng dẫn setup: ClickHouse Materialized Engine

Cách tiếp cận Materialized Engine (`materialized_engine`) nối ClickHouse trực tiếp vào một replication slot của PostgreSQL, dùng database engine `MaterializedPostgreSQL`. Không có message bus và không có service trung gian, nên đây là cách có overhead thấp nhất. Hãy chọn nó cho các workload **lưu lượng thấp đến trung bình (< 5.000 row/s)**, **chưa có hạ tầng Kafka**, và **ngân sách độ trễ thoải mái (< 30s)**.

> Để dựng ClickHouse, hãy làm theo [hướng dẫn deploy Docker Compose / managed services](./deployment-docker-compose.md) trước.

## Điều kiện tiên quyết

- Một Source_Database PostgreSQL đã bật logical replication:
  - `wal_level = logical`
  - Một role có thuộc tính `REPLICATION`
  - `max_replication_slots` và `max_wal_senders` ≥ 1 (cho mỗi pipeline)
- Một ClickHouse Sink (khuyến nghị version 24.x) có sẵn engine `MaterializedPostgreSQL`. Bật nó nếu cần:
  ```sql
  SET allow_experimental_database_materialized_postgresql = 1;
  ```
- Kết nối mạng từ ClickHouse trực tiếp tới PostgreSQL (port 5432).
- Quyền admin trên LumiBase CMS.

## Bước 1: Chuẩn bị PostgreSQL

```sql
-- Kiểm tra WAL level (phải trả về 'logical')
SHOW wal_level;

-- Cấp quyền replication cho role CDC
ALTER ROLE cdc_user WITH REPLICATION;
```

Materialized Engine tự tạo và sở hữu replication slot của nó (tên mặc định `lumibase_mat`); bạn không tạo nó thủ công.

## Bước 2: Đặt các biến môi trường

Cấu hình các biến của Materialized Engine được mô tả trong [tham chiếu Environment Variables](./environment-variables.md#materialized-engine-docker_compose). Tối thiểu:

```bash
CDC_PIPELINE_NAME=catalog-analytics
CDC_APPROACH=materialized_engine
CDC_DEPLOYMENT_TARGET=docker_compose
SOURCE_DATABASE_URL=postgresql://cdc_user:secret@postgres:5432/lumibase
CLICKHOUSE_SINK_URL=clickhouse://clickhouse:9000/analytics
CDC_REPLICATION_TABLES=public.products,public.categories
MATERIALIZED_DATABASE_NAME=lumibase_cdc_mat
```

Validate trước khi đăng ký:

```bash
curl -sS -X POST https://your-cms-host/api/v1/cdc/deploy/validate-env \
  -H "Authorization: Bearer $LUMI_ADMIN_TOKEN" \
  -H "X-Lumi-Site: $SITE_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "approach": "materialized_engine",
    "target": "docker_compose",
    "env": {
      "CDC_PIPELINE_NAME": "catalog-analytics",
      "SOURCE_DATABASE_URL": "postgresql://cdc_user:secret@postgres:5432/lumibase",
      "CLICKHOUSE_SINK_URL": "clickhouse://clickhouse:9000/analytics",
      "CDC_REPLICATION_TABLES": "public.products,public.categories"
    }
  }'
```

Output mong đợi:

```json
{ "data": { "valid": true } }
```

## Bước 3: Đăng ký pipeline

```bash
curl -sS -X POST https://your-cms-host/api/v1/cdc/pipelines \
  -H "Authorization: Bearer $LUMI_ADMIN_TOKEN" \
  -H "X-Lumi-Site: $SITE_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "pipeline_name": "catalog-analytics",
    "cdc_connector_type": "materialized_engine",
    "source_database_connection": "postgresql://cdc_user:secret@postgres:5432/lumibase",
    "clickhouse_sink_connection": "clickhouse://clickhouse:9000/analytics",
    "replication_tables": ["public.products", "public.categories"]
  }'
```

Registry chạy một lượt kiểm tra kết nối 10 giây tới source và sink, rồi trả về pipeline kèm một id dạng `nanoid`.

## Bước 4: Khởi động replication

```bash
curl -sS -X POST https://your-cms-host/api/v1/cdc/pipelines/$PIPELINE_ID/start \
  -H "Authorization: Bearer $LUMI_ADMIN_TOKEN" \
  -H "X-Lumi-Site: $SITE_ID"
```

ClickHouse tạo một database `MaterializedPostgreSQL` (`MATERIALIZED_DATABASE_NAME`), gắn vào replication slot, và tự động tạo một table ClickHouse cho mỗi table được replicate — map tên cột và kiểu của PostgreSQL sang tương đương trong ClickHouse (Requirement 3.3). Một table mới được thêm vào sẽ được materialize trong vòng 60 giây (Requirement 3.3).

## Bước 5: Verify

Chạy một lượt health check:

```bash
curl -sS https://your-cms-host/api/v1/cdc/pipelines/$PIPELINE_ID/health \
  -H "Authorization: Bearer $LUMI_ADMIN_TOKEN" \
  -H "X-Lumi-Site: $SITE_ID"
```

Output mong đợi:

```json
{
  "data": {
    "healthy": true,
    "services": [
      { "service": "source_database", "reachable": true },
      { "service": "clickhouse_sink", "reachable": true }
    ],
    "checkedAt": "2025-01-15T10:30:00.000Z"
  }
}
```

Xác nhận các table được replicate đã tồn tại và replication slot đang active:

```bash
# ClickHouse: liệt kê các table replicate được tạo tự động
clickhouse-client --query "SHOW TABLES FROM lumibase_cdc_mat"

# PostgreSQL: xác nhận slot đang active
psql "$SOURCE_DATABASE_URL" -c \
  "SELECT slot_name, active FROM pg_replication_slots WHERE slot_name = 'lumibase_mat';"
```

## Cách tiếp cận này hành xử thế nào

- **Replication lag** — giữ ở mức ≤ 10 giây trong điều kiện bình thường (Requirement 3.2).
- **Kết nối bị ngắt** — kết nối lại theo exponential backoff (bắt đầu từ `MATERIALIZED_RECONNECT_BASE_DELAY_MS`, mặc định 1000ms) tối đa `MATERIALIZED_RECONNECT_MAX_RETRIES` lần (mặc định 5), tiếp tục từ LSN được xác nhận gần nhất (Requirement 3.4). Sau khi hết số lần retry, pipeline chuyển sang `error` kèm lý do lỗi kết nối và thời lượng mất kết nối (Requirement 3.5).
- **Schema drift** — một thay đổi schema ở source (thêm/bỏ cột, đổi kiểu) được phát hiện trong vòng `MATERIALIZED_SCHEMA_DRIFT_INTERVAL_MS` (mặc định 60000ms) và đặt pipeline sang `error` kèm table bị ảnh hưởng và loại thay đổi (Requirement 3.6).
- **Xoá** — xoá pipeline sẽ detach database `MaterializedPostgreSQL` và drop replication slot của PostgreSQL (Requirement 1.8).

Về xử lý sự cố, xem [hướng dẫn Troubleshooting](./troubleshooting.md).

## Bước tiếp theo

- [Environment Variables — Materialized Engine](./environment-variables.md#materialized-engine-docker_compose)
- [Deployment — Docker Compose / managed services](./deployment-docker-compose.md)
- [Troubleshooting](./troubleshooting.md)
