---
title: CDC Troubleshooting
version: 1
lastUpdated: 2026-07-28T11:32:43.008Z
sourceLang: en
translatedFrom: en
sourceHash: 554b71767fc0509f
mtEngine: claude
syncStatus: machine-translated
codeVerified: 2026-07-28T11:32:43.008Z
codeVerifiedHash: 554b71767fc0509f
codeVerifiedClaims: 36
---

# Xử lý sự cố CDC

Hướng dẫn này nói về các tình huống lỗi được định nghĩa trong Requirements 2–4 và các hành vi registration/health trong bảng Error Handling của bản design: **lỗi replication slot**, **lỗi kết nối**, **sync job thất bại**, và **schema drift**. Nó đáp ứng phần xử lý sự cố của **Requirement 9.1**.

Khi một pipeline vào trạng thái `error`, hãy kiểm tra nó trước:

```bash
curl -sS https://your-cms-host/api/v1/cdc/pipelines/$PIPELINE_ID \
  -H "Authorization: Bearer $LUMI_ADMIN_TOKEN" \
  -H "X-Lumi-Site: $SITE_ID"
```

Các field `status` và `statusMessage` mô tả sự cố. Studio CDC Panel hiện cùng thông tin đó kèm timestamp lỗi, thành phần nguồn, mô tả, và ít nhất một bước khắc phục (Requirement 6.4).

---

## 1. Lỗi replication slot

Áp dụng cho Debezium + Kafka và Materialized Engine (cả hai đều dựa trên replication slot).

### Triệu chứng: status pipeline là `error`, thông báo nhắc tới replication slot

- **Debezium**: sau `DEBEZIUM_MAX_SLOT_FAILURES` lần thất bại liên tiếp (mặc định 3) khi cố đẩy offset của slot, pipeline được đặt sang `error` và một notification critical được phát ra (Requirement 2.5).
- **Materialized Engine**: sau khi hết `MATERIALIZED_RECONNECT_MAX_RETRIES` lần thử kết nối lại (mặc định 5), pipeline được đặt sang `error` kèm lý do lỗi kết nối và thời lượng mất kết nối (Requirement 3.5).

### Chẩn đoán

```sql
-- Kiểm tra các replication slot và chúng đang tụt lại / inactive đến đâu
SELECT slot_name, active, restart_lsn,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained_wal
FROM pg_replication_slots;
```

### Nguyên nhân thường gặp và cách sửa

| Nguyên nhân | Cách sửa |
|-------|-----|
| Slot inactive trong khi WAL tích tụ (đĩa đầy dần) | Restart connector (`/start`). Nếu pipeline đã bị bỏ, hãy xoá nó để slot được drop (xem bên dưới). |
| Hết `max_replication_slots` | Tăng `max_replication_slots` trong PostgreSQL rồi restart; xoá các slot không dùng. |
| Replication role mất thuộc tính `REPLICATION` | `ALTER ROLE cdc_user WITH REPLICATION;` |
| Tên slot xung đột với một tool khác | Đặt một `DEBEZIUM_SLOT_NAME` / `MATERIALIZED_SLOT_NAME` duy nhất. |

### Slot mồ côi sau khi xoá

Xoá một pipeline sẽ drop replication slot của nó như một phần của `connector.destroy()` (Requirement 1.8). Nếu việc dọn slot thất bại, API trả `409 REPLICATION_SLOT_CLEANUP_FAILED` và **giữ lại record trong registry** để slot mồ côi không bị lãng quên. Hãy thử xoá lại sau khi giải quyết nguyên nhân; như phương án cuối, drop slot thủ công:

```sql
SELECT pg_drop_replication_slot('lumibase_debezium');
```

> Một slot chỉ drop được khi đang inactive. Hãy dừng connector đang tiêu thụ nó trước.

---

## 2. Lỗi kết nối

Áp dụng cho việc đăng ký pipeline, health check, và mọi cách tiếp cận.

### Triệu chứng: việc đăng ký bị từ chối

| HTTP | Code | Ý nghĩa | Cách sửa |
|------|------|---------|-----|
| 400 | `CONNECTIVITY_CHECK_FAILED` | Một endpoint không kết nối được; field `endpoint` cho biết là cái nào | Sửa connection string / đường mạng tới endpoint đó |
| 408 | `CONNECTIVITY_TIMEOUT` | Lượt kiểm tra kết nối vượt timeout 10 giây | Kiểm tra quyền truy cập mạng, security group, và DNS tới endpoint |

Lượt kiểm tra kết nối có timeout 10 giây cho mỗi endpoint và báo rõ endpoint nào (source hay sink) không kết nối được.

### Triệu chứng: health check báo một service không kết nối được

```bash
curl -sS https://your-cms-host/api/v1/cdc/pipelines/$PIPELINE_ID/health \
  -H "Authorization: Bearer $LUMI_ADMIN_TOKEN" -H "X-Lumi-Site: $SITE_ID"
```

```json
{
  "data": {
    "healthy": false,
    "services": [
      { "service": "kafka_broker", "reachable": false, "reason": "connection refused" }
    ]
  }
}
```

### Nguyên nhân thường gặp và cách sửa

| Service | Cần kiểm tra |
|---------|--------|
| PostgreSQL | Kết nối được ở 5432? Credential hợp lệ? Có `?sslmode=require` nếu TLS bị bắt buộc? |
| ClickHouse | Kết nối được ở 8123 (HTTP) / 9000 (native)? Database có tồn tại? |
| Kafka | `KAFKA_BOOTSTRAP_SERVERS` host:port đúng và Debezium route tới được? |
| Airbyte | `AIRBYTE_API_URL` kết nối được? Workspace ID hợp lệ? |
| Redis (Cache_Invalidator) | `REDIS_URL` kết nối được từ bản deploy Workers/edge? |

### Kafka / ClickHouse mất kết nối (cách tiếp cận Debezium)

Những trường hợp này được xử lý tự động và tự phục hồi mà không cần can thiệp:

- **Kafka không sẵn sàng** — event buffer cục bộ tối đa 1 giờ / 500 MB (`KAFKA_BUFFER_MAX_AGE_MS` / `KAFKA_BUFFER_MAX_BYTES`) và replay đúng thứ tự khi phục hồi (Requirement 2.4).
- **ClickHouse không sẵn sàng** — event ở lại trên các Kafka topic và việc ingest tiếp tục đúng thứ tự khi ClickHouse kết nối lại được (Requirement 2.6).

Nếu chạm tới cap buffer, hãy tăng dung lượng Kafka/ClickHouse hoặc giảm tập table được replicate.

### Redis không sẵn sàng (Cache_Invalidator)

Cache_Invalidator xếp hàng tối đa `CACHE_INVALIDATOR_QUEUE_MAX` event (mặc định 10.000) trong lúc Redis mất kết nối, và replay chúng theo thứ tự thời gian khi kết nối lại. Khi tràn, các event cũ nhất bị loại bỏ và một warning được log kèm số lượng đã loại (Requirements 5.4, 5.5). Nếu bạn thấy warning về việc loại bỏ, hãy tăng cap của queue hoặc phục hồi Redis nhanh hơn.

---

## 3. Sync job thất bại

Áp dụng cho Airbyte.

### Triệu chứng: status pipeline là `error` sau các lần retry sync

Một lần sync Airbyte thất bại được retry tối đa `AIRBYTE_SYNC_MAX_RETRIES` lần (mặc định 3) theo exponential backoff bắt đầu từ 30 giây. Sau khi hết số lần retry, pipeline được đặt sang `error` và lý do thất bại được ghi vào registry (Requirement 4.4).

### Triệu chứng: provisioning thất bại hoặc hết thời gian

Nếu việc provision Airbyte thất bại hoặc vượt timeout 120 giây, pipeline chuyển sang `error`, lý do được ghi lại, và các tài nguyên đã cấp một phần được giải phóng (Requirement 4.6).

### Chẩn đoán và cách sửa

| Nguyên nhân | Cách sửa |
|-------|-----|
| Sync interval không hợp lệ | Dùng một giá trị trong khoảng **[300, 86400]** giây; nếu không việc đăng ký bị từ chối (Requirements 4.3, 4.7) |
| Credential source/destination bị Airbyte từ chối | Kiểm tra lại `SOURCE_DATABASE_URL` / `CLICKHOUSE_SINK_URL`; xác nhận Airbyte kết nối được tới cả hai |
| Airbyte API không kết nối được / sai workspace | Kiểm tra `AIRBYTE_API_URL` và `AIRBYTE_WORKSPACE_ID` |
| Schema/kiểu không tương thích ở destination | Xem log job của Airbyte; điều chỉnh mapping stream/field |
| Provisioning hết thời gian | Xác nhận Airbyte còn dung lượng; thử start lại; kiểm tra tài nguyên còn sót lại một phần |

Kiểm tra lý do đã ghi và metadata của lần sync gần nhất:

```bash
curl -sS https://your-cms-host/api/v1/cdc/pipelines/$PIPELINE_ID \
  -H "Authorization: Bearer $LUMI_ADMIN_TOKEN" -H "X-Lumi-Site: $SITE_ID"
# statusMessage, lastSyncAt, lastSyncRecordCount
```

---

## 4. Schema drift

Áp dụng cho Materialized Engine (Requirement 3.6); cũng liên quan tới Debezium và Airbyte khi schema ở source đổi.

### Triệu chứng: status pipeline là `error`, thông báo nêu rõ table bị ảnh hưởng và loại thay đổi

Materialized Engine kiểm tra schema drift ở source mỗi `MATERIALIZED_SCHEMA_DRIFT_INTERVAL_MS` (mặc định 60000ms). Việc thêm cột, bỏ cột, hoặc đổi kiểu trên một table được replicate sẽ được phát hiện trong vòng 60 giây và đặt pipeline sang `error`, báo rõ table bị ảnh hưởng và loại thay đổi (Requirement 3.6).

### Quy trình giải quyết

1. Đọc `statusMessage` để xác định table bị ảnh hưởng và loại thay đổi (cột được thêm / bị bỏ / đổi kiểu).
2. Hoà giải schema đích ở ClickHouse với schema PostgreSQL mới:
   - **Thêm cột** — thêm cột tương ứng vào table ClickHouse (hoặc tạo lại table được replicate để nhận cột mới).
   - **Bỏ cột** — bỏ cột đó hoặc ngừng tham chiếu tới nó ở phía sau.
   - **Đổi kiểu** — làm cho kiểu cột ở ClickHouse khớp với kiểu PostgreSQL mới.
3. Khởi động lại replication:
   ```bash
   curl -sS -X POST https://your-cms-host/api/v1/cdc/pipelines/$PIPELINE_ID/start \
     -H "Authorization: Bearer $LUMI_ADMIN_TOKEN" -H "X-Lumi-Site: $SITE_ID"
   ```
4. Xác nhận đã phục hồi bằng một lượt health check; Health Monitor phát một notification phục hồi khi chuyển từ error→active (Requirement 8.6).

> **Phòng ngừa:** hãy phối hợp các lần migrate schema ở source với cửa sổ bảo trì pipeline. Tạm dừng pipeline (`/stop`) trước khi áp một migration gây phá vỡ, rồi cập nhật schema đích và tiếp tục.

---

## Tham chiếu health monitoring

| Điều kiện | Hành vi |
|-----------|----------|
| Replication lag > ngưỡng (mặc định 60s, khoảng 10s–3600s) | Notification cảnh báo (Requirement 8.2) |
| Pipeline ở `error` > 5 phút | Cảnh báo critical (Requirement 8.3) |
| Metric bị bỏ lỡ 3 interval liên tiếp (90s) | Status → `error`, cảnh báo critical (Requirement 8.7) |
| Chuyển từ `error` → `active` | Notification phục hồi (Requirement 8.6) |

Kiểm tra metric hiện tại và metric lịch sử:

```bash
curl -sS https://your-cms-host/api/v1/cdc/pipelines/$PIPELINE_ID/metrics \
  -H "Authorization: Bearer $LUMI_ADMIN_TOKEN" -H "X-Lumi-Site: $SITE_ID"

curl -sS "https://your-cms-host/api/v1/cdc/pipelines/$PIPELINE_ID/metrics/history?since=2025-01-01T00:00:00Z" \
  -H "Authorization: Bearer $LUMI_ADMIN_TOKEN" -H "X-Lumi-Site: $SITE_ID"
```

## Xem thêm

- [Tổng quan kiến trúc](./architecture.md)
- [Environment Variables](./environment-variables.md)
- Hướng dẫn setup: [Debezium + Kafka](./setup-debezium-kafka.md) · [Materialized Engine](./setup-materialized-engine.md) · [Airbyte](./setup-airbyte.md)
