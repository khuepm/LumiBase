---
version: 5
lastUpdated: 2026-10-13T21:43:49.229Z
sourceLang: en
translatedFrom: en
sourceHash: 1e3d2d3993956138
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-10-13T21:43:49.229Z
codeVerifiedHash: 1e3d2d3993956138
codeVerifiedClaims: 8
---

# Local Development

> **Điều kiện tiên quyết:** Node.js 22.22.2+ (22.x), 24.15.0+ (24.x), or 26+, pnpm 9.12.0, Docker + Docker Compose, Git ≥ 2.40

## Quick start

```bash
# 1. Clone and install
git clone https://github.com/khuepm/lumibase.git
cd lumibase
pnpm install

# 2. Start infrastructure only; the CMS runs on the host below
docker compose -f docker/docker-compose.yml up -d postgres redis minio minio-init meilisearch imgproxy

# 3. Save the environment block below as .env.local, then export it
set -a
. ./.env.local
set +a

# 4. Apply migrations to your local development database
pnpm db:migrate

# 5. Run the Node CMS (:1989) in this terminal
pnpm -F @lumibase/cms exec tsx src/serve.ts
```

Thư mục gốc không có `.env.example`. Tạo `.env.local` (được Git bỏ qua) từ [khối environment](#file-environment) bên dưới. Các lệnh dùng port Compose mặc định và database phát triển local. `docker/.env.example` dùng hostname trong container, không dùng trực tiếp cho tiến trình trên máy host. Mở terminal thứ hai tại thư mục gốc repo để chạy Studio:

```bash
pnpm -F @lumibase/studio exec vite --host 127.0.0.1 --port 2026
```

**Các service đang chạy:**

| Service | URL | Mô tả |
|---------|-----|-------|
| CMS API | http://localhost:1989 | Hono REST + WebSocket API |
| Studio | http://localhost:2026 | Admin SPA |
| Docs viewer (tuỳ chọn) | http://localhost:5174 | Chạy riêng bằng `pnpm docs:dev` |
| PostgreSQL | localhost:5432 | Database |
| Redis | localhost:6379 | Cache + queues |
| MeiliSearch | http://localhost:7700 | Search |
| MinIO | http://localhost:9000 (console :9001) | Object storage tương thích S3 |
| imgproxy | http://localhost:8080 | Biến đổi ảnh |

---

## Chạy từng service riêng

```bash
# CMS API only
pnpm -F @lumibase/cms exec tsx src/serve.ts # Load .env.local first (port 1989)

# Studio only
pnpm -F @lumibase/studio exec vite --host 127.0.0.1 --port 2026

# Docs only
pnpm -F @lumibase/docs dev       # Vite docs (port 5174)
```

---

## Setup wizard lần đầu

Khi chạy lần đầu, CMS API phát hiện database trống và kích hoạt setup wizard. Truy cập http://localhost:2026/setup để:

1. Tạo admin user đầu tiên
2. Đặt tên site và ngôn ngữ mặc định
3. Cấu hình URL admin panel (bảo mật bằng đường dẫn ẩn)

---

## File environment

Lưu khối này thành `.env.local` tại thư mục gốc repo. Chạy lại `set -a; . ./.env.local; set +a` trong mỗi terminal chạy migration hoặc Node CMS; các lệnh đó không tự nạp file. Chỉ dùng các thông tin này cho phát triển local:

```env
LUMIBASE_ENV=development
LUMIBASE_RUNTIME=docker
LUMIBASE_DEV_AUTH=true
JWT_SECRET=local-dev-secret-min-32-chars-long
DATABASE_URL=postgresql://lumibase:lumibase_dev@localhost:5432/lumibase
REDIS_URL=redis://localhost:6379
S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
S3_BUCKET=lumibase-media
MEILISEARCH_HOST=http://localhost:7700
MEILISEARCH_API_KEY=lumibase_dev_key
IMGPROXY_URL=http://localhost:8080
IMGPROXY_KEY=736563726574
IMGPROXY_SALT=736563726574
LLM_PROVIDER=echo
```

---

## Quản lý database

```bash
# Generate a new migration after schema changes
pnpm db:generate

# Check connectivity, current version, and pending migrations without applying DDL
pnpm db:migrate:preflight

# Apply pending migrations
pnpm db:migrate

# Print the current migration version
pnpm db:migrate:version

# Open Drizzle Studio (database GUI)
pnpm db:studio

# Seed development data
pnpm db:seed-dev
```

---

## Testing

```bash
# Run all tests
pnpm test

# Run tests in a specific package
pnpm -F @lumibase/cms test

# Watch mode
pnpm -F @lumibase/cms test --watch

# Type-check all packages
pnpm typecheck

# Lint all packages
pnpm lint
```

---

## Mô phỏng Cloudflare Workers ở local

```bash
# Alternative to the Node CMS; stop it first to free port 1989
pnpm -F @lumibase/cms dev
```

Với cách này, đặt secret như `DATABASE_URL` và `JWT_SECRET` trong
`apps/cms/.dev.vars`. Wrangler dùng `apps/cms/wrangler.toml` và mô phỏng binding
local; environment Docker ở trên không cấu hình binding R2/KV.
Thiếu binding tương ứng có thể khiến kiểm tra storage/cache trong `/health` lỗi.
Dùng cách chạy Node CMS ở trên khi làm việc với hạ tầng Docker.

---

## Các vấn đề thường gặp

### Xung đột port

Nếu port đã bị chiếm, ghi đè port publish của container trong `docker/.env`:

```env
CMS_PORT=1990
```

Port dev của Studio được đặt trong `apps/studio/vite.config.ts`
(`server.port: 2026`) và không có biến môi trường nào ghi đè được. Hãy truyền port
trực tiếp cho Vite:

```bash
pnpm -F @lumibase/studio exec vite --host 127.0.0.1 --port 2027
```

### Docker không khởi động

```bash
# Check logs
docker compose -f docker/docker-compose.yml logs

# Force recreate
docker compose -f docker/docker-compose.yml up -d --force-recreate postgres redis minio minio-init meilisearch imgproxy
```

### Lỗi type sau `git pull`

Thay đổi schema hoặc package có thể cần regenerate types:

```bash
pnpm db:generate
pnpm install  # Update pnpm-lock if packages changed
pnpm typecheck
```

### MeiliSearch index lệch

```bash
# Reindex all searchable collections
curl -X POST http://localhost:1989/api/v1/search/reindex \
  -H "Authorization: Bearer <admin-token>" \
  -H "X-Lumi-Site: <your-site-id>"
```
