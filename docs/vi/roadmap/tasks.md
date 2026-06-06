# Roadmap & Task Breakdown

> **Scope:** Roadmap này dành cho **LumiBase Studio** — admin panel để quản lý data, collections, permissions, v.v. — và **LumiBase CMS API** chạy được trên cả Cloudflare Workers và Docker.
>
> **Consumer app (frontend end-user)** ở `apps/consumer` (Next.js) là demo dùng SDK để gọi Delivery API — **không phải** CMS Studio.
>
> Ngôn ngữ task: ngắn, có thể chuyển thẳng vào issue tracker. Mỗi task có **scope rõ ràng**, **deliverable**, và link tài liệu liên quan.

Quy ước:
- `[BE]` apps/cms (Backend API - Hono)
- `[FE]` apps/studio (Admin panel - React + Vite)
- `[DB]` packages/database
- `[RT]` packages/runtime (abstraction layer Cloudflare/Docker)
- `[AI]` packages/ai-skills + AI Copilot
- `[SDK]` packages/sdk (Type-safe client cho cả Studio và consumer apps)
- `[DOC]` apps/docs hoặc tài liệu trong `docs/`
- `[OPS]` infra/deploy/CI
- Mỗi PR nên gắn 1 nhánh `feature/<phase>-<short-name>` theo Git hygiene rule.

Trạng thái tổng quan: Phase 0 → Phase G (GA hardening) đã xong. POST-GA và Dual Deployment + AI Copilot đã hoàn thành. Hiện tại tập trung vào polish, dev experience và mở rộng marketplace.

---

## Phase 0 — Foundation (DONE)

Mục tiêu: bộ khung monorepo chạy được, schema lõi, auth Logto, CI.

- [x] `[OPS]` Tạo `apps/cms` (Hono + Cloudflare Workers template + wrangler config).
- [x] `[OPS]` Tạo `apps/studio` (Vite + React + TS + Tailwind + shadcn init).
- [x] `[OPS]` Tạo `packages/shared`, `packages/sdk`, `packages/ui`, `packages/extension-sdk` (boilerplate + tsconfig + lint).
- [x] `[DB]` Bổ sung schema: `users`, `user_sites`, `teams`, `team_members`, `roles`, `policies`, `role_policies`, `user_policies`, `permissions` (xem `data-model.md`).
- [x] `[DB]` Drizzle migration runner cho Hyperdrive (local + remote scripts).
- [x] `[BE]` Middleware `withAuth` (Logto JWKS), `withTenant` (`site_id` từ subdomain/header), `withLogger`.
- [x] `[BE]` `GET /auth/me` + `GET /utils/health`.
- [x] `[FE]` App shell + module bar + routing skeleton + Logto login flow.
- [x] `[FE]` API client trong `packages/sdk` (fetch wrapper, error format, site header).
- [x] `[OPS]` Pipeline CI (lint, typecheck, test, build) + preview deploy.
- [x] `[DOC]` Cập nhật `architecture.md` (root) khi cấu trúc thay đổi.

---

## Phase A — Schema engine (DONE)

Mục tiêu: tạo/quản lý collection & field qua API + UI.

- [x] `[DB]` Bảng `collections`, `fields`, `relations`.
- [x] `[BE]` `SchemaService` (CRUD + compile cache).
- [x] `[BE]` Endpoints `/collections`, `/fields`, `/relations`.
- [x] `[BE]` Endpoint diff `/collections/diff` + `PUT /collections/:name/schema`.
- [x] `[BE]` Validation tên collection/field, kiểm tra dependency khi xoá.
- [x] `[SDK]` Type-safe client cho schema.
- [x] `[BE]` Script CLI `apps/cms/scripts/typegen.ts` + alias `lumibase typegen`.
- [x] `[FE]` Module *Settings → Data Model* (list collection).
- [x] `[FE]` Collection wizard 3 bước.
- [x] `[FE]` Collection detail tabs (Fields, Display, Archive, Raw JSON).
- [x] `[FE]` Field inspector cơ bản (interfaces `input`, `input-multiline`, `toggle`, `select-dropdown`, `datetime`, `json-raw`).
- [x] `[FE]` Live JSON pane (Monaco) cho schema collection, two-way sync.
- [x] `[FE]` Drag-drop reorder field (dnd-kit).
- [x] `[BE]` Endpoint `GET /typegen/schema` (manifest đã apply permission).
- [x] `[SDK]` Generator core `packages/sdk/src/typegen/`.
- [x] `[FE]` Trang *Settings → Developer → Types* (preview + download).

---

## Phase B — Items & Field system mở rộng (DONE)

- [x] `[DB]` Bảng `items`, `revisions`, `activity` + indexes GIN.
- [x] `[BE]` `ItemService` build query Drizzle động (fields, filter, sort, paginate, deep).
- [x] `[BE]` Endpoints `/items/:collection` đầy đủ.
- [x] `[BE]` Revision write + revert.
- [x] `[BE]` Activity log middleware cho mutation.
- [x] `[BE]` Validation pipeline (Zod + JSONata) chạy server-side.
- [x] `[BE]` Conditions evaluator (server + helper xuất sang client).
- [x] `[BE]` Per-field encryption service (AES-GCM, key Workers Secret/env).
- [x] `[FE]` Content module list view (tabular layout) + filter builder + sort + paginate.
- [x] `[FE]` Detail editor + tabs side panel (Revisions, Raw JSON).
- [x] `[FE]` Interface registry hoàn chỉnh: text, number, choice, boolean, date, relation, file, json-raw, code, wysiwyg, markdown, slug, color, tags, rating, repeater, presentation.
- [x] `[FE]` Display registry: formatted-value, raw, boolean-icon, datetime, image, labels, mustache-template.
- [x] `[FE]` Raw toggle component (Monaco) cho mọi interface.
- [x] `[FE]` Bulk raw editor cho toàn item.
- [x] `[FE]` Revisions diff viewer.
- [x] `[FE]` Mustache display template editor.
- [x] `[BE]` `POST /utils/render-template` (mustache only Phase B).

---

## Phase C — Permissions & Access (DONE)

- [x] `[BE]` `PermissionService` (compile rule, cache, field mask).
- [x] `[BE]` Endpoints CRUD `/roles`, `/policies`, `/policies/:id/permissions`, attach/detach.
- [x] `[BE]` `GET /permissions/me` + `POST /permissions/check` (trace).
- [x] `[BE]` Tích hợp Permission vào ItemService (where injection + post-check).
- [x] `[BE]` Magic vars `$CURRENT_USER`, `$CURRENT_SITE`, `$CURRENT_ROLE`, `$NOW`, `$IP`, `$HEADERS.*`.
- [x] `[BE]` Time-bound + IP allow/deny ở policy level.
- [x] `[BE]` Permission compose rules.
- [x] `[FE]` Module Access Control: Roles, Policies (GUI + JSON Monaco), Permission matrix, Test sandbox.
- [x] `[FE]` Field-level hide/disable trong form theo `/permissions/me`.
- [x] `[FE]` List view hide column nếu không có quyền read field.
- [x] `[FE]` Hide/disable bulk action theo permission.

---

## Phase C2 — Presets, Bookmarks, Translations cơ bản (DONE)

- [x] `[DB]` Bảng `presets`, `translations`.
- [x] `[BE]` CRUD `/presets`, scope resolution (user > role > site).
- [x] `[BE]` CRUD `/translations` (namespace `ui`, `field`, `content`).
- [x] `[BE]` Locale settings (`settings.locales.*`).
- [x] `[FE]` Preset switcher + save/edit dialog ở list view.
- [x] `[FE]` Module Translations (UI strings tab + content tab JSONB).
- [x] `[FE]` Interface `translatable-text` (JSONB map locale).
- [x] `[FE]` i18n cho Studio UI (react-i18next bind to translations API).

---

## Phase D — Users, Files, Settings (DONE)

- [x] `[BE]` `/users`, `/users/invite`, `/users/:id/impersonate`, sessions.
- [x] `[BE]` `/teams`, `/team_members`.
- [x] `[BE]` Files: presigned R2/S3 upload, `/files`, `/assets/:id` transform, `/media` (StorageProvider abstraction).
- [x] `[BE]` Settings storage + cache + `settings.changed` event.
- [x] `[BE]` Webhooks CRUD + dispatcher (Queues / BullMQ).
- [x] `[BE]` Activity log endpoint (filter, paginate).
- [x] `[FE]` Module Users + Teams.
- [x] `[FE]` Module Files (grid + folders + drag-drop upload).
- [x] `[FE]` Module Settings (general, locales, security, files, webhooks, activity).
- [x] `[FE]` Notifications inbox (qua realtime).

---

## Phase E — Realtime / WebSocket (DONE)

- [x] `[OPS]` Tạo Durable Object class `SiteRoom` (Wrangler binding).
- [x] `[BE]` Endpoint `/realtime` upgrade WS, route tới DO theo `siteId`.
- [x] `[BE]` Protocol subscribe/unsubscribe/presence.
- [x] `[BE]` Publish pipeline trong ItemService.commit().
- [x] `[BE]` Permission re-check khi fan-out event.
- [x] `[BE]` Rate limit + heartbeat.
- [x] `[SDK]` Client realtime trong `packages/sdk`.
- [x] `[FE]` Hook `useRealtimeSubscription`, `usePresence`.
- [x] `[FE]` Presence chip topbar + detail editor.
- [x] `[FE]` List view "Live mode" toggle.
- [x] `[FE]` Smart preset subscribe.
- [x] `[FE]` Notifications realtime.

---

## Phase F — Extensions & Display Templates nâng cao (DONE)

- [x] `[DB]` Bảng `extensions`.
- [x] `[BE]` Extension uploader (multipart → R2/S3) + manifest validator + capability registry.
- [x] `[BE]` Sandbox loader (dynamic import + proxy ctx + capability gate).
- [x] `[BE]` Hook dispatcher tích hợp ItemService (`before/after`).
- [x] `[BE]` Endpoint mount `/extensions/:name/*` từ extension type `endpoint`.
- [x] `[BE]` `/utils/render-template` hỗ trợ component DSL.
- [x] `[FE]` Module Settings → Extensions (upload, review caps, enable/disable, version).
- [x] `[FE]` Dynamic loader UI extensions (interface/display/layout/panel/module).
- [x] `[FE]` Display template editor mode component (block builder).
- [x] `[DOC]` Tutorial "Build your first extension" trong `docs/features/extensions-system.md`.

---

## Phase G — Hardening & GA (DONE)

- [x] `[BE]` Postgres RLS policies bổ sung qua middleware `withRls()` (defence-in-depth).
- [x] `[BE]` Tag-based invalidation hoàn thiện (revalidateTag webhook → Next.js consumer).
- [x] `[BE]` Backups + restore qua endpoints `/api/v1/admin/backup` + `/api/v1/admin/restore` (NDJSON bundle).
- [x] `[BE]` Config export/import CLI (`apps/cms/scripts/config-cli.ts`).
- [x] `[FE]` Accessibility audit + fix.
- [x] `[FE]` Bundle size audit, lazy module splitting (TanStack Router lazy-load).
- [x] `[OPS]` Load test (k6) cho delivery API và realtime — `apps/cms/k6/`.
- [x] `[OPS]` SLO dashboards (Workers Analytics Engine + Grafana cho Docker).
- [x] `[DOC]` Public docs site (`apps/docs` — Vite + React + Markdown).

---

## Phase POST-GA1 — Translation Memory + MT (DONE)

- [x] `[DB]` Bảng `translation_memory` + `glossary`.
- [x] `[BE]` Service `translation-memory.ts` với providers: DeepL, OpenAI, Workers AI, echo fallback.
- [x] `[BE]` Routes `/api/v1/tm` (list/upsert/lookup fuzzy/translate pipeline TM → glossary → MT).
- [x] `[FE]` UI tích hợp TM trong module Translations.
- [x] `[DOC]` `features/translation-memory.md`.

## Phase POST-GA2 — Collaborative cursors (DONE)

- [x] `[BE]` `cursor-protocol.ts` (CRDT-lite: last-write-wins position + Y-style update vector).
- [x] `[BE]` Broadcast qua Durable Object SiteRoom (CF) hoặc in-process (Docker).
- [x] `[FE]` Render cursors + selection trong WYSIWYG / text fields.

## Phase POST-GA3 — Flows / Operations engine (DONE)

- [x] `[DB]` Bảng `flows`, `flow_runs`, `operations`.
- [x] `[BE]` Service `flow-service.ts` runner với operation types: `condition`, `transform`, `http`, `mail`, `log`, `sleep`, `run-extension`, `item.create|update|delete`, `notify`.
- [x] `[BE]` Routes `/api/v1/flows` + manual `/run` + `/runs` history.
- [x] `[BE]` Trigger types: `webhook`, `event` (item.*), `schedule` (cron), `manual`.
- [x] `[FE]` Module Automation → Flows (list page).
- [x] `[DOC]` `features/flows-automation.md`.

## Phase POST-GA4 — SCIM 2.0 provisioning (DONE)

- [x] `[BE]` `/scim/v2/Users` + `/Groups` + ServiceProviderConfig + Schemas + ResourceTypes (RFC 7644 subset).
- [x] `[BE]` Bearer token auth riêng (`SCIM_TOKEN`), không dùng Logto JWT.
- [x] `[BE]` Mapping: SCIM Group → LumiBase Team.
- [x] `[DOC]` `features/scim-provisioning.md`.

## Phase POST-GA5 — Marketplace extensions (DONE)

- [x] `[DB]` Bổ sung cột `signature`, `signatureAlg`, `publisherKeyId`, `publisher`, `marketplaceSlug`, `publishedAt`, `bundleSha256` vào `extensions`.
- [x] `[BE]` Routes `/api/v1/marketplace/extensions` (list, detail, install, publish).
- [x] `[BE]` Signature verification: SHA-256 bundle + ed25519/RSA-PSS qua WebCrypto, public keys load từ env `MARKETPLACE_PUBLIC_KEYS`.
- [x] `[FE]` Public Marketplace site dùng catalog API thật, SEO/static export/deploy checklist.
- [x] `[DOC]` Revenue sharing chốt hướng Free-first; commercial checkout/payout tách backlog pha sau.
- [x] `[DOC]` `features/marketplace.md`.

## Phase POST-GA6 — Materialized collections (DONE)

- [x] `[DB]` Bảng `materialized_collections`.
- [x] `[BE]` Routes `/api/v1/materialize` (register, refresh, drop).
- [x] `[BE]` Logical refresh strategy (count + lastRefreshedAt). Full denormalized write còn để mở.
- [x] `[DOC]` `features/materialized-collections.md`.

## Phase POST-GA7 — Advanced Permission Builder & RBAC (TODO)

Mục tiêu: nâng cấp Access Control hiện có thành hệ Role / Policy / Permission tương đương Directus nhưng fail-closed hơn, có conflict detection, policy flags, API keys theo role, import/export JSON và seed system permissions. Tham chiếu: `docs/vi/features/permission-builder-directus-investigation.md`.

### Chuẩn bị bắt buộc

- [x] `[BE]` Audit `PermissionService` hiện tại: ghi rõ hành vi compose hiện có (`OR` rules, union fields, merge presets/validation) và các case có thể mở rộng quyền im lặng.
- [x] `[DB]` Thiết kế migration backward-compatible cho `roles.admin_access/app_access` → policy-level `admin_access/app_access/enforce_tfa/ip_allow/ip_deny/valid_from/valid_until`.
- [x] `[DB]` Thêm stable `key`/`system_key` cho roles/policies để phục vụ import/export idempotent.
- [x] `[DOC]` Chốt danh sách system collections được đưa vào Permission Builder và nhóm sensitive/admin-only trước khi seed.
- [x] `[BE]` Định nghĩa JSON schema version `lumibase.access@v1` cho export/import roles, policies, permission rows, bindings và API key metadata.

### Schema & evaluator hardening

- [x] `[DB]` Thêm unique constraint `(policy_id, collection, action)` cho `permissions`; migration phải detect/report duplicate hiện có trước khi apply.
- [x] `[DB]` Thêm bảng `user_roles` để hỗ trợ nhiều role/user/site; giữ `user_sites.role_id` làm primary/display role trong giai đoạn chuyển đổi.
- [x] `[DB]` Thêm policy flags explicit vào `policies`; giữ `policies.rules` cho custom/future guardrails.
- [x] `[BE]` Mở rộng IP guard hỗ trợ IPv4, IPv6, CIDR và precedence `ipDeny` thắng `ipAllow`.
- [x] `[BE]` Enforce `update`/`delete` trong `ItemService` bằng action permission và row-level WHERE.
- [x] `[BE]` Enforce field whitelist cho `create`/`update`, bao gồm structural fields `status`/`sort`.
- [x] `[BE]` Enforce permission-level `validation` trong write path.
- [x] `[BE]` Enforce app access từ effective active policies khi vào Studio; API key luôn bị chặn khỏi Studio.
- [x] `[BE]` Enforce `enforceTfa=true`: user phải enroll và pass TFA; API key attach policy có TFA phải bị conflict/warning.
- [x] `[BE]` Mở rộng magic vars: `$CURRENT_ROLES`, `$CURRENT_POLICIES`, `$CURRENT_API_KEY`, nested `$CURRENT_USER.*`, `$NOW(+/- duration)`.
- [x] `[BE]` Fail closed cho unknown operator/magic var; thêm test cho `_null`, `_nnull`, `_empty`, `_nempty`, `_regex`, case-insensitive string ops.

### Conflict detection

- [x] `[BE]` Tạo `AccessConflictService` phân loại `compatible`, `warning`, `blocking` cho overlap cùng `collection + action`.
- [x] `[BE]` Block conflict unconditional-vs-restricted rule, `["*"]` vs whitelist fields, validation/preset cùng field khác value, admin bypass + granular policy.
- [x] `[BE]` Endpoint `POST /api/v1/access/conflicts/check` nhận target role/user/api_key + add/remove policies và trả diff có source policy.
- [x] `[BE]` Tích hợp conflict check vào attach role-policy, user-policy, API-key-policy; cho phép override warning có audit.
- [x] `[BE]` Tích hợp conflict check vào attach role-policy và user-policy; warning override ghi audit.
- [x] `[FE]` Role Detail gọi conflict check trước khi attach policy; blocking conflict không cho lưu.
- [x] `[FE]` Permission Matrix thêm Effective View hiển thị quyền cuối cùng và source policies.
- [x] `[TEST]` Property tests cho conflict classifier với các tổ hợp field/rule/preset/validation.

### API Keys theo Roles/Policies

- [x] `[DB]` Thêm `api_keys`, `api_key_roles`, `api_key_policies` với token hash, prefix, expire/revoke/last_used metadata.
- [x] `[BE]` Bearer auth lookup API key bằng hash; principal type `api_key` compile quyền giống user.
- [x] `[BE]` Rotate/revoke API key; plaintext chỉ trả một lần khi tạo/rotate.
- [x] `[BE]` Audit create/rotate/revoke/use-denied cho API key, không log plaintext token.
- [x] `[SDK]` Thêm client methods cho API key CRUD, attach roles/policies, conflict preview.
- [x] `[FE]` Studio API Keys page: create, rotate, revoke, attach roles/policies, preview effective permissions.
- [x] `[TEST]` API key không truy cập Studio; revoked/expired key bị 401; key chỉ thấy fields/rows theo policy.

### Import / Export Permission Builder

- [x] `[BE]` `GET /api/v1/access/export` xuất roles, policies, permissions, bindings, API key metadata bằng stable keys, không chứa secrets.
- [x] `[BE]` `POST /api/v1/access/import?dryRun=true` parse/validate/diff/conflict-check nhưng không ghi DB.
- [x] `[BE]` Import modes: `merge`, `replace-managed`, `replace-all`; apply trong transaction và audit diff summary.
- [x] `[BE]` Idempotency tests: import cùng manifest nhiều lần không tạo duplicate.
- [x] `[SDK]` Thêm access export/import client types.
- [x] `[FE]` Import dialog hiển thị diff, warnings, blocking conflicts và kết quả dry-run.
- [x] `[OPS]` CLI `lumibase access export/import` cho CI/CD giữa dev/staging/prod.

### System permissions & seeding

- [x] `[DB]` Cập nhật `seed-dev.ts` seed `policy_admin`, `role_administrator`, `policy_studio_self`, `policy_public`.
- [x] `[DB]` Seed explicit permissions cho nhóm schema/access manager: `collections`, `fields`, `relations`, `roles`, `policies`, `permissions`.
- [x] `[DB]` Đảm bảo sensitive collections (`system_state`, `audit_log`, `login_attempts`, `admin_backup_codes`, `scim_tokens`, `api_keys`) admin/security-only.
- [x] `[FE]` Permission Builder phân nhóm system collections và ẩn sensitive collections khỏi non-admin.
- [x] `[TEST]` Public policy mặc định không đọc được content/system collections nếu chưa explicit grant.

### Extension access control

- [x] `[DOC]` Ghi rõ Directus extension permission layers: install/enable, sandbox scopes, accountability services, app module self-check.
- [x] `[DB]` Thêm stable `extensions.key` và system access targets `extensions`, `extension_modules`, `extension_endpoints`, `extension_operations`.
- [x] `[BE]` Enforce `extensions:read/configure/install/enable/delete/grant_capability` trên extension management routes.
- [x] `[BE]` Enforce `extensions:execute` trước khi dispatch `/api/v1/extensions/:name/*`.
- [x] `[BE]` Extension data access mặc định dùng actor permissions; service-account mode cần policy/capability riêng và audit.
- [x] `[FE]` Studio extension loader/module bar chỉ hiển thị extension principal được phép đọc.
- [x] `[FE]` Permission Builder thêm nhóm Extension Access để gán user/role truy cập extension.
- [x] `[TEST]` User thiếu `extensions:execute` không gọi được endpoint extension dù extension enabled.

### Share action

- [x] `[DB]` Thêm bảng `shares` với role share chuyên dụng, password hash, validity window, max uses, revoke.
- [x] `[BE]` Implement `share` action: chỉ user có quyền share mới tạo share link; read payload vẫn đi qua role share permission.
- [x] `[FE]` Share dialog chỉ cho chọn role có `appAccess=false`, `adminAccess=false`, read permissions tối thiểu.
- [x] `[TEST]` Share link chỉ đọc fields/rows role share được phép, hết hạn/max uses/revoked đều bị deny.

---

## Phase Docker Dual-Deployment (DONE)

Mục tiêu: chạy được toàn bộ stack trên Docker không cần Cloudflare account.

- [x] `[RT]` Tạo package `@lumibase/runtime` với 6 interface: `CacheProvider`, `StorageProvider`, `DatabaseProvider`, `SearchProvider`, `QueueProvider`, `MediaProcessor`.
- [x] `[RT]` Cloudflare adapters: KV, R2, Hyperdrive, MeiliSearch Cloud HTTP, CF Queues, CF Image Resizing.
- [x] `[RT]` Docker adapters: Redis (ioredis), MinIO/S3 (`@aws-sdk/client-s3`), pg pool (`postgres`), MeiliSearch self-host, BullMQ on Redis, Imgproxy với signed URLs.
- [x] `[RT]` Factory `createRuntime(env)` chọn theo `LUMIBASE_RUNTIME`.
- [x] `[BE]` Refactor middleware/db.ts để dùng DatabaseProvider.
- [x] `[BE]` Refactor routes dùng KV/R2 sang `c.get('runtime').<provider>`.
- [x] `[BE]` Tạo `apps/cms/src/serve.ts` Node entrypoint với graceful shutdown (SIGTERM, 10s timeout).
- [x] `[BE]` Endpoint `/health` test connectivity (db, cache, search, storage, queue).
- [x] `[BE]` Endpoint `/metrics` Prometheus exposition format.
- [x] `[BE]` Endpoint `/api/v1/search` qua SearchProvider.
- [x] `[BE]` Auto-index/remove items qua QueueProvider khi item create/update/delete.
- [x] `[BE]` Media processing hook: enqueue thumbnail generation (150/300/600) khi upload.
- [x] `[OPS]` `docker/Dockerfile` multi-stage (Node 20 slim, non-root, HEALTHCHECK).
- [x] `[OPS]` `docker/Dockerfile.dev` cho hot-reload.
- [x] `[OPS]` `docker/scripts/entrypoint.sh` chạy migrations với retry exponential backoff.
- [x] `[OPS]` `docker/docker-compose.yml`: Postgres 16, Redis 7, MinIO, MeiliSearch, Imgproxy, CMS, Bull Board.
- [x] `[OPS]` `docker/docker-compose.monitoring.yml`: Prometheus + Grafana + Loki + pg-backup.
- [x] `[OPS]` `docker/docker-compose.prod.yml` cho production-like local testing.
- [x] `[OPS]` Pre-provisioned Grafana dashboard (request rate, latency p50/p95/p99, error rate, queue depth, cache hit ratio).
- [x] `[OPS]` `docker/scripts/backup.sh` + `restore.sh` (pg_dump → S3, retention 7 daily / 4 weekly).
- [x] `[OPS]` Workflow CI `.github/workflows/docker.yml` (build & push GHCR trên main, build-only PR, layer caching, health check verify).
- [x] `[DOC]` `apps/docs/content/deployment/{overview,cloudflare,docker,local-development,environment-variables}.md`.
- [x] `[DOC]` `apps/docs/content/guides/{tooling-recommendations,backup-recovery}.md`.
- [x] `[DOC]` `features/runtime-abstraction.md` + `features/observability.md` + `features/search.md`.

---

## Phase AI-First Copilot (DONE)

Mục tiêu: AI Agent tương tác an toàn với CMS qua HITL.

- [x] `[DB]` Bảng `ai_approvals` (id nanoid 21 + siteId + agentName + skillName + arguments jsonb + status + context + decidedAt + decidedBy).
- [x] `[AI]` Package `@lumibase/ai-skills` với `CORE_SKILLS` (listCollections, createCollection, deleteCollection, createField, deleteField, listItems, createItem, updateItem, deleteItem) + OpenAI tool definitions.
- [x] `[BE]` Service `ai-harness.ts` (validateSkill, checkCapabilities với wildcard `*`, evaluateRisk, execute, executeApproved, rejectApproval, runSkill timeout 30s).
- [x] `[BE]` Routes `/api/v1/ai/chat`, `/api/v1/ai/approvals`, `/api/v1/ai/approvals/:id/decide`.
- [x] `[BE]` Property tests fast-check (15 properties, 100+ iterations) + integration tests.
- [x] `[FE]` `components/ai-assistant.tsx` floating panel 320×480 glassmorphism, max 50 messages.
- [x] `[FE]` `modules/settings/ai-approvals.tsx` card list pending approvals với Approve/Reject.
- [x] `[DOC]` `features/ai-copilot.md` + giữ `features/ai-first-specification.md` lịch sử.

---

## Phase POST-GA — Nâng cao (TODO / In progress)

- [x] `[AI]` Tích hợp LLM provider thật (OpenAI / Anthropic / Workers AI) thay cho mock intent parser trong `/ai/chat`.
- [x] `[AI]` Thêm context memory (lịch sử conversation) trong AI Copilot.
- [x] `[AI]` Skill `aiSuggestField` + `aiContentAssist` (RAG via embeddings).
- [x] `[BE]` Materialize collection write thực sự (không chỉ logical refresh) — bảng vật lý + trigger refresh.
- [x] `[BE]` Multi-region Durable Objects sharding.
- [x] `[FE]` Marketplace browser UI trong Studio (browse, install với 1 click).
- [x] `[FE]` Flows visual editor (drag-drop graph) — hiện chỉ có list page.
- [x] `[BE]` SCIM Token rotation + audit.
- [x] `[OPS]` Multi-tenant isolation testing tự động (k6 cross-site leak detection).

---

## Phase POST-GA8 — Directus Data Model Parity (DONE)

Mục tiêu: nâng cấp Data Model / Collections Builder để một collection trong LumiBase có contract rõ như Directus: metadata đầy đủ, primary key strategy, system fields, field config nâng cao, relation metadata, schema permission, diff/apply atomic, SDK/typegen/OpenAPI và test parity. Tham chiếu chi tiết: `docs/en/features/directus-data-model-parity-tasks.md`.

### Milestone 1 — Correctness fixes trước khi mở rộng (DONE)

- [x] `[FE]` Collection wizard gửi đúng top-level payload (`note`, `accountability`, `versioning`, `singleton`, `primaryKeyType`, `storageMode`) thay vì nhét vào `meta`.
- [x] `[BE]` `ItemService.patch/replace/softDelete` enforce permission `update/delete`, row-level scope và field-level update allowlist.
- [x] `[BE]` Relation delete/dependency check đủ cả hai chiều `manyCollection` và `oneCollection`; block xoá field/collection khi còn relation trỏ tới.
- [x] `[TEST]` Thêm regression tests cho wizard payload, update/delete permission và relation dependency checks.

### Milestone 2 — Collection metadata + primary key contract (DONE)

- [x] `[DB]` Thêm first-class collection columns: `label`, `pluralLabel`, `hidden`, `system`, `primaryKeyField`, `primaryKeyType`, `storageMode`, `unarchiveValue`, `itemDuplicationFields`, `translations`.
- [x] `[BE]` Backfill/migration backward-compatible; route validation và `SchemaService` dùng field mới, giữ `meta` cho extension/custom UI hints.
- [x] `[SDK]` Cập nhật collection input/output types và schema client methods cho metadata mới.
- [x] `[FE]` Wizard có các bước Identity, Storage, System fields, Permissions defaults, Review JSON.
- [x] `[BE]` Implement primary key strategy cho `jsonb`: `nanoid`, `uuid`, `string`; defer hoặc block rõ `integer/bigInteger` nếu chưa có sequence.
- [x] `[TEST]` Create item respect primary key strategy; duplicate user-provided ID trả `409`.

### Milestone 3 — System fields và field configuration parity

- [x] `[BE]` Extend compiled schema với `systemFields` (`id`, `status`, `sort`, `user_created`, `user_updated`, `created_at`, `updated_at`, `deleted_at`).
- [x] `[FE]` Fields tab hiển thị system fields trong locked group; cho cấu hình display/hidden/readonly/translations/width nhưng không cho xoá.
- [x] `[DB]` Thêm field metadata: `label`, `note`, `defaultValue`, `nullable`, `unique`, `indexed`, `searchable`, `length`, `precision`, `scale`, `special`.
- [x] `[FE]` FieldInspector advanced tabs: Basics, Options, Display, Validation, Conditions, Layout, Storage, Translations.
- [x] `[BE]` Tách create/update/rename/delete/migration field path; reject đổi type/name khi đã có data nếu chưa có migration plan.
- [x] `[TEST]` FieldInspector không làm mất unknown `options/displayOptions/validation/conditions`; risky changes trả `409` hoặc cần confirm.

### Milestone 4 — Relations parity và deep read

- [x] `[BE]` Validate relation references: collection/field tồn tại, relation name không duplicate, `onDelete` hợp lệ theo storage mode.
- [x] `[DB]` Mở rộng relation metadata: `type`, `aliasField`, `relatedDisplayTemplate`, `junctionManyField`, `junctionOneField`.
- [x] `[BE]` Hỗ trợ relation types `m2o`, `o2m`, `m2m`; reserve `m2a` và trả "not implemented" nếu chọn.
- [x] `[BE]` Implement relation expansion cho item query (`fields=author.name,categories.*`, `deep[...]`) với permission masking cho related collections.
- [x] `[TEST]` M2O trả object khi request expand; O2M/M2M trả array; batching tránh N+1 ở case phổ biến.

### Milestone 5 — Schema permissions, diff/apply và storage positioning

- [x] `[BE]` Thêm schema permission actions: `schema:read/create/update/delete/migrate`.
- [x] `[BE]` Áp dụng `requireSchemaPermission` cho collections/fields/relations/compiled schema routes và AI schema skills.
- [x] `[BE]` Expand schema diff: collection metadata, field metadata, relation changes, risk classification và runtime impact.
- [x] `[BE]` `PUT /collections/:name/schema` validate toàn bộ, compute diff, apply transactionally khi runtime hỗ trợ, invalidate schema/permission/typegen cache và emit `schema.changed`.
- [x] `[FE]` Raw JSON schema tab hiển thị diff/risk trước khi apply.
- [x] `[DOC]` Ghi rõ storage modes `jsonb/materialized/physical/external`, kèm limitations badge trong Studio.
- [x] `[DOC]` Tạo design doc `docs/en/architecture/physical-collections.md` để quyết định physical/external mode.

### Milestone 6 — SDK, typegen, OpenAPI, docs và parity tests

- [x] `[SDK]` Mở schema resources đầy đủ: collections/fields/relations CRUD, field rename/delete options, schema diff/apply.
- [x] `[SDK]` Giữ legacy methods hoặc deprecation wrapper; preserve error `code/path/risk` metadata.
- [x] `[SDK]` Typegen include primary key type, system fields, nullable/required, readonly/generated và relation-expanded response types.
- [x] `[DOC]` Cập nhật `apps/cms/openapi.yaml`, `docs/en/features/collections-builder.md`, `docs/en/features/field-types-and-config.md`, `docs/en/data-model.md`.
- [x] `[DOC]` Sync bản tiếng Việt sau khi English contract ổn định.
- [x] `[TEST]` Backend/frontend/SDK parity suite đủ các acceptance criteria trong `directus-data-model-parity-tasks.md`.

---

## Cross-cutting checklist (mỗi phase)

- [x] Cập nhật `architecture.md` nếu thay đổi cấu trúc.
- [x] Viết unit + integration test trước khi merge; với logic phức tạp dùng property-based testing (fast-check).
- [x] Cập nhật OpenAPI spec (`apps/cms/openapi.yaml`) cho mọi endpoint mới.
- [x] Cập nhật `packages/sdk` types tương ứng.
- [x] Cập nhật docs trong `docs/features/` hoặc `apps/docs/content/`.
- [x] Làm trực tiếp trên `main` theo chỉ dẫn repo hiện tại; commit theo conventional commits và push thẳng để giảm conflict với các luồng song song.
- [x] Đảm bảo route mới hoạt động trên CẢ hai runtime (Cloudflare + Docker) — nếu phụ thuộc API cụ thể, gate bằng feature flag và document trong `features/runtime-abstraction.md`.
