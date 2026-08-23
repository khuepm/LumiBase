---
version: 1
lastUpdated: 2026-08-02T19:08:40.211Z
sourceLang: en
translatedFrom: en
sourceHash: 470f7657bd8de6b6
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-08-02T19:08:40.211Z
codeVerifiedHash: 470f7657bd8de6b6
codeVerifiedClaims: 8
---

# Audit hành vi Compose của PermissionService

Ngày audit: 2026-06-03.

Tài liệu này ghi lại hành vi runtime hiện tại của `PermissionService` trước khi tiếp tục công việc về Permission Builder nâng cao. Nó cố tình mô tả thực tế triển khai, bao gồm cả các lỗ hổng khác với bản thiết kế RBAC mong muốn.

Các file được rà soát:

- `apps/cms/src/services/permission-service.ts`
- `apps/cms/src/services/permission-dsl.ts`
- `apps/cms/src/services/item-service.ts`
- `apps/cms/src/routes/permissions.ts`

## Current Compose Flow

`PermissionService.bundle()` biên dịch một `PermissionBundle` cho principal hiện tại và cache dưới dạng `perm:{siteId}:{userId|anon}` trong 60 giây.

Trình biên dịch tải role chính từ `user_sites.role_id`, các role phụ từ `user_roles`, các policy của role từ `role_policies`, các policy trực tiếp của user từ `user_policies`, lọc bỏ các policy không hoạt động theo bảo vệ thời gian/IP, và gom nhóm các hàng quyền theo `collection::action`.

Nếu bất kỳ role hoặc policy hoạt động nào có `adminAccess=true`, bundle sẽ trở thành admin bypass và các hàng quyền không được biên dịch.

## Permission Row Composition

Các quy tắc mang tính cộng dồn (additive). Khi nhiều hàng chia sẻ cùng một `collection + action`, các quy tắc không rỗng sẽ được gộp lại với `_or`. Điều này có thể mở rộng quyền truy cập khi một policy mới được gắn vào rộng hơn policy hiện có.

Các trường (fields) mang tính cộng dồn. Nếu bất kỳ danh sách trường nào chứa `"*"`, danh sách hiệu lực sẽ trở thành `["*"]`; nếu không các danh sách sẽ được hợp lại. Một lỗ hổng hiện tại là các loại trừ như `"-secret"` có thể bị mất khi gộp với `"*"`.

Presets và validation được gộp bằng object spread. Nếu hai policy cùng định nghĩa một trường, hàng sau sẽ thắng một cách im lặng. Vì các hàng quyền được lấy bằng `inArray` và không có thứ tự ưu tiên rõ ràng, việc thắng này không đảm bảo ánh xạ sạch sẽ tới độ ưu tiên ràng buộc.

`sources` hiện theo dõi policy id/name đóng góp để kiểm tra Permission Matrix, nhưng đây không phải là vết theo dõi hoàn chỉnh theo từng trường/quy tắc.

## Runtime Enforcement Summary

Đọc/danh sách/chi tiết (Read/list/detail) là đường dẫn mạnh nhất hiện nay:

- Yêu cầu quyền `read`.
- Các quy tắc hàng được biên dịch vào SQL WHERE.
- Mặt nạ trường (field mask) được áp dụng sau khi truy vấn.
- Các trường mã hóa yêu cầu `read_decrypted`.

Lệnh tạo (Create) hiện được thực thi cho các lỗ hổng thắt chặt đã audit trước đó:

- Yêu cầu quyền `create`.
- Presets được áp dụng.
- Payload cuối cùng được kiểm tra đối chiếu với quy tắc create.
- Dữ liệu do người dùng gửi được kiểm tra đối chiếu với danh sách cho phép (whitelist) của trường, bao gồm cấu trúc `status`/`sort`.
- Validation ở cấp độ quyền được đánh giá trước khi chèn (insert).

Cập nhật/thay thế (Update/replace) hiện yêu cầu quyền `update` trong `ItemService.patch()`. Quy tắc hàng được chèn vào cả lệnh đọc trước khi cập nhật và SQL WHERE cập nhật cuối cùng, các trường do người dùng gửi được kiểm tra đối chiếu với whitelist, và validation ở cấp độ quyền được đánh giá trên snapshot cuối cùng.

Xóa (Delete) hiện yêu cầu quyền `delete` trong `ItemService.softDelete()`. Quy tắc hàng được chèn trước khi hook chạy và một lần nữa vào lệnh cập nhật xóa mềm.

Danh sách bản sửa đổi (Revision list) vẫn chưa có cổng quyết định quyền riêng. Revert đi qua replace và hiện kế thừa cổng update.

## Silent Widening Risks

- Các quy tắc không bị hạn chế có thể mở rộng các quy tắc bị hạn chế.
- `["*"]` có thể mở rộng một whitelist trường.
- Loại trừ trường có thể bị bỏ rơi trong quá trình gộp.
- Xung đột preset/validation có thể bị ghi đè một cách im lặng.
- Thao tác ghi trực tiếp vào DB hoặc import trong tương lai có thể bỏ qua trình kiểm tra xung đột khi gắn (attach).
- Cache quyền có thể bị lỗi thời lên tới 60 giây.
- Role legacy `adminAccess/appAccess` vẫn hoạt động như phương án dự phòng tương thích.
- Danh sách bản sửa đổi vẫn cần một quyết định quyền riêng.

## Recommended Hardening Order

1. Bảo toàn các loại trừ trường khi gộp với `"*"`.
2. Làm cho thứ tự gộp hàng quyền mang tính định hình (deterministic) theo độ ưu tiên ràng buộc.
3. Thêm một cổng quyết định quyền riêng cho danh sách bản sửa đổi.
4. Bắt buộc import/dry-run chạy cùng trình kiểm tra xung đột như các điểm cuối attach.
