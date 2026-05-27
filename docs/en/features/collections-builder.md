# Collections Builder (No-code)

> Mục tiêu: builder dễ dùng hơn Directus, hỗ trợ **drag-drop reorder**, **JSON live preview**, **diff trước khi save**, **AI suggest field**.

## 1. User flows

1. **Tạo collection**
   - Wizard 3 bước: *Metadata* (name, singleton, icon, color) → *Fields gợi ý* (template: blog post, product, …) → *Permissions defaults*.
   - Cho phép skip wizard và "Start blank".
2. **Sửa collection**
   - Tab: *Fields & Layout*, *Permissions*, *Display Template*, *Archive & Sort*, *Versioning*, *Realtime*, *Raw JSON*.
3. **Xoá / archive collection**: soft delete + cảnh báo nếu có relation.

## 2. Fields & Layout editor

- Layout grid 12 cột, mỗi field có `width: half|full|fill`.
- Drag-drop sắp xếp nhóm (group) và thứ tự field.
- Inline edit `label`, `name`, `required`, `readonly`.
- Side panel cấu hình chi tiết (xem `field-types-and-config.md`).
- "Insert from template" — chèn nhóm field mẫu (SEO, Audit, Timestamps).
- **Live JSON pane** (toggle): hiển thị schema collection ↔ form, edit JSON cũng cập nhật UI.

## 3. Raw JSON & Import/Export

- Endpoint `GET/PUT /collections/:id/schema` trả/nhận JSON chuẩn:
```json
{
  "name": "posts",
  "displayTemplate": "{{title}} — {{status}}",
  "fields": [
    { "name": "title", "type": "string", "interface": "input", "required": true, "width": "full" },
    { "name": "body", "type": "text", "interface": "wysiwyg", "options": { "toolbar": ["bold","link","image"] } }
  ],
  "relations": []
}
```
- `Export selection`: nhiều collection thành một bundle JSON/YAML để commit vào Git (Config-as-Code).
- `Diff & Apply`: so sánh schema hiện tại với file import, hiển thị thay đổi (add/remove/alter), yêu cầu confirm trước migrate.

## 4. AI Suggest (tuỳ chọn, Phase 2)

- Nút "AI suggest fields" → gọi Workers AI với prompt `"Create fields for: <description>"`, trả về proposal JSON, user accept từng field.

## 5. Validation khi save

- Tên collection: snake_case, 1-63 ký tự, không trùng (per site).
- Field name unique trong collection.
- Không xoá field còn data trừ khi tick "force + backup to revisions".
- Thay đổi `type` breaking → yêu cầu chiến lược migrate (cast / drop / keep-raw).

## 6. UI components (Studio)

- `CollectionListPage` — bảng collections + search/filter, icon, count items.
- `CollectionDetailPage` — tabs nói trên, layout 2 cột (canvas + inspector).
- `FieldInspector` — right drawer, theo interface render form options.
- `JsonDiffDialog` — render diff trước apply.
- `WizardModal` — onboarding.

## 7. Edge cases

- Singleton: ẩn list view, mở thẳng item duy nhất.
- Collection có >200 fields: virtualize danh sách.
- Khi đổi `archiveField`, kiểm tra dữ liệu hiện hữu.

## 8. Tasks (xem `roadmap/tasks.md` phase MVP-B)
