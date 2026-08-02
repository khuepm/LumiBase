---
title: Deployment — Docker Compose / Managed Services
version: 1
lastUpdated: 2026-07-28T11:36:50.546Z
sourceLang: en
translatedFrom: en
sourceHash: a6feffea289e31e4
mtEngine: claude
syncStatus: machine-translated
codeVerified: 2026-07-28T11:36:50.546Z
codeVerifiedHash: a6feffea289e31e4
codeVerifiedClaims: 14
---

# Hướng dẫn deploy: Docker Compose / Managed Services (toàn bộ stack có state)

Hướng dẫn này deploy **toàn bộ stack CDC có state** — Kafka Broker, Debezium Connector, ClickHouse Sink, Materialized Engine, và Airbyte Connector — dùng Docker Compose trên một network chung, hoặc các managed service bên ngoài (Confluent Cloud, ClickHouse Cloud, Airbyte Cloud). Nó tương ứng với deployment target `docker_compose` và đáp ứng phần stack có state của **Requirement 9.4**.

> Chỉ những service mà cách tiếp cận bạn chọn cần đến sẽ được provision. Debezium+Kafka cần Kafka + Debezium + ClickHouse; Materialized Engine chỉ cần ClickHouse; Airbyte cần nền tảng Airbyte + ClickHouse. Xem [Chọn một cách tiếp cận](./README.md#decision-criteria-choosing-an-approach).

## Điều kiện tiên quyết

- Docker Engine 24+ và Docker Compose v2 (nếu self-host), **hoặc** account cho các bản managed tương đương (Confluent Cloud / ClickHouse Cloud / Airbyte Cloud).
- Một Source_Database PostgreSQL đã bật logical replication (`wal_level = logical`, một role `REPLICATION`, và `max_replication_slots` / `max_wal_senders` đủ dùng).
- Một LumiBase CMS đang chạy với module CDC đã bật, cùng một admin token + site id cho `/api/v1/cdc`.
- Các service kết nối được với nhau trên một private network chung (hoặc firewall rule / VPC peering đúng cho managed service). Đừng phơi Kafka, Debezium Connect, ClickHouse, hay Airbyte trực tiếp ra Internet hoặc các LAN không tin cậy.

## Bước 1: Cấu hình biến môi trường

Tạo một `.env` cho stack, dùng [tham chiếu Environment Variables](./environment-variables.md) cho cách tiếp cận của bạn + target `docker_compose`. Ví dụ cho Debezium + Kafka:

```bash
CDC_PIPELINE_NAME=orders-analytics
CDC_APPROACH=debezium_kafka
CDC_DEPLOYMENT_TARGET=docker_compose
SOURCE_DATABASE_URL=postgresql://cdc_user:secret@postgres:5432/lumibase
CLICKHOUSE_SINK_URL=clickhouse://clickhouse:9000/analytics
CLICKHOUSE_DATABASE=analytics
CDC_REPLICATION_TABLES=public.orders,public.customers
KAFKA_BOOTSTRAP_SERVERS=kafka:9092
DEBEZIUM_CONNECT_URL=http://debezium:8083
```

## Bước 2: Định nghĩa stack Docker Compose

Các service cùng port/dependency của chúng đến từ service catalog của config generator. Một stack Debezium+Kafka tối giản như dưới đây.

> **Mặc định về bảo mật:** các port CDC được publish chỉ ở loopback (`127.0.0.1`) để operator truy cập cục bộ. Docker Compose bind các port dạng ngắn như `9092:9092` trên mọi interface của host; đừng dùng dạng đó cho Kafka, Debezium Connect, ClickHouse, hay Airbyte. Nếu LumiBase và các container CDC chạy trên cùng network Compose, hãy bỏ hẳn các entry `ports` và dùng hostname container-tới-container như `kafka:9092` và `debezium:8083`. Để truy cập từ xa, hãy đặt các service này sau một VPC/VPN/firewall riêng và bật các cơ chế xác thực, TLS, SASL, ACL của chính service đó trước khi mở bất kỳ port nào.

```yaml
# docker-compose.cdc.yml
services:
  kafka:
    image: confluentinc/cp-kafka:7.6.0
    ports: ["127.0.0.1:9092:9092"]
    networks: [cdc]

  debezium:
    image: debezium/connect:2.6
    ports: ["127.0.0.1:8083:8083"]
    depends_on: [kafka]
    environment:
      BOOTSTRAP_SERVERS: kafka:9092
      GROUP_ID: lumibase-cdc
      CONFIG_STORAGE_TOPIC: lumibase_cdc_configs
      OFFSET_STORAGE_TOPIC: lumibase_cdc_offsets
      STATUS_STORAGE_TOPIC: lumibase_cdc_status
    networks: [cdc]

  clickhouse:
    image: clickhouse/clickhouse-server:24.3
    ports: ["127.0.0.1:8123:8123", "127.0.0.1:9000:9000"]
    networks: [cdc]

networks:
  cdc:
    driver: bridge
```

Với cách tiếp cận **Materialized Engine**, chỉ cần service `clickhouse`. Với **Airbyte**, thay Kafka/Debezium bằng service `airbyte/server:0.63.0` ở container port 8001, và chỉ publish nó dưới dạng `127.0.0.1:8001:8001` khi cần truy cập từ host cục bộ. Image của service, container port, và thứ tự khởi động khớp với `STATEFUL_SERVICES_BY_APPROACH` trong `apps/cms/src/modules/cdc/ai-flow/config-generator.ts`.

| Cách tiếp cận | Services | Images | Container port (chỉ loopback nếu publish) |
|----------|----------|--------|---------------------------------------------|
| Debezium + Kafka | kafka_broker, debezium_connector, clickhouse_sink | `confluentinc/cp-kafka:7.6.0`, `debezium/connect:2.6`, `clickhouse/clickhouse-server:24.3` | 9092, 8083, 8123/9000 |
| Materialized Engine | clickhouse_sink (+ materialized_engine chạy bên trong ClickHouse) | `clickhouse/clickhouse-server:24.3` | 8123/9000 |
| Airbyte | airbyte_connector, clickhouse_sink | `airbyte/server:0.63.0`, `clickhouse/clickhouse-server:24.3` | 8001, 8123/9000 |

## Bước 3: Khởi động stack

```bash
docker compose -f docker-compose.cdc.yml --env-file .env up -d
docker compose -f docker-compose.cdc.yml ps
```

> **Phương án managed service:** thay vì chạy các container này, hãy trỏ `KAFKA_BOOTSTRAP_SERVERS` tới Confluent Cloud, `CLICKHOUSE_SINK_URL` tới ClickHouse Cloud, và `AIRBYTE_API_URL` tới Airbyte Cloud. Hãy bắt buộc dùng private networking hoặc IP allow-list, cộng với xác thực/TLS của provider cho từng managed endpoint. Các bước còn lại là như nhau.

## Bước 4: Deploy qua AI Flow Engine (khuyến nghị)

Hãy để AI Flow Engine provision và sắp thứ tự các service cho bạn. Nó thực hiện deploy theo từng bước và một lượt health check kết nối sau khi deploy (Requirements 7.2, 7.3, 7.7):

```bash
curl -sS -X POST https://your-cms-host/api/v1/cdc/deploy \
  -H "Authorization: Bearer $LUMI_ADMIN_TOKEN" \
  -H "X-Lumi-Site: $SITE_ID" \
  -H "Content-Type: application/json" \
  -d '{ "approach": "debezium_kafka", "target": "docker_compose" }'
```

Nếu một bước thất bại, orchestrator rollback mọi bước đã hoàn tất trước đó theo thứ tự ngược, trong vòng 60 giây, và báo bước thất bại, loại lỗi, cùng mô tả (Requirement 7.6).

## Bước 5: Đăng ký và khởi động một pipeline

Hãy làm theo hướng dẫn setup riêng cho từng cách tiếp cận để đăng ký và khởi động pipeline trên stack này:

- [Debezium + Kafka](./setup-debezium-kafka.md)
- [Materialized Engine](./setup-materialized-engine.md)
- [Airbyte](./setup-airbyte.md)

## Verification

### Lệnh verify

Response của lần deploy có kèm báo cáo sức khoẻ theo từng service. Để verify lại bất cứ lúc nào, hãy chạy một lượt health check pipeline:

```bash
curl -sS https://your-cms-host/api/v1/cdc/pipelines/$PIPELINE_ID/health \
  -H "Authorization: Bearer $LUMI_ADMIN_TOKEN" \
  -H "X-Lumi-Site: $SITE_ID"
```

### Output mong đợi

Mọi service đã provision đều báo kết nối được (ví dụ Debezium+Kafka):

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

Response `/deploy` cho một lần deploy thành công trông như thế này:

```json
{
  "data": {
    "deploymentId": "9bX2_qE7tA0",
    "approach": "debezium_kafka",
    "target": "docker_compose",
    "status": "completed",
    "health": {
      "passed": true,
      "services": [
        { "service": "kafka_broker", "reachable": true },
        { "service": "debezium_connector", "reachable": true },
        { "service": "clickhouse_sink", "reachable": true }
      ]
    }
  }
}
```

Bạn cũng có thể verify các service nền trực tiếp từ Docker host, nếu bạn vẫn giữ các binding port chỉ-loopback ở trên:

```bash
# ClickHouse kết nối được
curl -sS http://localhost:8123/ping            # → Ok.

# Debezium Kafka Connect kết nối được
curl -sS http://localhost:8083/connectors      # → [] hoặc một danh sách connector

# Các Kafka topic đã được tạo (một cho mỗi table được replicate)
kafka-topics.sh --bootstrap-server localhost:9092 --list | grep lumibase_cdc
```

## Cập nhật và tháo bỏ

```bash
# Cập nhật image rồi restart
docker compose -f docker-compose.cdc.yml pull
docker compose -f docker-compose.cdc.yml up -d

# Tháo bỏ (xoá pipeline trước để các replication slot được drop — Req 1.8)
curl -sS -X DELETE https://your-cms-host/api/v1/cdc/pipelines/$PIPELINE_ID \
  -H "Authorization: Bearer $LUMI_ADMIN_TOKEN" -H "X-Lumi-Site: $SITE_ID"
docker compose -f docker-compose.cdc.yml down
```

> Hãy luôn xoá pipeline qua API trước khi tháo stack, để các replication slot của PostgreSQL được giải phóng; nếu không Source_Database sẽ giữ lại các file WAL.

## Bước tiếp theo

- [Bản deploy edge trên Cloudflare Workers](./deployment-cloudflare-workers.md) — deploy các thành phần edge đứng trước stack này
- [Troubleshooting](./troubleshooting.md)
- [Environment Variables](./environment-variables.md)
