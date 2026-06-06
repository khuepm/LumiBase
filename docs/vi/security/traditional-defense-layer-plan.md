# Task/Plan: Lớp phòng thủ truyền thống cho LumiBase

## Mục tiêu

Triển khai lớp phòng thủ nền tảng trước khi AI Harness được phép tạo hoặc áp dụng thay đổi vào hệ thống. Lớp này đóng vai trò “chốt chặn cuối cùng” ở runtime: kể cả khi mã do AI sinh ra thiếu kiểm tra, các bề mặt quản trị, upload, browser policy và outbound URL vẫn bị ràng buộc bởi các quy tắc an toàn mặc định.

## Phạm vi task

1. **Core RBAC guard**
   - Chặn mọi principal không phải admin tại các bề mặt quản trị hệ thống như roles, policies, permissions, users, teams, settings, API keys, admin và CDC.
   - Mục tiêu là bảo vệ các bảng/collection hệ thống tương đương `lumibase_users`, `lumibase_roles`, `lumibase_permissions` khỏi thao tác leo thang đặc quyền.

2. **Security headers/CSP**
   - Gắn CSP mặc định vào mọi response.
   - Bật `nosniff`, `DENY` frame, `no-referrer`, `Permissions-Policy`, COOP và CORP để giảm XSS/CSS injection, clickjacking và lộ dữ liệu qua browser surface.

3. **Upload guard**
   - Cấm public role tạo metadata upload.
   - Giới hạn kích thước upload bằng `TRADITIONAL_UPLOAD_MAX_BYTES`, mặc định 10 MiB.
   - Cho phép MIME theo `TRADITIONAL_UPLOAD_ALLOWED_MIME`, mặc định chỉ gồm ảnh phổ biến, PDF, CSV và text.
   - Kiểm tra signed upload PUT trước khi ghi vào storage.

4. **SSRF guard dùng lại cho harness sau này**
   - Cung cấp utility kiểm tra outbound URL trước khi bất kỳ tính năng import/fetch URL nào gọi `fetch`.
   - Chặn protocol không phải HTTP(S), URL có embedded credentials, localhost, RFC1918, link-local, loopback và cloud metadata IP.

## Kế hoạch triển khai

- [x] Tạo nhánh `feature/traditional-defense-layer`.
- [x] Khảo sát CMS API và xác định các bề mặt rủi ro: system RBAC routes, file upload route, global middleware chain và các future URL-import call site.
- [x] Thêm middleware `traditional-defense` và mount vào CMS app.
- [x] Thêm SSRF guard utility độc lập để harness hoặc route import có thể tái sử dụng.
- [x] Thêm biến môi trường cấu hình upload guard trong `Bindings`.
- [x] Thêm unit tests cho RBAC guard, security headers, upload guard và SSRF guard.
- [ ] Ở phase harness tiếp theo: bắt buộc mọi tool/fetch/import do AI gọi phải đi qua `validateOutboundUrl` hoặc `guardedFetch`.
- [ ] Ở phase hardening tiếp theo: bổ sung audit event cho mọi lần guard từ chối thao tác và ánh xạ permission granular nếu cần cho non-admin operator.

## Tiêu chí hoàn tất

- Non-admin principal nhận `CORE_RBAC_FORBIDDEN` khi gọi system control-plane routes.
- Public role không thể tạo file metadata upload.
- Upload quá kích thước hoặc MIME ngoài allowlist bị từ chối trước khi ghi storage.
- Mọi response có CSP và các security headers nền tảng.
- SSRF guard có test cho localhost, private IP, link-local metadata IP và protocol nguy hiểm.
