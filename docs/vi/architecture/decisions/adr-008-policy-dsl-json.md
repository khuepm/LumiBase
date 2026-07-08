---
version: 1
lastUpdated: 2026-07-05T10:56:37.235Z
sourceLang: en
translatedFrom: en
sourceHash: c8336d583f99789d
mtEngine: claude
syncStatus: machine-translated
---

# ADR-008: JSON Policy DSL cho Phân quyền

**Date:** 2024-02-15
**Status:** Accepted

## Context

LumiBase cần một hệ thống phân quyền hỗ trợ:

1. **Kiểm soát truy cập cấp field** — một role có thể đọc `articles.title` nhưng không đọc được `articles.secret_notes`
2. **Quy tắc có điều kiện** — một role chỉ có thể đọc các item có `status = 'published'` hoặc `author = $currentUser.id`
3. **Config-as-Code** — quy tắc phân quyền nên xuất được ra JSON/YAML và nhập được vào một môi trường mới (GitOps)
4. **Đánh giá được ở tầng API** — không chỉ ở DB qua row-level security (RLS), vì LumiBase phục vụ các collection động với một tầng item tổng quát
5. **Có thể audit và dễ đọc** — các kiểm toán viên bảo mật cần xem lại quy tắc mà không cần hiểu mã nguồn

Các phương án đã cân nhắc:
- **OPA/Rego** — mạnh mẽ nhưng phức tạp, thêm phụ thuộc bên ngoài, không dễ tuần tự hóa thành config JSON
- **Casbin** — mục đích tổng quát nhưng hỗ trợ cấp field hạn chế; không phải policy JSON native
- **Attribute-Based Access Control (ABAC) trong code** — linh hoạt nhưng không xuất/nhập được nếu không có tuần tự hóa tùy chỉnh
- **JSON DSL tùy chỉnh** — kiểm soát hoàn toàn, tuần tự hóa được, có thể lưu trong DB và xuất ra

## Decision

Hiện thực một **JSON Policy DSL tùy chỉnh** lưu trong các bảng `policies` → `permissions`.

Hình dạng một quy tắc phân quyền:

```typescript
type PermissionRule = {
  collection: string           // "*" for any collection
  action: 'create' | 'read' | 'update' | 'delete' | '*'
  fields?: string[]           // undefined = all fields; ["id","title"] = specific fields
  conditions?: FilterQuery    // same filter operators as the API query params
}
```

Ví dụ một policy cấp cho content editor quyền đọc các bài viết đã xuất bản:

```json
{
  "name": "content-editor-read",
  "permissions": [
    {
      "collection": "articles",
      "action": "read",
      "fields": ["id", "title", "content", "status", "author"],
      "conditions": { "status": { "_eq": "published" } }
    }
  ]
}
```

Method `PermissionService.evaluate(user, action, collection, item?)`:
1. Nạp các role của người dùng và các policy đính kèm (cache với tag `perm:{siteId}:{roleId}`)
2. Tìm các quy tắc phân quyền khớp với cặp `(action, collection)`
3. Gộp các mặt nạ field (hợp của mọi field được phép qua các quy tắc khớp)
4. Đánh giá các điều kiện dựa trên dữ liệu item (cho `read`/`update`/`delete` trên các item cụ thể)

Cú pháp `conditions` giống hệt cú pháp filter của API — tái dùng chính bộ đánh giá dựa trên JSONata.

## Consequences

**Tích cực:**
- Tuần tự hóa hoàn toàn thành JSON — xuất/nhập hoạt động native với Config-as-Code
- Dễ đọc và audit được mà không cần kiến thức về code
- Kiểm soát cấp field là hạng nhất, không phải bổ sung về sau
- Cú pháp điều kiện tái dùng cú pháp filter của API — chỉ một bộ đánh giá phải bảo trì
- Policy lưu trong DB → quản lý được qua Studio UI và API mà không cần redeploy

**Tiêu cực:**
- DSL tùy chỉnh nghĩa là lỗi tùy chỉnh — bộ đánh giá phải được kiểm thử kỹ lưỡng (xem `src/services/__tests__/permission-dsl.test.ts`)
- Logic phân quyền phức tạp (ví dụ "chỉ cho phép cập nhật nếu item được tạo bởi người dùng hiện tại VÀ là ngày trong tuần") đòi hỏi thiết kế biểu đạt DSL cẩn thận
- Không có giải quyết xung đột policy tích hợp sẵn — các quy tắc chồng lấn được gộp theo hợp (quy tắc nới lỏng nhất thắng), điều này có thể gây bất ngờ cho admin mong đợi ngữ nghĩa deny-overrides-allow

**Trung tính:**
- Một endpoint debug `POST /api/v1/permissions/check` được cung cấp để admin kiểm thử việc đánh giá quy tắc mà không phải đi qua toàn bộ chu trình request
