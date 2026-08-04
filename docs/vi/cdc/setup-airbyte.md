---
title: Setup — Airbyte
version: 1
lastUpdated: 2026-07-28T10:30:25.123Z
sourceLang: en
translatedFrom: en
sourceHash: dca2d909753946f9
mtEngine: claude
syncStatus: machine-translated
codeVerified: 2026-07-28T10:30:25.123Z
codeVerifiedHash: dca2d909753946f9
codeVerifiedClaims: 12
---

# Hướng dẫn setup: Airbyte

Cách tiếp cận Airbyte (`airbyte`) provision một source Airbyte (PostgreSQL), một destination (ClickHouse), và một connection theo lịch, thông qua Airbyte API. Nó có ít hạ tầng phải vận hành nhất và lý tưởng khi bạn **thích dùng managed service** và ngân sách độ trễ của bạn chấp nhận được **sync theo lịch (5 phút tới 24 giờ)** thay vì streaming.

> Để dựng nền tảng Airbyte và ClickHouse, hãy làm theo [hướng dẫn deploy Docker Compose / managed services](./deployment-docker-compose.md) trước, hoặc dùng Airbyte Cloud.

## Điều kiện tiên quyết

- Một instance Airbyte kết nối được (self-hosted hoặc Airbyte Cloud) có quyền truy cập API.
- Một workspace ID của Airbyte.
- Một Source_Database PostgreSQL mà Airbyte kết nối tới được. Với sync mode incremental CDC, hãy bật logical replication (`wal_level = logical`) và một replication role, giống như các cách tiếp cận khác.
- Một ClickHouse Sink mà Airbyte kết nối tới được.
- Quyền admin trên LumiBase CMS.

## Bước 1: Ghi lại thông tin kết nối Airbyte của bạn

Bạn cần base URL của Airbyte API và workspace ID:

```bash
AIRBYTE_API_URL=http://airbyte:8001/api
AIRBYTE_WORKSPACE_ID=00000000-0000-0000-0000-000000000000
```

## Bước 2: Đặt các biến môi trường

Cấu hình các biến của Airbyte được mô tả trong [tham chiếu Environment Variables](./environment-variables.md#airbyte-docker_compose). Tối thiểu:

```bash
CDC_PIPELINE_NAME=reporting-sync
CDC_APPROACH=airbyte
CDC_DEPLOYMENT_TARGET=docker_compose
SOURCE_DATABASE_URL=postgresql://cdc_user:secret@postgres:5432/lumibase
CLICKHOUSE_SINK_URL=clickhouse://clickhouse:9000/analytics
CDC_REPLICATION_TABLES=public.invoices,public.payments
AIRBYTE_API_URL=http://airbyte:8001/api
AIRBYTE_WORKSPACE_ID=00000000-0000-0000-0000-000000000000
AIRBYTE_SYNC_MODE=incremental_cdc
AIRBYTE_SYNC_INTERVAL_SECONDS=300
```

> **Sync interval** phải nằm giữa **300 giây (5 phút)** và **86400 giây (24 giờ)**. Giá trị ngoài khoảng này bị từ chối kèm một lỗi validation (Requirements 4.3, 4.7).

Validate trước khi đăng ký:

```bash
curl -sS -X POST https://your-cms-host/api/v1/cdc/deploy/validate-env \
  -H "Authorization: Bearer $LUMI_ADMIN_TOKEN" \
  -H "X-Lumi-Site: $SITE_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "approach": "airbyte",
    "target": "docker_compose",
    "env": {
      "CDC_PIPELINE_NAME": "reporting-sync",
      "SOURCE_DATABASE_URL": "postgresql://cdc_user:secret@postgres:5432/lumibase",
      "CLICKHOUSE_SINK_URL": "clickhouse://clickhouse:9000/analytics",
      "CDC_REPLICATION_TABLES": "public.invoices,public.payments",
      "AIRBYTE_API_URL": "http://airbyte:8001/api",
      "AIRBYTE_WORKSPACE_ID": "00000000-0000-0000-0000-000000000000",
      "AIRBYTE_SYNC_INTERVAL_SECONDS": "300"
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
    "pipeline_name": "reporting-sync",
    "cdc_connector_type": "airbyte",
    "source_database_connection": "postgresql://cdc_user:secret@postgres:5432/lumibase",
    "clickhouse_sink_connection": "clickhouse://clickhouse:9000/analytics",
    "intermediary_connection": "http://airbyte:8001/api",
    "replication_tables": ["public.invoices", "public.payments"],
    "config": { "sync_mode": "incremental_cdc", "interval_seconds": 300 }
  }'
```

Khi start, connector provision source, destination và connection của Airbyte trong một timeout 120 giây (Requirement 4.1). Nếu việc provision thất bại hoặc vượt timeout, pipeline chuyển sang `error`, lý do được ghi lại, và mọi tài nguyên đã cấp một phần đều được giải phóng (Requirement 4.6).

## Bước 4: Khởi động replication

```bash
curl -sS -X POST https://your-cms-host/api/v1/cdc/pipelines/$PIPELINE_ID/start \
  -H "Authorization: Bearer $LUMI_ADMIN_TOKEN" \
  -H "X-Lumi-Site: $SITE_ID"
```

Airbyte chạy các sync job theo interval đã cấu hình. Ở mỗi lần sync thành công, Pipeline Registry cập nhật timestamp của lần sync gần nhất và số record (Requirement 4.5).

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
      { "service": "clickhouse_sink", "reachable": true },
      { "service": "airbyte_platform", "reachable": true }
    ],
    "checkedAt": "2025-01-15T10:30:00.000Z"
  }
}
```

Xác nhận lần sync gần nhất đã ghi được timestamp và số record:

```bash
curl -sS https://your-cms-host/api/v1/cdc/pipelines/$PIPELINE_ID \
  -H "Authorization: Bearer $LUMI_ADMIN_TOKEN" \
  -H "X-Lumi-Site: $SITE_ID"
```

Response bao gồm `lastSyncAt` và `lastSyncRecordCount`.

## Cách tiếp cận này hành xử thế nào

- **Sync mode** — hỗ trợ cả `full_refresh` và `incremental_cdc` (Requirement 4.2).
- **Sync interval** — được validate trong khoảng 5 phút–24 giờ (Requirements 4.3, 4.7).
- **Sync thất bại** — một lần sync lỗi được retry tối đa `AIRBYTE_SYNC_MAX_RETRIES` lần (mặc định 3) theo exponential backoff (bắt đầu từ 30s) trước khi pipeline chuyển sang `error` kèm lý do thất bại (Requirement 4.4).
- **Xoá** — cách tiếp cận này không dựa trên replication slot, nên xoá pipeline sẽ bỏ source/destination/connection của Airbyte mà không cần dọn replication slot của PostgreSQL.

Về xử lý sự cố, xem [hướng dẫn Troubleshooting](./troubleshooting.md).

## Bước tiếp theo

- [Environment Variables — Airbyte](./environment-variables.md#airbyte-docker_compose)
- [Deployment — Docker Compose / managed services](./deployment-docker-compose.md)
- [Troubleshooting](./troubleshooting.md)
