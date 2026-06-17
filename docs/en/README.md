# LumiBase Documentation

Tài liệu kỹ thuật cho LumiBase — **Content Operating System (Content OS)** Edge-native: nơi AI agent *vận hành* nội dung còn con người đặt ý định, định gu và chịu trách nhiệm cuối. **Chạy được trên cả Cloudflare Workers và Docker self-hosted** thông qua một runtime abstraction layer chung.

> Từ **v0.5.0**, LumiBase được tái định nghĩa từ *Content Management System* → *Content Operating System*: đơn vị công việc là **ý định (intent/SLO)**, nội dung được **reconcile liên tục** về desired state, agent kiếm **autonomy theo cấp (L0–L4)**, và mọi byte nội dung đều có **lai lịch (provenance)**. Xem [ai-native-vision.md](./ai-native-vision.md).

> Mục tiêu: vượt Directus ở các mảng **No-code Collection Builder**, **Permissions theo field/JSON policy**, **Raw editor cho mọi field**, **Extension SDK an toàn (kèm Marketplace ký số)**, **Display Templates**, **Realtime WebSocket** và **AI-First Copilot (HITL)** — đồng thời giữ DNA Edge-native, Multi-tenant của LumiBase nhưng cho phép tự host trên Docker khi cần.

## Bắt đầu nhanh

- [getting-started.md](./getting-started.md) — Khởi tạo dự án LumiBase mới bằng `npm create lumibase@latest` (CLI `create-lumibase`), từ thư mục trống đến server chạy được (Docker hoặc Cloudflare Workers).

## Agent Setup (cho AI agent)

- [agent-setup/index.md](./agent-setup/index.md) — Trang tổng hợp thiết lập AI agent cho LumiBase.
- [agent-setup/prompt.md](./agent-setup/prompt.md) — Hướng dẫn máy đọc được (machine-readable), agent fetch và execute trực tiếp.
- [agent-setup/claude-code.md](./agent-setup/claude-code.md) · [cursor.md](./agent-setup/cursor.md) · [github-copilot.md](./agent-setup/github-copilot.md) · [codex.md](./agent-setup/codex.md) · [windsurf.md](./agent-setup/windsurf.md) — Hướng dẫn từng agent.
- [llms.txt](../llms.txt) — Index toàn bộ docs cho LLM. [en/llms.txt](./llms.txt) — Index English docs.

## Cấu trúc tài liệu

- **Vision & Định vị**
  - [vision-and-positioning.md](./vision-and-positioning.md) — So sánh Directus, định vị USP của LumiBase.
  - [ai-native-vision.md](./ai-native-vision.md) — Tầm nhìn Content OS: tái định nghĩa CMS cho kỷ nguyên AI (intent-driven, reconciliation, trust gradient, multi-agent, mission control).
- **Kiến trúc**
  - [architecture/overview.md](./architecture/overview.md) — Tổng thể tech stack, các lớp, module, runtime abstraction.
  - [architecture/page-hydration.md](./architecture/page-hydration.md) — Hợp đồng API hydrate trang.
  - [architecture/decisions/index.md](./architecture/decisions/index.md) — Architecture Decision Records (ADR-001 đến ADR-008).
- **Mô hình dữ liệu**
  - [data-model.md](./data-model.md) — Schema lõi (sites, collections, fields, relations, permissions, presets, translations, files, revisions, activity, webhooks, extensions, **flows, ai_approvals, materialized_collections, translation_memory, glossary**).
- **Tính năng cốt lõi** (`features/`)
  - [collections-builder.md](./features/collections-builder.md) — No-code Collection Builder.
  - [field-types-and-config.md](./features/field-types-and-config.md) — Hệ thống field types & interface/display config.
  - [permissions-rbac.md](./features/permissions-rbac.md) — Roles, Policies, Permissions tới field (JSON rule engine).
  - [access-manifest-v1.md](./features/access-manifest-v1.md) — JSON schema contract `lumibase.access@v1` for access import/export.
  - [system-collections-access.md](./features/system-collections-access.md) — System/sensitive collection grouping for seeding and Permission Builder.
  - [raw-data-editing.md](./features/raw-data-editing.md) — Raw editor cho mọi field.
  - [user-management.md](./features/user-management.md) — Quản lý user, invitation, SSO/Logto.
  - [extensions-system.md](./features/extensions-system.md) — SDK extension + phân quyền sandbox.
  - [system-config.md](./features/system-config.md) — Hệ thống config (settings, env, theming, modules).
  - [bookmarks-presets.md](./features/bookmarks-presets.md) — Bookmark/Preset cho list view.
  - [translations-i18n.md](./features/translations-i18n.md) — Đa ngôn ngữ field/UI/content.
  - [display-templates.md](./features/display-templates.md) — Template hiển thị (listing + detail).
  - [websockets-realtime.md](./features/websockets-realtime.md) — Realtime subscribe/publish + presence + collaborative cursors.
  - [typegen.md](./features/typegen.md) — Sinh `lumibase-types.ts` (schema → TypeScript) như Directus.
  - [cloudflare-auth.md](./features/cloudflare-auth.md) — Logto/Cloudflare auth integration.
- **Content OS (v0.5 — AI-native)** (`ai-native-vision.md` + `.kiro/specs/content-os/`)
  - [ai-native-vision.md](./ai-native-vision.md) — Tầm nhìn & 7 nguyên lý: intent-driven, reconciliation loop, trust gradient (L0–L4), tenant constitution, provenance-first, multi-agent newsroom, Studio as Mission Control.
  - [.kiro/specs/content-os/requirements.md](../../.kiro/specs/content-os/requirements.md) — 17 EARS requirements (provenance, real skills, queued runs, MCP server, content intents/SLO, trust ledger, veto window, kill switch, constitution, agent org).
  - [.kiro/specs/content-os/design.md](../../.kiro/specs/content-os/design.md) — Kiến trúc, bảng/cột mới (migrations `0019`–`0027`), control loop, evaluator pinning.
  - [.kiro/specs/content-os/tasks.md](../../.kiro/specs/content-os/tasks.md) — 20 nhóm task theo module A–E.
- **Tính năng nâng cao (POST-GA / Dual-runtime)** (`features/`)
  - [ai-copilot.md](./features/ai-copilot.md) — AI Chat + Human-in-the-Loop approvals (Studio Copilot).
  - [agent-harness-layer.md](./features/agent-harness-layer.md) — Agent goals, runs, tools, memory, approvals, artifacts, evaluations, and app generation governance.
  - [runtime-abstraction.md](./features/runtime-abstraction.md) — Lớp `@lumibase/runtime` cho phép chạy trên Cloudflare và Docker.
  - [flows-automation.md](./features/flows-automation.md) — Flows / Operations engine (workflow automation).
  - [marketplace.md](./features/marketplace.md) — Marketplace extensions có ký số (signed bundles).
  - [scim-provisioning.md](./features/scim-provisioning.md) — SCIM 2.0 user/group provisioning.
  - [search.md](./features/search.md) — Full-text search (MeiliSearch self-host hoặc CF managed).
  - [translation-memory.md](./features/translation-memory.md) — Translation Memory + glossary + MT providers.
  - [materialized-collections.md](./features/materialized-collections.md) — Materialized read tables cho hot path.
  - [firebase-sync.md](./features/firebase-sync.md) — Sync content (`items`) sang Firebase Firestore/RTDB theo thời gian thực.
  - [observability.md](./features/observability.md) — Metrics, logs, dashboards (Prometheus/Grafana/Loki).
  - [ai-first-specification.md](./features/ai-first-specification.md) — Đặc tả gốc cho AI agent triển khai (lịch sử).
- **ClickHouse CDC** (`cdc/`)
  - [cdc/README.md](./cdc/README.md) — Tổng quan CDC + bảng tiêu chí chọn approach (Debezium+Kafka / Materialized Engine / Airbyte).
  - [cdc/architecture.md](./cdc/architecture.md) — Kiến trúc, sơ đồ hệ thống, deployment topology.
  - [cdc/environment-variables.md](./cdc/environment-variables.md) — Tham chiếu biến môi trường theo từng approach.
  - [cdc/troubleshooting.md](./cdc/troubleshooting.md) — Xử lý lỗi replication slot, kết nối, sync, schema drift.
  - Setup: [Debezium+Kafka](./cdc/setup-debezium-kafka.md) · [Materialized Engine](./cdc/setup-materialized-engine.md) · [Airbyte](./cdc/setup-airbyte.md).
  - Deployment: [Docker Compose / managed services](./cdc/deployment-docker-compose.md) · [Cloudflare Workers (edge only)](./cdc/deployment-cloudflare-workers.md).
- **SDK** (`sdk/`)
  - [sdk/index.md](./sdk/index.md) — SDK overview.
  - [sdk/javascript.md](./sdk/javascript.md) — JS/TS SDK đầy đủ (auth, items, files, realtime, AI Copilot, Flows).
  - [sdk/typegen.md](./sdk/typegen.md) — Sinh TypeScript types từ schema live.
- **API**
  - [api/hono-api-spec.md](./api/hono-api-spec.md) — REST/WS endpoints chuẩn hoá với đầy đủ request/response examples.
- **UI Studio**
  - [ui/README.md](../ui/README.md) — Spec for the redesigned Lumibase Studio and detailed screen specifications.
  - [en/ui/studio-ui-spec.md](./ui/studio-ui-spec.md) — Original page structure, modules, layouts, components, and state.
- **Triển khai** (`deployment/`)
  - [deployment/overview.md](./deployment/overview.md) — Tổng quan các target Cloudflare Workers, Cloudflare Pages và Docker.
  - [deployment/cloudflare.md](./deployment/cloudflare.md) — Lệnh build/deploy CMS Worker và docs Pages.
  - [deployment/docker.md](./deployment/docker.md) — Chạy CMS API ở Docker/self-hosted mode.
  - [deployment/private-admin-path.md](./deployment/private-admin-path.md) — Quy tắc bảo mật cho private admin path và production no-redirect.
  - [deployment/environment-variables.md](./deployment/environment-variables.md) — Biến môi trường và bindings.
  - [deployment/local-development.md](./deployment/local-development.md) — Quy trình local dev và kiểm tra trước deploy.
- **Operations** (`operations/`)
  - [operations/upgrades.md](./operations/upgrades.md) — Fixed-version upgrade policy, Cloudflare/Docker flows, backup, migrations, and rollback limits.
- **Đóng góp** (`contributing/`)
  - [contributing/index.md](./contributing/index.md) — Setup, branching, commit conventions, PR checklist.
  - [contributing/code-style.md](./contributing/code-style.md) — TypeScript, naming, service patterns.
  - [contributing/testing.md](./contributing/testing.md) — Vitest unit, property-based, integration tests.
  - [contributing/extension-dev.md](./contributing/extension-dev.md) — Build custom extensions (interface, display, operation, hook, endpoint).
- **Lộ trình**
  - [roadmap/tasks.md](./roadmap/tasks.md) — Task list chi tiết theo phase (Phase 0 → POST-GA + Dual-deployment + AI Copilot).
  - [roadmap/consumer-sdk.md](./roadmap/consumer-sdk.md), [roadmap/phase-d1-users.md](./roadmap/phase-d1-users.md), [roadmap/studio-content-slices.md](./roadmap/studio-content-slices.md).

## Apps & packages của monorepo

- **`apps/cms`** — Hono API, build cho cả Cloudflare Workers (Wrangler) và Node.js (Docker container).
- **`apps/studio`** — Admin SPA (React + Vite + TanStack Router). AI Copilot panel + module Access Control + Content + Files + Settings + Translations + Users.
- **`apps/docs`** — Vite docs viewer phục vụ `docs/` này lên web (port 5174 dev).
- **`apps/landing`** — Next.js landing page (`lumibase.dev`).
- **`apps/consumer`** — Next.js demo consumer (delivery API + SDK usage example), thay thế cho `apps/web` cũ.
- **`packages/database`** — Drizzle ORM schema + migrations (Postgres).
- **`packages/runtime`** — Abstraction layer (CacheProvider, StorageProvider, DatabaseProvider, SearchProvider, QueueProvider, MediaProcessor) với hai bộ adapter (Cloudflare và Docker).
- **`packages/ai-skills`** — Registry skill cho AI Copilot (CORE_SKILLS) + tool definitions OpenAI-compatible.
- **`packages/shared`** — Types, zod schemas, policy DSL, field DSL.
- **`packages/sdk`** — JS SDK (REST + WS + typegen).
- **`packages/ui`** — shadcn components + CVA tokens.
- **`packages/extension-sdk`** — Types và helpers cho dev viết extension.
- **`packages/create-lumibase`** — CLI bootstrap (`npm create lumibase@latest`) sinh dự án LumiBase mới từ template Docker hoặc Cloudflare Workers. Xem [getting-started.md](./getting-started.md).
- **`packages/mcp-server`** — MCP stdio server (`@lumibase/mcp-server`) expose tool cho AI assistant tạo/quản lý collections, fields, items.

## Nguyên tắc khi đọc tài liệu

1. **Config-as-Code first**: tất cả collection/field/permission đều export/import được dưới dạng JSON/YAML (xem `apps/cms/scripts/config-cli.ts`).
2. **Multi-tenant**: mọi entity domain đều có `site_id`, mọi query/cache key bao gồm `site_id`.
3. **Edge-friendly nhưng không khoá Cloudflare**: code business logic không phụ thuộc trực tiếp KV/R2/Hyperdrive — đi qua `@lumibase/runtime` nên chạy được cả Docker.
4. **1-roundtrip**: Studio và Delivery API ưu tiên trả payload aggregated.
5. **Backward-compat**: Mọi thay đổi schema phải đi qua revision/migration system.
6. **HITL cho AI**: hành động AI nguy hiểm (`schema:write`, `delete*`) luôn phải qua approval workflow trong bảng `ai_approvals`.
