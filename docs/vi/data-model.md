# Data Model (Drizzle / Postgres)

Tài liệu mô tả các bảng đã được khai báo trong `packages/database/src/schema/`. Row nội bộ mặc định dùng text ID. No-code content collections còn có chiến lược logical item primary key riêng qua `collections.primaryKeyField` và `collections.primaryKeyType`.

Mọi bảng domain theo tenant đều có `site_id`.

> **Tên bảng vật lý mang tiền tố `lumibase_`.** Mọi bảng hệ thống của LumiBase có tên
> vật lý `lumibase_<tên>` (vd bảng logic `users` có tên vật lý `lumibase_users`), được
> tạo bởi migration `0000_lumibase_init`. Điều này dành riêng namespace `lumibase_` cho
> platform — bảng nào KHÔNG có tiền tố này chắc chắn do người dùng tạo (hoặc là bảng
> materialization `mat_*`). Xem [ADR-010](./architecture/decisions/adr-010-lumibase-table-prefix.md).
> Các heading bên dưới dùng tên logic ngắn cho dễ đọc; bảng tóm tắt liệt kê tên vật lý.

Schema được tách theo domain:

| File | Bảng (tên vật lý) |
|------|------|
| `core.ts` | `lumibase_sites`, `lumibase_users`, `lumibase_user_sites`, `lumibase_teams`, `lumibase_team_members`, `lumibase_notifications` |
| `access.ts` | `lumibase_roles`, `lumibase_policies`, `lumibase_role_policies`, `lumibase_user_policies`, `lumibase_permissions` |
| `cms.ts` | `lumibase_pages`, `lumibase_collections`, `lumibase_fields`, `lumibase_relations`, `lumibase_items`, `lumibase_revisions`, `lumibase_releases`, `lumibase_release_items`, `lumibase_activity`, `lumibase_flows`, `lumibase_flow_runs`, `lumibase_operations`, `lumibase_materialized_collections` |
| `platform.ts` | `lumibase_folders`, `lumibase_files`, `lumibase_presets`, `lumibase_translations`, `lumibase_settings`, `lumibase_webhooks`, `lumibase_extensions`, `lumibase_translation_memory`, `lumibase_glossary`, `lumibase_push_subscriptions` |
| `ai.ts` | `lumibase_ai_approvals`, `lumibase_ai_conversations`, `lumibase_ai_messages`, `lumibase_ai_embeddings`, `lumibase_agent_*` |
| `firebase-sync.ts` | `lumibase_firebase_sync_pipelines`, `lumibase_firebase_sync_log` |
| `external-auth.ts` | `lumibase_auth_external_issuers` |

Migrations đầy đủ trong `packages/database/migrations/` và `packages/database/drizzle/`.

---

## 1. Core tenancy & identity (`core.ts`)

### `sites`
- `id`, `name`, `domain`, `createdAt`.

### `users`
| Column | Type | Note |
|---|---|---|
| `id` | text PK | nanoid |
| `logtoId` | text unique | OIDC subject |
| `email`, `firstName`, `lastName`, `avatar` | text |
| `status` | text | `active`/`invited`/`suspended` |
| `language`, `theme`, `tfa` | jsonb | preferences |
| `lastSeenAt` | timestamp |
| `createdAt`, `updatedAt` | timestamp |

### `user_sites` (membership N-N)
- `userId`, `siteId`, `roleId`, `joinedAt`. PK composite.

### `teams` / `team_members`
- `teams`: `id`, `siteId`, `name`, `description`.
- `team_members`: `teamId`, `userId`. PK composite.

### `notifications`
- Persistent inbox cho mention, denial reason, system events (kèm flow `realtime`).

## 2. Schema (no-code) — `cms.ts`

### `pages`
- Page-builder pages (consumed bởi `/deliver`).

### `collections`
| Column | Type | Note |
|---|---|---|
| `id` | text PK |
| `siteId` | text FK |
| `name` | text | machine name, unique per site |
| `label`, `pluralLabel` | text | nhãn hiển thị cho author |
| `hidden`, `system` | boolean |
| `singleton` | boolean |
| `icon`, `color`, `note` | text |
| `primaryKeyField` | text | field định danh item logic, mặc định `id` |
| `primaryKeyType` | text | `nanoid`, `uuid`, `integer`, `bigInteger`, `string` |
| `storageMode` | text | `jsonb`, `materialized`, `physical`, `external` |
| `displayTemplate` | text | mustache template default |
| `sortField`, `archiveField`, `archiveValue`, `unarchiveValue` | text |
| `itemDuplicationFields`, `translations` | jsonb |
| `accountability` | text | `all` / `activity` / `none` |
| `versioning` | boolean |
| `meta` | jsonb | extra UI hints, gồm override presentation an toàn cho system fields |
| `createdAt`, `updatedAt` |

Chiến lược primary key:

- `nanoid`: logical string identifier mặc định do LumiBase sinh.
- `uuid`: UUID string do service sinh.
- `string`: string identifier do caller cung cấp.
- `integer` / `bigInteger`: chiến lược sequence-backed dành cho materialized/physical storage; JSONB collection chặn các tổ hợp này.

Storage modes được ghi rõ để tránh nhầm `jsonb` với bảng vật lý kiểu Directus:

- `jsonb`: collection logic mặc định, backed bởi `items.data`; đổi schema nhanh, không chạy runtime DDL, index/unique theo SQL-native chỉ là advisory.
- `materialized`: JSONB là source of truth, thêm physical read projection được quản lý cho hot path.
- `physical`: mode tương lai cho bảng do LumiBase sở hữu kiểu Directus; schema diff đánh dấu storage runtime change.
- `external`: mode tương lai cho bảng ngoài được introspect; DDL/relation action phá huỷ bị giới hạn vì LumiBase không sở hữu table.

### `fields`
| Column | Type | Note |
|---|---|---|
| `id` | text PK |
| `siteId`, `collectionId` | text FK |
| `name` | text | machine |
| `type` | text | `string`,`text`,`integer`,`decimal`,`boolean`,`json`,`uuid`,`date`,`datetime`,`time`,`csv`,`hash`,`geometry`,`alias` |
| `interface` | text | UI editor key |
| `display` | text | display formatter key |
| `options`, `displayOptions`, `validation`, `conditions`, `translations` | jsonb |
| `required`, `readonly`, `hidden`, `encrypted`, `versioned`, `rawEnabled` | boolean |
| `sortOrder` | integer |
| `width`, `group` | text |

Compiled schema expose generated system fields bên cạnh user-defined rows:

| Field | Type | Ghi chú |
|---|---|---|
| `id` | `string` | Primary item identifier, readonly/generated. |
| `status` | `string` | Workflow status; hiển thị khi bật status/archive behavior. |
| `sort` | `integer` | Giá trị sắp xếp thủ công. |
| `user_created` | `string` | User tạo item, readonly/generated. |
| `user_updated` | `string` | User cập nhật cuối, readonly/generated. |
| `created_at` | `datetime` | Thời điểm tạo, readonly/generated. |
| `updated_at` | `datetime` | Thời điểm cập nhật cuối, readonly/generated. |
| `deleted_at` | `datetime` | Thời điểm soft-delete, readonly/generated và hidden. |

### `relations`
- `id`, `siteId`, `manyCollection`, `manyField`, `oneCollection`, `oneField`, `junctionCollection?`, `type`, `aliasField?`, `relatedDisplayTemplate?`, `junctionManyField?`, `junctionOneField?`, `sortField?`, `onDelete`, `meta jsonb`.
- Relation types là `m2o`, `o2m`, `m2m`, còn `m2a` reserved.
- Schema service validate collection/field được tham chiếu và chặn xóa collection khi relation vẫn tham chiếu một trong hai phía.

### `items`
| Column | Type |
|---|---|
| `id` | text PK |
| `siteId`, `collectionId` | text FK |
| `status` | text | `draft`/`published`/`archived` |
| `data` | jsonb | values keyed by field.name |
| `sort` | integer |
| `userCreated`, `userUpdated` | text FK users |
| `createdAt`, `updatedAt` | timestamp |
| `deletedAt` | timestamp nullable |

Indexes: `(siteId, collectionId, status)`, GIN on `data`.

### `revisions`
- `id`, `siteId`, `itemId`, `collectionId`, `delta jsonb`, `parentId`, `userId`, `createdAt`.

### `activity`
- `id`, `siteId`, `action`, `userId`, `collection`, `itemId`, `ip`, `userAgent`, `comment`, `payload jsonb`, `createdAt`.

### `flows` (POST-GA3)
| Column | Type | Note |
|---|---|---|
| `id`, `siteId` | PK + FK |
| `name`, `description` | text |
| `status` | text | `active` / `inactive` / `draft` |
| `triggerType` | text | `webhook` / `event` / `schedule` / `manual` |
| `triggerOptions`, `graph` | jsonb | graph: `{ entry?, nodes: [{ id, key, options, next?, onError? }] }` |
| `nextRunAt` | timestamp | dùng cho schedule trigger |
| `accountability` | text |

### `flow_runs`
- Mỗi run lưu `status`, `input`, `steps` (per-node output), `output`, `error`, `startedAt`, `finishedAt`.

### `operations`
- Khai báo từng operation node trong flow (key + type + options + position).
- Type: `condition` / `transform` / `http` / `mail` / `log` / `sleep` / `run-extension` / `item.create|update|delete` / `notify`.

### `materialized_collections` (POST-GA6)
- Định nghĩa "denormalized read tables" cho hot path.
- `target`, `refreshStrategy` (`auto`/`cron`/`manual`), `refreshCron`, `projection jsonb`, `filter jsonb`, `lastRefreshedAt`, `rowCount`, `status`, `error`.

### Runtime contract cho schema diff/apply

Schema service expose lifecycle parity với Directus:

- `POST /api/v1/collections/diff` so sánh collection metadata, fields và relations được đề xuất với schema hiện tại.
- `PUT /api/v1/collections/{name}/schema` validate và apply thay đổi metadata, field, relation transactionally khi runtime database hỗ trợ transaction.
- Apply invalidate compiled schema, permission và typegen cache keys, đồng thời emit event `schema.changed`.

Diff output gồm root `risk`, `runtimeImpact`, và entries theo collection/field/relation. Runtime impact values gồm `cache_invalidation`, `permission_recompile`, `typegen_rebuild`, `data_migration_required`, `relation_reindex`, `storage_runtime_change`.

### Typegen manifest v2

`GET /api/v1/typegen/schema` trả versioned manifest với:

- collection `primaryKey`, `primaryKeyField`, `primaryKeyType`;
- user fields cộng compiled system fields;
- flags `required`, `nullable`, `readonly`, `generated`, `system`, `encrypted`, `primaryKey`;
- relation descriptors cho expanded response types.

SDK generation dùng manifest này để emit base collection interfaces và relation response types dạng `CollectionExpanded`.

## 3. Permissions (`access.ts`)

### `roles`
- `id`, `siteId`, `name`, `description`, `icon`, `adminAccess` boolean, `appAccess` boolean.
- Ghi chú: `adminAccess/appAccess` đang tồn tại để tương thích implementation hiện tại. Blueprint RBAC mới khuyến nghị migrate các flag này sang `policies` để giống Directus v11 và để policy trở thành đơn vị import/export. Strategy backward-compatible xem [Migration role flags sang policy flags](./features/role-policy-flag-migration.md).

### `policies`
- `id`, `siteId`, `name`, `description`, `rules jsonb`. Policy độc lập có thể attach vào nhiều roles/users.
- Explicit flags: `adminAccess`, `appAccess`, `enforceTfa`, `ipAllow`, `ipDeny`, `validFrom`, `validUntil`. Đây là source of truth mới cho admin/app/TFA/IP/time guards.

### `role_policies` / `user_policies`
- Many-to-many với `priority`. `user_policies` cho phép gán policy trực tiếp user (override role).

### `permissions`
- `id`, `siteId`, `policyId`, `collection`, `action` (`create`/`read`/`update`/`delete`/`share`), `permissions jsonb` (row-level rule DSL), `validation jsonb`, `presets jsonb`, `fields jsonb` (field-level allow list, `*` = all).
- Nên có unique `(policyId, collection, action)` để tránh duplicate permission rows trong cùng policy.

### System collections cần seed permissions

Khi seed local/staging/prod, cần seed quyền cho các collection hệ thống, không chỉ collection nội dung. Nhóm nhạy cảm như `system_state`, `audit_log`, `login_attempts`, `login_baselines`, `admin_backup_codes`, `scim_tokens`, và các bảng API key tương lai chỉ nên dành cho admin/security policies. Contract chốt xem [System Collections & Sensitive Access](./features/system-collections-access.md); blueprint tổng thể xem [Permission Builder blueprint](./features/permission-builder-directus-investigation.md#9-system-collections-và-seeding).

## 4. Files & Assets (`platform.ts`)

### `files`
- `id`, `siteId`, `storage` (`r2`/`s3`/external), `filenameDisk`, `filenameDownload`, `mime`, `filesize`, `width`, `height`, `duration`, `folder`, `metadata jsonb`, `uploadedBy`, `createdAt`.

### `folders`
- `id`, `siteId`, `name`, `parent`.

## 5. UX state (`platform.ts`)

### `presets` (bookmark + view state)
- `id`, `siteId`, `bookmark` text nullable, `collection`, `userId?`, `roleId?`, `layout` (`tabular`/`cards`/`kanban`/`calendar`/`map`), `layoutQuery jsonb`, `layoutOptions jsonb`, `search`, `filter jsonb`, `icon`, `color`, `refreshInterval`.

### `translations` (UI strings + content)
- `id`, `siteId`, `language`, `namespace` (`ui`/`field`/`content`), `key`, `value`. Unique `(siteId, language, namespace, key)`.

## 6. Settings & Config (`platform.ts`)

### `settings` (key/value per site)
- `id`, `siteId`, `key`, `value jsonb`, `scope` (`site`/`module`), `updatedAt`.

### `webhooks`
- `id`, `siteId`, `name`, `url`, `actions text[]`, `collections text[]`, `headers jsonb`, `status`, `secret`, `createdAt`.

## 7. Extensions + Marketplace (`platform.ts`)

### `extensions`
| Column | Type | Note |
|---|---|---|
| `id` | text PK |
| `siteId` | nullable text FK | null = global |
| `name`, `version` | text |
| `type` | text | `hook`/`endpoint`/`module`/`interface`/`display`/`layout`/`panel`/`operation` |
| `enabled` | boolean |
| `bundleUrl` | text | R2/S3 path |
| `manifest` | jsonb |
| `capabilities` | jsonb | granted subset of manifest |
| `installedBy`, `installedAt` |
| **Marketplace fields (POST-GA5)**: `signature`, `signatureAlg` (`ed25519`/`rsa-pss-sha256`), `publisherKeyId`, `publisher`, `marketplaceSlug`, `publishedAt`, `bundleSha256` |

Indexes: `(siteId, name)`, `(publisher, publishedAt)`, `marketplaceSlug`.

## 8. Translation Memory (`platform.ts`, POST-GA1)

### `translation_memory`
- `(sourceLang, targetLang, sourceText, targetText)` + `quality` (0-100), `source` (`human`/`mt`/`imported`), `provider`, `hits`, `context`.

### `glossary`
- Term-level constraints: `rule` (`do-not-translate`/`prefer`/`forbidden`), `term`, `translation`, `note`.

## 9. Realtime / Notifications (`core.ts`)

### `notifications`
- `id`, `siteId`, `recipient` (userId), `sender?`, `subject`, `message`, `collection?`, `item?`, `status`, `createdAt`.

> Realtime cursor data (CRDT-lite) **không** persist trong Postgres — chỉ broadcast qua Durable Object/host process. Xem `apps/cms/src/services/cursor-protocol.ts`.

## 10. AI Copilot seed (`ai.ts`)

Các bảng hiện có là bước đầu của **Agent Harness Layer**: chat/copilot, HITL approval và RAG context. Blueprint mở rộng nằm ở [Agent Harness Layer](./features/agent-harness-layer.md).

### `ai_approvals`
| Column | Type | Note |
|---|---|---|
| `id` | text PK | nanoid(21) |
| `siteId` | text FK → sites CASCADE |
| `agentName` | text | default `'lumibase-copilot'` |
| `skillName` | text | từ `CORE_SKILLS` registry |
| `arguments` | jsonb | đối số skill |
| `status` | text | `pending` / `approved` / `rejected` |
| `context` | text nullable | message gốc của user |
| `createdAt`, `decidedAt` | timestamp |
| `decidedBy` | text FK → users SET NULL |

Index: `(siteId, status)`.

Hành vi: Skill nguy hiểm (`schema:write` hoặc tên bắt đầu bằng `delete`) bắt buộc tạo `ai_approvals` row chờ duyệt thay vì execute trực tiếp. Xem `docs/features/ai-copilot.md`.

### `ai_conversations`
- Thread hội thoại theo `siteId`, `userId`, `title`, `createdAt`, `updatedAt`.
- Index: `(siteId, userId)`.

### `ai_messages`
- Message trong conversation: `conversationId`, `role` (`user`/`assistant`/`system`), `content`, `toolCalls jsonb`, `metadata jsonb`, `createdAt`.
- Index: `(conversationId, createdAt)`.

### `ai_embeddings`
- RAG chunks theo `siteId`, `collection`, `itemId`, `fieldName`, `chunkText`, `embedding jsonb`, `model`, `createdAt`.
- Index: `(siteId, collection)`, `(itemId)`. Khi production có pgvector, migrate `embedding` từ JSONB sang `vector(1536)` hoặc dimension theo model.

## 11. Agent Harness Layer — system collections

Các collection sau là nền tảng hiện tại để LumiBase vận hành AI Agent theo lifecycle có audit/retry/evaluation:

| Collection | Mục đích | Quan hệ chính |
|---|---|---|
| `agent_goals` | Mục tiêu business người dùng/workflow giao cho agent | `siteId`, `createdBy`, `priority`, `deadline`, `status` |
| `agent_runs` | Một lần thực thi goal/task | `goalId`, `agentName`, `model`, `provider`, `budget`, `status`, `startedAt`, `finishedAt` |
| `agent_plans` | Plan/steps trước khi execute | `runId`, `steps jsonb`, `risk`, `approvalPolicy`, `status` |
| `agent_tools` | Registry tool/API/extension agent được gọi | `name`, `inputSchema`, `requiredCapabilities`, `riskPolicy`, `rateLimit`, `owner` |
| `agent_tool_calls` | Audit từng tool call | `runId`, `toolName`, `input`, `output`, `error`, `latencyMs`, `cost`, `createdAt` |
| `agent_memory` | Memory dài hạn ngoài conversation | `scope`, `source`, `content`, `confidence`, `expiresAt` |
| `agent_artifacts` | Output versioned: page/component/dataset/config/prompt/migration/API spec | `runId`, `type`, `target`, `contentRef`, `hash`, `status` |
| `agent_evaluations` | Validation/eval trước khi commit | `runId`, `artifactId`, `kind`, `status`, `score`, `summary`, `details` |
| `agent_approvals` | Approval tổng quát cho plan/tool/artifact | `runId`, `subjectType`, `subjectId`, `status`, `decidedBy`, `reason` |
| `agent_permissions` | Mapping agent/role/policy/capability | `agentName`, `policyId`, `capabilities`, `validFrom`, `validUntil` |

Các API runtime nằm dưới `/api/v1/agent/*`: goals, runs, tools, approvals, artifacts, memory và `generate-app`. `generate-app` tạo bộ artifact MVP gồm `page_spec`, `component_spec`, `seed_data`, `api_spec` và chạy evaluation trước khi trả kết quả. `AISecureHarness` vẫn giữ `/ai/*` backward-compatible nhưng khi chạy với service thật sẽ tự tạo transient goal/run và ghi `agent_tool_calls`/`agent_approvals`.

Vận hành: `agent_runs.metrics.stopReason` ghi lý do dừng như `completed`, `error`, `max_tool_calls`; `agent_tool_calls.cost` ghi token/cost estimate đã mask secret. Khi một goal fail lặp lại ít nhất 3 run và runtime có `QueueProvider`, service enqueue job vào queue `agent-dead-letter` với `siteId`, `goalId`, `runId`, `agentName`, `error`, `stopReason`.

Thiết kế bắt buộc: mọi bảng domain có `siteId`, index `(siteId, ...)`, audit metadata, và không cho prompt tự nâng quyền ngoài `agent_permissions`/policy snapshot.

## 12. Indexing & RLS

- Bắt buộc index `(siteId, …)` ở mọi bảng domain.
- Áp dụng Drizzle helper `scopeSite(siteId)` ở tầng repo.
- Postgres RLS được bật qua middleware `withRls()` (`apps/cms/src/middleware/rls.ts`) — set session var để defence-in-depth.
