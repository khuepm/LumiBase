---
title: Tổng quan Kiến trúc
---

# Tổng quan Kiến trúc

## 1. Sơ đồ tầng

```
┌──────────────────────────────────────────────────────────────────┐
│ Clients (Các ứng dụng client)                                    │
│  - apps/studio    (React + Vite + TanStack Router) — giao diện admin │
│  - apps/consumer  (Next.js)  — demo delivery                     │
│  - apps/docs      (Vite SPA) — trang tài liệu                    │
│  - apps/landing   (Next.js)  — trang chủ công khai               │
│  - SDK bên thứ ba / SCIM / webhooks                              │
└───────────────▲──────────────────────────────▲───────────────────┘
                │ REST + Hydration             │ WSS realtime
┌───────────────┴──────────────────────────────┴───────────────────┐
│ apps/cms — Hono.js                                               │
│   Hai điểm khởi động:                                            │
│     • src/index.ts  → Cloudflare Workers (wrangler dev/deploy)   │
│     • src/serve.ts  → Node.js / Docker (@hono/node-server)       │
│                                                                  │
│ Các Router:                                                      │
│   /auth            (Logto OIDC)                                  │
│   /collections /fields /relations  (schema admin)                │
│   /items/:collection                (CRUD content)               │
│   /typegen                          (TS types from schema)       │
│   /permissions /roles /policies                                  │
│   /users /teams                                                  │
│   /files /media /assets             (R2 / S3-MinIO storage)      │
│   /presets /bookmarks /translations                              │
│   /settings /extensions /webhooks /activity                      │
│   /flows /marketplace /materialize  (POST-GA)                    │
│   /search                           (MeiliSearch)                │
│   /tm                               (Translation Memory)         │
│   /ai                               (AI Copilot + HITL approvals)│
│   /admin/backup /admin/restore      (config GitOps)              │
│   /deliver/page/:slug               (1-roundtrip)                │
│   /realtime                         (WS upgrade)                 │
│   /metrics                          (Prometheus)                 │
│   /health                           (liveness probe)             │
│   /scim/v2/*                        (SCIM 2.0 provisioning)      │
│                                                                  │
│ Thứ tự Middleware:                                               │
│   logger → metrics → runtime → cors → tenant → auth → db → rls   │
│                                                                  │
│ Các Service:                                                     │
│   SchemaService, PermissionService, ItemService, RevisionService,│
│   ActivityService, ExtensionRuntime, FlowService, AISecureHarness│
│   TranslationMemory, CursorProtocol, Validation, Conditions,     │
│   CryptoService (per-field encryption), Template, Typegen        │
└───────────────▲──────────────────────────────▲───────────────────┘
                │ DatabaseProvider             │ Cache/Storage/Queue/Search/Media
                │                              │
┌───────────────┴──────────┐      ┌────────────┴────────────────────┐
│ Postgres                 │      │ @lumibase/runtime adapters       │
│  - Hyperdrive (CF mode)  │      │  Cloudflare      | Docker        │
│  - pg pool   (Docker)    │      │  ─────────────── | ────────────  │
│ packages/database        │      │  KV              | Redis         │
└──────────────────────────┘      │  R2              | MinIO/S3      │
                                  │  CF Queues       | BullMQ        │
                                  │  MeiliSearch     | MeiliSearch   │
                                  │  CF Image Resize | Imgproxy      │
                                  │  Durable Objects | (host process)│
                                  └──────────────────────────────────┘
```

## 2. Cấu trúc Monorepo

```
lumibase/
├── apps/
│   ├── cms/                  # Hono API — runs on Workers AND Node/Docker
│   │   └── src/
│   │       ├── routes/       # /collections, /items, /ai, /flows, /search, ...
│   │       ├── services/     # SchemaService, AISecureHarness, FlowService, ...
│   │       ├── middleware/   # auth, db, logger, rls, runtime, tenant
│   │       ├── realtime/     # SiteRoom (Durable Object) — CF only
│   │       ├── extensions/   # runtime loader + sandbox
│   │       ├── index.ts      # Cloudflare Workers entrypoint
│   │       └── serve.ts      # Node/Docker entrypoint
│   ├── studio/               # React + Vite admin SPA
│   │   └── src/
│   │       ├── modules/      # content, data-model, access, automation, files,
│   │       │                 # users, settings, translations
│   │       ├── components/   # AppShell, AI Assistant, presence, ...
│   │       ├── interfaces/   # field interfaces registry
│   │       ├── displays/     # field displays registry
│   │       ├── layouts/      # tabular/cards/kanban/calendar/map
│   │       └── lib/          # api client, ws client, policy eval, use-permissions
│   ├── consumer/             # Next.js delivery demo
│   ├── docs/                 # Vite docs viewer (this site)
│   └── landing/              # Next.js landing page
├── packages/
│   ├── database/             # Drizzle schemas + migrations
│   │   └── src/schema/       # core, access, cms, platform, ai
│   ├── runtime/              # Abstraction layer (CacheProvider/Storage/...)
│   │   └── src/adapters/     # cloudflare/, docker/
│   ├── ai-skills/            # CORE_SKILLS registry for AI Copilot
│   ├── shared/               # types, zod schemas, policy DSL, field DSL
│   ├── ui/                   # shadcn + cva tokens
│   ├── sdk/                  # JS SDK (REST+WS) cho client/extension
│   └── extension-sdk/        # types + helpers cho dev extension
├── docker/                   # Dockerfile, docker-compose.{yml,monitoring,prod}
│   ├── prometheus/  grafana/ scripts/
└── docs/
```

## 3. Các tầng logic chính (apps/cms)

1. **Schema layer** — quản lý `collections`, `fields`, `relations`, sinh ra "virtual schema" trong cache.
2. **Item layer** — CRUD generic dựa trên virtual schema; build query Drizzle động. Hỗ trợ `materialized_collections` cho hot path.
3. **Permission layer** — đánh giá Policy DSL trước mỗi hành động; trả về **field mask** (read/write).
4. **Delivery layer** — endpoints public, áp permission của role "public" + cache-tag.
5. **Realtime layer** — Cloudflare Durable Object per `site_id` (mode `cloudflare`); broadcast event chuẩn hoá. Có protocol cho **collaborative cursors** (CRDT-lite, last-write-wins + Y-style update vector).
6. **Extension layer** — load manifest, mount routes/hooks/UI vào registry; gate bằng capability. Tích hợp Marketplace có ký số.
7. **AI layer** — `AISecureHarness` đánh giá rủi ro, kiểm tra capability, chặn HITL cho skill nguy hiểm. Skills được khai báo trong `@lumibase/ai-skills`.
8. **Flows layer** — graph các operation (condition, transform, http, mail, log, sleep, run-extension, item.*, notify) chạy theo trigger (webhook, event, schedule, manual).
9. **Search layer** — đẩy/đồng bộ index lên MeiliSearch khi item đổi; tự động re-index qua queue.
10. **Translation Memory layer** — TM + glossary + MT provider chain (DeepL, OpenAI, Workers AI, echo fallback).

## 4. Caching & Vô hiệu hoá cache

- Cache keys: `schema:{site}:{collection}`, `perm:{site}:{role}:{collection}`, `settings:{site}` — qua `CacheProvider` (KV trên Cloudflare, Redis trên Docker).
- Tag-based: mỗi item ghi tag `item:{site}:{collection}:{id}`, mutation phát event → invalidate cache + revalidate Next.js tag (qua webhook tới `apps/consumer`).
- WebSocket cũng phát cùng event ⇒ client realtime + cache đồng bộ.

## 5. Lớp trừu tượng Runtime (Cloudflare ↔ Docker)

`@lumibase/runtime` định nghĩa 6 interface:

| Interface | Cloudflare adapter | Docker adapter |
|-----------|--------------------|----------------|
| `CacheProvider` | Cloudflare KV | Redis (ioredis) |
| `StorageProvider` | R2 | S3-compatible MinIO (`@aws-sdk/client-s3`) |
| `DatabaseProvider` | Hyperdrive connection | pg pool (`postgres`) |
| `SearchProvider` | MeiliSearch Cloud (HTTP) | MeiliSearch (self-host) |
| `QueueProvider` | Cloudflare Queues | BullMQ on Redis |
| `MediaProcessor` | CF Image Resizing | Imgproxy (signed URLs) |

Factory `createRuntime(env)` trong `packages/runtime/src/factory.ts` quyết định adapter theo `env.LUMIBASE_RUNTIME` (`cloudflare` | `docker`). Middleware `withRuntime()` inject `RuntimeContext` vào `c.set('runtime', ...)`. Toàn bộ route + service đọc qua `c.get('runtime').<provider>`.

Xem [features/runtime-abstraction.md](../features/runtime-abstraction.md) để biết chi tiết.

## 6. Đa Tenant (Multi-tenancy)

- `site_id` truyền qua subdomain hoặc header `X-Lumi-Site`.
- Middleware `withTenant()` gắn `c.set('siteId', …)` và inject vào mọi service.
- Drizzle helper `scopeSite(siteId)` wrap query builder để bắt buộc filter.
- Middleware `withRls()` set Postgres session var để áp dụng RLS policies bổ sung.

## 7. Bảo mật

- Logto JWT validate ở edge (JWKS cache qua `CacheProvider`).
- CSRF cho Studio (same-origin + token).
- Per-field encryption (AES-GCM, key in Workers Secret hoặc env var) cho field flagged `sensitive: true`.
- Extension chạy trong **isolated module** (dynamic import từ R2/S3), bị giới hạn bởi capability manifest. Marketplace bundles phải có signature ed25519/RSA-PSS hợp lệ.
- SCIM token riêng (`SCIM_TOKEN` env), không dùng Logto JWT pipeline.
- AI HITL: skill nguy hiểm (capability `schema:write` hoặc tên bắt đầu bằng `delete`) bắt buộc qua `ai_approvals`.

## 8. Quan sát hệ thống (Observability)

- **Cloudflare**: Workers Logpush (JSON logs) + Workers Analytics Engine (metrics).
- **Docker**: `/metrics` Prometheus endpoint + Loki/Promtail cho log + Grafana dashboard pre-provisioned (request rate, latency p50/p95/p99, error rate, queue depth, cache hit ratio).
- Activity table cho audit nghiệp vụ.
- Health check `/health` test kết nối tới DB, cache, search, storage, queue.

Xem [features/observability.md](../features/observability.md) để biết chi tiết stack monitoring.
