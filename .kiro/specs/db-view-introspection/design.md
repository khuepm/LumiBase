# Design — DB View Introspection & Field Bootstrap

> Status: **Proposal / Roadmap**. Tham chiếu code hiện tại đã verify; thành phần mới đánh dấu `[Proposal]`.

## 1. Vấn đề cốt lõi

LumiBase đọc field từ bảng `fields`. Khi bảng được tạo ngoài UI, không có record `fields` → field "vô hình" với Studio. Cần một lớp **đối chiếu** giữa:
- **Cột vật lý** (introspect từ DB) — nguồn A
- **Record `fields`** (metadata LumiBase) — nguồn B

`A \ B` = Uncatalogued (chấm than). `B \ A` = Drift/missing. `A ∩ B` = Catalogued.

## 2. Introspection qua runtime abstraction

Không import driver DB trong service. Thêm vào runtime ([`packages/runtime/src/`](packages/runtime/src/)) một cổng:

```ts
// [Proposal] runtime interface
interface SchemaIntrospector {
  listObjects(opts: { registered?: boolean }): Promise<DbObject[]>   // tables + views
  describeObject(name: string): Promise<DbColumn[]>                   // columns + types
}
```

- **Postgres adapter** (CF Hyperdrive/Neon + Docker Postgres): truy vấn `information_schema.columns`, `pg_catalog` cho PK/FK.
- **SQLite adapter** (nếu dùng ở dev): `PRAGMA table_info` / `PRAGMA foreign_key_list`.
- Adapter chọn theo `LUMIBASE_RUNTIME` ([[production-cf-bindings]]).

> Chỉ trả **metadata** (cột, kiểu, nullable, default, PK/FK). Không bao giờ trả rows (Req 5).

## 3. Service đối chiếu

```ts
// [Proposal] SchemaService.reconcileFields(collectionName)
const physical = await introspector.describeObject(collection.sourceObject)
const records  = await db.select().from(fields).where(eq(fields.collectionId, collection.id))
                                                .where(eq(fields.siteId, siteId))   // rule #2
return physical.map(col => ({
  column: col,
  field: records.find(r => r.name === col.name) ?? null,   // null ⇒ Uncatalogued ⇒ ⚠
}))
// + records không khớp cột nào ⇒ Drift
```

Endpoint:
- `[Proposal] GET /api/v1/collections/:name/introspect` → kết quả reconcile (catalogued/uncatalogued/drift + counts).
- `[Proposal] GET /api/v1/db/objects?registered=false` → DB picker.

Cả hai trả `{ data, meta }` (rule #5), filter `site_id`, loại bảng hệ thống LumiBase (Req 5.2).

## 4. Type_Map

```ts
// [Proposal] packages/shared/src/schemas/db-type-map.ts (hoặc cạnh schema-service)
const TYPE_MAP: Record<string, { type: string; interface: string; display?: string }> = {
  'text':        { type: 'string',    interface: 'input' },
  'varchar':     { type: 'string',    interface: 'input' },
  'int4':        { type: 'integer',   interface: 'input' },
  'int8':        { type: 'bigInteger',interface: 'input' },
  'bool':        { type: 'boolean',   interface: 'toggle', display: 'boolean' },
  'timestamptz': { type: 'timestamp', interface: 'datetime', display: 'datetime' },
  'date':        { type: 'timestamp', interface: 'datetime', display: 'datetime' },
  'jsonb':       { type: 'json',      interface: 'code' },
  'uuid':        { type: 'uuid',      interface: 'input' },
  // FK column (phát hiện qua introspect) → { type:'relation', interface:'relation-m2o' }
}
```
Suy thêm `nullable/length/precision/scale/unique/indexed` từ introspect (Req 3.3). Kiểu lạ → `string`/`input` + cảnh báo (Req 3.4).

## 5. Frontend

### 5.1 `fields-tab.tsx` (mở rộng)
- Gọi `/introspect` khi collection có `source_object`.
- Render row: chấm than (lucide `triangle-alert`) cho Uncatalogued, badge "drift" cho missing.
- Header counts: `N uncatalogued · M catalogued · K drift`.

### 5.2 `field-inspector.tsx` (mở rộng)
- Mode mới `configure-existing-column`: khoá tên/kiểu vật lý (cột đã tồn tại), nạp Type_Map, mở các tab Interface/Display/Validation/Conditions/Layout/classification như bình thường.
- Save → `PUT /api/v1/collections/:name/fields/:field` (đường có sẵn → `SchemaService.createField()` → audit classification + invalidate cache).

## 6. Luồng end-to-end (DB_View_Mode)

```
DBA tạo bảng `orders` trong Postgres (ngoài LumiBase)
  → user: Create collection → DB_View_Mode → chọn `orders`
  → registerDbCollection(): insert collections{ source_object:'orders', storage_mode:'physical' }
  → mở collection: 8 cột, tất cả ⚠ uncatalogued
  → user bấm cột `total_amount` (numeric) → inspector nạp Type_Map{integer/input}
  → chỉnh interface=currency, display=formatted-value, classification=internal → Save
  → PUT .../fields/total_amount → row `fields` tạo, ⚠ biến mất, cache invalidated
```

## 7. Edge cases
- **FK detection:** cần `pg_catalog`/`PRAGMA foreign_key_list`; nếu không phát hiện được, để `relation` cho người dùng tự chọn target.
- **View không có PK:** Flexible_View read-only, không cần PK để hiển thị; cảnh báo nếu muốn edit.
- **Bảng thiếu site_id:** chặn/mark non-RLS (Req 5.3) — chia sẻ logic với [`collection-create-modes`](../collection-create-modes/design.md) §4.4.
- **Drift cột bị xoá:** không tự xoá record `fields` (có thể đang versioned) — chỉ cảnh báo, để người dùng quyết.

## 8. Cross-spec
- Gọi từ [`collection-create-modes`](../collection-create-modes/design.md) (DB picker + register).
- ID strategy: tôn trọng `collections.primary_key_type` ([[do-sqlite-classes-free-plan]] không liên quan trực tiếp nhưng lưu ý DO nếu introspect chạy trong DO).
