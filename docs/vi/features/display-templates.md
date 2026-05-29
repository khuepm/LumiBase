# Display Templates

> Display Template = quy tắc để render một item thành chuỗi hoặc component, dùng trong list view, relation picker, detail header, breadcrumb.

## 1. Hai cấp template

### 1.1 Mustache (simple, mặc định)
- Lưu ở `collections.displayTemplate`: ví dụ `"{{title}} — {{status | upper}}"`.
- Filter built-in: `upper`, `lower`, `date('YYYY-MM-DD')`, `truncate(50)`, `default('—')`.
- Có thể tham chiếu nested: `{{author.first_name}} {{author.last_name}}` (auto join nếu có relation).

### 1.2 Component template (advanced, USP)
- Lưu JSON DSL:
```json
{
  "kind": "component-template",
  "template": [
    { "if": "$.cover", "render": { "type": "Image", "src": "$.cover.url", "size": "sm" } },
    { "render": { "type": "Stack", "direction": "col", "children": [
      { "type": "Text", "value": "$.title", "variant": "title" },
      { "type": "Row", "children": [
        { "type": "Badge", "value": "$.status", "variant": "$status_variant" },
        { "type": "Text", "value": "by {{author.full_name}}", "muted": true }
      ]}
    ]}}
  ]
}
```
- Renderer client-side dùng CVA tokens (`packages/ui`).
- Conditions dùng JSONata.

## 2. Nơi dùng

- **List view tabular**: cell template per column (override display).
- **Cards/Kanban layout**: card template = component template.
- **Detail header**: optional template thay tiêu đề mặc định.
- **Relation picker**: hiển thị item liên quan.
- **Delivery API**: trả thêm field `__display` nếu request `?fields=*,__display`.

## 3. UI editor

- Trong Collection settings → tab **Display Template**:
  - Mustache mode: textarea với autocomplete tên field + filter.
  - Component mode: GUI block-based editor (drag block, set bindings) + JSON tab.
- Live preview với 3 item mẫu (first/last/random).

## 4. Server-side render

- Endpoint `POST /utils/render-template` body `{ template, items }` → trả mảng `__display`.
- Cache theo `(siteId, collectionId, templateHash, itemId, updatedAt)`.

## 5. Bảo mật

- Template chỉ truy cập field user có quyền read; field bị mask → render `default` filter.

## 6. Tasks: Phase MVP-B (mustache) + POST-MVP-F (component DSL).
