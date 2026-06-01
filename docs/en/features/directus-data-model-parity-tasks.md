# Directus Data Model Parity Tasks

> Mục tiêu: đưa LumiBase Data Model / Collections Builder lên mức đáp ứng các thành phần cơ bản khi so sánh với Directus: tạo collection, tạo field/model, quan hệ, quyền schema, metadata, validation, item API, SDK và trải nghiệm Studio. Tài liệu này tập trung vào phần còn thiếu hoặc chưa đủ chặt trong codebase hiện tại.

## 1. Baseline hiện tại

LumiBase đã có nền tảng chính:

- `[DB]` `collections`, `fields`, `relations`, `items`, `revisions`, `activity` trong `packages/database/src/schema/cms.ts`.
- `[BE]` `SchemaService` quản lý CRUD collection, field, relation và compiled schema cache.
- `[BE]` `ItemService` CRUD item trên JSONB store, có validation, encryption, revisions, activity, realtime/search hooks.
- `[BE]` Routes `/api/v1/collections`, `/api/v1/collections/:name/fields`, `/api/v1/relations`, `/api/v1/items/:collection`.
- `[FE]` Studio Data Model có collection wizard, detail tabs, field inspector, display tab, raw JSON tab.
- `[SDK]` Client có nhóm schema/items cơ bản.

Điểm khác biệt kiến trúc cần giữ rõ: Directus tạo hoặc introspect table vật lý trong database; LumiBase MVP hiện dùng virtual schema + `items.data` JSONB, materialized collections là opt-in optimization. Nếu muốn cạnh tranh trực tiếp, phải hoặc hỗ trợ DDL/introspection, hoặc biến virtual schema thành lợi thế sản phẩm với contract rõ ràng.

## 2. Product contract cần đạt

Một collection trong LumiBase phải là một "model" đầy đủ, gồm:

- Machine identity: `name`, immutable sau khi tạo.
- Display identity: `label`, `pluralLabel`, `icon`, `color`, `note`, translations.
- Storage identity: `storageMode`, `primaryKey`, optional materialized target.
- Behavior: `singleton`, `accountability`, `versioning`, `archiveField`, `archiveValue`, `unarchiveValue`, `sortField`.
- System fields policy: `status`, `sort`, `createdAt`, `updatedAt`, `createdBy`, `updatedBy`, `deletedAt`.
- Field definitions: storage type, interface, display, validation, conditions, options, display options, translations, layout metadata.
- Relations: many-to-one, one-to-many, many-to-many, many-to-any, file relation, junction metadata.
- Access: schema management permissions and item-level permissions.
- API shape: REST, SDK typegen, OpenAPI, export/import, diff/apply.

## 3. Task group A: Collection metadata contract

### A1. Add missing collection columns

Scope: `[DB] packages/database`, `[BE] apps/cms`, `[SDK] packages/sdk`, `[FE] apps/studio`.

Add first-class columns to `collections` instead of hiding product-critical fields inside `meta`:

```ts
label: text('label')
pluralLabel: text('plural_label')
hidden: boolean('hidden').default(false).notNull()
system: boolean('system').default(false).notNull()
primaryKeyField: text('primary_key_field').default('id').notNull()
primaryKeyType: text('primary_key_type').default('nanoid').notNull()
storageMode: text('storage_mode').default('jsonb').notNull()
unarchiveValue: text('unarchive_value')
itemDuplicationFields: jsonb('item_duplication_fields').default([]).notNull()
translations: jsonb('translations').default({}).notNull()
```

Accepted `primaryKeyType` values:

- `nanoid`: current LumiBase default.
- `uuid`: UUID v4 or v7.
- `integer`: generated integer sequence. Only valid for physical/materialized mode unless explicitly emulated.
- `bigInteger`: generated bigint sequence. Same constraint as `integer`.
- `string`: user-provided string ID.

Accepted `storageMode` values:

- `jsonb`: current generic item store.
- `materialized`: virtual schema with managed physical projection.
- `physical`: future mode that creates and migrates a real table.
- `external`: future mode for introspected external table.

Implementation notes:

- Create a Drizzle migration for new columns.
- Backfill existing rows:
  - `label = titleCase(name)`
  - `pluralLabel = titleCase(name)`
  - `primaryKeyField = 'id'`
  - `primaryKeyType = 'nanoid'`
  - `storageMode = 'jsonb'`
- Update `CollectionInput`, route validation, SDK types, config export/import and OpenAPI.
- Keep `meta` only for extension/custom UI hints, not core collection behavior.

### A2. Fix Studio collection wizard payload

Current issue: Studio wizard sends `note`, `versioning`, `accountability` inside `meta`, while backend accepts them as top-level collection fields.

Required change:

```ts
client.schema.createCollection({
  name,
  label,
  pluralLabel,
  singleton,
  icon,
  color,
  note: note || null,
  accountability,
  versioning,
  primaryKeyType,
  storageMode,
})
```

Wizard steps:

1. Identity: name, label, plural label, icon, color, hidden.
2. Storage: primary key type, storage mode, singleton.
3. System fields: status, sort, created/updated fields, archive behavior.
4. Permissions defaults: role/policy presets or "inherit default".
5. Review: JSON preview, warnings, create.

Acceptance criteria:

- Creating a collection from Studio persists top-level `note`, `accountability`, `versioning`, `singleton`.
- Review step shows the exact API payload.
- If `primaryKeyType` is not supported by current storage mode, UI blocks submit with a precise message.

## 4. Task group B: Primary key and system fields

### B1. Define primary key strategy in item storage

Scope: `[DB]`, `[BE] ItemService`, `[SDK] typegen`.

For `jsonb` storage mode, implement ID generation policy in `ItemService.create()`:

- `nanoid`: generated by database default or service helper.
- `uuid`: generated by service.
- `string`: require `id` in request body or `data.id`, reject duplicate.
- `integer` / `bigInteger`: defer unless a sequence table is added.

Add a small service helper:

```ts
interface PrimaryKeyStrategy {
  field: string;
  type: 'nanoid' | 'uuid' | 'string' | 'integer' | 'bigInteger';
  generate(input: Record<string, unknown>): string | number;
  validate(value: unknown): void;
}
```

Acceptance criteria:

- Create item respects collection primary key strategy.
- Detail/update/delete accepts item ID using configured strategy.
- Typegen exposes primary key type per collection.
- Duplicate user-provided IDs return `409`.

### B2. Promote system fields to schema-visible fields

Directus treats ID/status/sort/audit fields as fields visible in the model. LumiBase currently has structural columns, but the Data Model UI does not expose them as configurable model fields.

Add generated virtual field definitions for:

- `id`
- `status`
- `sort`
- `user_created`
- `user_updated`
- `created_at`
- `updated_at`
- `deleted_at`

Implementation:

- Extend `CompiledCollection` with `systemFields`.
- `SchemaService.compile()` should append system field descriptors before user fields or expose a separate `systemFields` array.
- Studio Fields tab should show system fields in a locked group.
- Users can configure display, hidden, readonly, translations and width for system fields, but cannot delete them.
- If collection disables a system field behavior, mark the field hidden instead of removing the underlying column.

Acceptance criteria:

- Content list can include/hide system fields consistently.
- Typegen includes system fields.
- Raw JSON schema clearly separates `fields` and `systemFields`.

## 5. Task group C: Field configuration parity

### C1. Expand field DB contract

Add first-class fields metadata:

```ts
label: text('label')
note: text('note')
defaultValue: jsonb('default_value')
nullable: boolean('nullable').default(true).notNull()
unique: boolean('unique').default(false).notNull()
indexed: boolean('indexed').default(false).notNull()
searchable: boolean('searchable').default(false).notNull()
length: integer('length')
precision: integer('precision')
scale: integer('scale')
special: jsonb('special').default([]).notNull()
```

Rules:

- `name`, `type`, and storage-affecting fields are immutable after data exists unless a migration plan is provided.
- `interface`, `display`, `options`, `displayOptions`, `validation`, `conditions`, `translations`, `width`, `group`, `sortOrder` are editable.
- `unique` and `indexed` are advisory in `jsonb` mode unless a materialized/physical index exists. UI must label this clearly.

### C2. Implement FieldInspector advanced tabs

Replace the current single-form inspector with tabs:

- Basics: name, label, note, type, interface, required, readonly, hidden.
- Options: interface-specific options generated from registry schemas.
- Display: display key, display options, live preview.
- Validation: built-in rule builder and raw JSON mode.
- Conditions: rule builder and raw JSON mode.
- Layout: width, group, sort, presentation fields.
- Storage: default value, nullable, unique, indexed, searchable, encrypted, versioned, raw enabled.
- Translations: label/help per locale.

Implementation notes:

- The interface registry must expose option schemas in a UI-readable format.
- Unknown options must remain editable through raw JSON so extension interfaces do not lose config.
- Validation builder must write the same JSON DSL consumed by `validateItem()`.

Acceptance criteria:

- A user can configure every column currently present in `fields`.
- A user can configure newly added `label`, `note`, defaults, uniqueness/index hints, searchability, translations.
- No field save drops unknown `options`, `displayOptions`, `validation`, or `conditions`.

### C3. Enforce immutable and risky field changes

Backend `upsertField()` currently updates existing field type/interface freely.

Add:

- `createField(collection, input)` for new field.
- `updateField(collection, field, patch)` for non-breaking updates.
- `planFieldMigration(collection, field, proposal)` for type/default/nullability/index changes.
- `applyFieldMigration(planId)` for confirmed changes.

Minimum MVP behavior:

- Reject `type` changes if collection has any items.
- Reject changing `name`; require explicit `renameField()` endpoint.
- Reject deleting field with data unless `force=true` and a backup revision is written.

Acceptance criteria:

- Existing API remains backward compatible through `PUT`, but internally branches into safe create/update.
- Risky updates return `409` with migration guidance.
- Studio shows a confirmation dialog before destructive changes.

## 6. Task group D: Relations parity

### D1. Validate relation references

Current relation route accepts strings without verifying collections/fields.

Add validation in `SchemaService.createRelation()`:

- `manyCollection` exists.
- `manyField` exists on many collection.
- `oneCollection` exists.
- `oneField` exists when provided.
- `junctionCollection` exists for M2M if provided.
- `onDelete` is supported by storage mode.
- Relation names are unique enough to avoid duplicate edges.

Acceptance criteria:

- Invalid relation returns `400` with exact missing collection/field path.
- Deleting a collection checks both `manyCollection` and `oneCollection`, not only one side.
- Deleting a field referenced by a relation is blocked until relation is removed or migrated.

### D2. Add relation types and metadata

Extend relation schema with:

```ts
type: text('type').notNull() // m2o | o2m | m2m | m2a | file
aliasField: text('alias_field')
relatedDisplayTemplate: text('related_display_template')
junctionManyField: text('junction_many_field')
junctionOneField: text('junction_one_field')
```

Rules:

- M2O stores foreign key value on `manyField`.
- O2M is an alias computed from inverse M2O.
- M2M requires a junction collection and two M2O relations.
- M2A can wait, but reserve the type and reject with "not implemented" if selected.

### D3. Implement deep read and relation expansion

Add item query support:

- `fields=title,author.name,categories.*`
- `deep[author][fields]=id,name`
- `deep[categories][limit]=10`

Implementation:

- Build relation graph from compiled schema.
- Resolve relation expansions after base item query.
- Apply permissions to every related collection.
- Avoid N+1 by batching relation lookups.

Acceptance criteria:

- M2O values resolve to related item when requested.
- O2M/M2M return arrays.
- Field-level permission masking still applies to related items.

## 7. Task group E: Schema permissions and security

### E1. Protect schema management endpoints

The collections route currently documents schema permission enforcement as a stub. Replace with real checks.

Required permissions:

- `schema:read`: list/get collections, fields, relations, compiled schema.
- `schema:create`: create collection, create field, create relation.
- `schema:update`: patch collection, update field, update relation, apply schema.
- `schema:delete`: delete collection, delete field, delete relation.
- `schema:migrate`: breaking type changes, field rename, storage mode changes.

Implementation:

- Add schema permission actions to shared policy types.
- Add `requireSchemaPermission(c, action)` middleware/helper.
- Apply it to `collectionsRouter` and `relationsRouter`.
- Ensure AI skills that create schema use the same capability checks.

Acceptance criteria:

- Non-admin authenticated users cannot mutate schema without explicit permission.
- Permission denial is indistinguishable from other API errors only where security policy requires it; otherwise return `403`.
- Tests cover read-only, schema editor and admin roles.

### E2. Fix item update/delete permissions

`ItemService.list/detail/create` checks permission, but update/delete must also enforce permissions.

Required changes:

- In `patch()`: call `perm(collectionName, 'update')`.
- In `replace()`: reuse update permission.
- In `softDelete()`: call `perm(collectionName, 'delete')`.
- Apply row-level `whereFor()` to update/delete target lookup.
- Apply field-level update allowlist: reject patches to fields not writable by current permission.

Acceptance criteria:

- A read-only user cannot patch/delete by direct API call.
- A user with row-scoped update cannot update rows outside scope.
- A user cannot update hidden/readonly fields through raw JSON.

## 8. Task group F: Collection lifecycle and schema diff

### F1. Make schema diff complete

Current diff compares only a few collection fields and added/removed/changed fields.

Expand diff to include:

- Collection metadata changes.
- Field metadata changes.
- Relation add/update/remove.
- Risk classification: `safe`, `requires-confirmation`, `destructive`, `unsupported`.
- Runtime impact: cache invalidation, item migration, materialized refresh, typegen update.

Response shape:

```json
{
  "summary": {
    "safe": 3,
    "requiresConfirmation": 1,
    "destructive": 0,
    "unsupported": 0
  },
  "changes": [
    {
      "kind": "field.update",
      "path": "posts.title.label",
      "before": "Title",
      "after": "Headline",
      "risk": "safe"
    }
  ]
}
```

### F2. Apply schema atomically

`PUT /collections/:name/schema` should be atomic from the user's perspective.

Implementation:

- Validate entire schema first.
- Compute diff.
- Reject unsupported/destructive changes unless explicitly confirmed.
- Apply collection, fields, relations in a transaction when runtime supports it.
- Invalidate compiled schema, permission cache and typegen cache.
- Emit realtime `schema.changed` event.

Acceptance criteria:

- Partial schema apply cannot leave a collection half-updated.
- Studio Raw JSON tab shows diff before apply.
- Typegen preview updates after apply.

## 9. Task group G: Storage modes and Directus positioning

### G1. Document and implement storage mode behavior

Add product docs and API metadata explaining:

- `jsonb`: fastest to evolve, no runtime DDL, lower SQL-native compatibility.
- `materialized`: JSONB source of truth with physical read optimization.
- `physical`: Directus-like real table, future milestone.
- `external`: introspected table, future milestone.

For MVP parity, do not pretend `jsonb` is the same as Directus physical tables. Studio should show a storage badge and limitations.

### G2. Physical mode spike

Create a technical design before implementation:

- How to create tenant-scoped physical tables safely.
- Naming convention: `site_<siteId>_<collectionName>` or schema-per-site.
- Migration planning for add/drop/rename/type change.
- RLS and permission interaction.
- Drizzle/raw SQL boundary.
- Backup/export/import behavior.
- Cloudflare Hyperdrive/Postgres compatibility.

Deliverable:

- `docs/en/architecture/physical-collections.md`
- Decision: implement now, defer, or keep materialized-only strategy.

## 10. Task group H: SDK, typegen, OpenAPI and docs

### H1. SDK schema resources

SDK must expose:

```ts
client.schema.collections.list()
client.schema.collections.create(input)
client.schema.collections.update(name, patch)
client.schema.collections.delete(name)
client.schema.fields.create(collection, input)
client.schema.fields.update(collection, field, patch)
client.schema.fields.rename(collection, field, nextName)
client.schema.fields.delete(collection, field, options)
client.schema.relations.list(params)
client.schema.relations.create(input)
client.schema.relations.update(id, patch)
client.schema.relations.delete(id)
client.schema.diff(input)
client.schema.apply(input, options)
```

Acceptance criteria:

- Existing legacy SDK methods continue to work or emit deprecation warnings.
- TypeScript types match backend validation schemas.
- SDK errors preserve code/path/risk metadata.

### H2. Typegen improvements

Typegen should include:

- Primary key type.
- System fields.
- Nullable vs required fields.
- Readonly/generated fields.
- Relation-expanded response types.
- Encrypted field read behavior: decrypted type vs masked string depending permission cannot be known at compile time, so document as `T | '***'` if necessary.

### H3. OpenAPI and public docs

Update:

- `apps/cms/openapi.yaml`
- `docs/en/features/collections-builder.md`
- `docs/en/features/field-types-and-config.md`
- `docs/en/data-model.md`
- Vietnamese mirrors after English contract stabilizes.

## 11. Task group I: Tests

Minimum tests required before marking parity work complete:

### Backend tests

- Collection create persists all top-level metadata.
- Duplicate collection name returns `409`.
- Invalid primary key strategy returns `400`.
- Schema endpoints enforce schema permissions.
- Field type change with existing data returns `409`.
- Field delete with existing data requires force.
- Relation create validates collection/field existence.
- Collection delete blocks relations on both sides.
- Item update/delete enforce permissions and row scope.
- Schema diff classifies safe/destructive changes correctly.
- Schema apply invalidates cache.

### Frontend tests

- Wizard sends correct payload.
- Wizard blocks unsupported storage/primary key combinations.
- FieldInspector preserves unknown raw JSON options.
- Risky field changes show confirmation.
- System fields render locked.
- Relation builder blocks invalid references before submit.
- Raw schema apply shows diff.

### SDK/typegen tests

- Generated types include primary key and system fields.
- Relation-expanded types compile.
- SDK schema methods hit expected routes and preserve error metadata.

## 12. Suggested implementation order

1. Fix current correctness bugs:
   - Wizard top-level metadata payload.
   - Item update/delete permission checks.
   - Relation delete/dependency checks on both sides.
2. Add collection metadata columns and API/SDK types.
3. Add primary key strategy contract for `jsonb` mode.
4. Expand field config DB + FieldInspector advanced tabs.
5. Split field create/update/rename/delete/migration endpoints.
6. Harden relation validation and relation metadata.
7. Add schema permission checks.
8. Expand schema diff/apply.
9. Add system fields to compiled schema/typegen/Studio.
10. Implement relation expansion in item queries.
11. Update OpenAPI/docs and add parity test suites.
12. Decide physical/external storage strategy.

## 13. Definition of done

This work is done when a new LumiBase user can:

- Create a collection from Studio with identity, storage, system fields, archive/sort, permissions defaults and review JSON.
- Add fields with full type/interface/display/validation/condition/storage config.
- Add M2O/O2M/M2M relations with validation.
- Manage items through REST and SDK with permissions applied consistently.
- Export/import a schema, preview diff and apply safely.
- Generate types that represent the collection model accurately.
- Understand whether the collection is JSONB, materialized, physical or external, including tradeoffs.

Non-goal for the first parity milestone:

- Full existing database introspection.
- Full physical table DDL migration engine.
- Many-to-any relation runtime.
- Visual migration planner for every type conversion.
