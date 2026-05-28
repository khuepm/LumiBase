# LumiBase — Architecture (root summary)

Bản tóm tắt kiến trúc cho LumiBase. Chi tiết theo từng tầng xem trong `docs/`.

## Components

### Apps

- **`apps/cms`** — Hono.js API. Chạy được trên hai runtime:
  - **Cloudflare Workers** (entry: `src/index.ts` qua Wrangler) — dùng KV, R2, Hyperdrive, Durable Objects, Queues.
  - **Node.js / Docker** (entry: `src/serve.ts` qua `@hono/node-server`) — dùng Redis, MinIO/S3, PostgreSQL pool, MeiliSearch, BullMQ.
  - Việc chọn runtime do biến môi trường `LUMIBASE_RUNTIME` quyết định, qua middleware `withRuntime()` và factory `createRuntime(env)` trong `@lumibase/runtime`.
- **`apps/studio`** — React 18 + Vite + TS + Tailwind + shadcn/ui + TanStack Router. Admin SPA, không SSR. Có AI Copilot panel + Approvals dashboard.
- **`apps/docs`** — Vite + React docs viewer. Đọc Markdown từ `docs/` qua `vite-plugin-docs-loader`. Static build, deploy lên CDN.
- **`apps/landing`** — Next.js landing page cho `lumibase.dev`.
- **`apps/consumer`** — Next.js delivery demo — đại diện workload thực tế dùng SDK và Page Hydration API. Thay thế cho `apps/web` cũ.

### Packages

- **`packages/database`** — Drizzle schema + migrations. Tách theo domain: `core.ts` (sites/users/teams), `access.ts` (roles/policies/permissions/scim_tokens), `cms.ts` (collections/fields/items/flows/operations/materialized), `platform.ts` (files/presets/translations/settings/webhooks/extensions/translation-memory/glossary), `ai.ts` (ai_approvals/ai_conversations/ai_messages/ai_embeddings).
- **`packages/runtime`** — Runtime abstraction layer. Định nghĩa các interface `CacheProvider`, `StorageProvider`, `DatabaseProvider`, `SearchProvider`, `QueueProvider`, `MediaProcessor` và hai bộ adapter (Cloudflare, Docker). Factory `createRuntime(env)`.
- **`packages/ai-skills`** — CORE_SKILLS registry cho AI Copilot. Mỗi skill khai báo `requiredCapabilities`, `parameters` (JSON Schema OpenAI-compatible), `description`.
- **`packages/shared`** — types, zod schemas, policy DSL, field DSL (dùng chung BE/FE/SDK).
- **`packages/sdk`** — JS SDK (REST + WS) cho client/extension + typegen core.
- **`packages/ui`** — shadcn components + CVA tokens.
- **`packages/extension-sdk`** — types & helpers cho dev viết extension.

## Interactions

```
Studio (React)        ──HTTPS──┐
Consumer (Next.js)    ──HTTPS──┤
Docs viewer (static)  ──HTTPS──┤
3rd-party SDK         ──HTTPS──┼──► apps/cms (Hono)
SCIM (Okta/AzureAD)   ──HTTPS──┤        │
                               │        ├── @lumibase/runtime
                               │        │     ├── DatabaseProvider → Postgres (Hyperdrive | pg pool)
                               │        │     ├── CacheProvider    → Cloudflare KV | Redis
                               │        │     ├── StorageProvider  → R2 | MinIO/S3
                               │        │     ├── SearchProvider   → MeiliSearch (cloud | self-host)
                               │        │     ├── QueueProvider    → CF Queues | BullMQ on Redis
                               │        │     └── MediaProcessor   → CF Image Resizing | Imgproxy
                               │        │
                               │        └── Durable Object per site (realtime room) — Cloudflare only
                               │
Studio/Consumer ◄──WSS──── apps/cms /api/v1/realtime
```

## Design rationales

- **Edge-first nhưng không lock-in**: tất cả service đi qua `@lumibase/runtime`, business logic và route không gọi trực tiếp KV/R2/Hyperdrive nữa. Self-host bằng Docker là first-class deployment option.
- **Multi-tenant by default**: `site_id` ở mọi entity domain; mọi cache key chứa `site_id`. Postgres RLS bổ sung defence-in-depth.
- **Config-as-Code**: collections, roles, policies, settings export/import được (NDJSON qua `/api/v1/admin/backup` + `apps/cms/scripts/config-cli.ts`).
- **1-roundtrip page hydration**: Delivery API trả layout + data trong 1 payload.
- **No DDL runtime**: collection/field thay đổi không tạo bảng vật lý; dùng JSONB + virtual schema. Hot path có thể opt-in `materialized_collections` (xem `docs/features/materialized-collections.md`).
- **Capability sandbox cho extension** thay vì trust toàn bộ code; bundles được ký số (ed25519/RSA-PSS) khi qua marketplace.
- **Policy DSL** thay vì code rule cứng — cho phép field-level + row-level + time/IP-bound.
- **AI HITL**: AI Copilot không bao giờ thực thi trực tiếp các skill nguy hiểm. Mỗi yêu cầu nguy hiểm sinh một hàng `ai_approvals` chờ admin duyệt (xem `docs/features/ai-copilot.md`).

## State & coupling notes

- Permission cache là global state quan trọng → bắt buộc invalidate qua KV/Redis write + WS broadcast `permissions.changed`.
- Drizzle helper `scopeSite(siteId)` là tight contract; mọi service phải dùng để tránh leak cross-tenant.
- Tránh global mutable singleton trong Worker; mọi context (db, runtime, siteId, auth) truyền qua Hono `c.set/get`.
- Studio gọi `usePermissions()` (`apps/studio/src/lib/use-permissions.ts`) để hydrate `/permissions/me`; module **Access Control** (`apps/studio/src/modules/access/`) quản lý Roles, Policies, Permission Matrix, Test Sandbox. Hook là single source of truth cho UI gating (column hide, field disable, bulk action lock) — đừng fork logic ở chỗ khác.
- AI Harness (`apps/cms/src/services/ai-harness.ts`) là stateless service được khởi tạo per-request; mọi truy vấn `ai_approvals` đều scope `siteId` và không bao giờ tiết lộ bản ghi cross-tenant.

## Update policy

File này phải được cập nhật khi:
1. Thêm/đổi app hoặc package.
2. Thay đổi cách giao tiếp giữa các thành phần.
3. Thay đổi nền tảng (Workers → Node, KV → Redis, …) hoặc thêm runtime mới.
4. Thêm provider interface mới trong `@lumibase/runtime`.
