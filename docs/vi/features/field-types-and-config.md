# Field Types & Configuration

> LumiBase coi field là **đối tượng cấu hình bậc nhất**. Mỗi field có 4 lớp config độc lập: `type` (lưu trữ), `interface` (cách edit), `display` (cách hiển thị), `validation` (rule).

## 1. Type catalogue (storage-level)

| Type | DB | Ghi chú |
|---|---|---|
| `string` | text | có `maxLength` |
| `text` | text | dài, no length |
| `integer` / `bigInteger` | int4/int8 |
| `decimal` | numeric(p,s) |
| `boolean` | boolean |
| `json` | jsonb |
| `uuid` | uuid |
| `date` / `datetime` / `time` / `timestamp` | tương ứng |
| `csv` | text (CSV serialized) |
| `hash` | text (one-way) |
| `geometry` | jsonb (GeoJSON) |
| `alias` | virtual | dùng cho M2O/O2M/M2M/M2A, group, presentation |

## 2. Interface registry

Mỗi interface có:
```ts
interface FieldInterface<TOptions> {
  id: string;            // 'input', 'wysiwyg', 'select-dropdown', 'relation-m2m', 'code', 'json-raw', 'file-image', 'datetime', ...
  types: FieldType[];    // các type tương thích
  optionsSchema: ZodSchema<TOptions>;
  Component: React.FC<{ value; onChange; options: TOptions; field }>; 
  // raw fallback
  supportsRaw: true;
}
```

Danh sách interface MVP:
- Text: `input` ✅, `input-multiline` ✅, `wysiwyg` ✅, `markdown` ✅, `code` (monaco) ✅, `slug` ✅, `color` ✅.
- Number: `input-number` ✅, `slider` ⏳, `rating` ✅.
- Choice: `select-dropdown` ✅, `select-radio` ⏳, `select-checkbox` ⏳, `tags` ✅.
- Boolean: `toggle` ✅.
- Date: `datetime` ✅, `date-range` ⏳.
- Relation: `relation-m2o` ✅, `relation-o2m` ✅, `relation-m2m` ✅, `relation-m2a` ⏳, `relation-tree` ⏳.
- File: `file` ✅, `file-image` ⏳ (covered by `file`), `file-multiple` ⏳.
- Special: `json-raw` ✅, `geometry-map` ⏳, `repeater` ✅, `presentation-divider` ✅, `presentation-notice` ✅.

> Source of truth: `apps/studio/src/modules/content/interfaces/registry.tsx`.
> Authors pick interfaces from the **Field inspector** (Data Model → Collection → Fields → Add/Edit field).

## 3. Display registry

| Display | Implemented | File |
|---|---|---|
| `formatted-value` | ✅ Phase B | `displays/formatted-value.tsx` |
| `raw` | ✅ Phase B | `displays/raw.tsx` |
| `boolean-icon` | ✅ Phase A | `displays/boolean-icon.tsx` |
| `datetime` (alias of `formatted-date`) | ✅ Phase A | `displays/formatted-date.tsx` |
| `image` | ✅ Phase B | `displays/image.tsx` |
| `labels` | ✅ Phase B | `displays/labels.tsx` |
| `relation-related-values` | ✅ via `relation` | `displays/relation.tsx` |
| `mustache-template` (alias of `mustache`) | ✅ Phase B | `displays/mustache.tsx` |
| `badge` | ✅ Phase A | `displays/badge.tsx` |
| `color-swatch` | ✅ Phase A | `displays/color-swatch.tsx` |
| `rating-stars` | ✅ Phase A | `displays/rating-stars.tsx` |
| `tags-pills` | ✅ Phase A | `displays/tags-pills.tsx` |

- Display cho relation hỗ trợ **mustache** sử dụng `displayTemplate` của collection liên quan.
- Authors edit `displayTemplate` qua **Display tab** của collection (Mustache template editor có
  autocomplete + live preview, file: `modules/content/mustache-template-editor.tsx`).
- `display` và `displayOptions` lưu ở top-level columns của bảng `fields` (xem `packages/database/src/schema/cms.ts`).

## 4. Per-field configuration

JSON định nghĩa field:
```json
{
  "name": "cover",
  "type": "uuid",
  "interface": "file-image",
  "display": "image",
  "options": {
    "folder": "covers",
    "crop": true,
    "aspectRatio": "16:9"
  },
  "displayOptions": { "size": "medium", "rounded": true },
  "validation": {
    "rules": [
      { "type": "required" },
      { "type": "filesize", "max": "5MB" },
      { "type": "mime", "allow": ["image/png","image/jpeg","image/webp"] }
    ]
  },
  "conditions": [
    { "rule": "$.status == 'published'", "set": { "required": true } }
  ],
  "translations": {
    "en": { "label": "Cover", "help": "16:9 image" },
    "vi": { "label": "Ảnh bìa", "help": "Ảnh 16:9" }
  },
  "encrypted": false,
  "versioned": true,
  "rawEnabled": true,
  "width": "full",
  "group": "media"
}
```

### 4.1 Validation DSL
- Built-in rules: `required`, `regex`, `minLength`, `maxLength`, `min`, `max`, `enum`, `unique`, `filesize`, `mime`, `email`, `url`.
- Custom: `{ "type": "expression", "expr": "$count(value) <= 5" }` — chạy JSONata server-side & client-side.

### 4.2 Conditions DSL
- `rule` là biểu thức JSONata trên item context (`$`).
- `set` ghi đè `required`/`readonly`/`hidden`/`options`.

### 4.3 Per-field encryption
- `encrypted: true` → server mã hoá trước khi lưu (AES-GCM, key per site trong Workers Secret), giải mã khi đọc (nếu permission cho phép); raw editor sẽ hiển thị `***` trừ khi có quyền `read:decrypted`.

### 4.4 Per-field versioning
- `versioned: true` → ghi delta vào `revisions` mỗi lần thay đổi field này. Field không bật sẽ bỏ qua để tiết kiệm.

## 5. Advanced Content Features & Raw mode

Các tính năng nâng cao đã được tích hợp trong Studio Content:
- **Raw Toggle Per Field**: Người dùng có thể chuyển đổi linh hoạt giữa giao diện component trực quan và Monaco Editor (raw JSON) trên từng field. Trạng thái edit được bảo lưu kể cả khi JSON invalid.
- **Bulk Raw Editor**: Cho phép chọn hàng loạt items từ danh sách và chỉnh sửa trực tiếp raw JSON của chúng cùng lúc. Tích hợp tính năng validate trước khi lưu.
- **Revisions Diff Viewer**: Công cụ so sánh trực quan `delta.before` và `delta.after` của revisions. Hỗ trợ hiển thị highlight thay đổi, lọc hiển thị và chuyển đổi qua lại với chế độ raw.

**Raw mode contract:**
- Mọi field `rawEnabled !== false` đều render được ở chế độ Raw (xem `raw-data-editing.md`).
- Interface phải expose hàm `toRaw(value)` và `fromRaw(raw)` để chuyển đổi an toàn (mặc định JSON.stringify/parse).

## 6. Server-side responsibilities

- `SchemaService` cache "compiled field" (zod + JSONata pre-parsed) trong KV.
- `ItemService` chạy validation trước insert/update, áp `conditions`, mã hoá field flagged.

## 7. Tasks: xem `roadmap/tasks.md` Phase MVP-B & B2.
