# Tổng quan Triển khai

Lumibase hỗ trợ hai chế độ triển khai: **Cloudflare Workers** (edge) và **Docker** (tự host). Cả hai chế độ đều dùng chung codebase CMS API và logic nghiệp vụ — chỉ khác nhau ở tầng adapter hạ tầng.

## Chọn chế độ triển khai

| Tiêu chí | Cloudflare Workers | Docker (Tự host) |
|----------|-------------------|---------------------|
| Độ trễ | Cực thấp (edge, PoPs toàn cầu) | Phụ thuộc vùng/nhà cung cấp |
| Mở rộng | Tự động, theo request | Thủ công hoặc do nền tảng quản lý |
| Chi phí | Trả theo request | Compute + storage cố định |
| Lưu trữ dữ liệu | Vùng Cloudflare | Toàn quyền kiểm soát |
| Phụ thuộc vendor | Hệ sinh thái Cloudflare | Bất kỳ nền tảng container nào |
| Phát triển local | Wrangler dev (hạn chế) | Full stack qua Docker Compose |
| Giám sát | Workers Analytics Engine | Prometheus + Grafana |
| Tìm kiếm | MeiliSearch Cloud (HTTP) | MeiliSearch tự host |
| Hàng đợi | Cloudflare Queues | BullMQ (Redis) |
| Xử lý media | CF Image Resizing | Imgproxy |

## Kiến trúc: Cloudflare Workers

```
┌─────────────────────────────────────────────────────────────────┐
│                        Cloudflare Edge                           │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │              Lumibase CMS (Hono.js Worker)                │  │
│  │                                                           │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌──────────────────┐  │  │
│  │  │   Routes    │  │ Middleware  │  │    Services      │  │  │
│  │  └──────┬──────┘  └──────┬──────┘  └────────┬─────────┘  │  │
│  │         └─────────────────┼──────────────────┘            │  │
│  │                           │                               │  │
│  │              ┌────────────▼────────────┐                  │  │
│  │              │  @lumibase/runtime      │                  │  │
│  │              │  (Cloudflare Adapter)   │                  │  │
│  │              └────────────┬────────────┘                  │  │
│  └───────────────────────────┼───────────────────────────────┘  │
│                              │                                   │
│  ┌───────────┐  ┌───────────▼───┐  ┌─────────────────────────┐ │
│  │  KV Cache │  │  Hyperdrive   │  │  R2 Object Storage      │ │
│  │           │  │  (PG Pooler)  │  │                         │ │
│  └───────────┘  └───────┬───────┘  └─────────────────────────┘ │
│                          │                                       │
└──────────────────────────┼───────────────────────────────────────┘
                           │
                  ┌────────▼────────┐
                  │   PostgreSQL    │
                  │  (Neon / Supabase)│
                  └─────────────────┘

Dịch vụ bên ngoài:
  ┌──────────────────┐  ┌──────────────────┐
  │ MeiliSearch Cloud│  │ Cloudflare Queues │
  └──────────────────┘  └──────────────────┘
```

## Kiến trúc: Docker (Tự host)

```
┌─────────────────────────────────────────────────────────────────┐
│                     Docker Host / Cluster                         │
│                                                                   │
│  ┌───────────────────────────────────────────────────────────┐   │
│  │              Lumibase CMS (Node.js + Hono)                │   │
│  │              Port 1989                                    │   │
│  │                                                           │   │
│  │              ┌────────────────────────────┐               │   │
│  │              │  @lumibase/runtime         │               │   │
│  │              │  (Docker Adapter)          │               │   │
│  │              └────────────┬───────────────┘               │   │
│  └───────────────────────────┼───────────────────────────────┘   │
│                              │                                    │
│         ┌────────────────────┼────────────────────┐              │
│         │                    │                    │              │
│  ┌──────▼──────┐  ┌─────────▼─────────┐  ┌──────▼──────┐       │
│  │    Redis    │  │    PostgreSQL     │  │    MinIO    │       │
│  │  Port 6379 │  │    Port 5432      │  │  Port 9000  │       │
│  │  (Cache +  │  │                   │  │  (S3-compat │       │
│  │   Queues)  │  │                   │  │   storage)  │       │
│  └─────────────┘  └───────────────────┘  └─────────────┘       │
│                                                                   │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │ MeiliSearch │  │  Imgproxy   │  │  Prometheus + Grafana   │  │
│  │  Port 7700  │  │  Port 8080  │  │  Ports 9090 / 3002     │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

## Tóm tắt Topology Dịch vụ

### Dịch vụ cốt lõi (Bắt buộc)

| Dịch vụ | Cloudflare | Docker |
|---------|-----------|--------|
| CMS API | Worker (edge) | Container Node.js |
| Cơ sở dữ liệu | PostgreSQL qua Hyperdrive | Container PostgreSQL 16 |
| Cache | Cloudflare KV | Redis 7 |
| Lưu trữ đối tượng | Cloudflare R2 | MinIO (tương thích S3) |

### Công cụ tích hợp (Docker)

| Dịch vụ | Port | Mục đích |
|---------|------|---------|
| MeiliSearch | 7700 | Tìm kiếm toàn văn |
| Imgproxy | 8080 | Chuyển đổi hình ảnh |
| BullMQ (qua Redis) | — | Hàng đợi tác vụ nền |
| Bull Board | 3001 | Giao diện giám sát hàng đợi |

### Observability Stack (Tùy chọn)

| Dịch vụ | Port | Mục đích |
|---------|------|---------|
| Prometheus | 9090 | Thu thập metrics |
| Grafana | 3002 | Dashboard và trực quan hóa |
| Loki | 3100 | Tổng hợp log |

## Chọn Runtime

Runtime được xác định bởi biến môi trường `LUMIBASE_RUNTIME`:

```bash
# Cloudflare Workers (mặc định khi deploy qua Wrangler)
LUMIBASE_RUNTIME=cloudflare

# Docker / tự host (mặc định khi LUMIBASE_RUNTIME không được set trong Node.js)
LUMIBASE_RUNTIME=docker
```

Runtime factory (`createRuntime(env)`) khởi tạo bộ adapter phù hợp khi khởi động. Toàn bộ logic nghiệp vụ, routes, và middleware giữ nguyên giữa hai chế độ.

## Bước tiếp theo

- [Hướng dẫn triển khai Cloudflare](./cloudflare.md) — Deploy lên Cloudflare Workers
- [Hướng dẫn triển khai Docker](./docker.md) — Deploy với Docker
- [Phát triển Local](./local-development.md) — Bắt đầu phát triển local với Docker Compose
- [Biến môi trường](./environment-variables.md) — Tham chiếu cấu hình đầy đủ
