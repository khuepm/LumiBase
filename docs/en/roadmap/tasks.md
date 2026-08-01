---
version: 1
lastUpdated: 2026-06-23T13:13:36.000Z
sourceLang: vi
translatedFrom: vi
sourceHash: 75a34bb34c05772c
mtEngine: claude
syncStatus: machine-translated
---

# Roadmap & Task Breakdown

> **Scope:** This roadmap covers **LumiBase Studio** — the admin panel for managing data, collections, permissions, etc. — and the **LumiBase CMS API**, which runs on both Cloudflare Workers and Docker.
>
> The **Consumer app (the end-user frontend)** in `apps/consumer` (Next.js) is a demo that uses the SDK to call the Delivery API — it is **not** the CMS Studio.
>
> Task language: short, ready to drop straight into an issue tracker. Each task has a **clear scope**, a **deliverable**, and a link to related docs.

Conventions:
- `[BE]` apps/cms (Backend API - Hono)
- `[FE]` apps/studio (Admin panel - React + Vite)
- `[DB]` packages/database
- `[RT]` packages/runtime (the Cloudflare/Docker abstraction layer)
- `[AI]` packages/ai-skills + AI Copilot
- `[SDK]` packages/sdk (a type-safe client for both Studio and consumer apps)
- `[DOC]` apps/docs or docs in `docs/`
- `[OPS]` infra/deploy/CI
- Each PR should be on a `feature/<phase>-<short-name>` branch per the Git hygiene rule.

Overall status: Phase 0 → Phase G (GA hardening) is done. POST-GA and Dual Deployment + AI Copilot are complete. The current focus is polish, developer experience, and expanding the marketplace.

## Active Ops Hardening Tasks

Sources: `apps/docs/content/deployment/docker.md`, `apps/docs/content/guides/backup-recovery.md`.

- [x] `[OPS]` Docker image runs as a non-root user.
- [x] `[BE]` Validate the production config when `NODE_ENV=production` or `LUMIBASE_ENV=production`.
- [x] `[BE]` Support Docker secret files via `*_FILE` before migration/server startup.
- [x] `[BE]` CORS allowlist via `CORS_ALLOWED_ORIGINS`; reject a wildcard in production.
- [x] `[BE]` Require `ENCRYPTION_KEY` in production and validate the AES key format.
- [x] `[BE]` Require DB TLS `sslmode=require|verify-ca|verify-full` in production, unless `DATABASE_SSL_MODE=disable` is explicit.
- [x] `[OPS]` `docker-compose.prod.yml` does not publish ports for stateful internal services.
- [x] `[DOC]` Update the Docker deployment docs and the environment reference.
- [x] `[DOC]` Add a restore drill, row-count verification, app health check after restore, media/search rebuild, and RTO/RPO documentation.
- [x] `[DOC]` Add Cloudflare DR validation for Workers, Hyperdrive, R2, KV, Queues, MeiliSearch Cloud, DNS/WAF/Access.
- [x] `[OPS]` Configure real TLS termination at the deploy environment's load balancer/reverse proxy.
- [x] `[OPS]` Automate a periodic restore drill for the Docker and Cloudflare restore environments.

---

## Phase 0 — Foundation (DONE)

Goal: a working monorepo skeleton, the core schema, Logto auth, CI.

- [x] `[OPS]` Create `apps/cms` (Hono + Cloudflare Workers template + wrangler config).
- [x] `[OPS]` Create `apps/studio` (Vite + React + TS + Tailwind + shadcn init).
- [x] `[OPS]` Create `packages/contracts`, `packages/sdk`, `packages/ui`, `packages/extension-sdk` (boilerplate + tsconfig + lint).
- [x] `[DB]` Add schema: `users`, `user_sites`, `teams`, `team_members`, `roles`, `policies`, `role_policies`, `user_policies`, `permissions` (see `data-model.md`).
- [x] `[DB]` Drizzle migration runner for Hyperdrive (local + remote scripts).
- [x] `[BE]` `withAuth` middleware (Logto JWKS), `withTenant` (`site_id` from subdomain/header), `withLogger`.
- [x] `[BE]` `GET /auth/me` + `GET /utils/health`.
- [x] `[FE]` App shell + module bar + routing skeleton + Logto login flow.
- [x] `[FE]` API client in `packages/sdk` (fetch wrapper, error format, site header).
- [x] `[OPS]` CI pipeline (lint, typecheck, test, build) + preview deploy.
- [x] `[DOC]` Update `architecture.md` (root) when the structure changes.

---

## Phase A — Schema engine (DONE)

Goal: create/manage collections & fields via API + UI.

- [x] `[DB]` Tables `collections`, `fields`, `relations`.
- [x] `[BE]` `SchemaService` (CRUD + compile cache).
- [x] `[BE]` Endpoints `/collections`, `/fields`, `/relations`.
- [x] `[BE]` Diff endpoint `/collections/diff` + `PUT /collections/:name/schema`.
- [x] `[BE]` Validate collection/field names, check dependencies on delete.
- [x] `[SDK]` Type-safe client for the schema.
- [x] `[BE]` CLI script `apps/cms/scripts/typegen.ts` + alias `lumibase typegen`.
- [x] `[FE]` Module *Settings → Data Model* (collection list).
- [x] `[FE]` 3-step collection wizard.
- [x] `[FE]` Collection detail tabs (Fields, Display, Archive, Raw JSON).
- [x] `[FE]` Basic field inspector (interfaces `input`, `input-multiline`, `toggle`, `select-dropdown`, `datetime`, `json-raw`).
- [x] `[FE]` Live JSON pane (Monaco) for the collection schema, two-way sync.
- [x] `[FE]` Drag-drop field reorder (dnd-kit).
- [x] `[BE]` Endpoint `GET /typegen/schema` (manifest with permissions applied).
- [x] `[SDK]` Generator core `packages/sdk/src/typegen/`.
- [x] `[FE]` *Settings → Developer → Types* page (preview + download).

---

## Phase B — Items & extended Field system (DONE)

- [x] `[DB]` Tables `items`, `revisions`, `activity` + GIN indexes.
- [x] `[BE]` `ItemService` builds Drizzle queries dynamically (fields, filter, sort, paginate, deep).
- [x] `[BE]` Full `/items/:collection` endpoints.
- [x] `[BE]` Revision write + revert.
- [x] `[BE]` Activity-log middleware for mutations.
- [x] `[BE]` Validation pipeline (Zod + JSONata) running server-side.
- [x] `[BE]` Conditions evaluator (server + a helper exported to the client).
- [x] `[BE]` Per-field encryption service (AES-GCM, key in Workers Secret/env).
- [x] `[FE]` Content module list view (tabular layout) + filter builder + sort + paginate.
- [x] `[FE]` Detail editor + side-panel tabs (Revisions, Raw JSON).
- [x] `[FE]` Complete interface registry: text, number, choice, boolean, date, relation, file, json-raw, code, wysiwyg, markdown, slug, color, tags, rating, repeater, presentation.
- [x] `[FE]` Display registry: formatted-value, raw, boolean-icon, datetime, image, labels, mustache-template.
- [x] `[FE]` Raw toggle component (Monaco) for every interface.
- [x] `[FE]` Bulk raw editor for the whole item.
- [x] `[FE]` Revisions diff viewer.
- [x] `[FE]` Mustache display-template editor.
- [x] `[BE]` `POST /utils/render-template` (mustache only in Phase B).

---

## Phase C — Permissions & Access (DONE)

- [x] `[BE]` `PermissionService` (compile rule, cache, field mask).
- [x] `[BE]` CRUD endpoints `/roles`, `/policies`, `/policies/:id/permissions`, attach/detach.
- [x] `[BE]` `GET /permissions/me` + `POST /permissions/check` (trace).
- [x] `[BE]` Integrate Permissions into ItemService (where injection + post-check).
- [x] `[BE]` Magic vars `$CURRENT_USER`, `$CURRENT_SITE`, `$CURRENT_ROLE`, `$NOW`, `$IP`, `$HEADERS.*`.
- [x] `[BE]` Time-bound + IP allow/deny at the policy level.
- [x] `[BE]` Permission compose rules.
- [x] `[FE]` Access Control module: Roles, Policies (GUI + JSON Monaco), Permission matrix, Test sandbox.
- [x] `[FE]` Field-level hide/disable in the form per `/permissions/me`.
- [x] `[FE]` List view hides a column when there's no read permission on the field.
- [x] `[FE]` Hide/disable bulk actions per permission.

---

## Phase C2 — Presets, Bookmarks, basic Translations (DONE)

- [x] `[DB]` Tables `presets`, `translations`.
- [x] `[BE]` CRUD `/presets`, scope resolution (user > role > site).
- [x] `[BE]` CRUD `/translations` (namespaces `ui`, `field`, `content`).
- [x] `[BE]` Locale settings (`settings.locales.*`).
- [x] `[FE]` Preset switcher + save/edit dialog in the list view.
- [x] `[FE]` Translations module (UI strings tab + content tab JSONB).
- [x] `[FE]` `translatable-text` interface (JSONB locale map).
- [x] `[FE]` i18n for the Studio UI (react-i18next bound to the translations API).

---

## Phase D — Users, Files, Settings (DONE)

- [x] `[BE]` `/users`, `/users/invite`, `/users/:id/impersonate`, sessions.
- [x] `[BE]` `/teams`, `/team_members`.
- [x] `[BE]` Files: presigned R2/S3 upload, `/files`, `/assets/:id` transform, `/media` (StorageProvider abstraction).
- [x] `[BE]` Settings storage + cache + `settings.changed` event.
- [x] `[BE]` Webhooks CRUD + dispatcher (Queues / BullMQ).
- [x] `[BE]` Activity-log endpoint (filter, paginate).
- [x] `[FE]` Users + Teams module.
- [x] `[FE]` Files module (grid + folders + drag-drop upload).
- [x] `[FE]` Settings module (general, locales, security, files, webhooks, activity).
- [x] `[FE]` Notifications inbox (via realtime).

---

## Phase E — Realtime / WebSocket (DONE)

- [x] `[OPS]` Create the Durable Object class `SiteRoom` (Wrangler binding).
- [x] `[BE]` `/realtime` endpoint upgrades WS, routes to the DO by `siteId`.
- [x] `[BE]` Subscribe/unsubscribe/presence protocol.
- [x] `[BE]` Publish pipeline in ItemService.commit().
- [x] `[BE]` Permission re-check on event fan-out.
- [x] `[BE]` Rate limit + heartbeat.
- [x] `[SDK]` Realtime client in `packages/sdk`.
- [x] `[FE]` Hooks `useRealtimeSubscription`, `usePresence`.
- [x] `[FE]` Presence chip in the topbar + detail editor.
- [x] `[FE]` List view "Live mode" toggle.
- [x] `[FE]` Smart preset subscribe.
- [x] `[FE]` Realtime notifications.

---

## Phase F — Advanced Extensions & Display Templates (DONE)

- [x] `[DB]` Table `extensions`.
- [x] `[BE]` Extension uploader (multipart → R2/S3) + manifest validator + capability registry.
- [x] `[BE]` Sandbox loader (dynamic import + proxy ctx + capability gate).
- [x] `[BE]` Hook dispatcher integrated with ItemService (`before/after`).
- [x] `[BE]` Mount endpoint `/extensions/:name/*` from `endpoint`-type extensions.
- [x] `[BE]` `/utils/render-template` supports the component DSL.
- [x] `[FE]` Settings → Extensions module (upload, review caps, enable/disable, version).
- [x] `[FE]` Dynamic loader for UI extensions (interface/display/layout/panel/module).
- [x] `[FE]` Display-template editor in component mode (block builder).
- [x] `[DOC]` "Build your first extension" tutorial in `docs/features/extensions-system.md`.

---

## Phase G — Hardening & GA (DONE)

- [x] `[BE]` Additional Postgres RLS policies via the `withRls()` middleware (defense-in-depth).
- [x] `[BE]` Complete tag-based invalidation (revalidateTag webhook → Next.js consumer).
- [x] `[BE]` Backups + restore via the `/api/v1/admin/backup` + `/api/v1/admin/restore` endpoints (NDJSON bundle).
- [x] `[BE]` Config export/import CLI (`apps/cms/scripts/config-cli.ts`).
- [x] `[FE]` Accessibility audit + fix.
- [x] `[FE]` Bundle size audit, lazy module splitting (TanStack Router lazy-load).
- [x] `[OPS]` Load test (k6) for the delivery API and realtime — `apps/cms/k6/`.
- [x] `[OPS]` SLO dashboards (Workers Analytics Engine + Grafana for Docker).
- [x] `[DOC]` Public docs site (`apps/docs` — Vite + React + Markdown).

---

## Phase POST-GA1 — Translation Memory + MT (DONE)

- [x] `[DB]` Tables `translation_memory` + `glossary`.
- [x] `[BE]` `translation-memory.ts` service with providers: DeepL, OpenAI, Workers AI, echo fallback.
- [x] `[BE]` Routes `/api/v1/tm` (list/upsert/fuzzy lookup/translate pipeline TM → glossary → MT).
- [x] `[FE]` TM integration UI in the Translations module.
- [x] `[DOC]` `features/translation-memory.md`.

## Phase POST-GA2 — Collaborative cursors (DONE)

- [x] `[BE]` `cursor-protocol.ts` (CRDT-lite: last-write-wins position + Y-style update vector).
- [x] `[BE]` Broadcast via the Durable Object SiteRoom (CF) or in-process (Docker).
- [x] `[FE]` Render cursors + selection in WYSIWYG / text fields.

## Phase POST-GA3 — Flows / Operations engine (DONE)

- [x] `[DB]` Tables `flows`, `flow_runs`, `operations`.
- [x] `[BE]` `flow-service.ts` runner service with operation types: `condition`, `transform`, `http`, `mail`, `log`, `sleep`, `run-extension`, `item.create|update|delete`, `notify`.
- [x] `[BE]` Routes `/api/v1/flows` + manual `/run` + `/runs` history.
- [x] `[BE]` Trigger types: `webhook`, `event` (item.*), `schedule` (cron), `manual`.
- [x] `[FE]` Automation → Flows module (list page).
- [x] `[DOC]` `features/flows-automation.md`.

## Phase POST-GA4 — SCIM 2.0 provisioning (DONE)

- [x] `[BE]` `/scim/v2/Users` + `/Groups` + ServiceProviderConfig + Schemas + ResourceTypes (RFC 7644 subset).
- [x] `[BE]` A separate Bearer token auth (`SCIM_TOKEN`), not using Logto JWT.
- [x] `[BE]` Mapping: SCIM Group → LumiBase Team.
- [x] `[DOC]` `features/scim-provisioning.md`.

## Phase POST-GA5 — Marketplace extensions (DONE)

- [x] `[DB]` Add columns `signature`, `signatureAlg`, `publisherKeyId`, `publisher`, `marketplaceSlug`, `publishedAt`, `bundleSha256` to `extensions`.
- [x] `[BE]` Routes `/api/v1/marketplace/extensions` (list, detail, install, publish).
- [x] `[BE]` Signature verification: SHA-256 bundle + ed25519/RSA-PSS via WebCrypto, public keys loaded from the env `MARKETPLACE_PUBLIC_KEYS`.
- [x] `[FE]` Public Marketplace site using the real catalog API, SEO/static export/deploy checklist.
- [x] `[DOC]` Revenue sharing settled on Free-first; commercial checkout/payout split into a later backlog.
- [x] `[DOC]` `features/marketplace.md`.

## Phase POST-GA6 — Materialized collections (DONE)

- [x] `[DB]` Table `materialized_collections`.
- [x] `[BE]` Routes `/api/v1/materialize` (register, refresh, drop).
- [x] `[BE]` Logical refresh strategy (count + lastRefreshedAt). Full denormalized write still open.
- [x] `[DOC]` `features/materialized-collections.md`.

## Phase POST-GA7 — Advanced Permission Builder & RBAC (TODO)

Goal: upgrade the existing Access Control into a Role / Policy / Permission system equivalent to Directus but more fail-closed, with conflict detection, policy flags, role-based API keys, JSON import/export, and seeded system permissions. Reference: `docs/vi/features/permission-builder-directus-investigation.md`.

### Mandatory preparation

- [x] `[BE]` Audit the current `PermissionService`: clearly document the existing compose behavior (`OR` rules, union fields, merge presets/validation) and cases that could silently widen permissions.
- [x] `[DB]` Design a backward-compatible migration for `roles.admin_access/app_access` → policy-level `admin_access/app_access/enforce_tfa/ip_allow/ip_deny/valid_from/valid_until`.
- [x] `[DB]` Add a stable `key`/`system_key` for roles/policies to support idempotent import/export.
- [x] `[DOC]` Finalize the list of system collections included in the Permission Builder and the sensitive/admin-only groups before seeding.
- [x] `[BE]` Define the JSON schema version `lumibase.access@v1` for export/import of roles, policies, permission rows, bindings, and API key metadata.

### Schema & evaluator hardening

- [x] `[DB]` Add a unique constraint `(policy_id, collection, action)` to `permissions`; the migration must detect/report existing duplicates before applying.
- [x] `[DB]` Add a `user_roles` table to support multiple roles/user/site; keep `user_sites.role_id` as the primary/display role during the transition.
- [x] `[DB]` Add explicit policy flags to `policies`; keep `policies.rules` for custom/future guardrails.
- [x] `[BE]` Extend the IP guard to support IPv4, IPv6, CIDR, and the precedence `ipDeny` beats `ipAllow`.
- [x] `[BE]` Enforce `update`/`delete` in `ItemService` with action permission and row-level WHERE.
- [x] `[BE]` Enforce field whitelist for `create`/`update`, including the structural fields `status`/`sort`.
- [x] `[BE]` Enforce permission-level `validation` in the write path.
- [x] `[BE]` Enforce app access from effective active policies when entering Studio; API keys are always blocked from Studio.
- [x] `[BE]` Enforce `enforceTfa=true`: the user must enroll and pass TFA; an API key attaching a TFA policy must be flagged as a conflict/warning.
- [x] `[BE]` Extend magic vars: `$CURRENT_ROLES`, `$CURRENT_POLICIES`, `$CURRENT_API_KEY`, nested `$CURRENT_USER.*`, `$NOW(+/- duration)`.
- [x] `[BE]` Fail closed for unknown operator/magic var; add tests for `_null`, `_nnull`, `_empty`, `_nempty`, `_regex`, case-insensitive string ops.

### Conflict detection

- [x] `[BE]` Create an `AccessConflictService` classifying `compatible`, `warning`, `blocking` for overlaps on the same `collection + action`.
- [x] `[BE]` Block conflicts of unconditional-vs-restricted rule, `["*"]` vs whitelisted fields, validation/preset on the same field with different values, admin bypass + granular policy.
- [x] `[BE]` Endpoint `POST /api/v1/access/conflicts/check` takes a target role/user/api_key + add/remove policies and returns a diff with the source policy.
- [x] `[BE]` Integrate the conflict check into attaching role-policy, user-policy, api-key-policy; allow overriding a warning with an audit.
- [x] `[BE]` Integrate the conflict check into attaching role-policy and user-policy; a warning override is audited.
- [x] `[FE]` Role Detail calls the conflict check before attaching a policy; a blocking conflict prevents saving.
- [x] `[FE]` The Permission Matrix adds an Effective View showing the final permissions and source policies.
- [x] `[TEST]` Property tests for the conflict classifier with combinations of field/rule/preset/validation.

### API Keys by Roles/Policies

- [x] `[DB]` Add `api_keys`, `api_key_roles`, `api_key_policies` with token hash, prefix, expire/revoke/last_used metadata.
- [x] `[BE]` Bearer auth looks up the API key by hash; the `api_key` principal type compiles permissions like a user.
- [x] `[BE]` Rotate/revoke an API key; the plaintext is only returned once at create/rotate.
- [x] `[BE]` Audit create/rotate/revoke/use-denied for API keys, without logging the plaintext token.
- [x] `[SDK]` Add client methods for API key CRUD, attach roles/policies, conflict preview.
- [x] `[FE]` Studio API Keys page: create, rotate, revoke, attach roles/policies, preview effective permissions.
- [x] `[TEST]` An API key cannot access Studio; a revoked/expired key gets 401; a key only sees the fields/rows allowed by policy.

### Permission Builder Import / Export

- [x] `[BE]` `GET /api/v1/access/export` exports roles, policies, permissions, bindings, API key metadata with stable keys, containing no secrets.
- [x] `[BE]` `POST /api/v1/access/import?dryRun=true` parses/validates/diffs/conflict-checks but does not write the DB.
- [x] `[BE]` Import modes: `merge`, `replace-managed`, `replace-all`; applied in a transaction with an audited diff summary.
- [x] `[BE]` Idempotency tests: importing the same manifest multiple times creates no duplicates.
- [x] `[SDK]` Add access export/import client types.
- [x] `[FE]` Import dialog shows the diff, warnings, blocking conflicts, and dry-run results.
- [x] `[OPS]` CLI `lumibase access export/import` for CI/CD between dev/staging/prod.

### System permissions & seeding

- [x] `[DB]` Update `seed-dev.ts` to seed `policy_admin`, `role_administrator`, `policy_studio_self`, `policy_public`.
- [x] `[DB]` Seed explicit permissions for the schema/access manager group: `collections`, `fields`, `relations`, `roles`, `policies`, `permissions`.
- [x] `[DB]` Ensure sensitive collections (`system_state`, `audit_log`, `login_attempts`, `admin_backup_codes`, `scim_tokens`, `api_keys`) are admin/security-only.
- [x] `[FE]` The Permission Builder groups system collections and hides sensitive collections from non-admins.
- [x] `[TEST]` The default public policy cannot read content/system collections without an explicit grant.

### Extension access control

- [x] `[DOC]` Document the Directus extension permission layers: install/enable, sandbox scopes, accountability services, app module self-check.
- [x] `[DB]` Add a stable `extensions.key` and system access targets `extensions`, `extension_modules`, `extension_endpoints`, `extension_operations`.
- [x] `[BE]` Enforce `extensions:read/configure/install/enable/delete/grant_capability` on extension management routes.
- [x] `[BE]` Enforce `extensions:execute` before dispatching `/api/v1/extensions/:name/*`.
- [x] `[BE]` Extension data access defaults to actor permissions; service-account mode needs its own policy/capability and audit.
- [x] `[FE]` The Studio extension loader/module bar only shows extensions the principal is allowed to read.
- [x] `[FE]` The Permission Builder adds an Extension Access group to grant users/roles access to extensions.
- [x] `[TEST]` A user without `extensions:execute` cannot call an extension endpoint even if the extension is enabled.

### Share action

- [x] `[DB]` Add a `shares` table with a dedicated share role, password hash, validity window, max uses, revoke.
- [x] `[BE]` Implement the `share` action: only a user with the share permission can create a share link; the read payload still goes through the share role's permissions.
- [x] `[FE]` The Share dialog only allows selecting a role with `appAccess=false`, `adminAccess=false`, and minimal read permissions.
- [x] `[TEST]` A share link only reads the fields/rows the share role is allowed; expired/max-uses/revoked are all denied.

---

## Phase Docker Dual-Deployment (DONE)

Goal: run the entire stack on Docker without a Cloudflare account.

- [x] `[RT]` Create the `@lumibase/runtime` package with 6 interfaces: `CacheProvider`, `StorageProvider`, `DatabaseProvider`, `SearchProvider`, `QueueProvider`, `MediaProcessor`.
- [x] `[RT]` Cloudflare adapters: KV, R2, Hyperdrive, MeiliSearch Cloud HTTP, CF Queues, CF Image Resizing.
- [x] `[RT]` Docker adapters: Redis (ioredis), MinIO/S3 (`@aws-sdk/client-s3`), pg pool (`postgres`), self-hosted MeiliSearch, BullMQ on Redis, Imgproxy with signed URLs.
- [x] `[RT]` Factory `createRuntime(env)` selects by `LUMIBASE_RUNTIME`.
- [x] `[BE]` Refactor middleware/db.ts to use the DatabaseProvider.
- [x] `[BE]` Refactor routes using KV/R2 to `c.get('runtime').<provider>`.
- [x] `[BE]` Create `apps/cms/src/serve.ts` Node entrypoint with graceful shutdown (SIGTERM, 10s timeout).
- [x] `[BE]` `/health` endpoint tests connectivity (db, cache, search, storage, queue).
- [x] `[BE]` `/metrics` endpoint in Prometheus exposition format.
- [x] `[BE]` `/api/v1/search` endpoint via the SearchProvider.
- [x] `[BE]` Auto-index/remove items via the QueueProvider on item create/update/delete.
- [x] `[BE]` Media processing hook: enqueue thumbnail generation (150/300/600) on upload.
- [x] `[OPS]` `docker/Dockerfile` multi-stage (Node 20 slim, non-root, HEALTHCHECK).
- [x] `[OPS]` `docker/Dockerfile.dev` for hot-reload.
- [x] `[OPS]` `docker/scripts/entrypoint.sh` runs migrations with exponential-backoff retry.
- [x] `[OPS]` `docker/docker-compose.yml`: Postgres 16, Redis 7, MinIO, MeiliSearch, Imgproxy, CMS, Bull Board.
- [x] `[OPS]` `docker/docker-compose.monitoring.yml`: Prometheus + Grafana + Loki + pg-backup.
- [x] `[OPS]` `docker/docker-compose.prod.yml` for production-like local testing.
- [x] `[OPS]` Pre-provisioned Grafana dashboard (request rate, latency p50/p95/p99, error rate, queue depth, cache hit ratio).
- [x] `[OPS]` `docker/scripts/backup.sh` + `restore.sh` (pg_dump → S3, retention 7 daily / 4 weekly).
- [x] `[OPS]` CI workflow `.github/workflows/docker.yml` (build & push GHCR on main, build-only on PR, layer caching, health check verify).
- [x] `[DOC]` `apps/docs/content/deployment/{overview,cloudflare,docker,local-development,environment-variables}.md`.
- [x] `[DOC]` `apps/docs/content/guides/{tooling-recommendations,backup-recovery}.md`.
- [x] `[DOC]` `features/runtime-abstraction.md` + `features/observability.md` + `features/search.md`.

---

## Phase AI-First Copilot (DONE)

Goal: an AI Agent that interacts safely with the CMS via HITL.

- [x] `[DB]` Table `ai_approvals` (id nanoid 21 + siteId + agentName + skillName + arguments jsonb + status + context + decidedAt + decidedBy).
- [x] `[AI]` Package `@lumibase/ai-skills` with `CORE_SKILLS` (listCollections, createCollection, deleteCollection, createField, deleteField, listItems, createItem, updateItem, deleteItem) + OpenAI tool definitions.
- [x] `[BE]` Service `ai-harness.ts` (validateSkill, checkCapabilities with wildcard `*`, evaluateRisk, execute, executeApproved, rejectApproval, runSkill 30s timeout).
- [x] `[BE]` Routes `/api/v1/ai/chat`, `/api/v1/ai/approvals`, `/api/v1/ai/approvals/:id/decide`.
- [x] `[BE]` fast-check property tests (15 properties, 100+ iterations) + integration tests.
- [x] `[FE]` `components/ai-assistant.tsx` floating panel 320×480 glassmorphism, max 50 messages.
- [x] `[FE]` `modules/settings/ai-approvals.tsx` card list of pending approvals with Approve/Reject.
- [x] `[DOC]` `features/ai-copilot.md` + keep the historical `features/ai-first-specification.md`.

---

## Phase POST-GA — Advanced (TODO / In progress)

- [x] `[AI]` Integrate a real LLM provider (OpenAI / Anthropic / Workers AI) instead of the mock intent parser in `/ai/chat`.
- [x] `[AI]` Add context memory (conversation history) to the AI Copilot.
- [x] `[AI]` Skills `aiSuggestField` + `aiContentAssist` (RAG via embeddings).
- [x] `[BE]` Real materialized collection writes (not just logical refresh) — a physical table + a refresh trigger.
- [x] `[BE]` Multi-region Durable Objects sharding.
- [x] `[FE]` Marketplace browser UI in Studio (browse, 1-click install).
- [x] `[FE]` Flows visual editor (drag-drop graph) — currently only a list page.
- [x] `[BE]` SCIM Token rotation + audit.
- [x] `[OPS]` Automated multi-tenant isolation testing (k6 cross-site leak detection).


---

## Phase Agent Harness Layer (DONE)

Goal: turn LumiBase into a control plane where humans, agents, data, workflows, and applications co-evolve under control. The detailed checklist is in [`agent-harness-implementation.md`](./agent-harness-implementation.md).

### A. Foundational lifecycle

- [x] `[DB]` Add `agent_goals`, `agent_runs`, `agent_plans`, `agent_tool_calls` with `siteId`, lifecycle status, policy snapshot, budget, audit metadata, and indexes by `siteId/runId/goalId`.
- [x] `[BE]` Create `AgentRunService` to open/append/close/fail/retry a run; refactor `AISecureHarness` so every runtime execute is tied to a `goalId/runId`.
- [x] `[TEST]` Extended property tests for multi-tenant isolation, a failed run still keeps the audit trail, and retry does not duplicate tool calls/artifacts.

### B. Tool Registry + capability policy

- [x] `[DB]` Add `agent_tools` and `agent_permissions` to declare input/output schema, required capabilities, risk policy, rate limit, and validity window.
- [x] `[BE]` Implement `ToolRegistryService` to load core skills + DB overrides; enforce disabled tool, capability, risk policy, and rate limit.
- [x] `[FE]` Studio "Agent Harness" page showing tools, risk, approvals, runs, artifacts, and memory.
- [x] `[SDK]` Add types/client methods for tools, capabilities, and risk policies.

### C. General approval

- [x] `[DB]` Add `agent_approvals` for `plan` / `tool_call` / `artifact` / `schema_diff`; bridge backward-compatibly with `ai_approvals`.
- [x] `[BE]` Foundational approval policy engine: `none`, `before_execute`, `before_commit`, `two_person_rule`, `owner_only`, `security_admin_only` as a contract/policy field.
- [x] `[FE]` Elevate the Studio surface into an Agent Harness queue with subject type, status, and a decision surface.
- [x] `[TEST]` A dangerous plan does not execute before approval; a rejected/expired approval cannot commit.

### D. Artifact Store + Evaluation Gate

- [x] `[DB]` Add `agent_artifacts` and `agent_evaluations` with content hash, version, status, eval kind/status/score/details.
- [x] `[BE]` First artifact writers: `schema_diff`, `page_spec`, `component_spec`, `seed_data`, `api_spec`, `prompt`, `migration`.
- [x] `[BE]` First eval runners: JSON schema validation, schema/migration guard, generated API spec validation, prompt safety check.
- [x] `[FE]` Minimal artifact review UI in the Studio Agent Harness: list artifacts, status, hash, generated app artifacts.
- [x] `[TEST]` An artifact that fails eval cannot be published; the artifact hash is stable; publish/rollback is idempotent.

### E. Memory + App Generation MVP

- [x] `[DB]` Add `agent_memory` with scope, provenance, confidence, expiry, and an optional embedding.
- [x] `[BE]` RAG context builder that respects expiry, provenance, and secret redaction.
- [x] `[AI]` Skills `generateAppSpec`, `generateApiDocs`, `generateSeedData` produce an artifact payload instead of writing directly to content/schema.
- [x] `[FE]` A "Generate" action in the Agent Harness creates app artifacts from `products/orders/customers` with a budget and approval policy.
- [x] `[TEST]` E2E demo: generate a storefront from `products/orders/customers` → plan → artifacts → eval → approval → publish.

### F. Operations

- [x] `[BE]` Metrics for run success/fail, approval latency, tool latency, eval fail rate, token/cost estimate, and budget stop reason.
- [x] `[OPS]` A Grafana "Agent Harness" dashboard and a dead-letter queue for repeatedly failing runs/tool calls.
- [x] `[DOC]` Update `data-model.md`, `architecture/overview.md`, OpenAPI, SDK docs, and runtime limitations per phase.

---

## Phase POST-GA8 — Directus Data Model Parity (DONE)

Goal: upgrade the Data Model / Collections Builder so a collection in LumiBase has a contract as clear as Directus's: full metadata, primary key strategy, system fields, advanced field config, relation metadata, schema permissions, atomic diff/apply, SDK/typegen/OpenAPI, and parity tests. Detailed reference: `docs/en/features/directus-data-model-parity-tasks.md`.

### Milestone 1 — Correctness fixes before expansion (DONE)

- [x] `[FE]` The collection wizard sends the correct top-level payload (`note`, `accountability`, `versioning`, `singleton`, `primaryKeyType`, `storageMode`) instead of cramming it into `meta`.
- [x] `[BE]` `ItemService.patch/replace/softDelete` enforce `update/delete` permission, row-level scope, and the field-level update allowlist.
- [x] `[BE]` Relation delete/dependency checks cover both `manyCollection` and `oneCollection` directions; block deleting a field/collection while a relation still points to it.
- [x] `[TEST]` Add regression tests for the wizard payload, update/delete permission, and relation dependency checks.

### Milestone 2 — Collection metadata + primary key contract (DONE)

- [x] `[DB]` Add first-class collection columns: `label`, `pluralLabel`, `hidden`, `system`, `primaryKeyField`, `primaryKeyType`, `storageMode`, `unarchiveValue`, `itemDuplicationFields`, `translations`.
- [x] `[BE]` Backward-compatible backfill/migration; route validation and `SchemaService` use the new fields, keeping `meta` for extension/custom UI hints.
- [x] `[SDK]` Update the collection input/output types and schema client methods for the new metadata.
- [x] `[FE]` The wizard has Identity, Storage, System fields, Permissions defaults, and Review JSON steps.
- [x] `[BE]` Implement the primary key strategy for `jsonb`: `nanoid`, `uuid`, `string`; explicitly defer or block `integer/bigInteger` if there's no sequence yet.
- [x] `[TEST]` Create item respects the primary key strategy; a duplicate user-provided ID returns `409`.

### Milestone 3 — System fields and field configuration parity

- [x] `[BE]` Extend the compiled schema with `systemFields` (`id`, `status`, `sort`, `user_created`, `user_updated`, `created_at`, `updated_at`, `deleted_at`).
- [x] `[FE]` The Fields tab shows system fields in a locked group; allows configuring display/hidden/readonly/translations/width but not deletion.
- [x] `[DB]` Add field metadata: `label`, `note`, `defaultValue`, `nullable`, `unique`, `indexed`, `searchable`, `length`, `precision`, `scale`, `special`.
- [x] `[FE]` FieldInspector advanced tabs: Basics, Options, Display, Validation, Conditions, Layout, Storage, Translations.
- [x] `[BE]` Separate the create/update/rename/delete/migration field paths; reject changing type/name when data exists without a migration plan.
- [x] `[TEST]` FieldInspector does not lose unknown `options/displayOptions/validation/conditions`; risky changes return `409` or require confirmation.

### Milestone 4 — Relations parity and deep read

- [x] `[BE]` Validate relation references: the collection/field exists, the relation name is not duplicated, `onDelete` is valid for the storage mode.
- [x] `[DB]` Extend relation metadata: `type`, `aliasField`, `relatedDisplayTemplate`, `junctionManyField`, `junctionOneField`.
- [x] `[BE]` Support relation types `m2o`, `o2m`, `m2m`; reserve `m2a` and return "not implemented" if chosen.
- [x] `[BE]` Implement relation expansion for item queries (`fields=author.name,categories.*`, `deep[...]`) with permission masking for related collections.
- [x] `[TEST]` M2O returns an object on expand; O2M/M2M return an array; batching avoids N+1 in common cases.

### Milestone 5 — Schema permissions, diff/apply, and storage positioning

- [x] `[BE]` Add schema permission actions: `schema:read/create/update/delete/migrate`.
- [x] `[BE]` Apply `requireSchemaPermission` to collections/fields/relations/compiled schema routes and AI schema skills.
- [x] `[BE]` Expand the schema diff: collection metadata, field metadata, relation changes, risk classification, and runtime impact.
- [x] `[BE]` `PUT /collections/:name/schema` validates everything, computes the diff, applies transactionally when the runtime supports it, invalidates schema/permission/typegen cache, and emits `schema.changed`.
- [x] `[FE]` The Raw JSON schema tab shows the diff/risk before applying.
- [x] `[DOC]` Document the storage modes `jsonb/materialized/physical/external`, with a limitations badge in Studio.
- [x] `[DOC]` Create the design doc `docs/en/architecture/physical-collections.md` to decide on physical/external mode.

### Milestone 6 — SDK, typegen, OpenAPI, docs, and parity tests

- [x] `[SDK]` Open the full schema resources: collections/fields/relations CRUD, field rename/delete options, schema diff/apply.
- [x] `[SDK]` Keep legacy methods or a deprecation wrapper; preserve the error `code/path/risk` metadata.
- [x] `[SDK]` Typegen includes the primary key type, system fields, nullable/required, readonly/generated, and relation-expanded response types.
- [x] `[DOC]` Update `apps/cms/openapi.yaml`, `docs/en/features/collections-builder.md`, `docs/en/features/field-types-and-config.md`, `docs/en/data-model.md`.
- [x] `[DOC]` Sync the Vietnamese version after the English contract stabilizes.
- [x] `[TEST]` Backend/frontend/SDK parity suite covering the acceptance criteria in `directus-data-model-parity-tasks.md`.

---

## Cross-cutting checklist (every phase)

- [x] Update `architecture.md` if the structure changes.
- [x] Write unit + integration tests before merging; for complex logic use property-based testing (fast-check).
- [x] Update the OpenAPI spec (`apps/cms/openapi.yaml`) for every new endpoint.
- [x] Update the corresponding `packages/sdk` types.
- [x] Update docs in `docs/features/` or `apps/docs/content/`.
- [x] Work directly on `main` per the current repo guidance; commit with conventional commits and push directly to reduce conflicts with parallel workstreams.
- [x] Ensure new routes work on BOTH runtimes (Cloudflare + Docker) — if it depends on a specific API, gate it with a feature flag and document it in `features/runtime-abstraction.md`.
