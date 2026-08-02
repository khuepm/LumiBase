---
title: CDC Environment Variables
version: 1
lastUpdated: 2026-07-28T11:36:50.940Z
sourceLang: en
translatedFrom: en
sourceHash: 33f9bb09f337356a
mtEngine: claude
syncStatus: machine-translated
codeVerified: 2026-07-28T11:36:50.940Z
codeVerifiedHash: 33f9bb09f337356a
codeVerifiedClaims: 60
---

# Biến môi trường CDC

Đây là tham chiếu biến môi trường theo từng cách tiếp cận cho hệ thống ClickHouse CDC, kèm mô tả, giá trị mặc định, quy tắc validation, cùng một ví dụ cấu hình đầy đủ chạy được cho mỗi cách tiếp cận. Nó đáp ứng **Requirement 9.3**.

Các định nghĩa này được sinh ra từ, và phải luôn nhất quán với, `apps/cms/src/modules/cdc/ai-flow/config-generator.ts` (hàm `generateConfig(approach, target)`). Nếu bạn đổi một biến ở đó, hãy cập nhật trang này trong cùng thay đổi. Mọi key đều khớp pattern `^[A-Z_][A-Z0-9_]*$`.

Các biến bạn cần phụ thuộc vào hai trục:

- **approach** — `debezium_kafka`, `materialized_engine`, hoặc `airbyte`.
- **target** — `docker_compose` (toàn bộ stack có state) hoặc `cloudflare_workers` (chỉ các thành phần edge).

Bạn có thể lấy đúng tập biến cho bất kỳ tổ hợp nào từ API:

```bash
curl -sS -X POST https://your-cms-host/api/v1/cdc/deploy/validate-env \
  -H "Authorization: Bearer $LUMI_ADMIN_TOKEN" -H "X-Lumi-Site: $SITE_ID" \
  -H "Content-Type: application/json" \
  -d '{"approach":"debezium_kafka","target":"docker_compose","env":{}}'
# → 400 ENV_VALIDATION_ERROR liệt kê mọi biến bắt buộc còn thiếu
```

---

## Biến chung (mọi cách tiếp cận và mọi target)

Các biến định danh này luôn có mặt, để hai nửa của một bản deploy bị chia tách có thể đối chiếu được với nhau.

| Biến | Mô tả | Mặc định | Bắt buộc | Quy tắc validation |
|----------|-------------|---------|----------|-----------------|
| `CDC_PIPELINE_NAME` | Tên dễ đọc của CDC pipeline mà bản deploy này phục vụ. | — | Có | Chuỗi không rỗng, tối đa 128 ký tự |
| `CDC_APPROACH` | Cách tiếp cận replication CDC mà bản deploy này hiện thực. | `<approach>` | Có | Một trong: `debezium_kafka`, `materialized_engine`, `airbyte` |
| `CDC_DEPLOYMENT_TARGET` | Deployment target đang host các thành phần này. | `<target>` | Có | Một trong: `docker_compose`, `cloudflare_workers` |

---

## Stack có state — biến chung (`docker_compose`)

Dùng chung cho cả ba cách tiếp cận khi target là `docker_compose`.

| Biến | Mô tả | Mặc định | Bắt buộc | Quy tắc validation |
|----------|-------------|---------|----------|-----------------|
| `SOURCE_DATABASE_URL` | Connection string của Source_Database PostgreSQL mà connector replicate từ đó. | — | Có | URL kết nối `postgres://` hoặc `postgresql://` hợp lệ |
| `CLICKHOUSE_SINK_URL` | Connection string của ClickHouse_Sink nhận dữ liệu được replicate. | — | Có | URL kết nối `clickhouse://`, `http://`, hoặc `https://` hợp lệ |
| `CLICKHOUSE_DATABASE` | Tên database ClickHouse chứa các table được replicate. | `default` | Không | Chuỗi không rỗng |
| `CDC_REPLICATION_TABLES` | Danh sách các table PostgreSQL đầy đủ tên, cách nhau bằng dấu phẩy, cần replicate. | — | Có | Danh sách một hoặc nhiều tên table, cách nhau bằng dấu phẩy |

---

## Debezium + Kafka (`docker_compose`)

Các biến chung + biến chung của stack có state (ở trên), cộng thêm:

| Biến | Mô tả | Mặc định | Bắt buộc | Quy tắc validation |
|----------|-------------|---------|----------|-----------------|
| `KAFKA_BOOTSTRAP_SERVERS` | Các bootstrap server của Kafka_Broker, cách nhau bằng dấu phẩy (`host:port`). | `kafka:9092` | Có | Danh sách các entry `host:port`, cách nhau bằng dấu phẩy |
| `DEBEZIUM_CONNECT_URL` | Endpoint REST của Debezium Kafka Connect, dùng để đăng ký connector. | `http://debezium:8083` | Có | URL `http://` hoặc `https://` hợp lệ |
| `KAFKA_TOPIC_PREFIX` | Tiền tố áp cho các Kafka topic theo từng table do Debezium tạo. | `lumibase_cdc` | Không | Chuỗi không rỗng |
| `DEBEZIUM_SLOT_NAME` | Tên replication slot của PostgreSQL mà Debezium tạo trên Source_Database. | `lumibase_debezium` | Không | Chuỗi không rỗng |
| `DEBEZIUM_PUBLICATION_NAME` | Tên publication của PostgreSQL mà Debezium dùng cho logical replication. | `lumibase_cdc_pub` | Không | Chuỗi không rỗng |
| `KAFKA_BUFFER_MAX_BYTES` | Cap kích cỡ buffer cục bộ (byte) được giữ khi Kafka mất kết nối. | `524288000` | Không | Số nguyên dương (≥ 1) |
| `KAFKA_BUFFER_MAX_AGE_MS` | Tuổi tối đa (ms) của các event buffer cục bộ khi Kafka mất kết nối. | `3600000` | Không | Số nguyên dương (≥ 1) |
| `DEBEZIUM_MAX_SLOT_FAILURES` | Số lần lỗi replication slot liên tiếp được chấp nhận trước khi pipeline bị đánh dấu `error`. | `3` | Không | Số nguyên dương (≥ 1) |

### Ví dụ cấu hình đầy đủ chạy được — Debezium + Kafka

```bash
# Chung
CDC_PIPELINE_NAME=orders-analytics
CDC_APPROACH=debezium_kafka
CDC_DEPLOYMENT_TARGET=docker_compose

# Chung của stack có state
SOURCE_DATABASE_URL=postgresql://cdc_user:secret@postgres:5432/lumibase
CLICKHOUSE_SINK_URL=clickhouse://clickhouse:9000/analytics
CLICKHOUSE_DATABASE=analytics
CDC_REPLICATION_TABLES=public.orders,public.customers

# Debezium + Kafka
KAFKA_BOOTSTRAP_SERVERS=kafka:9092
DEBEZIUM_CONNECT_URL=http://debezium:8083
KAFKA_TOPIC_PREFIX=lumibase_cdc
DEBEZIUM_SLOT_NAME=lumibase_debezium
DEBEZIUM_PUBLICATION_NAME=lumibase_cdc_pub
KAFKA_BUFFER_MAX_BYTES=524288000
KAFKA_BUFFER_MAX_AGE_MS=3600000
DEBEZIUM_MAX_SLOT_FAILURES=3
```

---

## Materialized Engine (`docker_compose`)

Các biến chung + biến chung của stack có state (ở trên), cộng thêm:

| Biến | Mô tả | Mặc định | Bắt buộc | Quy tắc validation |
|----------|-------------|---------|----------|-----------------|
| `MATERIALIZED_DATABASE_NAME` | Tên database `MaterializedPostgreSQL` của ClickHouse được tạo cho việc replicate. | `lumibase_cdc_mat` | Không | Chuỗi không rỗng |
| `MATERIALIZED_SLOT_NAME` | Tên replication slot của PostgreSQL mà Materialized Engine sở hữu. | `lumibase_mat` | Không | Chuỗi không rỗng |
| `MATERIALIZED_RECONNECT_MAX_RETRIES` | Số lần thử kết nối lại tối đa trước khi báo lỗi. | `5` | Không | Số nguyên dương (≥ 1) |
| `MATERIALIZED_RECONNECT_BASE_DELAY_MS` | Độ trễ exponential-backoff ban đầu (ms) khi kết nối lại. | `1000` | Không | Số nguyên dương (≥ 1) |
| `MATERIALIZED_SCHEMA_DRIFT_INTERVAL_MS` | Khoảng thời gian (ms) giữa các lần kiểm tra schema drift ở source. | `60000` | Không | Số nguyên dương (≥ 1) |

### Ví dụ cấu hình đầy đủ chạy được — Materialized Engine

```bash
# Chung
CDC_PIPELINE_NAME=catalog-analytics
CDC_APPROACH=materialized_engine
CDC_DEPLOYMENT_TARGET=docker_compose

# Chung của stack có state
SOURCE_DATABASE_URL=postgresql://cdc_user:secret@postgres:5432/lumibase
CLICKHOUSE_SINK_URL=clickhouse://clickhouse:9000/analytics
CLICKHOUSE_DATABASE=analytics
CDC_REPLICATION_TABLES=public.products,public.categories

# Materialized Engine
MATERIALIZED_DATABASE_NAME=lumibase_cdc_mat
MATERIALIZED_SLOT_NAME=lumibase_mat
MATERIALIZED_RECONNECT_MAX_RETRIES=5
MATERIALIZED_RECONNECT_BASE_DELAY_MS=1000
MATERIALIZED_SCHEMA_DRIFT_INTERVAL_MS=60000
```

---

## Airbyte (`docker_compose`)

Các biến chung + biến chung của stack có state (ở trên), cộng thêm:

| Biến | Mô tả | Mặc định | Bắt buộc | Quy tắc validation |
|----------|-------------|---------|----------|-----------------|
| `AIRBYTE_API_URL` | Base URL của Airbyte_Connector API, dùng để provision source/destination/connection. | `http://airbyte:8001/api` | Có | URL `http://` hoặc `https://` hợp lệ |
| `AIRBYTE_WORKSPACE_ID` | Workspace ID của Airbyte sở hữu các tài nguyên được provision. | — | Có | Chuỗi không rỗng |
| `AIRBYTE_SYNC_MODE` | Sync mode của Airbyte cho connection này. | `incremental_cdc` | Không | Một trong: `full_refresh`, `incremental_cdc` |
| `AIRBYTE_SYNC_INTERVAL_SECONDS` | Interval của lịch sync, tính bằng giây; enforce mức tối thiểu 5 phút của Airbyte. | `300` | Không | Số nguyên từ 300 đến 86400 (bao gồm hai đầu) |
| `AIRBYTE_PROVISION_TIMEOUT_MS` | Timeout (ms) cho việc provision các tài nguyên Airbyte. | `120000` | Không | Số nguyên dương (≥ 1) |
| `AIRBYTE_SYNC_MAX_RETRIES` | Số lần một lần sync thất bại được retry kèm backoff. | `3` | Không | Số nguyên dương (≥ 1) |

### Ví dụ cấu hình đầy đủ chạy được — Airbyte

```bash
# Chung
CDC_PIPELINE_NAME=reporting-sync
CDC_APPROACH=airbyte
CDC_DEPLOYMENT_TARGET=docker_compose

# Chung của stack có state
SOURCE_DATABASE_URL=postgresql://cdc_user:secret@postgres:5432/lumibase
CLICKHOUSE_SINK_URL=clickhouse://clickhouse:9000/analytics
CLICKHOUSE_DATABASE=analytics
CDC_REPLICATION_TABLES=public.invoices,public.payments

# Airbyte
AIRBYTE_API_URL=http://airbyte:8001/api
AIRBYTE_WORKSPACE_ID=00000000-0000-0000-0000-000000000000
AIRBYTE_SYNC_MODE=incremental_cdc
AIRBYTE_SYNC_INTERVAL_SECONDS=300
AIRBYTE_PROVISION_TIMEOUT_MS=120000
AIRBYTE_SYNC_MAX_RETRIES=3
```

---

## Thành phần edge (`cloudflare_workers`)

Khi target là `cloudflare_workers`, bản deploy **chỉ** gồm các biến chung cộng các biến edge bên dưới. Các biến kết nối của phần có state (`SOURCE_DATABASE_URL`, `CLICKHOUSE_SINK_URL`, các biến Kafka/Materialized/Airbyte) **không** thuộc một bản deploy Workers — chúng nằm ở bản deploy `docker_compose`/managed-services đi kèm, được truy cập qua HTTPS. Các biến edge là như nhau với cả ba cách tiếp cận.

| Biến | Mô tả | Mặc định | Bắt buộc | Quy tắc validation |
|----------|-------------|---------|----------|-----------------|
| `CDC_STATEFUL_STACK_URL` | Endpoint HTTPS của bản deploy có state `docker_compose`/managed-services đi kèm, nơi runtime Workers nói chuyện tới. | — | Có | URL kết nối `https://` hợp lệ (runtime Workers bắt buộc HTTPS) |
| `CDC_API_AUTH_TOKEN` | Bearer token bảo vệ các endpoint control-plane CDC mà Worker phơi ra. | — | Có | Chuỗi không rỗng |
| `REDIS_URL` | Connection string Redis mà Cache_Invalidator refresh. | — | Có | URL kết nối `redis://` hoặc `rediss://` hợp lệ |
| `CACHE_KEY_NAMESPACE` | Tiền tố namespace key của CacheProvider, dùng khi dẫn xuất cache key. | `lumibase` | Không | Chuỗi không rỗng |
| `CACHE_INVALIDATOR_QUEUE_MAX` | Kích cỡ queue có giới hạn để buffer event khi Redis mất kết nối. | `10000` | Không | Số nguyên dương (≥ 1) |
| `CACHE_INVALIDATOR_DEDUP_WINDOW_MS` | Cửa sổ dedupe (ms) để gộp các event UPDATE liên tiếp cho cùng một key. | `1000` | Không | Số nguyên dương (≥ 1) |

### Ví dụ cấu hình đầy đủ chạy được — edge trên Cloudflare Workers

```bash
# Chung (approach phải khớp với bản deploy có state đi kèm)
CDC_PIPELINE_NAME=orders-analytics
CDC_APPROACH=debezium_kafka
CDC_DEPLOYMENT_TARGET=cloudflare_workers

# Thành phần edge
CDC_STATEFUL_STACK_URL=https://cdc-stack.internal.example.com
CDC_API_AUTH_TOKEN=replace-with-a-strong-random-token
REDIS_URL=rediss://default:token@us1-abc-12345.upstash.io:6379
CACHE_KEY_NAMESPACE=lumibase
CACHE_INVALIDATOR_QUEUE_MAX=10000
CACHE_INVALIDATOR_DEDUP_WINDOW_MS=1000
```

> **Bảo mật:** `CDC_API_AUTH_TOKEN` và các credential nhúng trong `REDIS_URL` / `CDC_STATEFUL_STACK_URL` là secret. Trên Cloudflare Workers, hãy đặt chúng bằng `wrangler secret put` thay vì commit vào `wrangler.toml`. Control-plane API của CDC bị chặn ở mức admin; đừng bao giờ phơi nó ra khi chưa có `CDC_API_AUTH_TOKEN`.

## Hành vi validation

Khi bạn gửi các giá trị env (qua `/deploy` hoặc `/deploy/validate-env`), mỗi giá trị được kiểm tra theo quy tắc ở trên. Giá trị không hợp lệ trả `400 ENV_VALIDATION_ERROR` kèm danh sách các field không hợp lệ và ràng buộc cụ thể bị vi phạm ở từng field (Requirements 7.4, 7.5). Mỗi entry trong `invalidFields` mang `key` gây lỗi, một định danh `rule` ngắn và ổn định (một trong `required`, `key_format`, `unknown_key`, `type`, `min_length`, `max_length`, `pattern`, `min`, `max`, `enum`, `url`, `protocol`), và một `reason` dễ đọc:

```json
{
  "errors": [
    {
      "code": "ENV_VALIDATION_ERROR",
      "message": "Environment variable validation failed.",
      "invalidFields": [
        { "key": "AIRBYTE_SYNC_INTERVAL_SECONDS", "rule": "max", "reason": "value must be <= 86400" }
      ]
    }
  ]
}
```

## Xem thêm

- [Tổng quan kiến trúc](./architecture.md)
- Hướng dẫn setup: [Debezium + Kafka](./setup-debezium-kafka.md) · [Materialized Engine](./setup-materialized-engine.md) · [Airbyte](./setup-airbyte.md)
- Hướng dẫn deploy: [Docker Compose / managed services](./deployment-docker-compose.md) · [Cloudflare Workers (chỉ edge)](./deployment-cloudflare-workers.md)
