---
title: Setup — Debezium + Kafka
version: 1
lastUpdated: 2026-07-28T10:30:25.426Z
sourceLang: en
translatedFrom: en
sourceHash: 55b2746cb07ab931
mtEngine: claude
syncStatus: machine-translated
codeVerified: 2026-07-28T10:30:25.426Z
codeVerifiedHash: 55b2746cb07ab931
codeVerifiedClaims: 16
---

# Hướng dẫn setup: Debezium + Kafka

Cách tiếp cận Debezium + Kafka (`debezium_kafka`) đọc write-ahead log (WAL) của PostgreSQL bằng Debezium và publish các event INSERT/UPDATE/DELETE lên các Kafka topic được phân vùng theo table. ClickHouse ingest các topic đó qua Kafka table engine. Hãy chọn cách này cho các workload **throughput cao (> 10.000 row/s)** hoặc **độ trễ rất thấp (< 5s)**.

> Hướng dẫn này cấu hình bản thân connector. Để dựng các service nền (Kafka, Debezium, ClickHouse), hãy làm theo [hướng dẫn deploy Docker Compose / managed services](./deployment-docker-compose.md) trước.

## Điều kiện tiên quyết

- Một Source_Database PostgreSQL đã bật logical replication:
  - `wal_level = logical`
  - Một role có thuộc tính `REPLICATION`
  - `max_replication_slots` và `max_wal_senders` ≥ 1 (cho mỗi pipeline)
- Một Kafka Broker kết nối được (self-hosted hoặc Confluent Cloud).
- Một worker Debezium / Kafka Connect kết nối được tới cả PostgreSQL và Kafka.
- Một ClickHouse Sink kết nối được, có sẵn Kafka table engine.
- Quyền admin trên LumiBase CMS (`/api/v1/cdc` bị chặn ở mức admin và scope theo site).

## Bước 1: Chuẩn bị PostgreSQL

Xác nhận logical replication đã bật và tạo một publication cho các table bạn muốn replicate:

```sql
-- Kiểm tra WAL level (phải trả về 'logical')
SHOW wal_level;

-- Tạo publication cho các table được replicate
CREATE PUBLICATION lumibase_cdc_pub FOR TABLE public.orders, public.customers;
```

Debezium tự tạo replication slot của nó (tên mặc định `lumibase_debezium`) ở lần start đầu tiên; bạn không cần tạo slot thủ công.

## Bước 2: Đặt các biến môi trường

Cấu hình các biến của Debezium+Kafka được mô tả trong [tham chiếu Environment Variables](./environment-variables.md#debezium--kafka-docker_compose). Tối thiểu:

```bash
CDC_PIPELINE_NAME=orders-analytics
CDC_APPROACH=debezium_kafka
CDC_DEPLOYMENT_TARGET=docker_compose
SOURCE_DATABASE_URL=postgresql://cdc_user:secret@postgres:5432/lumibase
CLICKHOUSE_SINK_URL=clickhouse://clickhouse:9000/analytics
CDC_REPLICATION_TABLES=public.orders,public.customers
KAFKA_BOOTSTRAP_SERVERS=kafka:9092
DEBEZIUM_CONNECT_URL=http://debezium:8083
```

Validate các giá trị trước khi đăng ký pipeline:

```bash
curl -sS -X POST https://your-cms-host/api/v1/cdc/deploy/validate-env \
  -H "Authorization: Bearer $LUMI_ADMIN_TOKEN" \
  -H "X-Lumi-Site: $SITE_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "approach": "debezium_kafka",
    "target": "docker_compose",
    "env": {
      "CDC_PIPELINE_NAME": "orders-analytics",
      "SOURCE_DATABASE_URL": "postgresql://cdc_user:secret@postgres:5432/lumibase",
      "CLICKHOUSE_SINK_URL": "clickhouse://clickhouse:9000/analytics",
      "CDC_REPLICATION_TABLES": "public.orders,public.customers",
      "KAFKA_BOOTSTRAP_SERVERS": "kafka:9092",
      "DEBEZIUM_CONNECT_URL": "http://debezium:8083"
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
    "pipeline_name": "orders-analytics",
    "cdc_connector_type": "debezium_kafka",
    "source_database_connection": "postgresql://cdc_user:secret@postgres:5432/lumibase",
    "clickhouse_sink_connection": "clickhouse://clickhouse:9000/analytics",
    "intermediary_connection": "kafka://kafka:9092",
    "replication_tables": ["public.orders", "public.customers"]
  }'
```

Registry chạy một lượt kiểm tra kết nối (timeout 10s) tới source và sink, rồi trả về pipeline mới kèm một id dạng `nanoid` và `status: "provisioning"`.

## Bước 4: Khởi động replication

```bash
curl -sS -X POST https://your-cms-host/api/v1/cdc/pipelines/$PIPELINE_ID/start \
  -H "Authorization: Bearer $LUMI_ADMIN_TOKEN" \
  -H "X-Lumi-Site: $SITE_ID"
```

Debezium đăng ký connector, tạo một Kafka topic cho mỗi table (có tiền tố `KAFKA_TOPIC_PREFIX`, mặc định `lumibase_cdc`), và ClickHouse bắt đầu ingest qua Kafka table engine.

## Bước 5: Verify

Chạy một lượt health check:

```bash
curl -sS https://your-cms-host/api/v1/cdc/pipelines/$PIPELINE_ID/health \
  -H "Authorization: Bearer $LUMI_ADMIN_TOKEN" \
  -H "X-Lumi-Site: $SITE_ID"
```

Output mong đợi (mọi service đã provision đều kết nối được):

```json
{
  "data": {
    "healthy": true,
    "services": [
      { "service": "source_database", "reachable": true },
      { "service": "kafka_broker", "reachable": true },
      { "service": "clickhouse_sink", "reachable": true }
    ],
    "checkedAt": "2025-01-15T10:30:00.000Z"
  }
}
```

Xác nhận các topic đã được tạo và dữ liệu đang chảy vào ClickHouse:

```bash
# Các Kafka topic (một cho mỗi table được replicate)
kafka-topics.sh --bootstrap-server kafka:9092 --list | grep lumibase_cdc

# Số row ở target ClickHouse
clickhouse-client --query "SELECT count() FROM analytics.orders"
```

## Cách tiếp cận này hành xử thế nào

- **Định tuyến topic** — mỗi table map sang một tên topic tất định và duy nhất (Requirement 2.2).
- **Kafka mất kết nối** — event được buffer cục bộ tối đa 1 giờ / 500 MB và được replay đúng thứ tự khi phục hồi (Requirement 2.4); xem `KAFKA_BUFFER_MAX_AGE_MS` / `KAFKA_BUFFER_MAX_BYTES`.
- **ClickHouse mất kết nối** — event được giữ lại trên các Kafka topic và việc ingest tiếp tục đúng thứ tự khi ClickHouse kết nối lại được (Requirement 2.6).
- **Replication slot lỗi** — sau `DEBEZIUM_MAX_SLOT_FAILURES` lần lỗi liên tiếp (mặc định 3), status của pipeline chuyển thành `error` kèm lý do thất bại (Requirement 2.5).
- **Xoá** — xoá pipeline sẽ drop replication slot của PostgreSQL để các file WAL không bị giữ lại (Requirement 1.8).

Về xử lý sự cố, xem [hướng dẫn Troubleshooting](./troubleshooting.md).

## Bước tiếp theo

- [Environment Variables — Debezium + Kafka](./environment-variables.md#debezium--kafka-docker_compose)
- [Deployment — Docker Compose / managed services](./deployment-docker-compose.md)
- [Troubleshooting](./troubleshooting.md)
