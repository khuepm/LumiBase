# Studio Content Module — Slice Tracking

> Mô-đun Content trong LumiBase Studio quản lý dữ liệu động cho một collection duy nhất. Development được chia thành các "slices" (phát triển tăng dần, mỗi slice xây dựng trên slice trước).

## Tổng quan

| Slice | Mô tả | Trạng thái | Files chính |
|-------|-------|------------|-------------|
| 1 | SDK items API + Content module list view | ✅ Done | `packages/sdk/src/`, `apps/studio/src/modules/content/items-list.tsx` |
| 2 | Detail editor shell + Revisions tab + Raw JSON tab | ✅ Done | `apps/studio/src/modules/content/item-detail.tsx`, `revisions-panel.tsx`, `raw-json-panel.tsx` |
| 3 | Interface registry phần 1 (text, number, toggle, select, datetime, json-raw) | ✅ Done | `apps/studio/src/modules/content/interfaces/` |
| 4 | Interface registry phần 2 (relation, code, wysiwyg, markdown, file, repeater, presentation) | ✅ Done | `apps/studio/src/modules/content/interfaces/` |
| 5 | Display registry + Raw toggle + Bulk raw editor | ✅ Done | `apps/studio/src/modules/content/displays/`, `bulk-raw-editor.tsx`, `raw-toggle.tsx` |
| 6 | Revisions diff viewer + Mustache display | ✅ Done | `apps/studio/src/modules/content/revisions-diff.tsx`, `displays/mustache.tsx` |
| 7 | Cập nhật docs/features/field-types-and-config.md | ✅ Done | `docs/features/field-types-and-config.md` |

---

## Slice 1 — SDK items API + Content module list view

**Mục tiêu:** Thiết lập SDK items API và view danh sách content.

### SDK items API
- **File:** `packages/sdk/src/client.ts`
- **APIs:**
  - `listItems(siteId, collectionId, options)` — danh sách items với filter/sort/pagination
  - `getItem(siteId, collectionId, itemId)` — chi tiết item
  - `createItem(siteId, collectionId, data)` — tạo item mới
  - `updateItem(siteId, collectionId, itemId, data)` — cập nhật item
  - `deleteItem(siteId, collectionId, itemId)` — xoá item
  - `listFields(siteId, collectionId)` — danh sách fields của collection

### Content module list view
- **File:** `apps/studio/src/modules/content/items-list.tsx`
- **Features:**
  - Tabular view của items
  - Filter, sort, pagination
  - Click row → navigate đến detail editor
  - PAGE_SIZE = 25

---

## Slice 2 — Detail editor shell + Revisions tab + Raw JSON tab

**Mục tiêu:** Xây dựng shell cho detail editor với 3 tab: Fields, Revisions, Raw JSON.

### Item detail editor
- **File:** `apps/studio/src/modules/content/item-detail.tsx`
- **Tabs:**
  - **FieldsTab:** Form edit các field (sẽ được wire vào interface registry ở slice 3+)
  - **RevisionsTab:** Danh sách revisions với khả năng revert
  - **RawJsonTab:** Xem/edit raw JSON của item

### Revisions panel
- **File:** `apps/studio/src/modules/content/revisions-panel.tsx`
- **Features:**
  - List revisions (từ SDK: `listRevisions()`)
  - Hiển thị delta JSON (before/after)
  - Nút revert về revision cũ
  - Diff viewer (sẽ được thêm ở slice 6)

### Raw JSON panel
- **File:** `apps/studio/src/modules/content/raw-json-panel.tsx`
- **Features:**
  - Monaco Editor để xem/edit raw JSON
  - Validate JSON trước khi save
  - Sync với FieldsTab

---

## Slice 3 — Interface registry phần 1

**Mục tiêu:** Xây dựng interface registry và implement các interface cơ bản.

### Interface registry
- **File:** `apps/studio/src/modules/content/interfaces/registry.tsx`
- **Contract:** `InterfaceComponent<T>` nhận `{ value, onChange, field }`
- **Helper:** `readOptions<T>(field)` đọc options từ `field.meta.options`

### Interfaces implement (Phase A + Phase B slice 3)
| Interface | File | Description |
|-----------|------|-------------|
| `input` | `text.tsx` | Text input cơ bản |
| `input-multiline` | `text.tsx` | Textarea |
| `toggle` | `toggle.tsx` | Boolean toggle |
| `select-dropdown` | `select.tsx` | Select dropdown với options |
| `datetime` | `datetime.tsx` | Date/time picker |
| `json-raw` | `json-raw.tsx` | Monaco Editor cho JSON |
| `input-number` | `number.tsx` | Number input |
| `slug` | `slug.tsx` | Slug field với auto-generate |
| `color` | `color.tsx` | Color picker |
| `rating` | `rating.tsx` | Star rating |
| `tags` | `tags.tsx` | Tag input với autocomplete |

---

## Slice 4 — Interface registry phần 2

**Mục tiêu:** Implement các interface phức tạp hơn: relation, code, wysiwyg, markdown, file, repeater, presentation.

### Interfaces implement (Phase B slice 4)
| Interface | File | Description |
|-----------|------|-------------|
| `relation-m2o` | `relation-m2o.tsx` | Many-to-one relation selector |
| `relation-o2m` | `relation-many.tsx` | One-to-many relation list |
| `relation-m2m` | `relation-many.tsx` | Many-to-many relation list |
| `code` | `code.tsx` | Code editor (Monaco) |
| `wysiwyg` | `wysiwyg.tsx` | Rich text editor (document.execCommand) |
| `markdown` | `markdown.tsx` | Markdown editor với preview |
| `file` | `file.tsx` | File upload (drag-and-drop, placeholder URL: `lumibase://pending/<name>`) |
| `repeater` | `repeater.tsx` | Repeater field với drag-and-drop (dnd-kit) |
| `presentation-divider` | `presentation.tsx` | Divider UI (read-only) |
| `presentation-notice` | `presentation.tsx` | Notice UI (read-only) |

**Lưu ý:** File interface chỉ stub UI, không thực hiện upload thật. TODO: `phase-e/storage`

---

## Slice 5 — Display registry + Raw toggle + Bulk raw editor

**Mục tiêu:** Xây dựng display registry cho list view, raw toggle per field, và bulk raw editor.

### Display registry
- **File:** `apps/studio/src/modules/content/displays/registry.tsx`
- **Contract:** `DisplayProps<T>` nhận `{ value, field, row? }`
- **Purpose:** Render field values trong list view (read-only, stateless)

### Displays implement
| Display | File | Description |
|---------|------|-------------|
| `formatted-value` | `text.tsx` | Text display cơ bản |
| `boolean-icon` | `boolean-icon.tsx` | Icon cho boolean |
| `badge` | `badge.tsx` | Badge cho enum/status |
| `relation-related-values` | `relation.tsx` | Hiển thị related item values |
| `datetime` | `formatted-date.tsx` | Date/time formatted |
| `color-swatch` | `color-swatch.tsx` | Color swatch |
| `rating-stars` | `rating-stars.tsx` | Star rating display |
| `labels` | `tags-pills.tsx` | Tags pills |
| `mustache-template` | `mustache.tsx` (slice 6) | Mustache template interpolation |

### Raw toggle per field
- **File:** `apps/studio/src/modules/content/interfaces/raw-toggle.tsx`
- **Features:**
  - Toggle giữa interface component và Monaco Editor (raw JSON)
  - Preserve user edits ngay cả khi JSON invalid
  - Wire vào FieldsTab của item-detail

### Bulk raw editor
- **File:** `apps/studio/src/modules/content/bulk-raw-editor.tsx`
- **Features:**
  - Select multiple items từ list view
  - Edit raw JSON của tất cả selected items cùng lúc
  - Validate JSON trước khi save
  - Wire vào items-list với "Edit raw (N)" button

---

## Slice 6 — Revisions diff viewer + Mustache display

**Mục tiêu:** Implement diff viewer cho revisions và mustache display template.

### Revisions diff viewer
- **File:** `apps/studio/src/modules/content/revisions-diff.tsx`
- **Features:**
  - So sánh `delta.before` và `delta.after` của revision
  - Highlight thay đổi (added/removed/modified)
  - Toggle giữa diff view và raw JSON
  - Filter "Show unchanged"
  - Wire vào RevisionsPanel

### Mustache display
- **File:** `apps/studio/src/modules/content/displays/mustache.tsx`
- **Features:**
  - Mustache template interpolation sử dụng `field.meta.displayTemplate`
  - Truy cập sibling fields thông qua `row` prop
  - Wire vào display registry

---

## Slice 7 — Cập nhật docs/features/field-types-and-config.md

**Mục tiêu:** Cập nhật documentation để reflect những gì đã implement.

### Tasks
- [x] Cập nhật danh sách interface thực tế (đã implement)
- [x] Cập nhật danh sách display thực tế (đã implement)
- [x] Thêm note về raw toggle, bulk raw editor, diff viewer
- [x] Sync với code hiện tại

---

## Dependencies & Tech Stack

- **React + Vite** — Frontend framework
- **@tanstack/react-query** — Data fetching & caching
- **@monaco-editor/react** — Code editor (JSON, code interface)
- **@lumibase/sdk** — Workspace dependency cho API
- **dnd-kit** — Drag-and-drop cho repeater
- **Tailwind CSS** — Styling
- **Mustache.js** — Template interpolation (mustache display)

---

## Nguồn slice definitions

Các slice definitions không có trong task docs (`docs/roadmap/tasks.md` chỉ có phases). Slice definitions được tạo bởi AI assistant dựa trên:
1. Yêu cầu thực tế của LumiBase Studio
2. Best practices cho incremental development
3. Tách biệt rõ ràng giữa: SDK → UI shell → Interface registry → Display registry → Advanced features

**Reference:** Design spec tại `docs/features/field-types-and-config.md`
