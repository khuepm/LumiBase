---
version: 1
lastUpdated: 2026-07-28T11:48:31.596Z
sourceLang: en
translatedFrom: en
sourceHash: bec65a2bb768bb4d
mtEngine: claude
syncStatus: machine-translated
codeVerified: 2026-07-28T11:48:31.596Z
codeVerifiedHash: bec65a2bb768bb4d
codeVerifiedClaims: 22
---

# Checklist deploy LumiBase lên production

> Checklist đầy đủ để deploy LumiBase lên production. Hỗ trợ cả **Cloudflare Workers** (edge) và **Docker** (self-hosted).

---

## Mục lục

1. [Chuẩn bị trước khi deploy](#1-chuẩn-bị-trước-khi-deploy)
2. [Dựng hạ tầng](#2-dựng-hạ-tầng)
3. [Secret & biến môi trường](#3-secret--biến-môi-trường)
4. [Thiết lập database](#4-thiết-lập-database)
5. [Storage & service](#5-storage--service)
6. [Deploy Cloudflare Workers](#6-deploy-cloudflare-workers)
7. [Deploy Docker](#7-deploy-docker)
8. [Verify sau khi deploy](#8-verify-sau-khi-deploy)
9. [Làm chặt bảo mật](#9-làm-chặt-bảo-mật)
10. [Monitoring & observability](#10-monitoring--observability)
11. [Backup & recovery](#11-backup--recovery)
12. [Xử lý sự cố](#12-xử-lý-sự-cố)

---

## 1. Chuẩn bị trước khi deploy

### Code đã sẵn sàng

- [ ] Mọi test pass: `pnpm test`
- [ ] Type check pass: `pnpm typecheck`
- [ ] Build thành công: `pnpm build`
- [ ] Không còn câu lệnh `console.log` trong code production
- [ ] Mọi mục TODO/FIXME đã được xử lý hoặc ghi lại
- [ ] CHANGELOG đã cập nhật kèm release note

### Version & release

- [ ] Đã nâng version trong các file `package.json`
- [ ] Đã tạo git tag: `git tag v0.x.x`
- [ ] Đã tạo release branch (nếu dùng GitFlow)

---

## 2. Dựng hạ tầng

### Cloudflare (deploy edge)

- [ ] Account Cloudflare có plan Workers Paid
- [ ] Đã cài và đăng nhập Wrangler CLI: `wrangler login`
- [ ] Đã cấu hình zone cho domain của bạn (ví dụ `lumibase.dev`)
- [ ] Đã tạo instance Hyperdrive:
  ```bash
  wrangler hyperdrive create lumibase-hyperdrive \
    --connection-string="postgresql://user:pass@host:5432/db?sslmode=require"
  ```
- [ ] Đã tạo KV namespace:
  ```bash
  wrangler kv:namespace create CONFIG_CACHE
  ```
- [ ] Đã tạo R2 bucket:
  ```bash
  wrangler r2 bucket create lumibase-media
  ```
- [ ] Đã tạo Queue (cho realtime):
  ```bash
  wrangler queues create lumibase-realtime
  ```
- [ ] Đã cập nhật `wrangler.toml` với các binding ID

### Docker (deploy self-hosted)

- [ ] Đã cài Docker Engine 24+
- [ ] Đã cài Docker Compose v2
- [ ] Đủ tài nguyên: 4GB+ RAM, 20GB+ đĩa
- [ ] Domain đã trỏ về IP của server
- [ ] Đã cấu hình firewall rule (mở 80, 443)

---

## 3. Secret & biến môi trường

### Sinh secret

```bash
# JWT Secret (bắt buộc)
openssl rand -base64 32

# Encryption Key (bắt buộc)
openssl rand -base64 32

# Imgproxy Key & Salt (bắt buộc với Docker)
openssl rand -hex 32  # key
openssl rand -hex 32  # salt

# MeiliSearch Master Key
openssl rand -base64 32

# Metrics Token
openssl rand -base64 24
```

### Secret cho Cloudflare Workers

Đặt qua `wrangler secret put --env production`:

| Secret | Bắt buộc | Lệnh |
|--------|----------|---------|
| `JWT_SECRET` | Có | `wrangler secret put JWT_SECRET --env production` |
| `ENCRYPTION_KEY` | Có | `wrangler secret put ENCRYPTION_KEY --env production` |
| `CF_ACCESS_CERTS_URL` | Nếu dùng CF Access | `wrangler secret put CF_ACCESS_CERTS_URL --env production` |
| `CF_ACCESS_AUDIENCE` | Nếu dùng CF Access | `wrangler secret put CF_ACCESS_AUDIENCE --env production` |
| `SENTRY_DSN` | Khuyến nghị | `wrangler secret put SENTRY_DSN --env production` |
| `METRICS_TOKEN` | Khuyến nghị | `wrangler secret put METRICS_TOKEN --env production` |
| `OPENAI_API_KEY` | Nếu dùng AI | `wrangler secret put OPENAI_API_KEY --env production` |

### Environment cho Docker

- [ ] Copy template: `cp docker/.env.prod.example docker/.env`
- [ ] Điền hết các placeholder `REPLACE_*`
- [ ] Xác nhận không còn giá trị dev nào:
  ```bash
  grep -E "dev_secret|lumibase_dev|minioadmin|REPLACE" docker/.env
  # Kết quả phải rỗng!
  ```

### Các kiểm tra bảo mật then chốt

- [ ] `LUMIBASE_DEV_AUTH=false` (RẤT QUAN TRỌNG!)
- [ ] `LUMIBASE_ENV=production`
- [ ] `JWT_SECRET` là chuỗi ngẫu nhiên (không phải `dev_secret_key`)
- [ ] `ENCRYPTION_KEY` đã được đặt
- [ ] `DATABASE_SSL_MODE=require` (không phải `disable`)
- [ ] `CORS_ALLOWED_ORIGINS` không chứa `*` hay `localhost`

---

## 4. Thiết lập database

### Yêu cầu về PostgreSQL

- [ ] PostgreSQL 15+ đang chạy
- [ ] Đã bật SSL/TLS
- [ ] Có user riêng với quyền hạn giới hạn:
  ```sql
  CREATE USER lumibase WITH PASSWORD 'strong_password';
  CREATE DATABASE lumibase OWNER lumibase;
  GRANT ALL PRIVILEGES ON DATABASE lumibase TO lumibase;
  ```
- [ ] Có connection pooling (PgBouncer hoặc Hyperdrive)

### Chạy migration

```bash
# Từ gốc repo (db:migrate là một script ở gốc)
pnpm db:migrate

# Chạy thử các migration đang chờ trước
pnpm db:migrate:preflight

# Hoặc, filter theo package — lưu ý script ở đó là `migrate`, không phải `db:migrate`
pnpm -F @lumibase/database migrate
```

- [ ] Migration hoàn tất không lỗi
- [ ] Version schema khớp với codebase

### Bảo mật database

- [ ] Đã bật Row Level Security (RLS)
- [ ] Không cho truy cập public schema
- [ ] Đã bật audit logging
- [ ] Đã cấu hình lịch backup

---

## 5. Storage & service

### Storage tương thích S3

- [ ] Đã tạo bucket với permission phù hợp
- [ ] Đã cấu hình CORS cho các domain của bạn:
  ```json
  {
    "AllowedOrigins": ["https://studio.example.com"],
    "AllowedMethods": ["GET", "PUT", "POST"],
    "AllowedHeaders": ["*"]
  }
  ```
- [ ] Có lifecycle rule cho các upload tạm (tuỳ chọn)

### MeiliSearch

- [ ] Instance MeiliSearch đang chạy
- [ ] Đã đặt master key (không dùng mặc định)
- [ ] Đã tạo index cho việc tìm kiếm nội dung

### Redis

- [ ] Instance Redis đang chạy
- [ ] Đã bật xác thực bằng password
- [ ] Đã bật TLS (nếu ở xa)
- [ ] Đã cấu hình persistence (RDB/AOF)

### Imgproxy

- [ ] Instance Imgproxy đang chạy
- [ ] Đã cấu hình signing key
- [ ] Đã đặt giới hạn bộ nhớ phù hợp

---

## 6. Deploy Cloudflare Workers

### Kiểm tra trước khi deploy

- [ ] Đã rà `wrangler.toml` cho env production
- [ ] Đã điền hết các binding ID:
  - [ ] `HYPERDRIVE` id
  - [ ] `CONFIG_CACHE` KV id
  - [ ] Tên R2 bucket `MEDIA`
  - [ ] Tên queue `REALTIME_QUEUE`
- [ ] Đã cấu hình route đúng:
  ```toml
  [[env.production.routes]]
  pattern = "api.yourdomain.com"
  custom_domain = true
  ```

### Deploy

```bash
# Build (bundle dry-run cho env production)
pnpm -F @lumibase/cms build:production

# Deploy
wrangler deploy --env production

# Verify
curl https://api.yourdomain.com/health
```

- [ ] Deploy thành công
- [ ] Health check trả về `{ "status": "ok" }`
- [ ] Không có lỗi trong dashboard Cloudflare

### Durable Objects

- [ ] SiteRoom DO đã được migrate (tag: v1)
- [ ] Kết nối WebSocket hoạt động

---

## 7. Deploy Docker

### Kiểm tra trước khi deploy

- [ ] `docker/.env` đã được cấu hình (từ `.env.prod.example`)
- [ ] Đã pull image Docker: `docker compose pull`
- [ ] Đã tạo volume để lưu bền

### Deploy

```bash
cd docker

# Khởi động các service hạ tầng trước
docker compose up -d postgres redis meilisearch imgproxy

# Chờ các service healthy
docker compose ps

# Chạy migration
docker compose run --rm cms pnpm -F @lumibase/database migrate

# Khởi động CMS
docker compose up -d cms

# (Tuỳ chọn) Khởi động kèm TLS
docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d
```

- [ ] Mọi container đang chạy: `docker compose ps`
- [ ] Không có vòng restart trong log: `docker compose logs --tail=100`
- [ ] Health check pass:
  ```bash
  curl http://localhost:1989/health
  ```

### Scale (tuỳ chọn)

```bash
# Scale CMS theo chiều ngang
docker compose up -d --scale cms=3
```

---

## 8. Verify sau khi deploy

### Health & kết nối

```bash
# Endpoint health
curl https://api.yourdomain.com/health
# Mong đợi: { "status": "ok", "env": "production", ... }

# Version của API
curl https://api.yourdomain.com/api/v1/health
```

- [ ] Health check trả về `ok`
- [ ] Kết nối database hoạt động
- [ ] Kết nối Redis hoạt động
- [ ] Kết nối storage hoạt động
- [ ] Kết nối search hoạt động

### Test theo chức năng

- [ ] Đăng nhập admin hoạt động
- [ ] Tạo được một site thử
- [ ] Tạo được một content item
- [ ] Upload được file media
- [ ] Search trả về kết quả
- [ ] WebSocket realtime hoạt động (nếu đã bật)

### Mốc hiệu năng cơ sở

- [ ] Thời gian phản hồi < 200ms với các query đơn giản
- [ ] Không rò rỉ bộ nhớ (theo dõi trong 1 giờ)
- [ ] CPU ổn định khi có tải

---

## 9. Làm chặt bảo mật

### Xác thực

- [ ] Đã tắt dev auth (`LUMIBASE_DEV_AUTH=false`)
- [ ] Đã cấu hình thời hạn JWT phù hợp
- [ ] Đã bật rate limiting
- [ ] Lockout account hoạt động

### Mạng

- [ ] Bắt buộc HTTPS (không HTTP)
- [ ] Đã bật header HSTS
- [ ] CORS bị giới hạn về các origin đã biết
- [ ] Đã cấu hình header CSP (cho Studio)

### Bảo mật API

- [ ] Endpoint `/metrics` được bảo vệ bởi `METRICS_TOKEN`
- [ ] Endpoint SCIM được bảo vệ (nếu dùng)
- [ ] Đã tắt introspection GraphQL ở production
- [ ] Đã bật validate MIME type khi upload file

### Bảo vệ dữ liệu

- [ ] Mã hoá at rest (database)
- [ ] Mã hoá in transit (TLS ở mọi nơi)
- [ ] Mã hoá field cho dữ liệu nhạy cảm (`ENCRYPTION_KEY`)
- [ ] Đã bật audit logging cho PII

---

## 10. Monitoring & observability

### Theo dõi lỗi

- [ ] Đã cấu hình Sentry (Cloudflare):
  ```bash
  wrangler secret put SENTRY_DSN --env production
  ```
- [ ] Project Sentry đang nhận lỗi
- [ ] Đã cấu hình alert rule

### Metrics

- [ ] Prometheus đang scrape `/metrics`
- [ ] Đã dựng dashboard Grafana
- [ ] Đang theo dõi các metric then chốt:
  - [ ] Request rate
  - [ ] Error rate (5xx)
  - [ ] Độ trễ phản hồi (p50, p95, p99)
  - [ ] Thời lượng query database
  - [ ] Số kết nối đang hoạt động

### Logging

- [ ] Đã bật log JSON có cấu trúc
- [ ] Đã dựng nơi gom log (Loki, CloudWatch, v.v.)
- [ ] Đã cấu hình policy giữ log
- [ ] Dữ liệu nhạy cảm không bị log

### Alerting

- [ ] Alert khi error rate tăng vọt
- [ ] Alert khi độ trễ xuống cấp
- [ ] Alert khi connection pool của database cạn
- [ ] Alert về dung lượng đĩa (Docker)
- [ ] Alert khi certificate sắp hết hạn

---

## 11. Backup & recovery

### Backup database

- [ ] Backup tự động hằng ngày
- [ ] Backup được lưu ngoài site (S3, v.v.)
- [ ] Đã bật mã hoá backup
- [ ] Policy giữ: tối thiểu 30 ngày
- [ ] Đã test việc phục hồi từ backup

### Backup media

- [ ] Đã bật versioning trên S3 (hoặc replicate xuyên region)
- [ ] Có lifecycle rule cho các version cũ

### Backup cấu hình

- [ ] `wrangler.toml` nằm trong version control
- [ ] `.env` của Docker được backup an toàn (đã mã hoá)
- [ ] Secret được ghi lại trong password manager

### Khắc phục thảm hoạ

- [ ] Đã ghi lại quy trình phục hồi
- [ ] Đã định nghĩa recovery time objective (RTO)
- [ ] Đã định nghĩa recovery point objective (RPO)
- [ ] Đã diễn tập DR

---

## 12. Xử lý sự cố

### Các vấn đề thường gặp

#### Health check fail

```bash
# Xem log của service
docker compose logs cms --tail=100

# Kiểm tra kết nối database bằng cách chạy thử migration
docker compose exec cms pnpm -F @lumibase/database migrate:preflight

# Kiểm tra kết nối Redis
docker compose exec redis redis-cli ping
```

#### Lỗi 500 khi có request

```bash
# Kiểm tra secret bị thiếu
grep "JWT_SECRET\|ENCRYPTION_KEY" docker/.env

# Xác nhận secret đã được đặt (Cloudflare)
wrangler secret list --env production
```

#### Lỗi kết nối database

- Kiểm tra định dạng `DATABASE_URL`
- Kiểm tra SSL mode khớp với cấu hình server
- Kiểm tra kết nối mạng
- Kiểm tra giới hạn connection pool

#### Lỗi CORS

- Xác nhận `CORS_ALLOWED_ORIGINS` có chứa domain frontend của bạn
- Kiểm tra dấu gạch chéo cuối (không được có)
- Xác nhận protocol (https, không phải http)

### Quy trình rollback

```bash
# Cloudflare Workers
wrangler rollback --env production

# Docker
docker compose down
docker compose pull  # pull tag trước đó
docker compose up -d
```

---

## Tra cứu nhanh: các secret bắt buộc

### Cloudflare Workers

| Secret | Bắt buộc | Cách sinh |
|--------|----------|----------|
| `JWT_SECRET` | Có | `openssl rand -base64 32` |
| `ENCRYPTION_KEY` | Có | `openssl rand -base64 32` |
| `CF_ACCESS_CERTS_URL` | Nếu dùng CF Access | Từ dashboard CF |
| `CF_ACCESS_AUDIENCE` | Nếu dùng CF Access | Từ dashboard CF |
| `SENTRY_DSN` | Khuyến nghị | Từ project Sentry |
| `METRICS_TOKEN` | Khuyến nghị | `openssl rand -base64 24` |

### Docker

| Biến | Bắt buộc | Cách sinh |
|----------|----------|----------|
| `JWT_SECRET` | Có | `openssl rand -base64 32` |
| `ENCRYPTION_KEY` | Có | `openssl rand -base64 32` |
| `DATABASE_URL` | Có | Connection string kèm SSL |
| `REDIS_URL` | Có | Connection string |
| `S3_ACCESS_KEY` | Có | Từ provider |
| `S3_SECRET_KEY` | Có | Từ provider |
| `MEILISEARCH_API_KEY` | Có | `openssl rand -base64 32` |
| `IMGPROXY_KEY` | Có | `openssl rand -hex 32` |
| `IMGPROXY_SALT` | Có | `openssl rand -hex 32` |

---

## Ký xác nhận

| Mục kiểm tra | Người xác nhận | Ngày |
|-------|-------------|------|
| Hoàn tất phần trước deploy | | |
| Hạ tầng đã sẵn sàng | | |
| Đã cấu hình secret | | |
| Đã migrate database | | |
| Các service đều healthy | | |
| Đã làm chặt bảo mật | | |
| Monitoring đang hoạt động | | |
| Đã verify backup | | |

**Version đã deploy:** `v____`
**Ngày deploy:** `____-__-__`
**Người deploy:** `____________`
