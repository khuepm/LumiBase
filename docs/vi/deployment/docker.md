---
<!-- check-parity: allow inline-code -->
version: 1
lastUpdated: 2026-08-02T19:21:08.504Z
sourceLang: en
translatedFrom: en
sourceHash: 562cf0016bbc6d0f
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-08-02T19:21:08.504Z
codeVerifiedHash: 562cf0016bbc6d0f
codeVerifiedClaims: 9
---

<!-- check-parity: allow inline-code -->

# Docker Deployment

Docker mode chạy CMS API bằng Node.js và dùng hạ tầng tự host cho các dịch vụ stateful.

## Dịch vụ

File compose nền là `docker/docker-compose.yml`. Khi chạy production/self-hosted,
thêm override `docker/docker-compose.prod.yml`. Override production dùng cho:

- CMS API container từ image CMS đã publish.
- PostgreSQL.
- Redis cho cache và queue adapter.
- MinIO cho object storage tương thích S3.
- Prometheus/Grafana nếu bật observability.

## Cấu hình

Tạo file môi trường từ mẫu:

```bash
cp docker/.env.example docker/.env
```

Cập nhật giá trị production cho database, Redis, object storage, JWT và admin authentication trước khi start stack.

## Chạy production

Pin CMS image bằng `LUMIBASE_VERSION` để production chạy đúng release mong muốn.
Nếu không set, `docker/docker-compose.prod.yml` sẽ fallback về `latest`.

```bash
LUMIBASE_VERSION=0.4.3 docker compose -f docker/docker-compose.yml -f docker/docker-compose.prod.yml up -d
```

Kiểm tra API:

```bash
curl -fsS http://localhost:1989/health
```

## Build local thay vì pull image đã publish

Giữ build local trong override riêng để production mặc định luôn dùng image đã
publish. Thêm `docker/docker-compose.build.yml` sau production override:

```bash
docker compose \
  -f docker/docker-compose.yml \
  -f docker/docker-compose.prod.yml \
  -f docker/docker-compose.build.yml \
  up -d --build
```

## Note: lỗi `SERVICE_UNAVAILABLE` do instance under pressure

Nếu client nhận HTTP `503` với nội dung tương tự:

```json
{
  "errors": [
    {
      "code": "SERVICE_UNAVAILABLE",
      "message": "LumiBase API is temporarily unavailable because this instance is under pressure. Retry later.",
      "details": { "reason": "event_loop_delay" }
    }
  ]
}
```

điều này không nhất thiết nghĩa là service CMS đã chết. Trong Docker mode, `LUMIBASE_PRESSURE_LIMITER_ENABLED=true` cho phép CMS tự bảo vệ khi event loop Node.js bị nghẽn. Guard trả `503` kèm `Retry-After` để upstream/client retry có kiểm soát thay vì tiếp tục dồn request vào một process đang quá tải.

Các nguyên nhân thường gặp:

- API bị gọi dồn hoặc CPU/RAM container quá thấp.
- Endpoint export/thống kê xử lý dữ liệu lớn bằng JavaScript trên hot path.
- Query kéo quá nhiều bản ghi rồi mới lọc/format/`JSON.parse` trong ứng dụng.
- Cache hoặc queue backend chậm làm request tích tụ.
- Docker compose trỏ nhầm hostname nội bộ, ví dụ service trong container phải gọi PostgreSQL bằng tên service như `postgres`, không phải `localhost`.

Hướng kiểm tra nhanh:

```bash
docker stats
docker compose logs --since=10m cms
curl -i http://localhost:1989/health
curl -s http://localhost:1989/metrics | grep -E 'nodejs_eventloop|process_cpu|lumibase_http_request_duration'
```

Nếu cần nới ngưỡng tạm thời trong lúc điều tra, có thể đặt:

```env
LUMIBASE_PRESSURE_LIMITER_MAX_EVENT_LOOP_DELAY=1500
LUMIBASE_PRESSURE_LIMITER_MAX_EVENT_LOOP_UTILIZATION=false
LUMIBASE_PRESSURE_LIMITER_RETRY_AFTER=5
```

Chỉ tắt guard trong thời gian ngắn khi đã có cơ chế bảo vệ khác ở reverse proxy hoặc autoscaling:

```env
LUMIBASE_PRESSURE_LIMITER_ENABLED=false
```

Không nên tắt lâu dài. Cách xử lý đúng là xác định endpoint gây spike, tối ưu query/index/pagination/export streaming, hoặc tăng replica/CPU cho CMS.

## Rollback

Để rollback CMS container về release trước:

1. Đổi `LUMIBASE_VERSION` về version trước đó.
2. Pull lại CMS image đã pin.
3. Recreate riêng service CMS.

```bash
docker compose pull cms
docker compose up -d cms
```

Docker mode phù hợp cho self-hosting hoặc rehearsal production local. Cloudflare Workers vẫn là đường deploy edge mặc định.
