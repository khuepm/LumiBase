---
version: 1
lastUpdated: 2026-07-28T00:11:35.763Z
sourceLang: en
translatedFrom: en
sourceHash: 6edecac703c795d3
mtEngine: claude
syncStatus: machine-translated
codeVerified: 2026-07-28T00:11:35.763Z
codeVerifiedHash: 6edecac703c795d3
codeVerifiedClaims: 14
---

# Data Model (Drizzle / Postgres)

Tài liệu mô tả các bảng đã được khai báo trong `packages/database/src/schema/`. Row nội bộ mặc định dùng text ID. No-code content collections còn có chiến lược logical item primary key riêng qua `collections.primaryKeyField` và `collections.primaryKeyType`.

Mọi bảng domain theo tenant đều có `site_id`.

> **Tên bảng vật lý mang tiền tố `lumibase_`.** Mọi bảng hệ thống của LumiBase có tên
> vật lý `lumibase_<tên>` (vd bảng logic `users` có tên vật lý `lumibase_users`), được
> tạo bởi migration `0000_lumibase_init`. Điều này dành riêng namespace `lumibase_` cho
> platform — bảng nào KHÔNG có tiền tố này chắc chắn do người dùng tạo (hoặc là bảng
> materialization `mat_*`). Xem [ADR-010](./architecture/decisions/adr-010-lumibase-table-prefix.md).
> Các heading bên dưới dùng tên logic ngắn cho dễ đọc; bảng tóm tắt liệt kê tên vật lý.

Các file schema được chia theo domain:

| File | Bảng (vật lý) |
|------|------|
| `core.ts` | `lumibase_sites`, `lumibase_users`, `lumibase_user_sites`, `lumibase_teams`, `lumibase_team_members`, `lumibase_notifications` |
| `access.ts` | `lumibase_roles`, `lumibase_policies`, `lumibase_role_policies`, `lumibase_user_policies`, `lumibase_permissions`, `lumibase_refresh_tokens` |
| `cms.ts` | `lumibase_pages`, `lumibase_collections`, `lumibase_fields`, `lumibase_relations`, `lumibase_items`, `lumibase_revisions`, `lumibase_releases`, `lumibase_release_items`, `lumibase_activity`, `lumibase_flows`, `lumibase_flow_runs`, `lumibase_operations`, `lumibase_materialized_collections` |
| `platform.ts` | `lumibase_folders`, `lumibase_files`, `lumibase_presets`, `lumibase_translations`, `lumibase_settings`, `lumibase_webhooks`, `lumibase_extensions`, `lumibase_translation_memory`, `lumibase_glossary`, `lumibase_push_subscriptions` |
| `ai.ts` | `lumibase_ai_approvals`, `lumibase_agent_*` |
| `firebase-sync.ts` | `lumibase_firebase_sync_pipelines`, `lumibase_firebase_sync_log` |
| `external-auth.ts` | `lumibase_auth_external_issuers` |

Migration nằm ở `packages/database/migrations/` và `packages/database/drizzle/`.

---

## 1. Core tenancy & identity (`core.ts`)

### `sites`
- `id`, `name`, `domain`, `createdAt`, cùng các cột identity/branding/theme và `defaultLanguage`, `defaultAppearance`, `defaultSaveAction` (`stay`|`return`|`create_new`, mặc định `stay` — save action mặc định của Studio ở cấp site; override theo từng user nằm ở `users.preferences.saveAction`).

### `users`
| Column | Type | Note |
|---|---|---|
| `id` | text PK | nanoid |
| `logtoId` | text unique | OIDC subject |
| `email`, `firstName`, `lastName`, `avatar` | text |
| `status` | text | `active`/`invited`/`suspended` |
| `language`, `theme`, `tfa` | jsonb | preferences |
| `preferences` | jsonb | UI prefs theo user: `{ language, theme, timezone, defaultPresets, saveAction }`. `saveAction` (`stay`/`return`/`create_new`) override `sites.default_save_action`. |
| `lastSeenAt` | timestamp |
| `passwordChangedAt` | timestamp | Được set ở mọi lần reset/change (migration `0006`). Token password-reset có `iat` sớm hơn mốc này sẽ bị từ chối → link reset dùng một lần. |
| `createdAt`, `updatedAt` | timestamp |

Unique index: `users_external_id_unique`, `users_is_bootstrap_unique` (partial, `is_bootstrap = true`), và `users_email_lower_unique` trên `lower(email)` (migration `0006`) — email là identity toàn cục, một account cho một địa chỉ. ⚠️ Migrate một instance đang chạy sẽ fail nếu instance đó đã có email trùng nhau khi bỏ qua hoa/thường; phải de-duplicate trước.

### `user_sites` (membership N-N)
- `userId`, `siteId`, `roleId`, `joinedAt`. PK composite.

### `teams` / `team_members`
- `teams`: `id`, `siteId`, `name`, `description`.
- `team_members`: `teamId`, `userId`. PK composite.

### `notifications`
- Inbox lưu bền cho mention, lý do bị từ chối và system event. Việc gửi realtime nằm ở tầng trên lớp persistence này.

## 2. Schema (no-code) — `cms.ts`

### `pages`
- Trang page-builder được `/deliver` tiêu thụ.

### `collections`
| Column | Type | Note |
|---|---|---|
| `id` | text PK |
| `siteId` | text FK |
| `name` | text | machine name, unique theo site |
| `label`, `pluralLabel` | text | label hiển thị cho người biên tập |
| `hidden`, `system` | boolean |
| `singleton` | boolean |
| `icon`, `color`, `note` | text |
| `primaryKeyField` | text | field định danh logic của item, mặc định `id` |
| `primaryKeyType` | text | `nanoid`, `uuid`, `integer`, `bigInteger`, `string` |
| `storageMode` | text | `jsonb`, `materialized`, `physical`, `external` |
| `displayTemplate` | text | mustache template mặc định |
| `sortField`, `archiveField`, `archiveValue`, `unarchiveValue` | text |
| `itemDuplicationFields`, `translations` | jsonb |
| `accountability` | text | `all` / `activity` / `none` |
| `versioning` | boolean |
| `meta` | jsonb | UI hint bổ sung, gồm cả override an toàn cho cách hiển thị system field |
| `createdAt`, `updatedAt` |

Chiến lược primary key:

- `nanoid`: định danh chuỗi logic mặc định do LumiBase sinh.
- `uuid`: chuỗi UUID do service sinh.
- `string`: định danh chuỗi do caller cung cấp.
- `integer` / `bigInteger`: chiến lược dựa trên sequence, dành riêng cho storage materialized/physical; collection JSONB chặn các tổ hợp này.

Storage mode được khai báo tường minh có chủ đích:

- `jsonb`: collection logic mặc định, dựa trên `items.data`; schema tiến hoá nhanh nhất, không cần DDL runtime, index/unique constraint SQL-native ở mức advisory.
- `materialized`: JSONB là source of truth, kèm projection đọc vật lý được quản lý cho các đường nóng.
- `physical`: chế độ table sở hữu kiểu Directus (tương lai); schema diff đánh dấu đây là thay đổi storage runtime.
- `external`: chế độ introspect table (tương lai); các hành vi DDL/relation phá huỷ bị hạn chế vì LumiBase không sở hữu table.

### `fields`
| Column | Type | Note |
|---|---|---|
| `id` | text PK |
| `siteId`, `collectionId` | text FK |
| `name` | text | machine |
| `type` | text | `string`,`text`,`integer`,`decimal`,`boolean`,`json`,`uuid`,`date`,`datetime`,`time`,`csv`,`hash`,`geometry`,`alias` |
| `interface` | text | key của UI editor |
| `display` | text | key của display formatter |
| `options`, `displayOptions`, `validation`, `conditions`, `translations` | jsonb |
| `required`, `readonly`, `hidden`, `encrypted`, `versioned`, `rawEnabled` | boolean |
| `classification` | text | Mức nhạy cảm dữ liệu (Req 5): `none`/`internal`/`pii`/`phi`. `pii`/`phi` buộc phải `encrypted=true`; chi phối masking mặc định, gating `read_decrypted` và audit `field_access_log`. |
| `sortOrder` | integer |
| `width`, `group` | text |

Compiled schema phơi ra các system field được sinh tự động, bên cạnh các row do người dùng định nghĩa:

| Field | Type | Ghi chú |
|---|---|---|
| `id` | `string` | Định danh item chính, readonly/generated. |
| `status` | `string` | Workflow status; hiển thị khi bật hành vi status/archive. |
| `sort` | `integer` | Giá trị sắp xếp thủ công. |
| `user_created` | `string` | User ID người tạo, readonly/generated. |
| `user_updated` | `string` | User ID người sửa gần nhất, readonly/generated. |
| `created_at` | `datetime` | Timestamp tạo, readonly/generated. |
| `updated_at` | `datetime` | Timestamp sửa gần nhất, readonly/generated. |
| `deleted_at` | `datetime` | Timestamp soft-delete, readonly/generated và hidden. |

### `relations`
- `id`, `siteId`, `manyCollection`, `manyField`, `oneCollection`, `oneField`, `junctionCollection?`, `type`, `aliasField?`, `relatedDisplayTemplate?`, `junctionManyField?`, `junctionOneField?`, `sortField?`, `onDelete`, `meta jsonb`.
- Loại relation gồm `m2o`, `o2m`, `m2m`, còn `m2a` được để dành.
- Schema service validate collection/field được tham chiếu, và chặn xoá collection khi relation vẫn còn trỏ vào một trong hai phía.

### `items`
| Column | Type |
|---|---|
| `id` | text PK |
| `siteId`, `collectionId` | text FK |
| `status` | text | `draft`/`published`/`archived` |
| `data` | jsonb | giá trị đánh key theo field.name |
| `sort` | integer |
| `userCreated`, `userUpdated` | text FK users |
| `publishAt`, `unpublishAt` | timestamp nullable | Khung thời gian scheduling (Req 7); worker reconcile đổi status, delivery filter theo khung này. |
| `editorialState` | text nullable | Trạng thái human review (Req 9): `draft`/`in_review`/`approved`/`published`/`rejected`. Khác với veto-window của AI. |
| `dekWrapped` | text nullable | Chế độ envelope (Req 4.5): DEK theo từng record, được bọc bởi KEK. Non-null ⇒ các field encrypted của record này dùng DEK riêng; null ⇒ chế độ shared-key. Việc đọc là tự-mô-tả từ cột này. |
| `createdAt`, `updatedAt` | timestamp |
| `deletedAt` | timestamp nullable |

Index: `(siteId, collectionId, status)`, GIN trên `data`, `(siteId, status, publishAt)`, `(siteId, status, unpublishAt)`.

### `revisions`
- `id`, `siteId`, `itemId`, `collectionId`, `delta jsonb`, `parentId`, `userId`, `createdAt`.

### `releases` (Content Releases)
- Một bundle publish xuyên collection. `id`, `siteId`, `name`, `description`, `status` (`draft`|`scheduled`|`published`|`failed`|`partially_failed`), `atomicityMode` (`all_or_nothing`|`best_effort`), `publishAt`, `publishedAt`, `maintenanceWindow jsonb`, `statusReason`, `createdBy → users.id (set null)`, `createdAt`, `updatedAt`.
- Index: `releases_site_status_idx (siteId, status)`, `releases_publish_due_idx (siteId, status, publishAt)` (đối xứng với `items.publishDueIdx` cho vòng quét của scheduler).

### `release_items` (Content Releases)
- Bảng junction release ↔ item, có thể ghim vào một revision cụ thể. `id`, `siteId`, `releaseId → releases.id (cascade)`, `collection`, `itemId → items.id (cascade)`, `targetStatus` (mặc định `published`), `revisionId → revisions.id (set null)`, `outcome` (`published`|`skipped`|`failed`), `outcomeReason`, `createdAt`.
- Unique `(releaseId, collection, itemId)` (key cho upsert); index `(siteId, releaseId)`.

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
- Định nghĩa các bảng đọc đã denormalize cho đường nóng.
- `target`, `refreshStrategy` (`auto`/`cron`/`manual`), `refreshCron`, `projection jsonb`, `filter jsonb`, `lastRefreshedAt`, `rowCount`, `status`, `error`.

### Runtime contract cho schema diff/apply

Schema service phơi ra lifecycle ngang bằng Directus:

- `POST /api/v1/collections/diff` so sánh metadata collection, field và relation được đề xuất với schema hiện tại.
- `PUT /api/v1/collections/{name}/schema` validate rồi áp dụng thay đổi metadata, field và relation trong một transaction khi database runtime hỗ trợ transaction.
- Apply invalidate cache key của compiled schema, permission và typegen, đồng thời phát event `schema.changed`.

Output của diff gồm `risk`, `runtimeImpact` ở cấp gốc và entry cho từng collection/field/relation. Giá trị runtime impact gồm `cache_invalidation`, `permission_recompile`, `typegen_rebuild`, `data_migration_required`, `relation_reindex` và `storage_runtime_change`.

### Typegen manifest v2

`GET /api/v1/typegen/schema` trả về manifest có version, gồm:

- `primaryKey`, `primaryKeyField`, `primaryKeyType` của collection;
- user field cộng với system field đã compile;
- các flag `required`, `nullable`, `readonly`, `generated`, `system`, `encrypted`, `primaryKey`;
- relation descriptor cho các response type đã expand.

Quá trình sinh SDK dùng manifest này để phát ra interface collection cơ sở và các response type relation `CollectionExpanded`.

## 3. Permissions (`access.ts`)

### `roles`
- `id`, `siteId`, `name`, `description`, `icon`, `adminAccess` boolean, `appAccess` boolean.
- Lưu ý: `adminAccess/appAccess` là flag tương thích cũ. Công việc RBAC mới chuyển các flag này sang policy để role chỉ còn là đơn vị nhóm. Xem [Role Flag to Policy Flag Migration](./features/role-policy-flag-migration.md).

### `policies`
- `id`, `siteId`, `name`, `description`, `rules jsonb`. Policy độc lập có thể attach vào nhiều roles/users.
- Flag tường minh: `adminAccess`, `appAccess`, `enforceTfa`, `ipAllow`, `ipDeny`, `validFrom`, `validUntil`. Đây là source of truth mới cho các guard admin/app/TFA/IP/thời gian.

### `role_policies` / `user_policies`
- Many-to-many với `priority`. `user_policies` cho phép gán policy trực tiếp user (override role).

### `permissions`
- `id`, `siteId`, `policyId`, `collection`, `action` (`create`/`read`/`update`/`delete`/`share`), `permissions jsonb` (DSL rule ở mức row), `validation jsonb`, `presets jsonb`, `fields text[]` (allow list ở mức field, `*` = tất cả).

### `refresh_tokens` (migration `0005`, vật lý `lumibase_refresh_tokens`)
- `id`, `siteId`, `userId`, `audience` (`studio`/`frontend`), `tokenHash` (sha256, unique — không bao giờ lưu plaintext), `familyId` (chuỗi rotation), `replacedBy`, `expiresAt`, `revokedAt`, `lastIp`, `lastUserAgent`, `createdAt`.
- Token gia hạn session, có rotation và thu hồi được. Dùng lại một row đã revoke sẽ revoke toàn bộ `familyId` (phát hiện đánh cắp). Được quét dọn bởi cron mỗi giờ sau khi hết hạn. Xem [`security/user-management.md`](./security/user-management.md) §4d.

### System collections cần seed permissions

Khi seed local/staging/prod, phải seed permission cho system collection một cách tường minh. Các collection nhạy cảm như `system_state`, `audit_log`, `login_attempts`, `login_baselines`, `admin_backup_codes`, `scim_tokens` và các bảng API key trong tương lai chỉ dành cho admin/security. Xem [System Collections & Sensitive Access](./features/system-collections-access.md).

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

### `settings` (key/value theo site)
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
| `bundleUrl` | text | đường dẫn R2/S3 |
| `manifest` | jsonb |
| `capabilities` | jsonb | tập con của manifest đã được cấp |
| `installedBy`, `installedAt` |
| **Marketplace fields (POST-GA5)**: `signature`, `signatureAlg` (`ed25519`/`rsa-pss-sha256`), `publisherKeyId`, `publisher`, `marketplaceSlug`, `publishedAt`, `bundleSha256` |

Index: `(siteId, name)`, `(publisher, publishedAt)`, `marketplaceSlug`.

## 8. Translation Memory (`platform.ts`, POST-GA1)

### `translation_memory`
- `(sourceLang, targetLang, sourceText, targetText)` + `quality` (0-100), `source` (`human`/`mt`/`imported`), `provider`, `hits`, `context`.

### `glossary`
- Ràng buộc ở mức thuật ngữ: `rule` (`do-not-translate`/`prefer`/`forbidden`), `term`, `translation`, `note`.

## 9. Realtime / Notifications (`core.ts`)

### `notifications`
- `id`, `siteId`, `recipient` (userId), `sender?`, `subject`, `message`, `collection?`, `item?`, `status`, `createdAt`.

> Realtime cursor data (CRDT-lite) **không** persist trong Postgres — chỉ broadcast qua Durable Object/host process. Xem `apps/cms/src/services/cursor-protocol.ts`.

## 10. AI Copilot và Agent Harness (`ai.ts`)

Các bảng Copilot hiện có cung cấp lịch sử chat/HITL. Agent Harness mở rộng nền
tảng đó bằng lifecycle, tool, approval, artifact, evaluation và memory ở dạng
first-class. Xem [Agent Harness Layer](./features/agent-harness-layer.md) để nắm
contract phía người dùng và runtime.

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

Hành vi: Skill nguy hiểm (`schema:write` hoặc tên bắt đầu bằng `delete`) bắt buộc
tạo `ai_approvals` row chờ duyệt thay vì execute trực tiếp. Xem
[AI Copilot](./features/ai-copilot.md). Các hành vi harness nguy hiểm mới cũng ghi
kèm record `agent_approvals` (dạng tổng quát, có liên kết) khi phù hợp.

### Các bảng harness `agent_*`

| Collection | Mục đích |
|---|---|
| `agent_goals` | Mục tiêu business do user, workflow hoặc generation template tạo ra |
| `agent_runs` | Từng lần thực thi, kèm status, budget, metrics và liên kết retry |
| `agent_plans` | Các step đã lập kế hoạch gắn với một run |
| `agent_tools` | Entry registry tool, kèm schema, owner, trạng thái enabled, capability, risk và rate policy |
| `agent_permissions` | Cấp capability theo agent/role/policy |
| `agent_tool_calls` | Record audit theo tenant cho từng tool call hoặc lần bị chặn |
| `agent_approvals` | Approval tổng quát cho plan, tool call, artifact và schema diff |
| `agent_artifacts` | Output sinh ra có version như schema diff, spec, seed data, prompt và migration |
| `agent_evaluations` | Kết quả evaluation, dùng làm cửa chặn trước approve/publish |
| `agent_memory` | Memory dài hạn theo scope, kèm provenance, confidence, expiry và embedding tuỳ chọn |

Mọi bảng harness đều có `siteId` và bắt buộc truy vấn qua filter theo tenant.

Ghi chú vận hành:

- `POST /api/v1/agent/generate-app` tạo artifact `page_spec`, `component_spec`, `seed_data`, `api_spec` và chạy evaluation cho từng artifact trước khi trả kết quả.
- `agent_runs.metrics.stopReason` ghi lý do hoàn tất hoặc dừng theo budget, ví dụ `completed`, `error`, `max_tool_calls`.
- `agent_tool_calls.cost` lưu token/cost estimate sau khi đã mask secret.
- Nếu cùng một goal fail ít nhất ba run và runtime có `QueueProvider`, run service enqueue `agent-dead-letter` với payload thất bại theo tenant.

### Các bảng Content OS (`content-os.ts`)

| Collection | Mục đích |
|---|---|
| `content_intents` | Trạng thái mong muốn được khai báo (SLO) theo collection: rule, cron schedule, budget, mức autonomy tối đa, maintenance window |
| `content_drifts` | Vi phạm rule đã phát hiện; unique `(siteId, fingerprint)` dedupe việc phát hiện giữa các lần scan |
| `agent_autonomy_grants` | Mức tin cậy đã đạt được theo (site, agentRole, capability): level 0–4, evidence, expiry |
| `agent_incidents` | Bằng chứng để hạ cấp và nguồn cho exception inbox (`veto`, `eval_fail`, `load_guard`, …) |
| `agent_freezes` | Kill-switch freeze (scope `site`/`role`); `liftedAt IS NULL` = đang active; đồng thời là audit trail |
| `agent_roles` | Thư viện role multi-agent với tập capability tối thiểu; harness enforce role ∩ grant |
| `constitutions` | Tập evaluator cho publish-gate, có version; định danh bằng hash sha256; mỗi site tối đa một bản `active` |

Các cột Content OS thêm vào bảng có sẵn:

- `revisions`: `authorType`, `createdByRunId`, `model`, `constitutionHash`, `sources`, `confidence`, `staged`, `autoCommitAt` (provenance + staging cho veto).
- `items`: `pinnedFields` (Law Zero — các field mà một lần sửa của con người đã khoá lại, chặn agent ghi).
- `agent_goals`: `parentGoalId` (cây goal), `origin` (`user/reconciler/planner/flow`), `intentId`, `driftFingerprint`, `agentRole`.
- `agent_approvals`: `kind` (`approval`/`veto`), `autoCommitAt`, `approverType` (`human`/`agent`), `approverRunId`.

### Các bảng lấy cảm hứng từ Directus (`cms.ts`)

| Collection | Mục đích |
|---|---|
| `content_versions` | Nhánh draft song song có tên của một item, khác với `revisions` tuyến tính. Snapshot `data` của item + một `hash` của main tại thời điểm snapshot (phát hiện phân kỳ). Promote áp version lên main qua ItemService (ghi một revision). Unique `(siteId, collectionId, itemId, key)`. Xem `.kiro/specs/content-versioning`. |
| `dashboards` | Container dashboard Insights theo site (name/icon/color/note). |
| `panels` | Một visualization trên dashboard: `type` (metric/timeSeries/bar/pie/list/table), `position` (`{x,y,w,h}`), `query` (một `PanelQuery`), `options`. Aggregate chạy an toàn (whitelist field + scope siteId). Xem `.kiro/specs/insights-dashboard`. |
| `transform_presets` | Preset biến đổi ảnh có tên: `key` an toàn cho URL → một `TransformDsl` (`{ width?, height?, format?, quality?, fit?, focal? }`). Được resolve bởi `GET /media/:key?preset=<key>`. Unique `(siteId, key)`. Migration `0004_transform_presets`. Xem `.kiro/specs/image-transform-dsl`. |

## 11. Firebase Sync (`firebase-sync.ts`)

Xem [features/firebase-sync.md](./features/firebase-sync.md). Migration: `0000_lumibase_init` (đã hợp nhất).

## 11d. Change Feed (`cdc.ts` — spec cdc-extension-integration)

| Bảng | Mục đích |
|---|---|
| `lumibase_cdc_change_events` | Outbox transactional chỉ-ghi-thêm: một row cho mỗi mutation đã commit (`resource` `item`/`collection`/`field`/`setting` — mặc định `item`, migration `0008`; `collection`, `item_id`, `operation`, `payload` đã mask, `changed_fields`, actor/source, `occurred_at`). `type` của envelope là `<plural-resource>.<operation>`. Thứ tự feed = keyset `(occurred_at, id)` — PK nanoid không mang thứ tự. Index `(site_id, occurred_at, id)` và `(site_id, collection, occurred_at, id)`. |
| `lumibase_cdc_subscriptions` | Registry consumer + checkpoint (`cursor_occurred_at` + `cursor_id`), kind `pull`/`webhook`/`extension`, status `active`/`paused`/`dead`/`stale`, filters, `consecutive_failures`. Unique `(site_id, name)`. |
| `lumibase_cdc_deliveries` | Log chỉ-ghi-thêm cho từng lần thử gửi theo batch (attempt, status, http status, error message có giới hạn độ dài, duration). Được prune theo cùng cửa sổ retention với outbox. |

Cả ba đều scope theo `site_id` với RLS `site_isolation`. Xem `docs/vi/features/cdc-change-feed.md`.

## 11c. External JWT auth (`external-auth.ts`)

### `auth_external_issuers`
- Issuer JWT ngoài được tin cậy, theo từng site. **Chỉ config public — không có secret** (chữ ký được verify dựa trên JWKS của issuer). `id`, `siteId` (FK sites, cascade), `issuer` (khớp claim `iss`), `jwksUri`/`discoveryUrl` (bắt buộc một trong hai), `audience` (jsonb: string|string[]), `algorithms` (jsonb: allowlist thuật toán bất đối xứng), `claimMapping` (jsonb: `{ email, roles, siteId?, externalId? }`), `roleMapping` (jsonb: `{ "<claim role>": { roleId|systemKey } }`), `defaultRoleId`, `jitProvisioning`, `clockSkewSeconds`, `enabled`, `createdAt`, `updatedAt`.
- Unique `(siteId, issuer)`; index `(siteId, enabled)`. Migration: `0000_lumibase_init` (đã hợp nhất). Xem [security/external-jwt-auth.md](./security/external-jwt-auth.md).

### `lumibase_firebase_sync_pipelines`
| Column | Type | Note |
|---|---|---|
| `id` | text PK | nanoid |
| `siteId` | text | FK `sites.id` (cascade) |
| `name` | text | unique theo `(siteId, name)` |
| `target` | text | `firestore` / `rtdb` |
| `status` | text | `active` / `paused` / `error` |
| `statusMessage` | text | lỗi gần nhất (nullable) |
| `projectId` | text | Firebase project id |
| `credentialsEncrypted` | text | credential blob mã hoá AES-GCM (write-only) |
| `collections` | jsonb | machine-names; `[]` = mọi collection |
| `targetPath` | text | template, mặc định `{collection}` |
| `syncOnCreate` / `syncOnUpdate` / `syncOnDelete` | integer | 1/0 bật từng action |
| `lastSyncAt` | timestamp | lần sync thành công gần nhất |
| `lastSyncItemCount` | integer | nullable |
| `createdAt` / `updatedAt` | timestamp | |

### `lumibase_firebase_sync_log`
| Column | Type | Note |
|---|---|---|
| `id` | text PK | nanoid |
| `pipelineId` | text | FK `lumibase_firebase_sync_pipelines.id` (cascade) |
| `siteId` | text | FK `sites.id` (cascade) |
| `collection` / `itemId` | text | nguồn của thay đổi |
| `action` | text | `create` / `update` / `delete` |
| `result` | text | `success` / `error` |
| `errorMessage` | text | nullable |
| `durationMs` | integer | round-trip gọi Firebase REST |
| `recordedAt` | timestamp | index `(pipelineId, recordedAt)` |

---

## 11b. Nội dung có kiểm soát / nhạy cảm (`regulated.ts`)

Các bảng opt-in, chỉ thêm vào, phục vụ nhóm capability regulated-content-readiness. Cài đặt Tier 1 mặc định không bao giờ ghi vào chúng. Quy ước ID: `nanoid` cho tất cả (cả domain lẫn audit-grade), khớp với PK `audit_log` hiện có.

### `encryption_keys`
**Chỉ** metadata cho versioning/rotation key (Req 3.3) — không bao giờ lưu key material; bytes nằm trong `KeyProvider` của runtime (Workers Secrets / env).
| Column | Type | Note |
|---|---|---|
| `id` | text PK | nanoid |
| `siteId` | text FK nullable | null ⇒ key toàn cục |
| `keyId` | text | id version được nhúng trong envelope ciphertext (vd `v1`) |
| `status` | text | `active` (mã hoá dữ liệu mới) / `retired` (chỉ giải mã) |
| `algo` | text | mặc định `AES-GCM` |
| `createdAt`, `retiredAt` | timestamp |
Unique: `(siteId, keyId)`.

### `field_access_log`
Audit mọi lần đọc đã giải mã của field `pii`/`phi` (Req 6). Không bao giờ lưu giá trị đã giải mã; ghi theo batch, cách ly theo site bằng RLS.
| Column | Type | Note |
|---|---|---|
| `id` | text PK | nanoid |
| `siteId` | text FK |
| `collection` | text |
| `recordIds` | jsonb | id các record bị ảnh hưởng (gộp lại với read dạng list) |
| `fields` | jsonb | tên các field đã giải mã |
| `actor`, `action`, `requestId` | text |
| `timestamp` | timestamp |
Index: `(siteId, timestamp)`, `(actor, timestamp)`.

### `content_reviews`
Record ký duyệt biên tập của con người (Req 9). `itemId` dùng `onDelete: set null` để lịch sử review vẫn tồn tại sau khi xoá dữ liệu (Req 11.3).
| Column | Type | Note |
|---|---|---|
| `id` | text PK | nanoid |
| `siteId` | text FK |
| `itemId` | text FK nullable | set null khi xoá item |
| `revisionId` | text |
| `requestedBy`, `decidedBy` | text FK users (set null) |
| `assignedTo` | text | user id hoặc role token |
| `status` | text | `pending`/`approved`/`rejected` |
| `reason` | text |
| `decidedAt`, `createdAt` | timestamp |
Index: `(siteId, status)`, `(siteId, assignedTo)`.

### `erasure_requests`
Lifecycle quyền được xoá theo GDPR (Req 11). Lưu **hash** của định danh chủ thể, không bao giờ plaintext; hỗ trợ dual-control.
| Column | Type | Note |
|---|---|---|
| `id` | text PK | nanoid |
| `siteId` | text FK |
| `scope` | jsonb | `{ collection, filter }` |
| `subjectHash` | text | hash của subject id (không bao giờ plaintext) |
| `reason` | text |
| `requestedBy`, `confirmedBy` | text FK users (set null) | `confirmedBy` = admin thứ hai (dual-control, Req 11.4) |
| `status` | text | `pending`/`confirmed`/`executing`/`completed`/`failed` |
| `recordCount` | integer |
| `createdAt`, `completedAt` | timestamp |
Index: `(siteId, status)`.

---

## 11d. Git Integration (`git-integration.ts`)

Kết nối GitHub/GitLab theo từng tenant + state PR/CI được cache, log webhook thô,
môi trường preview tạm thời và provenance commit↔content. Mọi bảng đều có
`site_id` (cascade) và được đăng ký cho RLS. Tên vật lý mang tiền tố `lumibase_`
(ADR-010). Migration `0009_git_integration`.

| Bảng (vật lý) | Mục đích | Cột chính |
|-------|---------|-------------|
| `lumibase_git_integrations` | Một kết nối repo cho mỗi `(site, provider, repo)` | `provider`, `repo_full_name`, `auth_method` (app\|pat), `installation_id`, `encrypted_token`, `webhook_secret_enc`, `status`, `scopes`, `sync_config` |
| `lumibase_git_pull_requests` | State PR/MR được cache | unique `(integration_id, number)`; `state`, `ci_status`, `mergeable`, `head_sha`, `preview_url`, `raw` |
| `lumibase_git_ci_runs` | CI run + jobs + ref tới log đã lưu | unique `(integration_id, provider_run_id)`; `status`, `jobs`, `duration_ms`, `log_ref` (blob của runtime) |
| `lumibase_git_webhook_events` | Event vào ở dạng thô (replay được) | unique `(provider, delivery_id)`; `event`, `payload`, `processed`, `error` |
| `lumibase_git_preview_envs` | Site preview tạm thời cho mỗi PR | unique `(pr_id)`; `ephemeral_site_id`, `status`, `url`, `expires_at` |
| `lumibase_git_provenance` | Liên kết commit/PR → content/schema/intent | `commit_sha`, `pr_number`, `collection`, `item_id`, `change_type` |

Token + webhook secret được mã hoá at rest qua `CryptoService` (AES-GCM, AAD ràng
buộc vào `{ siteId, integrationId, field }`); plaintext không bao giờ được lưu.

## 12. Indexing & RLS

- Bắt buộc index `(siteId, …)` ở mọi bảng domain.
- Áp dụng Drizzle helper `scopeSite(siteId)` ở tầng repo.
- Postgres RLS được bật qua middleware `withRls()` (`apps/cms/src/middleware/rls.ts`) — set session var để defence-in-depth.
