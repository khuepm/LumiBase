# Tài liệu LumiBase

Tài liệu kỹ thuật cho LumiBase — Headless CMS Edge-native lấy cảm hứng từ Directus, **chạy được trên cả Cloudflare Workers và Docker self-hosted** thông qua một runtime abstraction layer chung.

> Mục tiêu: vượt Directus ở các mảng **No-code Collection Builder**, **Permissions theo field/JSON policy**, **Raw editor cho mọi field**, **Extension SDK an toàn**, **Display Templates**, **Realtime WebSocket** và **AI-First Copilot (HITL)** — đồng thời giữ DNA Edge-native, Multi-tenant nhưng cho phép tự host trên Docker khi cần.

## Cấu trúc tài liệu

- **Tầm nhìn & Định vị**
  - [vision-and-positioning.md](./vision-and-positioning.md) — So sánh Directus, định vị USP của LumiBase.
- **Kiến trúc**
  - [architecture/overview.md](./architecture/overview.md) — Tổng thể tech stack, các lớp, module, runtime abstraction.
  - [architecture/page-hydration.md](./architecture/page-hydration.md) — Hợp đồng API hydrate trang.
- **Mô hình dữ liệu**
  - [data-model.md](./data-model.md) — Schema lõi (sites, collections, fields, relations, permissions, presets, translations, files, revisions, activity, webhooks, extensions, flows, ai_approvals, v.v.).
- **Tính năng cốt lõi** (`features/`)
  - [collections-builder.md](./features/collections-builder.md) — No-code Collection Builder.
  - [field-types-and-config.md](./features/field-types-and-config.md) — Hệ thống field types & interface/display config.
  - [permissions-rbac.md](./features/permissions-rbac.md) — Roles, Policies, Permissions tới field.
  - [permission-builder-directus-investigation.md](./features/permission-builder-directus-investigation.md) — Điều tra Directus DB và blueprint Permission Builder nâng cao.
  - [access-manifest-v1.md](./features/access-manifest-v1.md) — JSON schema contract `lumibase.access@v1` cho import/export quyền.
  - [system-collections-access.md](./features/system-collections-access.md) — Phân nhóm system/sensitive collections cho seeding và Permission Builder.
  - [raw-data-editing.md](./features/raw-data-editing.md) — Raw editor cho mọi field.
  - [user-management.md](./features/user-management.md) — Quản lý user, invitation, SSO.
  - [extensions-system.md](./features/extensions-system.md) — SDK extension + sandbox.
  - [ai-copilot.md](./features/ai-copilot.md) — AI Chat + Human-in-the-Loop approvals.
  - [websockets-realtime.md](./features/websockets-realtime.md) — Realtime subscribe/publish.
- **API**
  - [api/hono-api-spec.md](./api/hono-api-spec.md) — REST/WS endpoints chuẩn hoá.
- **UI Studio**
  - [ui/README.md](../ui/README.md) — Bản thiết kế lại giao diện Lumibase Studio và đặc tả chi tiết các màn hình.
- **Vận hành** (`operations/`)
  - [operations/upgrades.md](./operations/upgrades.md) — Chính sách fixed-version, luồng nâng cấp Cloudflare/Docker, backup, migration và giới hạn rollback.
- **Lộ trình**
  - [roadmap/tasks.md](./roadmap/tasks.md) — Task list chi tiết theo phase.

## Apps & packages chính

| Package | Mô tả |
|---------|--------|
| `apps/cms` | Hono API — Cloudflare Workers & Docker |
| `apps/studio` | Admin SPA (React + Vite + TanStack Router) |
| `apps/docs` | Docs viewer (Vite, port 5174 dev) |
| `apps/landing` | Landing page (`lumibase.dev`) |
| `packages/runtime` | Abstraction layer (Cache, Storage, DB, Search, Queue, Media) |
| `packages/ai-skills` | Registry skill cho AI Copilot |
| `packages/shared` | Types, zod schemas, policy DSL |
| `packages/sdk` | JS SDK (REST + WS + typegen) |

## Nguyên tắc

1. **Config-as-Code first** — collection/field/permission export/import JSON/YAML.
2. **Multi-tenant** — mọi entity có `site_id`.
3. **Edge-friendly** — business logic qua `@lumibase/runtime`, không khoá Cloudflare.
4. **1-roundtrip** — API ưu tiên payload aggregated.
5. **HITL cho AI** — hành động nguy hiểm luôn qua approval workflow.
