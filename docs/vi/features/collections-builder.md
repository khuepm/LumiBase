---
title: Trình tạo Collection (No-code)
---

# Trình tạo Collection (No-code)

> Mục tiêu: builder dễ dùng hơn Directus, hỗ trợ **kéo-thả sắp xếp lại**, **xem trước JSON trực tiếp**, **diff trước khi lưu**, **AI gợi ý field**.

## 1. Luồng người dùng

1. **Tạo collection**
   - Wizard 3 bước: *Metadata* (tên, singleton, icon, màu) → *Gợi ý Fields* (template: bài viết blog, sản phẩm, …) → *Phân quyền mặc định*.
   - Cho phép bỏ qua wizard và chọn "Bắt đầu trống".
2. **Sửa collection**
   - Tab: *Fields & Layout*, *Phân quyền*, *Display Template*, *Lưu trữ & Sắp xếp*, *Versioning*, *Realtime*, *Raw JSON*.
3. **Xoá / lưu trữ collection**: soft delete + cảnh báo nếu có quan hệ (relation).

## 2. Trình chỉnh sửa Fields & Layout

- Layout grid 12 cột, mỗi field có `width: half|full|fill`.
- Kéo-thả sắp xếp nhóm (group) và thứ tự field.
- Chỉnh sửa inline `label`, `name`, `required`, `readonly`.
- Panel bên cấu hình chi tiết (xem `field-types-and-config.md`).
- "Chèn từ template" — chèn nhóm field mẫu (SEO, Kiểm toán, Timestamps).
- **Khung JSON trực tiếp** (toggle): hiển thị schema collection ↔ form, chỉnh JSON cũng cập nhật UI.

## 3. Raw JSON & Nhập/Xuất

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
- `Xuất lựa chọn`: nhiều collection thành một bundle JSON/YAML để commit vào Git (Config-as-Code).
- `Diff & Áp dụng`: so sánh schema hiện tại với file import, hiển thị thay đổi (thêm/xoá/sửa), yêu cầu xác nhận trước khi migrate.

## 4. Storage modes và limitation badge

Mỗi collection có `storageMode`. Studio hiển thị mode dưới dạng badge trong wizard tạo collection và giữ tradeoff hiển thị trước khi tác giả tạo hoặc migrate model.

| Mode | Badge trong Studio | Hành vi hiện tại | Giới hạn |
|---|---|---|---|
| `jsonb` | Current | Collection ảo mặc định. Item nằm trong document JSONB `items.data`, nên đổi schema không chạy DDL. | Unique/index theo SQL-native chỉ là advisory nếu chưa có materialized hoặc physical projection. Integer primary key bị chặn ở mode này. |
| `materialized` | Optimized | JSONB vẫn là source of truth, kèm physical projection được quản lý cho hot read path. | Cần quản lý độ mới của projection, refresh strategy và indexes; write vẫn đi qua logical collection. |
| `physical` | Future | Dành cho bảng vật lý kiểu Directus. Schema diff đánh dấu đây là storage runtime change. | Chưa có DDL migration engine tổng quát. Cần tenant-safe table naming, rollback, relation/index DDL và kế hoạch online migration. |
| `external` | Future | Dành cho bảng ngoài được introspect. | Chưa hỗ trợ write. DDL và relation action phá huỷ phải bị giới hạn vì LumiBase không sở hữu table. |

Không trình bày `jsonb` như tương đương bảng vật lý của Directus. Định vị sản phẩm hiện tại là đổi schema nhanh trước, dùng materialized projection cho hiệu năng, còn quyết định physical/external được theo dõi trong `docs/en/architecture/physical-collections.md`.

## 5. Gợi ý AI (tuỳ chọn, Phase 2)

- Nút "AI gợi ý fields" → gọi Workers AI với prompt `"Tạo fields cho: <mô tả>"`, trả về JSON đề xuất, người dùng chấp nhận từng field.

## 6. Kiểm tra hợp lệ khi lưu

- Tên collection: snake_case, 1-63 ký tự, không được trùng (theo site).
- Tên field phải duy nhất trong collection.
- Không xoá field còn dữ liệu trừ khi chọn "bắt buộc + sao lưu vào revisions".
- Thay đổi `type` gây breaking → yêu cầu chiến lược migrate (ép kiểu / xoá / giữ nguyên raw).

## 7. Các thành phần UI (Studio)

- `CollectionListPage` — bảng collections + tìm kiếm/lọc, icon, số lượng items.
- `CollectionDetailPage` — các tab nêu trên, layout 2 cột (canvas + inspector).
- `FieldInspector` — drawer phải, render form tùy chọn theo interface.
- `JsonDiffDialog` — hiển thị diff trước khi áp dụng.
- `WizardModal` — hướng dẫn khởi tạo.

## 8. Trường hợp biên (Edge cases)

- Singleton: ẩn chế độ xem danh sách, mở thẳng item duy nhất.
- Collection có >200 fields: ảo hoá danh sách (virtualize).
- Khi đổi `archiveField`, kiểm tra dữ liệu hiện hữu.

## 9. Công việc (xem `roadmap/tasks.md` phase MVP-B)
