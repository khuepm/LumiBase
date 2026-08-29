---
version: 1
lastUpdated: 2026-08-02T19:08:11.984Z
sourceLang: en
translatedFrom: en
sourceHash: 96605efe226fc3ad
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-08-02T19:08:11.984Z
codeVerifiedHash: 96605efe226fc3ad
codeVerifiedClaims: 2
---

# Hướng dẫn kiểm thử Insecure Direct Object References (IDOR)

## Tổng quan
Tài liệu này nêu hướng dẫn kiểm thử để ngăn Insecure Direct Object References (IDOR) trong LumiBase. IDOR xảy ra khi ứng dụng cho phép truy cập trực tiếp vào đối tượng dựa trên input do người dùng cung cấp. Hệ quả là kẻ tấn công có thể bỏ qua phân quyền và truy cập thẳng vào tài nguyên trong hệ thống, ví dụ bản ghi database hoặc file.

Trong LumiBase, việc bảo đảm cô lập tenant nghiêm ngặt là tối quan trọng. Dữ liệu thuộc một tenant (site) TUYỆT ĐỐI không được để người dùng của tenant khác truy cập hay sửa đổi, kể cả khi họ biết hoặc đoán được ID nội bộ.

## Phạm vi
*   **Collection mục tiêu:** Mọi bảng/collection built-in có tiền tố `lumibase_`. (Lưu ý: collection tùy chỉnh do người dùng tạo có hệ thống phân quyền riêng dựa trên role/policy).
*   **Endpoint mục tiêu:** Chủ yếu là các endpoint CRUD dưới `/items`, gồm cả thao tác đơn lẻ và hàng loạt (bulk).

## Nguyên tắc cốt lõi
1.  **Cô lập tenant:** Người dùng đã xác thực trong Tenant A (`X-Lumi-Site: tenant-a`) phải nhận `403 Forbidden` hoặc `404 Not Found` khi cố truy cập hoặc sửa bản ghi thuộc Tenant B (`X-Lumi-Site: tenant-b`).
2.  **Kiểm tra phân quyền:** Mọi endpoint nhận một ID phải xác minh tài nguyên được yêu cầu thuộc về tenant context hiện tại *trước khi* thực hiện bất kỳ thao tác nào.

## Kịch bản kiểm thử

Các kịch bản sau phải được phủ trong bộ test tự động (`apps/cms/src/__tests__/idor-tenant-isolation.integration.test.ts`):

### 1. Thao tác trên một item
*   **GET `/:collection/:id`**: Thử lấy một bản ghi thuộc tenant khác.
*   **PATCH `/:collection/:id`**: Thử cập nhật một bản ghi thuộc tenant khác.
*   **DELETE `/:collection/:id`**: Thử xóa một bản ghi thuộc tenant khác.

### 2. Thao tác hàng loạt (bulk)
*   **POST `/:collection/bulk`**:
    *   Thử cập nhật một lô bản ghi trong đó một phần hoặc toàn bộ thuộc tenant khác.
    *   Thử xóa một lô bản ghi trong đó một phần hoặc toàn bộ thuộc tenant khác.
    *   *Rủi ro:* Lặp qua danh sách cập nhật mà không xác minh quyền sở hữu tenant cho *từng* item.

### 3. Revisions và tài nguyên con
*   **GET `/:collection/:id/revisions`**: Thử xem lịch sử revision của một bản ghi thuộc tenant khác.
*   **POST `/:collection/:id/revert/:revisionId`**: Thử revert một bản ghi thuộc tenant khác về một revision trước đó.
*   **DELETE `/:collection/:id/pins/:field`**: Thử gỡ pin khỏi một bản ghi thuộc tenant khác.

## Mô phỏng tenant trong test

Trong integration test, tenant context được thiết lập qua HTTP header `X-Lumi-Site`.

```typescript
const res = await app.request('/api/v1/items/lumibase_example/target_id', {
  method: 'GET',
  headers: {
    'X-Lumi-Site': 'tenant-b-id', // Simulated tenant context
    'Authorization': 'Bearer <token_for_tenant_a_user>'
  }
});
// Expect 403 or 404
```
