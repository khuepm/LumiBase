# Triển khai Docker

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
LUMIBASE_VERSION=0.4.2 docker compose -f docker/docker-compose.yml -f docker/docker-compose.prod.yml up -d
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
