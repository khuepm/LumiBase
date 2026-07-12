# Data Model (Drizzle / Postgres)

This document describes the tables declared in `packages/database/src/schema/`. Internal database rows use text IDs by default. No-code content collections also carry a logical item primary key strategy through `collections.primaryKeyField` and `collections.primaryKeyType`.

Every tenant-scoped domain table has `site_id`.

> **Physical table names carry a `lumibase_` prefix.** Every LumiBase system table
> is physically named `lumibase_<name>` (e.g. the logical `users` table is physically
> `lumibase_users`), created by the `0000_lumibase_init` migration. This reserves the
> `lumibase_` namespace for the platform,
> so any table WITHOUT that prefix is unambiguously user-created (or a `mat_*`
> materialization). See [ADR-010](./architecture/decisions/adr-010-lumibase-table-prefix.md).
> The section headings below use the short logical name for readability; the
> summary table lists the physical names.

Schema files are split by domain:

| File | Bảng (physical) |
|------|------|
| `core.ts` | `lumibase_sites`, `lumibase_users`, `lumibase_user_sites`, `lumibase_teams`, `lumibase_team_members`, `lumibase_notifications` |
| `access.ts` | `lumibase_roles`, `lumibase_policies`, `lumibase_role_policies`, `lumibase_user_policies`, `lumibase_permissions`, `lumibase_refresh_tokens` |
| `cms.ts` | `lumibase_pages`, `lumibase_collections`, `lumibase_fields`, `lumibase_relations`, `lumibase_items`, `lumibase_revisions`, `lumibase_releases`, `lumibase_release_items`, `lumibase_activity`, `lumibase_flows`, `lumibase_flow_runs`, `lumibase_operations`, `lumibase_materialized_collections` |
| `platform.ts` | `lumibase_folders`, `lumibase_files`, `lumibase_presets`, `lumibase_translations`, `lumibase_settings`, `lumibase_webhooks`, `lumibase_extensions`, `lumibase_translation_memory`, `lumibase_glossary`, `lumibase_push_subscriptions` |
| `ai.ts` | `lumibase_ai_approvals`, `lumibase_agent_*` |
| `firebase-sync.ts` | `lumibase_firebase_sync_pipelines`, `lumibase_firebase_sync_log` |
| `external-auth.ts` | `lumibase_auth_external_issuers` |

Migrations live in `packages/database/migrations/` and `packages/database/drizzle/`.

---

## 1. Core tenancy & identity (`core.ts`)

### `sites`
- `id`, `name`, `domain`, `createdAt`, plus identity/branding/theme columns and `defaultLanguage`, `defaultAppearance`, and `defaultSaveAction` (`stay`|`return`|`create_new`, default `stay` — the site-wide default Studio save action; per-user override lives in `users.preferences.saveAction`).

### `users`
| Column | Type | Note |
|---|---|---|
| `id` | text PK | nanoid |
| `logtoId` | text unique | OIDC subject |
| `email`, `firstName`, `lastName`, `avatar` | text |
| `status` | text | `active`/`invited`/`suspended` |
| `language`, `theme`, `tfa` | jsonb | preferences |
| `preferences` | jsonb | per-user UI prefs: `{ language, theme, timezone, defaultPresets, saveAction }`. `saveAction` (`stay`/`return`/`create_new`) overrides `sites.default_save_action`. |
| `lastSeenAt` | timestamp |
| `passwordChangedAt` | timestamp | Set on every reset/change (migration `0006`). A password-reset token whose `iat` predates it is rejected → single-use reset links. |
| `createdAt`, `updatedAt` | timestamp |

Unique indexes: `users_external_id_unique`, `users_is_bootstrap_unique` (partial, `is_bootstrap = true`), and `users_email_lower_unique` on `lower(email)` (migration `0006`) — email is identity-global, one account per address. ⚠️ Migrating an existing instance fails if it already holds case-insensitive duplicate emails; de-duplicate first.

### `user_sites` (membership N-N)
- `userId`, `siteId`, `roleId`, `joinedAt`. PK composite.

### `teams` / `team_members`
- `teams`: `id`, `siteId`, `name`, `description`.
- `team_members`: `teamId`, `userId`. PK composite.

### `notifications`
- Persistent inbox for mentions, denial reasons, and system events. Realtime delivery is handled above this persistence layer.

## 2. Schema (no-code) — `cms.ts`

### `pages`
- Page-builder pages consumed by `/deliver`.

### `collections`
| Column | Type | Note |
|---|---|---|
| `id` | text PK |
| `siteId` | text FK |
| `name` | text | machine name, unique per site |
| `label`, `pluralLabel` | text | author-facing labels |
| `hidden`, `system` | boolean |
| `singleton` | boolean |
| `icon`, `color`, `note` | text |
| `primaryKeyField` | text | logical item identifier field, defaults to `id` |
| `primaryKeyType` | text | `nanoid`, `uuid`, `integer`, `bigInteger`, `string` |
| `storageMode` | text | `jsonb`, `materialized`, `physical`, `external` |
| `displayTemplate` | text | mustache template default |
| `sortField`, `archiveField`, `archiveValue`, `unarchiveValue` | text |
| `itemDuplicationFields`, `translations` | jsonb |
| `accountability` | text | `all` / `activity` / `none` |
| `versioning` | boolean |
| `meta` | jsonb | extra UI hints, including safe system-field presentation overrides |
| `createdAt`, `updatedAt` |

Primary key strategy:

- `nanoid`: default logical string identifier generated by LumiBase.
- `uuid`: service-generated UUID string.
- `string`: caller-provided string identifier.
- `integer` / `bigInteger`: sequence-backed strategies reserved for materialized/physical storage support; JSONB collections block these combinations.

Storage modes are intentionally explicit:

- `jsonb`: default logical collection backed by `items.data`; fastest schema evolution, no runtime DDL, advisory SQL-native indexes/unique constraints.
- `materialized`: JSONB source of truth plus managed physical read projection for hot paths.
- `physical`: future Directus-like owned table mode; schema diffs mark this as a storage runtime change.
- `external`: future introspected table mode; destructive DDL/relation actions are limited because LumiBase does not own the table.

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
| `classification` | text | Data sensitivity (Req 5): `none`/`internal`/`pii`/`phi`. `pii`/`phi` must be `encrypted=true`; drives default masking, `read_decrypted` gating, and `field_access_log` audit. |
| `sortOrder` | integer |
| `width`, `group` | text |

Compiled schemas expose generated system fields in addition to user-defined rows:

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | Primary item identifier, readonly/generated. |
| `status` | `string` | Workflow status; visible when status/archive behavior is enabled. |
| `sort` | `integer` | Manual ordering value. |
| `user_created` | `string` | Creator user ID, readonly/generated. |
| `user_updated` | `string` | Last updater user ID, readonly/generated. |
| `created_at` | `datetime` | Creation timestamp, readonly/generated. |
| `updated_at` | `datetime` | Last update timestamp, readonly/generated. |
| `deleted_at` | `datetime` | Soft-delete timestamp, readonly/generated and hidden. |

### `relations`
- `id`, `siteId`, `manyCollection`, `manyField`, `oneCollection`, `oneField`, `junctionCollection?`, `type`, `aliasField?`, `relatedDisplayTemplate?`, `junctionManyField?`, `junctionOneField?`, `sortField?`, `onDelete`, `meta jsonb`.
- Relation types are `m2o`, `o2m`, `m2m`, with `m2a` reserved.
- The schema service validates referenced collections and fields, and blocks collection deletes when relations still reference either side.

### `items`
| Column | Type |
|---|---|
| `id` | text PK |
| `siteId`, `collectionId` | text FK |
| `status` | text | `draft`/`published`/`archived` |
| `data` | jsonb | values keyed by field.name |
| `sort` | integer |
| `userCreated`, `userUpdated` | text FK users |
| `publishAt`, `unpublishAt` | timestamp nullable | Scheduling window (Req 7); the reconcile worker flips status, delivery filters to the window. |
| `editorialState` | text nullable | Human review state (Req 9): `draft`/`in_review`/`approved`/`published`/`rejected`. Distinct from the AI veto-window. |
| `dekWrapped` | text nullable | Envelope mode (Req 4.5): the per-record DEK wrapped by the KEK. Non-null ⇒ this record's encrypted fields use a per-record DEK; null ⇒ shared-key mode. Reads are self-describing from this column. |
| `createdAt`, `updatedAt` | timestamp |
| `deletedAt` | timestamp nullable |

Indexes: `(siteId, collectionId, status)`, GIN on `data`, `(siteId, status, publishAt)`, `(siteId, status, unpublishAt)`.

### `revisions`
- `id`, `siteId`, `itemId`, `collectionId`, `delta jsonb`, `parentId`, `userId`, `createdAt`.

### `releases` (Content Releases)
- A cross-collection publish bundle. `id`, `siteId`, `name`, `description`, `status` (`draft`|`scheduled`|`published`|`failed`|`partially_failed`), `atomicityMode` (`all_or_nothing`|`best_effort`), `publishAt`, `publishedAt`, `maintenanceWindow jsonb`, `statusReason`, `createdBy → users.id (set null)`, `createdAt`, `updatedAt`.
- Indexes: `releases_site_status_idx (siteId, status)`, `releases_publish_due_idx (siteId, status, publishAt)` (mirrors `items.publishDueIdx` for the scheduler sweep).

### `release_items` (Content Releases)
- Junction release ↔ item, optionally pinned to one revision. `id`, `siteId`, `releaseId → releases.id (cascade)`, `collection`, `itemId → items.id (cascade)`, `targetStatus` (default `published`), `revisionId → revisions.id (set null)`, `outcome` (`published`|`skipped`|`failed`), `outcomeReason`, `createdAt`.
- Unique `(releaseId, collection, itemId)` (upsert key); index `(siteId, releaseId)`.

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
- Defines denormalized read tables for hot paths.
- `target`, `refreshStrategy` (`auto`/`cron`/`manual`), `refreshCron`, `projection jsonb`, `filter jsonb`, `lastRefreshedAt`, `rowCount`, `status`, `error`.

### Schema diff/apply runtime contract

The schema service exposes a Directus-parity lifecycle:

- `POST /api/v1/collections/diff` compares proposed collection metadata, fields, and relations with the current schema.
- `PUT /api/v1/collections/{name}/schema` validates and applies metadata, field, and relation changes transactionally when the database runtime supports transactions.
- Apply invalidates compiled schema, permission, and typegen cache keys and emits a `schema.changed` event.

Diff output includes root `risk`, `runtimeImpact`, and per collection/field/relation entries. Runtime impact values include `cache_invalidation`, `permission_recompile`, `typegen_rebuild`, `data_migration_required`, `relation_reindex`, and `storage_runtime_change`.

### Typegen manifest v2

`GET /api/v1/typegen/schema` returns a versioned manifest with:

- collection `primaryKey`, `primaryKeyField`, and `primaryKeyType`;
- user fields plus compiled system fields;
- `required`, `nullable`, `readonly`, `generated`, `system`, `encrypted`, and `primaryKey` flags;
- relation descriptors for expanded response types.

SDK generation uses this manifest to emit base collection interfaces and `CollectionExpanded` relation response types.

## 3. Permissions (`access.ts`)

### `roles`
- `id`, `siteId`, `name`, `description`, `icon`, `adminAccess` boolean, `appAccess` boolean.
- Note: `adminAccess/appAccess` are legacy compatibility flags. New RBAC work migrates these flags to policies so roles remain grouping units. See [Role Flag to Policy Flag Migration](./features/role-policy-flag-migration.md).

### `policies`
- `id`, `siteId`, `name`, `description`, `rules jsonb`. Policy độc lập có thể attach vào nhiều roles/users.
- Explicit flags: `adminAccess`, `appAccess`, `enforceTfa`, `ipAllow`, `ipDeny`, `validFrom`, `validUntil`. These are the new source of truth for admin/app/TFA/IP/time guards.

### `role_policies` / `user_policies`
- Many-to-many với `priority`. `user_policies` cho phép gán policy trực tiếp user (override role).

### `permissions`
- `id`, `siteId`, `policyId`, `collection`, `action` (`create`/`read`/`update`/`delete`/`share`), `permissions jsonb` (row-level rule DSL), `validation jsonb`, `presets jsonb`, `fields text[]` (field-level allow list, `*` = all).

### `refresh_tokens` (migration `0005`, physical `lumibase_refresh_tokens`)
- `id`, `siteId`, `userId`, `audience` (`studio`/`frontend`), `tokenHash` (sha256, unique — plaintext never stored), `familyId` (rotation chain), `replacedBy`, `expiresAt`, `revokedAt`, `lastIp`, `lastUserAgent`, `createdAt`.
- Rotating, revocable session-renewal tokens. Reuse of a revoked row revokes the whole `familyId` (theft detection). Swept on the hourly cron once expired. See [`security/user-management.md`](./security/user-management.md) §4d.

### System collections seed permissions

When seeding local/staging/prod, seed system collection permissions explicitly. Sensitive collections such as `system_state`, `audit_log`, `login_attempts`, `login_baselines`, `admin_backup_codes`, `scim_tokens`, and future API key tables are admin/security-only. See [System Collections & Sensitive Access](./features/system-collections-access.md).

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

## 10. AI Copilot and Agent Harness (`ai.ts`)

The existing Copilot tables provide chat/HITL history. The Agent Harness extends
that foundation with first-class lifecycle, tools, approvals, artifacts,
evaluations, and memory. See [Agent Harness Layer](./features/agent-harness-layer.md)
for the user-facing and runtime contract.

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

Behavior: dangerous skills (`schema:write` or names starting with `delete`) must
create an `ai_approvals` row and wait for approval instead of executing
directly. See [AI Copilot](./features/ai-copilot.md). New dangerous harness
actions also write linked/generalized `agent_approvals` records where applicable.

### `agent_*` harness tables

| Collection | Purpose |
|---|---|
| `agent_goals` | Business goals created by a user, workflow, or generation template |
| `agent_runs` | Individual execution attempts with status, budget, metrics, and retry linkage |
| `agent_plans` | Planned steps associated with a run |
| `agent_tools` | Tool registry entries with schemas, owner, enabled state, capability, risk, and rate policy |
| `agent_permissions` | Agent/role/policy capability grants |
| `agent_tool_calls` | Scoped audit records for each tool call or denial |
| `agent_approvals` | Generalized approvals for plans, tool calls, artifacts, and schema diffs |
| `agent_artifacts` | Versioned generated outputs such as schema diffs, specs, seed data, prompts, and migrations |
| `agent_evaluations` | Evaluation results used as gates before approval/publish |
| `agent_memory` | Scoped long-lived memory with provenance, confidence, expiry, and optional embedding |

All harness tables include `siteId` and must be queried through tenant-scoped
filters.

Operational notes:

- `POST /api/v1/agent/generate-app` creates `page_spec`, `component_spec`, `seed_data`, and `api_spec` artifacts and evaluates each artifact before returning.
- `agent_runs.metrics.stopReason` records completion or budget stop reasons such as `completed`, `error`, and `max_tool_calls`.
- `agent_tool_calls.cost` stores token/cost estimates after secret masking.
- If the same goal fails at least three runs and a runtime `QueueProvider` is available, the run service enqueues `agent-dead-letter` with the scoped run failure payload.

### Content OS tables (`content-os.ts`)

| Collection | Purpose |
|---|---|
| `content_intents` | Declared desired state (SLO) per collection: rules, cron schedule, budget, autonomy cap, maintenance window |
| `content_drifts` | Detected rule violations; unique `(siteId, fingerprint)` dedupes detection across scans |
| `agent_autonomy_grants` | Earned trust per (site, agentRole, capability): level 0–4, evidence, expiry |
| `agent_incidents` | Demotion evidence and exception-inbox feed (`veto`, `eval_fail`, `load_guard`, …) |
| `agent_freezes` | Kill-switch freezes (scope `site`/`role`); `liftedAt IS NULL` = active; doubles as audit trail |
| `agent_roles` | Multi-agent role library with minimal capability sets; harness enforces role ∩ grant |
| `constitutions` | Versioned publish-gate evaluator sets; sha256 hash identity; at most one `active` per site |

Content OS columns on existing tables:

- `revisions`: `authorType`, `createdByRunId`, `model`, `constitutionHash`, `sources`, `confidence`, `staged`, `autoCommitAt` (provenance + veto staging).
- `items`: `pinnedFields` (Law Zero — fields a human edit locked against agent writes).
- `agent_goals`: `parentGoalId` (goal tree), `origin` (`user/reconciler/planner/flow`), `intentId`, `driftFingerprint`, `agentRole`.
- `agent_approvals`: `kind` (`approval`/`veto`), `autoCommitAt`, `approverType` (`human`/`agent`), `approverRunId`.

### Directus-inspired tables (`cms.ts`)

| Collection | Purpose |
|---|---|
| `content_versions` | Named parallel draft branches of an item, distinct from linear `revisions`. Snapshots item `data` + a `hash` of main at snapshot time (divergence detection). Promote applies a version to main via ItemService (writes a revision). Unique `(siteId, collectionId, itemId, key)`. See `.kiro/specs/content-versioning`. |
| `dashboards` | Insights dashboard container per site (name/icon/color/note). |
| `panels` | One visualization on a dashboard: `type` (metric/timeSeries/bar/pie/list/table), `position` (`{x,y,w,h}`), `query` (a `PanelQuery`), `options`. Aggregates run safely (field whitelist + siteId scope). See `.kiro/specs/insights-dashboard`. |
| `transform_presets` | Named image-transform presets: URL-safe `key` → a `TransformDsl` (`{ width?, height?, format?, quality?, fit?, focal? }`). Resolved by `GET /media/:key?preset=<key>`. Unique `(siteId, key)`. Migration `0004_transform_presets`. See `.kiro/specs/image-transform-dsl`. |

## 11. Firebase Sync (`firebase-sync.ts`)

Xem [features/firebase-sync.md](./features/firebase-sync.md). Migration: `0000_lumibase_init` (consolidated).

## 11d. Change Feed (`cdc.ts` — spec cdc-extension-integration)

| Table | Purpose |
|---|---|
| `lumibase_cdc_change_events` | Append-only transactional outbox: one row per committed mutation (`resource` `item`/`collection`/`field`/`setting` — default `item`, migration `0008`; `collection`, `item_id`, `operation`, masked `payload`, `changed_fields`, actor/source, `occurred_at`). The envelope `type` is `<plural-resource>.<operation>`. Feed order = keyset `(occurred_at, id)` — nanoid PKs carry no order. Indexes `(site_id, occurred_at, id)` and `(site_id, collection, occurred_at, id)`. |
| `lumibase_cdc_subscriptions` | Consumer registry + checkpoint (`cursor_occurred_at` + `cursor_id`), kind `pull`/`webhook`/`extension`, status `active`/`paused`/`dead`/`stale`, filters, `consecutive_failures`. Unique `(site_id, name)`. |
| `lumibase_cdc_deliveries` | Append-only delivery-attempt log per batch (attempt, status, http status, bounded error message, duration). Pruned on the same retention window as the outbox. |

All three are `site_id`-scoped with `site_isolation` RLS. See `docs/en/features/cdc-change-feed.md`.

## 11c. External JWT auth (`external-auth.ts`)

### `auth_external_issuers`
- Per-site trusted external JWT issuer. **Public config only — no secrets** (signatures verify against the issuer's JWKS). `id`, `siteId` (FK sites, cascade), `issuer` (matches the `iss` claim), `jwksUri`/`discoveryUrl` (one required), `audience` (jsonb: string|string[]), `algorithms` (jsonb: asymmetric allowlist), `claimMapping` (jsonb: `{ email, roles, siteId?, externalId? }`), `roleMapping` (jsonb: `{ "<claim role>": { roleId|systemKey } }`), `defaultRoleId`, `jitProvisioning`, `clockSkewSeconds`, `enabled`, `createdAt`, `updatedAt`.
- Unique `(siteId, issuer)`; index `(siteId, enabled)`. Migration: `0000_lumibase_init` (consolidated). See [security/external-jwt-auth.md](./security/external-jwt-auth.md).

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

## 11b. Regulated / sensitive content (`regulated.ts`)

Opt-in, additive tables for the regulated-content-readiness capability set. Default Tier 1 installations never write to them. ID convention: `nanoid` for all (domain + audit-grade), matching the existing `audit_log` PK.

### `encryption_keys`
Metadata **only** for key versioning/rotation (Req 3.3) — never stores key material; the bytes live in the runtime `KeyProvider` (Workers Secrets / env).
| Column | Type | Note |
|---|---|---|
| `id` | text PK | nanoid |
| `siteId` | text FK nullable | null ⇒ global key |
| `keyId` | text | version id embedded in the ciphertext envelope (e.g. `v1`) |
| `status` | text | `active` (encrypt new) / `retired` (decrypt only) |
| `algo` | text | default `AES-GCM` |
| `createdAt`, `retiredAt` | timestamp |
Unique: `(siteId, keyId)`.

### `field_access_log`
Audit of every decrypted read of a `pii`/`phi` field (Req 6). Never stores the decrypted value; written in batches, site-isolated by RLS.
| Column | Type | Note |
|---|---|---|
| `id` | text PK | nanoid |
| `siteId` | text FK |
| `collection` | text |
| `recordIds` | jsonb | affected record ids (aggregate for list reads) |
| `fields` | jsonb | field names decrypted |
| `actor`, `action`, `requestId` | text |
| `timestamp` | timestamp |
Indexes: `(siteId, timestamp)`, `(actor, timestamp)`.

### `content_reviews`
Human editorial sign-off records (Req 9). `itemId` is `onDelete: set null` so review history survives erasure (Req 11.3).
| Column | Type | Note |
|---|---|---|
| `id` | text PK | nanoid |
| `siteId` | text FK |
| `itemId` | text FK nullable | set null on item delete |
| `revisionId` | text |
| `requestedBy`, `decidedBy` | text FK users (set null) |
| `assignedTo` | text | user id or role token |
| `status` | text | `pending`/`approved`/`rejected` |
| `reason` | text |
| `decidedAt`, `createdAt` | timestamp |
Indexes: `(siteId, status)`, `(siteId, assignedTo)`.

### `erasure_requests`
GDPR right-to-erasure lifecycle (Req 11). Stores a **hash** of the subject identifier, never plaintext; supports dual-control.
| Column | Type | Note |
|---|---|---|
| `id` | text PK | nanoid |
| `siteId` | text FK |
| `scope` | jsonb | `{ collection, filter }` |
| `subjectHash` | text | hash of subject id (never plaintext) |
| `reason` | text |
| `requestedBy`, `confirmedBy` | text FK users (set null) | `confirmedBy` = second admin (dual-control, Req 11.4) |
| `status` | text | `pending`/`confirmed`/`executing`/`completed`/`failed` |
| `recordCount` | integer |
| `createdAt`, `completedAt` | timestamp |
Index: `(siteId, status)`.

---

## 12. Indexing & RLS

- Bắt buộc index `(siteId, …)` ở mọi bảng domain.
- Áp dụng Drizzle helper `scopeSite(siteId)` ở tầng repo.
- Postgres RLS được bật qua middleware `withRls()` (`apps/cms/src/middleware/rls.ts`) — set session var để defence-in-depth.
