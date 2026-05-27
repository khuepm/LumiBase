# Data Model (Drizzle / Postgres)

Tài liệu mô tả các bảng đã được khai báo trong `packages/database/src/schema/`. Tất cả PK là `nanoid` text. Domain table luôn có `site_id`.

Schema được tách theo domain:

| File | Bảng |
|------|------|
| `core.ts` | `sites`, `users`, `user_sites`, `teams`, `team_members`, `notifications` |
| `access.ts` | `roles`, `policies`, `role_policies`, `user_policies`, `permissions` |
| `cms.ts` | `pages`, `collections`, `fields`, `relations`, `items`, `revisions`, `activity`, `flows`, `flow_runs`, `operations`, `materialized_collections` |
| `platform.ts` | `folders`, `files`, `presets`, `translations`, `settings`, `webhooks`, `extensions`, `translation_memory`, `glossary` |
| `ai.ts` | `ai_approvals` |

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
| `singleton` | boolean |
| `icon`, `color`, `note` | text |
| `displayTemplate` | text | mustache template default |
| `sortField`, `archiveField`, `archiveValue` | text |
| `accountability` | text | `all` / `activity` / `none` |
| `versioning` | boolean |
| `meta` | jsonb | extra UI hints |
| `createdAt`, `updatedAt` |

### `fields`
| Column | Type | Note |
|---|---|---|
| `id` | text PK |
| `siteId`, `collectionId` | text FK |
| `name` | text | machine |
| `type` | text | `string`,`text`,`integer`,`decimal`,`boolean`,`json`,`uuid`,`date`,`datetime`,`time`,`csv`,`hash`,`geometry`,`alias` |
| `interface` | text | UI editor key |
| `display` | text | display formatter key |
| `options`, `displayOptions`, `validation`, `conditions`, `permissionsHint`, `translations` | jsonb |
| `required`, `readonly`, `hidden`, `encrypted`, `versioned`, `rawEnabled` | boolean |
| `sortOrder` | integer |
| `width`, `group` | text |

### `relations`
- `id`, `siteId`, `manyCollection`, `manyField`, `oneCollection`, `oneField`, `junctionCollection?`, `sortField?`, `onDelete`, `meta jsonb`.

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

## 3. Permissions (`access.ts`)

### `roles`
- `id`, `siteId`, `name`, `description`, `icon`, `adminAccess` boolean, `appAccess` boolean.

### `policies`
- `id`, `siteId`, `name`, `description`, `rules jsonb`. Policy độc lập có thể attach vào nhiều roles/users.

### `role_policies` / `user_policies`
- Many-to-many với `priority`. `user_policies` cho phép gán policy trực tiếp user (override role).

### `permissions`
- `id`, `siteId`, `policyId`, `collection`, `action` (`create`/`read`/`update`/`delete`/`share`), `permissions jsonb` (row-level rule DSL), `validation jsonb`, `presets jsonb`, `fields text[]` (field-level allow list, `*` = all).

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

## 10. AI Copilot — HITL (`ai.ts`)

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

## 11. Indexing & RLS

- Bắt buộc index `(siteId, …)` ở mọi bảng domain.
- Áp dụng Drizzle helper `scopeSite(siteId)` ở tầng repo.
- Postgres RLS được bật qua middleware `withRls()` (`apps/cms/src/middleware/rls.ts`) — set session var để defence-in-depth.
