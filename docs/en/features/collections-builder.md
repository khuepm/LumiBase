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

## 4. Storage modes and limitation badges

Every collection has a `storageMode`. Studio shows the mode as a badge in the collection wizard and keeps the tradeoff visible before authors create or migrate a model.

| Mode | Studio badge | Current behavior | Limitations |
|---|---|---|---|
| `jsonb` | Current | Default virtual collection. Items live in the shared `items.data` JSONB document, so schema changes do not run DDL. | SQL-native unique/index constraints are advisory unless a materialized or physical projection exists. Integer primary keys are blocked in this mode. |
| `materialized` | Optimized | JSONB remains the source of truth while a managed physical projection can serve hot read paths. | Projection freshness, refresh strategy, and indexes must be managed; writes still go through the logical collection. |
| `physical` | Future | Reserved for Directus-like managed physical tables. Schema diff marks this as a storage runtime change. | Not implemented as a general DDL migration engine yet. Requires tenant-safe table naming, rollback, relation/index DDL, and online migration planning. |
| `external` | Future | Reserved for introspected external tables. | Not implemented for writes. Destructive relation actions and DDL must remain limited because LumiBase does not own the table. |

Do not present `jsonb` as equivalent to Directus physical tables. The product promise is faster evolution first, with materialized projections for performance and a future physical/external decision tracked in `docs/en/architecture/physical-collections.md`.

## 5. AI Suggest (tuỳ chọn, Phase 2)

- Nút "AI suggest fields" → gọi Workers AI với prompt `"Create fields for: <description>"`, trả về proposal JSON, user accept từng field.

## 6. Validation khi save

- Tên collection: snake_case, 1-63 ký tự, không trùng (per site).
- Field name unique trong collection.
- Không xoá field còn data trừ khi tick "force + backup to revisions".
- Thay đổi `type` breaking → yêu cầu chiến lược migrate (cast / drop / keep-raw).

## 7. UI components (Studio)

- `CollectionListPage` — bảng collections + search/filter, icon, count items.
- `CollectionDetailPage` — tabs nói trên, layout 2 cột (canvas + inspector).
- `FieldInspector` — right drawer, theo interface render form options.
- `JsonDiffDialog` — render diff trước apply.
- `WizardModal` — onboarding.

## 8. Edge cases

- Singleton: ẩn list view, mở thẳng item duy nhất.
- Collection có >200 fields: virtualize danh sách.
- Khi đổi `archiveField`, kiểm tra dữ liệu hiện hữu.

## 9. Tasks (xem `roadmap/tasks.md` phase MVP-B)
