---
version: 1
lastUpdated: 2026-07-28T00:13:52.452Z
sourceLang: en
translatedFrom: en
sourceHash: 872e80cfb4e04a65
mtEngine: claude
syncStatus: machine-translated
codeVerified: 2026-07-28T00:13:52.452Z
codeVerifiedHash: 872e80cfb4e04a65
codeVerifiedClaims: 6
---

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
- Storage identity: `storageMode`, `primaryKey`, materialized target tuỳ chọn.
- Behavior: `singleton`, `accountability`, `versioning`, `archiveField`, `archiveValue`, `unarchiveValue`, `sortField`.
- Chính sách system field: `status`, `sort`, `createdAt`, `updatedAt`, `createdBy`, `updatedBy`, `deletedAt`.
- Định nghĩa field: storage type, interface, display, validation, conditions, options, display options, translations, metadata layout.
- Relations: many-to-one, one-to-many, many-to-many, many-to-any, file relation, metadata junction.
- Access: quyền quản lý schema và quyền ở mức item.
- Hình dạng API: REST, SDK typegen, OpenAPI, export/import, diff/apply.

## 3. Task group A: Contract metadata của collection

### A1. Thêm các cột collection còn thiếu

Scope: `[DB] packages/database`, `[BE] apps/cms`, `[SDK] packages/sdk`, `[FE] apps/studio`.

Thêm các cột first-class vào `collections` thay vì giấu các field quan trọng của sản phẩm trong `meta`:

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

Các giá trị `primaryKeyType` được chấp nhận:

- `nanoid`: mặc định hiện tại của LumiBase.
- `uuid`: UUID v4 hoặc v7.
- `integer`: sequence integer được sinh tự động. Chỉ hợp lệ với mode physical/materialized, trừ khi được emulate tường minh.
- `bigInteger`: sequence bigint được sinh tự động. Cùng ràng buộc như `integer`.
- `string`: ID chuỗi do người dùng cung cấp.

Các giá trị `storageMode` được chấp nhận:

- `jsonb`: item store chung hiện tại.
- `materialized`: virtual schema với projection vật lý được quản lý.
- `physical`: mode tương lai, tạo và migrate một table thật.
- `external`: mode tương lai cho table ngoài được introspect.

Ghi chú triển khai:

- Tạo một Drizzle migration cho các cột mới.
- Backfill các row hiện có:
  - `label = titleCase(name)`
  - `pluralLabel = titleCase(name)`
  - `primaryKeyField = 'id'`
  - `primaryKeyType = 'nanoid'`
  - `storageMode = 'jsonb'`
- Cập nhật `CollectionInput`, validation ở route, SDK types, config export/import và OpenAPI.
- Chỉ giữ `meta` cho UI hint của extension/custom, không dùng cho hành vi cốt lõi của collection.

### A2. Sửa payload của collection wizard trong Studio

Vấn đề hiện tại: wizard của Studio gửi `note`, `versioning`, `accountability` bên trong `meta`, trong khi backend nhận chúng như field top-level của collection.

Thay đổi cần thiết:

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

Các bước của wizard:

1. Identity: name, label, plural label, icon, color, hidden.
2. Storage: primary key type, storage mode, singleton.
3. System fields: status, sort, các field created/updated, hành vi archive.
4. Mặc định permissions: preset role/policy hoặc "inherit default".
5. Review: JSON preview, cảnh báo, create.

Tiêu chí chấp nhận:

- Tạo collection từ Studio lưu được `note`, `accountability`, `versioning`, `singleton` ở mức top-level.
- Bước review hiển thị đúng payload API.
- Nếu `primaryKeyType` không được storage mode hiện tại hỗ trợ, UI chặn submit kèm thông báo chính xác.

## 4. Task group B: Primary key và system fields

### B1. Định nghĩa chiến lược primary key trong item storage

Scope: `[DB]`, `[BE] ItemService`, `[SDK] typegen`.

Với storage mode `jsonb`, triển khai chính sách sinh ID trong `ItemService.create()`:

- `nanoid`: sinh bởi default của database hoặc helper của service.
- `uuid`: sinh bởi service.
- `string`: bắt buộc có `id` trong request body hoặc `data.id`, từ chối trùng lặp.
- `integer` / `bigInteger`: hoãn lại cho đến khi có bảng sequence.

Thêm một helper nhỏ ở tầng service:

```ts
interface PrimaryKeyStrategy {
  field: string;
  type: 'nanoid' | 'uuid' | 'string' | 'integer' | 'bigInteger';
  generate(input: Record<string, unknown>): string | number;
  validate(value: unknown): void;
}
```

Tiêu chí chấp nhận:

- Tạo item tôn trọng chiến lược primary key của collection.
- Detail/update/delete nhận item ID theo chiến lược đã cấu hình.
- Typegen phơi ra kiểu primary key theo từng collection.
- ID do người dùng cung cấp bị trùng thì trả `409`.

### B2. Đưa system field thành field nhìn thấy được trong schema

Directus coi các field ID/status/sort/audit là field nhìn thấy trong model. LumiBase hiện có các cột cấu trúc, nhưng UI Data Model không phơi chúng ra như field model cấu hình được.

Thêm định nghĩa virtual field được sinh tự động cho:

- `id`
- `status`
- `sort`
- `user_created`
- `user_updated`
- `created_at`
- `updated_at`
- `deleted_at`

Triển khai:

- Mở rộng `CompiledCollection` với `systemFields`.
- `SchemaService.compile()` nên nối descriptor của system field trước user field, hoặc phơi ra một array `systemFields` riêng.
- Tab Fields của Studio nên hiển thị system field trong một nhóm bị khoá.
- Người dùng có thể cấu hình display, hidden, readonly, translations và width cho system field, nhưng không thể xoá chúng.
- Nếu collection tắt hành vi của một system field, đánh dấu field đó hidden thay vì bỏ cột nền.

Tiêu chí chấp nhận:

- Content list có thể include/hide system field một cách nhất quán.
- Typegen bao gồm system field.
- Raw JSON schema tách rõ `fields` và `systemFields`.

## 5. Task group C: Ngang bằng về cấu hình field

### C1. Mở rộng contract DB của field

Thêm metadata field ở dạng first-class:

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

Quy tắc:

- `name`, `type` và các field ảnh hưởng tới storage là immutable khi đã có dữ liệu, trừ khi có kế hoạch migration đi kèm.
- `interface`, `display`, `options`, `displayOptions`, `validation`, `conditions`, `translations`, `width`, `group`, `sortOrder` sửa được.
- `unique` và `indexed` chỉ ở mức advisory trong mode `jsonb`, trừ khi có index materialized/physical. UI phải ghi rõ điều này.

### C2. Triển khai các tab nâng cao cho FieldInspector

Thay inspector một-form hiện tại bằng các tab:

- Basics: name, label, note, type, interface, required, readonly, hidden.
- Options: option riêng theo interface, sinh từ schema của registry.
- Display: display key, display options, live preview.
- Validation: rule builder có sẵn và mode raw JSON.
- Conditions: rule builder và mode raw JSON.
- Layout: width, group, sort, presentation field.
- Storage: default value, nullable, unique, indexed, searchable, encrypted, versioned, raw enabled.
- Translations: label/help theo từng locale.

Ghi chú triển khai:

- Interface registry phải phơi option schema ở dạng UI đọc được.
- Option lạ phải vẫn sửa được qua raw JSON để interface của extension không mất config.
- Validation builder phải ghi ra đúng DSL JSON mà `validateItem()` tiêu thụ.

Tiêu chí chấp nhận:

- Người dùng có thể cấu hình mọi cột đang có trong `fields`.
- Người dùng có thể cấu hình các phần mới thêm: `label`, `note`, default, hint uniqueness/index, searchability, translations.
- Không lần lưu field nào làm mất `options`, `displayOptions`, `validation` hay `conditions` lạ.

### C3. Enforce các thay đổi field immutable và rủi ro

`upsertField()` ở backend hiện đang cho update type/interface của field có sẵn một cách tự do.

Thêm:

- `createField(collection, input)` cho field mới.
- `updateField(collection, field, patch)` cho các update không phá vỡ.
- `planFieldMigration(collection, field, proposal)` cho thay đổi type/default/nullability/index.
- `applyFieldMigration(planId)` cho thay đổi đã xác nhận.

Hành vi MVP tối thiểu:

- Từ chối thay đổi `type` nếu collection đang có item.
- Từ chối thay đổi `name`; yêu cầu endpoint `renameField()` tường minh.
- Từ chối xoá field đang có dữ liệu, trừ khi `force=true` và một revision backup đã được ghi.

Tiêu chí chấp nhận:

- API hiện có vẫn tương thích ngược qua `PUT`, nhưng bên trong phân nhánh sang create/update an toàn.
- Update rủi ro trả `409` kèm hướng dẫn migration.
- Studio hiện dialog xác nhận trước các thay đổi phá huỷ.

## 6. Task group D: Ngang bằng về relations

### D1. Validate tham chiếu của relation

Route relation hiện tại nhận string mà không verify collection/field.

Thêm validation trong `SchemaService.createRelation()`:

- `manyCollection` tồn tại.
- `manyField` tồn tại trên many collection.
- `oneCollection` tồn tại.
- `oneField` tồn tại khi được cung cấp.
- `junctionCollection` tồn tại với M2M nếu được cung cấp.
- `onDelete` được storage mode hỗ trợ.
- Tên relation đủ unique để tránh edge trùng lặp.

Tiêu chí chấp nhận:

- Relation không hợp lệ trả `400` kèm đúng path collection/field bị thiếu.
- Xoá collection kiểm tra cả `manyCollection` và `oneCollection`, không chỉ một phía.
- Xoá field đang được relation tham chiếu bị chặn cho đến khi relation được bỏ hoặc migrate.

### D2. Thêm loại relation và metadata

Mở rộng schema relation với:

```ts
type: text('type').notNull() // m2o | o2m | m2m | m2a | file
aliasField: text('alias_field')
relatedDisplayTemplate: text('related_display_template')
junctionManyField: text('junction_many_field')
junctionOneField: text('junction_one_field')
```

Quy tắc:

- M2O lưu giá trị foreign key trên `manyField`.
- O2M là alias được tính từ M2O nghịch đảo.
- M2M cần một junction collection và hai relation M2O.
- M2A có thể để sau, nhưng phải giữ chỗ cho type này và từ chối với "not implemented" nếu được chọn.

### D3. Triển khai deep read và relation expansion

Thêm hỗ trợ query item:

- `fields=title,author.name,categories.*`
- `deep[author][fields]=id,name`
- `deep[categories][limit]=10`

Triển khai:

- Dựng relation graph từ compiled schema.
- Resolve các relation expansion sau query item cơ sở.
- Áp permission cho mọi collection liên quan.
- Tránh N+1 bằng cách batch các lần tra relation.

Tiêu chí chấp nhận:

- Giá trị M2O resolve thành item liên quan khi được yêu cầu.
- O2M/M2M trả về array.
- Masking permission ở mức field vẫn áp lên các item liên quan.

## 7. Task group E: Quyền schema và bảo mật

### E1. Bảo vệ các endpoint quản lý schema

Route collections hiện đang tài liệu hoá việc enforce quyền schema như một stub. Thay bằng kiểm tra thật.

Các quyền cần có:

- `schema:read`: list/get collection, field, relation, compiled schema.
- `schema:create`: tạo collection, tạo field, tạo relation.
- `schema:update`: patch collection, update field, update relation, apply schema.
- `schema:delete`: xoá collection, xoá field, xoá relation.
- `schema:migrate`: thay đổi type phá vỡ, rename field, thay đổi storage mode.

Triển khai:

- Thêm các action quyền schema vào shared policy types.
- Thêm middleware/helper `requireSchemaPermission(c, action)`.
- Áp nó vào `collectionsRouter` và `relationsRouter`.
- Bảo đảm các AI skill tạo schema dùng cùng bộ kiểm tra capability.

Tiêu chí chấp nhận:

- User đã đăng nhập nhưng không phải admin không thể mutate schema mà không có quyền tường minh.
- Việc từ chối quyền chỉ được làm cho khó phân biệt với lỗi API khác ở nơi chính sách bảo mật yêu cầu; còn lại trả `403`.
- Test bao phủ role read-only, schema editor và admin.

### E2. Sửa quyền update/delete của item

`ItemService.list/detail/create` có kiểm tra permission, nhưng update/delete cũng phải enforce.

Thay đổi cần thiết:

- Trong `patch()`: gọi `perm(collectionName, 'update')`.
- Trong `replace()`: dùng lại quyền update.
- Trong `softDelete()`: gọi `perm(collectionName, 'delete')`.
- Áp `whereFor()` ở mức row cho việc tra cứu target của update/delete.
- Áp allowlist update ở mức field: từ chối patch vào field mà permission hiện tại không cho ghi.

Tiêu chí chấp nhận:

- User read-only không thể patch/delete bằng lệnh gọi API trực tiếp.
- User có quyền update giới hạn theo row không thể update row ngoài phạm vi.
- User không thể update field hidden/readonly qua raw JSON.

## 8. Task group F: Lifecycle collection và schema diff

### F1. Làm cho schema diff đầy đủ

Diff hiện tại chỉ so sánh một vài field của collection cùng các field được thêm/bỏ/đổi.

Mở rộng diff để bao gồm:

- Thay đổi metadata collection.
- Thay đổi metadata field.
- Thêm/update/bỏ relation.
- Phân loại rủi ro: `safe`, `requires-confirmation`, `destructive`, `unsupported`.
- Ảnh hưởng runtime: cache invalidation, migrate item, refresh materialized, cập nhật typegen.

Hình dạng response:

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

### F2. Apply schema theo kiểu atomic

`PUT /collections/:name/schema` phải là atomic từ góc nhìn người dùng.

Triển khai:

- Validate toàn bộ schema trước.
- Tính diff.
- Từ chối các thay đổi unsupported/destructive trừ khi được xác nhận tường minh.
- Áp collection, field, relation trong một transaction khi runtime hỗ trợ.
- Invalidate compiled schema, cache permission và cache typegen.
- Phát event realtime `schema.changed`.

Tiêu chí chấp nhận:

- Apply schema một phần không thể để collection ở trạng thái nửa vời.
- Tab Raw JSON của Studio hiển thị diff trước khi apply.
- Preview typegen cập nhật sau khi apply.

## 9. Task group G: Storage mode và định vị so với Directus

### G1. Tài liệu hoá và triển khai hành vi của storage mode

Thêm docs sản phẩm và metadata API giải thích:

- `jsonb`: tiến hoá nhanh nhất, không cần DDL runtime, tương thích SQL-native thấp hơn.
- `materialized`: JSONB là source of truth, kèm tối ưu đọc vật lý.
- `physical`: table thật kiểu Directus, cột mốc tương lai.
- `external`: table được introspect, cột mốc tương lai.

Để ngang bằng ở mức MVP, đừng giả vờ `jsonb` giống table vật lý của Directus. Studio nên hiện một badge storage kèm các giới hạn.

### G2. Spike cho mode physical

Tạo một thiết kế kỹ thuật trước khi triển khai:

- Cách tạo table vật lý scope theo tenant một cách an toàn.
- Quy ước đặt tên: `site_<siteId>_<collectionName>` hoặc schema-per-site.
- Lập kế hoạch migration cho add/drop/rename/đổi type.
- Tương tác giữa RLS và permission.
- Ranh giới Drizzle/raw SQL.
- Hành vi backup/export/import.
- Tương thích Cloudflare Hyperdrive/Postgres.

Sản phẩm giao:

- `docs/en/architecture/physical-collections.md`
- Quyết định: triển khai ngay, hoãn, hay giữ chiến lược chỉ-materialized.

## 10. Task group H: SDK, typegen, OpenAPI và docs

### H1. Các resource schema của SDK

SDK phải phơi ra:

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

Tiêu chí chấp nhận:

- Các method SDK legacy hiện có vẫn chạy, hoặc phát cảnh báo deprecation.
- Kiểu TypeScript khớp với schema validation ở backend.
- Lỗi SDK giữ được metadata code/path/risk.

### H2. Cải tiến typegen

Typegen nên bao gồm:

- Kiểu primary key.
- System fields.
- Field nullable so với required.
- Field readonly/generated.
- Response type khi relation được expand.
- Hành vi đọc field encrypted: không thể biết ở compile time là kiểu đã giải mã hay string bị mask (phụ thuộc permission), nên hãy tài liệu hoá dưới dạng `T | '***'` nếu cần.

### H3. OpenAPI và docs công khai

Cập nhật:

- `apps/cms/openapi.yaml`
- `docs/en/features/collections-builder.md`
- `docs/en/features/field-types-and-config.md`
- `docs/en/data-model.md`
- Bản mirror tiếng Việt sau khi contract tiếng Anh đã ổn định.

## 11. Task group I: Tests

Các test tối thiểu cần có trước khi đánh dấu công việc parity là hoàn thành:

### Test backend

- Tạo collection lưu được toàn bộ metadata top-level.
- Tên collection trùng trả `409`.
- Chiến lược primary key không hợp lệ trả `400`.
- Các endpoint schema enforce quyền schema.
- Đổi type field khi đang có dữ liệu trả `409`.
- Xoá field đang có dữ liệu yêu cầu force.
- Tạo relation validate sự tồn tại của collection/field.
- Xoá collection bị chặn bởi relation ở cả hai phía.
- Update/delete item enforce permission và phạm vi row.
- Schema diff phân loại đúng thay đổi safe/destructive.
- Schema apply invalidate cache.

### Test frontend

- Wizard gửi đúng payload.
- Wizard chặn các tổ hợp storage/primary key không được hỗ trợ.
- FieldInspector giữ nguyên các option raw JSON lạ.
- Thay đổi field rủi ro hiện xác nhận.
- System field render ở trạng thái khoá.
- Relation builder chặn tham chiếu không hợp lệ trước khi submit.
- Apply raw schema hiển thị diff.

### Test SDK/typegen

- Type được sinh ra bao gồm primary key và system field.
- Các type có relation được expand compile được.
- Method schema của SDK gọi đúng route và giữ được metadata lỗi.

## 12. Thứ tự triển khai đề xuất

1. Sửa các bug đúng-sai hiện tại:
   - Payload metadata top-level của wizard.
   - Kiểm tra permission update/delete của item.
   - Kiểm tra delete/dependency của relation ở cả hai phía.
2. Thêm các cột metadata của collection cùng type ở API/SDK.
3. Thêm contract chiến lược primary key cho mode `jsonb`.
4. Mở rộng DB cấu hình field + các tab nâng cao của FieldInspector.
5. Tách các endpoint create/update/rename/delete/migration của field.
6. Làm chặt validation relation và metadata relation.
7. Thêm kiểm tra quyền schema.
8. Mở rộng schema diff/apply.
9. Thêm system field vào compiled schema/typegen/Studio.
10. Triển khai relation expansion trong query item.
11. Cập nhật OpenAPI/docs và thêm bộ test parity.
12. Quyết định chiến lược storage physical/external.

## 13. Definition of done

Công việc này hoàn thành khi một người dùng LumiBase mới có thể:

- Tạo một collection từ Studio với identity, storage, system fields, archive/sort, mặc định permissions và review JSON.
- Thêm field với đầy đủ cấu hình type/interface/display/validation/condition/storage.
- Thêm relation M2O/O2M/M2M có validation.
- Quản lý item qua REST và SDK với permission được áp nhất quán.
- Export/import một schema, xem trước diff và apply an toàn.
- Sinh type phản ánh chính xác model của collection.
- Hiểu được collection đang là JSONB, materialized, physical hay external, kèm các đánh đổi.

Không thuộc mục tiêu của cột mốc parity đầu tiên:

- Introspect đầy đủ database có sẵn.
- Engine migration DDL table vật lý đầy đủ.
- Runtime cho relation many-to-any.
- Trình lập kế hoạch migration trực quan cho mọi phép chuyển đổi type.
