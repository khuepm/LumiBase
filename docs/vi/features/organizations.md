---
version: 3
lastUpdated: 2026-11-10T01:32:16.688Z
sourceLang: en
translatedFrom: en
sourceHash: 2e5f91825eda8ddd
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-10T01:32:16.688Z
codeVerifiedHash: 2e5f91825eda8ddd
codeVerifiedClaims: 6
---

# Cài đặt Organization

Organization gom các site dưới những vai trò cố định. Trên màn hình nhỏ, mở **Settings navigation** để tới trang organization. Bản cài hiện có nhận một organization với slug `default`; setup tạo organization trước site đầu tiên. Mở **Settings → Organization** bằng tài khoản owner hoặc admin. Mục này vẫn hiện khi chỉ có một organization; switcher ở header chỉ hiện khi bạn thuộc nhiều organization.

## Vai trò

- Owner: cài đặt organization, thành viên, key, tạo/xóa/chuyển site và xóa organization.
- Admin: cài đặt, thành viên, key và tạo site. Chỉ owner được đổi slug hoặc quản lý owner.
- Billing và member: đọc organization. Các tab ghi được ẩn; quyền API vẫn là hàng rào quyết định.

## Chọn organization và site

Switcher ở header chọn organization hiển thị trong Organization settings. Trong **Sites**, dùng **Open site** để chọn không gian nội dung. **Create site** tạo role và membership, chọn site mới rồi tải lại Studio sau khi xóa dữ liệu cache. Request site tiếp tục dùng `X-Lumi-Site`; request organization không gửi header này.

Owner chỉ có thể chuyển site tới organization mà chính họ cũng là owner. Xóa và chuyển cần xác nhận tường minh. Không thể xóa hoặc hạ cấp owner cuối cùng. Organization phải không còn site trước khi bị xóa.

## Key và phê duyệt

**Keys** tạo, xoay và thu hồi credential `lbo_`. Key mới hiện trong biên nhận dành cho người dùng có thể đóng; hãy sao chép vào nơi lưu trữ an toàn. Danh sách chỉ chứa metadata của key. **General** có thể bật tool MCP organization; công tắc tắt toàn instance vẫn có hiệu lực.

**Approvals** liệt kê yêu cầu MCP organization. Xem thao tác và tham số rồi duyệt hoặc từ chối. API kiểm tra lại quyền hiện tại của bên yêu cầu và người duyệt. Thao tác dành riêng cho owner vẫn cần owner, kể cả quyền sở hữu cả hai organization khi chuyển site. Token mới chỉ hiện trong biên nhận dành cho người duyệt, không xuất hiện trong phản hồi cho agent. Không thể duyệt yêu cầu của bên đã bị thu hồi quyền; vẫn có thể từ chối yêu cầu đó.

## Cô lập tenant

Lựa chọn organization là tùy chọn trình duyệt, không cấp quyền truy cập. Query chứa id organization và phạm vi phiên không mang bí mật; đổi organization dựng lại form và bỏ token đang hiển thị. Đổi site hủy query, xóa cache nội dung và tải lại shell. Server xác minh riêng membership organization và quyền sở hữu site trên mỗi request.

Đăng nhập và gia hạn của owner/admin organization dùng membership hiện tại ngay cả khi thiếu membership trực tiếp ở site. Role trực tiếp yếu hơn không ghi đè quyền kế thừa đó. Gỡ quyền kế thừa sẽ chặn gia hạn trừ khi role site trực tiếp vẫn cho phép; nếu chỉ còn role frontend thì phiên gia hạn mang audience frontend.

Đăng nhập bằng mật khẩu và gia hạn vẫn cần một site tồn tại. Trước khi xóa site cuối cùng, hãy giữ organization key hoặc phiên Studio còn hiệu lực để tạo lại site qua API organization. Nếu mọi credential này hết hạn hoặc bị mất, cần khôi phục bản sao lưu. Phục hồi instance không phụ thuộc site là thiết kế riêng (backlog B196).

## Desktop và kiểm chứng

Các contract C1–C7 của shell desktop/mobile được giữ: dùng lại accessor token-store và cách xác định API origin, không đổi định dạng phiên hay cổng phát triển mặc định, và gửi refresh token trong body. Sau khi đổi site, refresh và logout vẫn đi tới site gốc của phiên. Khi clipboard không hoạt động, giao diện cho phép sao chép thủ công. CORS cho phép `X-Confirm-Delete` từ origin Studio/shell đã cấu hình.

Kiểm chứng bao gồm cấu hình organization, quyền, xác nhận, biên nhận key, xóa cache site, cả hai cây route Settings, kế thừa quyền đăng nhập/gia hạn và preflight xóa qua origin khác. Xem `apps/studio/src/modules/organization/__tests__`, `apps/studio/src/lib/__tests__/api.test.ts`, `apps/cms/src/routes/__tests__/organization-session.db.integration.test.ts` và `apps/cms/src/__tests__/organization-cors.test.ts`.
