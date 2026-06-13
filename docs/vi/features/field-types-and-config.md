# Field Types và Configuration

LumiBase coi mỗi field là schema object first-class. Field có metadata độc lập cho storage, editor, display, validation, permission và runtime. Cùng một contract được Studio, REST schema endpoints, SDK schema resources và typegen sử dụng.

## 1. Storage types

| Type | Runtime value | Ghi chú |
|---|---|---|
| `string` | `string` | Text ngắn, có thể dùng `length`. |
| `text` | `string` | Text dài. |
| `integer` / `bigInteger` | `number` | Sequence-backed primary key dành cho non-JSONB storage mode. |
| `decimal` | `number` | Dùng `precision` và `scale`. |
| `boolean` | `boolean` | Boolean flag. |
| `json` | `unknown` | Raw JSON object/value. |
| `uuid` | `string` hoặc branded ID | UUID value, thường dùng cho primary key hoặc relation. |
| `date` / `datetime` / `time` / `timestamp` | `string` | Date/time serialized dạng ISO-like. |
| `csv` | `string` | CSV serialized text. |
| `hash` | `string` | Hash một chiều. |
| `geometry` | `GeoJSON.Geometry` | Lưu dưới dạng GeoJSON-like JSON. |
| `alias` | virtual | Dùng cho relation aliases, groups và presentation-only fields. |

## 2. Field metadata

Field definition có thể gồm:

```json
{
  "name": "cover",
  "type": "uuid",
  "interface": "file",
  "display": "image",
  "label": "Cover",
  "note": "16:9 hero image",
  "defaultValue": null,
  "nullable": true,
  "required": false,
  "readonly": false,
  "hidden": false,
  "encrypted": false,
  "versioned": true,
  "rawEnabled": true,
  "unique": false,
  "indexed": true,
  "searchable": true,
  "special": ["file"],
  "options": { "folder": "covers" },
  "displayOptions": { "size": "medium" },
  "validation": {
    "rules": [
      { "type": "mime", "allow": ["image/png", "image/jpeg", "image/webp"] }
    ]
  },
  "conditions": [
    { "rule": "$.status == 'published'", "set": { "required": true } }
  ],
  "translations": {
    "vi": { "label": "Ảnh bìa", "help": "Ảnh 16:9" }
  },
  "width": "full",
  "group": "media",
  "sortOrder": 20
}
```

`required` nghĩa là value phải có khi create/update item. `nullable` mô tả stored value có được là `null` không. Typegen giữ cả hai: required field là property bắt buộc, optional field có `?`, nullable field có thêm `| null`.

## 3. Readonly, generated và system fields

Readonly fields không được update qua item writes hoặc raw schema edits trừ khi backend cho phép override system-field an toàn. Generated fields do LumiBase hoặc storage runtime sinh, nên client code nên coi là read-only.

System fields được compile cho mọi collection:

- `id`
- `status`
- `sort`
- `user_created`
- `user_updated`
- `created_at`
- `updated_at`
- `deleted_at`

Typegen emit TypeScript property `readonly` cho field có `readonly` hoặc `generated`.

## 4. Interface registry

Interfaces định nghĩa cách Studio edit field:

```ts
interface FieldInterface<TOptions> {
  id: string;
  types: string[];
  optionsSchema: unknown;
  Component: React.ComponentType<{
    value: unknown;
    onChange(value: unknown): void;
    options: TOptions;
    field: unknown;
  }>;
  supportsRaw: boolean;
}
```

Studio hiện có input text, multiline, WYSIWYG, markdown, code, slug, color, number input, rating, dropdown choices, tags, toggle, date/datetime, relation editors, file, raw JSON, repeater, divider và notice interfaces. Source of truth là `apps/studio/src/modules/content/interfaces/registry.tsx`.

## 5. Display registry

Displays điều khiển rendering ở read/list view và độc lập với editor interface.

| Display | Mục đích |
|---|---|
| `formatted-value` / `raw` | Render scalar chung. |
| `boolean-icon` | Render boolean bằng icon. |
| `datetime` | Format date/time. |
| `image` | Preview image. |
| `labels` / `badge` | Label cho choice/status. |
| `relation-related-values` | Render related item theo template của target collection. |
| `mustache-template` | Display compose bằng Mustache. |
| `color-swatch` | Color chip. |
| `rating-stars` | Rating display. |
| `tags-pills` | List tags. |

Authors chỉnh collection `displayTemplate` trong tab Display. Relation display có thể dùng template của collection liên quan.

## 6. Validation và conditions

Validation rules chạy server-side trước writes và cũng hỗ trợ Studio validation:

- Built-ins: `required`, `regex`, `minLength`, `maxLength`, `min`, `max`, `enum`, `unique`, `filesize`, `mime`, `email`, `url`.
- Expression rule: `{ "type": "expression", "expr": "$count(value) <= 5" }`.

Conditions dùng item context để override field state:

```json
{ "rule": "$.status == 'published'", "set": { "required": true, "readonly": true } }
```

Condition output có thể override `required`, `readonly`, `hidden`, hoặc `options`.

## 7. Encryption và versioning

`encrypted: true` yêu cầu item service mã hóa field trước khi lưu. Read permission quyết định caller nhận decrypted value hay masked value. Vì typegen không biết permission runtime, encrypted string-like fields được emit thành `T | '***'` cộng nullability.

`versioned: true` ghi delta cấp field vào `revisions` khi field đổi. Field không versioned bị bỏ khỏi revision delta để giảm nhiễu và tiết kiệm storage.

## 8. Relation fields

Relations lưu trong bảng `relations` và có thể annotate field bằng `kind` và `target` trong typegen manifest.

- `m2o`: many-side field lưu primary key của target. Generated base types dùng branded ID của target khi có thể.
- `o2m` và `m2m`: generated expanded types expose array target items.
- `m2a`: reserved cho many-to-any và emit `Array<{ collection: string; item: unknown }>` đến khi có collection union cụ thể.

Generated base collection interfaces biểu diễn stored values. Generated `CollectionExpanded` types thay relation fields bằng object expanded shape.

## 9. Risky field mutations

Schema service phân loại risky field mutations trước apply:

- Rename: dùng `renameFrom` và giữ nguyên `type`/`interface` hiện tại trong SDK rename helper.
- Đổi type khi đã có data: cần `migrationPlan` và `confirmRiskyChange`.
- Xóa field khi đã có data: cần destructive path rõ ràng. SDK nhận delete options như `confirmRiskyChange`, `migrationPlan`, `force`, `backupToRevisions`.

Schema diff trả `risk` và `runtimeImpact` để Studio/automation yêu cầu xác nhận trước thay đổi phá hủy.

## 10. Raw mode

Field có `rawEnabled !== false` có thể edit bằng raw mode. Interfaces nên expose behavior `toRaw(value)` và `fromRaw(raw)` an toàn, fallback mặc định là JSON stringify/parse. Field Inspector giữ unknown JSON options để build Studio cũ không xóa config mới.
