---
title: Trình tạo Collection
---

# Trình tạo Collection

Collections Builder là bề mặt no-code để định nghĩa content model trong LumiBase. Contract parity với Directus được khai báo rõ: metadata collection, chiến lược primary key, storage mode, fields, relations, schema diff/apply, SDK typegen và các giới hạn runtime đều là dữ liệu schema first-class.

## 1. Vòng đời collection

Tác giả tạo collection bằng Studio wizard hoặc apply Raw JSON. Payload tạo collection lưu metadata ở top-level, không giấu trong `meta`:

- `name`, `label`, `pluralLabel`, `note`
- `hidden`, `system`, `singleton`
- `icon`, `color`
- `primaryKeyField`, `primaryKeyType`
- `storageMode`
- `displayTemplate`
- `sortField`, `archiveField`, `archiveValue`, `unarchiveValue`
- `itemDuplicationFields`, `translations`
- `accountability`, `versioning`
- `meta`

Tên collection là duy nhất theo site, dùng snake_case, bắt đầu bằng chữ thường và nằm trong giới hạn machine-name 1-63 ký tự.

## 2. Primary key

Mỗi collection có logical primary key field và type.

| `primaryKeyType` | Hành vi hiện tại |
|---|---|
| `nanoid` | Mặc định, string identifier do LumiBase sinh. |
| `uuid` | UUID string do service sinh. |
| `string` | Identifier string do caller cung cấp. |
| `integer` | Dành cho storage materialized/physical có sequence; bị chặn với JSONB collection. |
| `bigInteger` | Dành cho storage materialized/physical có sequence; bị chặn với JSONB collection. |

Studio chặn tổ hợp primary key/storage mode không hỗ trợ trước khi submit. Backend cũng validate để Raw JSON và SDK nhận lỗi rõ ràng.

## 3. System fields

Compiled schema expose system fields tách khỏi user fields. Studio render chúng trong nhóm bị khóa và chỉ cho override presentation an toàn như `display`, `hidden`, `readonly`, `width`, `translations`.

| Field | Type | Mục đích |
|---|---|---|
| `id` | `string` | Primary item identifier. |
| `status` | `string` | Workflow status cho draft/published/archive. |
| `sort` | `integer` | Giá trị sắp xếp thủ công. |
| `user_created` | `string` | User tạo item. |
| `user_updated` | `string` | User cập nhật cuối. |
| `created_at` | `datetime` | Thời điểm tạo. |
| `updated_at` | `datetime` | Thời điểm cập nhật cuối. |
| `deleted_at` | `datetime` | Thời điểm soft-delete. |

Raw schema output giữ user fields trong `fields` và compiled system fields trong `systemFields` để tooling phân biệt schema do tác giả khai báo với field runtime sinh ra.

## 4. Fields và layout

Fields tab hỗ trợ metadata kiểu Directus cho từng field:

- Basics: `name`, `label`, `note`, `type`, `interface`, `display`.
- Behavior: `required`, `nullable`, `readonly`, `hidden`, `encrypted`, `versioned`, `rawEnabled`.
- Storage hints: `unique`, `indexed`, `searchable`, `length`, `precision`, `scale`, `special`.
- UI và validation: `options`, `displayOptions`, `validation`, `conditions`, `translations`, `width`, `group`, `sortOrder`.

Studio inspector giữ lại unknown JSON config để option mới không bị mất khi build Studio cũ edit field.

## 5. Relations

Relations là schema resource first-class. Mỗi relation lưu:

- `manyCollection`, `manyField`
- `oneCollection`, `oneField`
- `junctionCollection`
- `type`: `m2o`, `o2m`, `m2m`, hoặc reserved `m2a`
- `aliasField`, `relatedDisplayTemplate`, `junctionManyField`, `junctionOneField`
- `sortField`, `onDelete`, `meta`

Backend validate collection/field được tham chiếu, chặn xóa collection khi vẫn có relation phụ thuộc ở một trong hai phía, và đưa relation changes vào schema diff/apply.

## 6. Raw JSON, diff và apply

Raw JSON dùng cùng contract với SDK:

```json
{
  "name": "posts",
  "label": "Posts",
  "primaryKeyField": "id",
  "primaryKeyType": "nanoid",
  "storageMode": "jsonb",
  "displayTemplate": "{{title}} — {{status}}",
  "fields": [
    {
      "name": "title",
      "type": "string",
      "interface": "input",
      "required": true,
      "nullable": false,
      "width": "full"
    }
  ],
  "relations": []
}
```

Dùng `POST /api/v1/collections/diff` để preview thay đổi schema. Dùng `PUT /api/v1/collections/{name}/schema` để apply. Apply compute cùng diff, validate fields/relations, chạy transactionally khi runtime DB hỗ trợ, invalidate schema/permission/typegen cache và emit event `schema.changed`.

Diff entries có:

- `risk`: `low`, `medium`, `high`
- `runtimeImpact`: `cache_invalidation`, `permission_recompile`, `typegen_rebuild`, `data_migration_required`, `relation_reindex`, `storage_runtime_change`
- thay đổi collection metadata, fields và relations

Raw JSON tab trong Studio khóa Apply cho đến khi preview đã chạy, sau đó hiển thị risk, runtime impact và raw diff.

## 7. Storage modes

Mỗi collection có `storageMode`. Studio hiển thị mode dưới dạng badge trong wizard và giữ tradeoff hiển thị trước khi tác giả tạo hoặc migrate model.

| Mode | Badge trong Studio | Hành vi hiện tại | Giới hạn |
|---|---|---|---|
| `jsonb` | Current | Collection logic mặc định. Item nằm trong document JSONB `items.data`, nên đổi schema không chạy DDL. | Unique/index SQL-native chỉ là advisory nếu chưa có materialized/physical projection. Integer primary key bị chặn. |
| `materialized` | Optimized | JSONB vẫn là source of truth, kèm managed physical projection cho hot read path. | Cần quản lý freshness, refresh strategy và indexes; writes vẫn đi qua logical collection. |
| `physical` | Future | Dành cho bảng vật lý kiểu Directus do LumiBase sở hữu. Schema diff đánh dấu storage runtime change. | Chưa có DDL migration engine tổng quát. Cần tenant-safe table naming, rollback, relation/index DDL và online migration plan. |
| `external` | Future | Dành cho bảng ngoài được introspect. | Chưa hỗ trợ writes. DDL/relation action phá hủy bị giới hạn vì LumiBase không sở hữu table. |

Không trình bày `jsonb` như tương đương bảng vật lý của Directus. Promise hiện tại là đổi schema nhanh trước, dùng materialized projection cho performance và theo dõi quyết định physical/external trong `docs/en/architecture/physical-collections.md`.

## 8. SDK và typegen

SDK expose schema resources dưới `client.schema`:

```ts
client.schema.collections.list();
client.schema.fields.rename("posts", "headline", "title", {
  type: "string",
  interface: "input",
  confirmRiskyChange: true,
});
client.schema.relations.create({
  manyCollection: "posts",
  manyField: "author_id",
  oneCollection: "authors",
  type: "m2o",
});
client.schema.diff("posts", proposedSchema);
client.schema.apply("posts", proposedSchema);
```

Legacy flat methods như `schema.listCollections()` và `schema.upsertField()` vẫn tồn tại. SDK errors giữ metadata backend `code`, `path`, `risk` qua `LumiError.body`.

Typegen manifest version `2` gồm primary key metadata, system fields, nullable/required, readonly/generated flags, encrypted field read behavior và relation descriptors. Generated output có base collection interfaces và relation-expanded response types như `PostsExpanded`.
