# Triển khai Docker

Docker mode chạy CMS API bằng Node.js và dùng hạ tầng tự host cho các dịch vụ stateful.

## Dịch vụ

File production compose là `docker/docker-compose.prod.yml`, dùng cho:

- CMS API container.
- PostgreSQL.
- Redis cho cache và queue adapter.
- MinIO cho object storage tương thích S3.
- Prometheus/Grafana nếu bật observability.

## Build và chạy

```bash
pnpm --filter @lumibase/cms build:node
docker compose -f docker/docker-compose.prod.yml build
cp docker/.env.example docker/.env
docker compose -f docker/docker-compose.prod.yml --env-file docker/.env up -d
```

Kiểm tra API:

```bash
curl -fsS http://localhost:1989/health
```

Docker mode phù hợp cho self-hosting hoặc rehearsal production local. Cloudflare Workers vẫn là đường deploy edge mặc định.
