# Task/Plan: Các guard bảo mật runtime cho LumiBase

## Mục tiêu

Chuẩn bị nền bảo mật runtime rõ ràng trước khi AI Harness được phép tạo hoặc áp dụng thay đổi vào hệ thống. Mỗi guard có trách nhiệm riêng, tên riêng và điểm gắn riêng trong pipeline để đội phát triển dễ hiểu, dễ review và dễ bắt buộc Harness sử dụng về sau.

## Phạm vi task

1. **Control-plane access guard**
   - Chặn principal không phải admin tại các bề mặt quản trị hệ thống như roles, policies, permissions, users, teams, settings, API keys, admin và CDC.
   - Bảo vệ các bảng/collection hệ thống tương đương `lumibase_users`, `lumibase_roles`, `lumibase_permissions` khỏi thao tác leo thang đặc quyền.

2. **Security headers middleware**
   - Gắn CSP mặc định vào mọi response.
   - Bật `nosniff`, `DENY` frame, `no-referrer`, `Permissions-Policy`, COOP và CORP để giảm XSS/CSS injection, clickjacking và lộ dữ liệu qua browser surface.

3. **File upload policy**
   - Cấm public role tạo metadata upload.
   - Giới hạn kích thước upload bằng `FILE_UPLOAD_MAX_BYTES`, mặc định 10 MiB.
   - Cho phép MIME theo `FILE_UPLOAD_ALLOWED_MIME_TYPES`, mặc định chỉ gồm ảnh phổ biến, PDF, CSV và text.
   - Kiểm tra signed upload PUT trước khi ghi vào storage.

4. **Outbound URL guard**
   - Cung cấp utility kiểm tra outbound URL trước khi bất kỳ tính năng import/fetch URL nào gọi `fetch`.
   - Chặn protocol không phải HTTP(S), URL có embedded credentials, localhost, RFC1918, link-local, loopback và cloud metadata IP.

## Kế hoạch triển khai

- [x] Tách các thành phần thành module riêng: `security-headers`, `control-plane-access-guard`, `file-upload-policy`, và `outbound-url-guard`.
- [x] Gắn `security-headers` vào global middleware chain.
- [x] Gắn `control-plane-access-guard` và `file-upload-policy` vào authenticated tenant-scoped API chain.
- [x] Thêm biến môi trường cấu hình upload policy trong `Bindings`.
- [x] Thêm unit tests riêng cho từng guard để tên test phản ánh đúng trách nhiệm.
- [x] Bổ sung audit event cụ thể cho các lần guard từ chối thao tác: `control_plane_access_denied` và `file_upload_policy_denied`.
- [ ] Ở phase Harness tiếp theo: bắt buộc mọi tool/fetch/import do AI gọi phải đi qua `validateOutboundUrl` hoặc `guardedFetch`.
- [ ] Ở phase hardening tiếp theo: ánh xạ permission granular nếu cần cho non-admin operator.

## Tiêu chí hoàn tất

- Non-admin principal nhận `CONTROL_PLANE_FORBIDDEN` khi gọi system control-plane routes.
- Public role không thể tạo file metadata upload.
- Upload quá kích thước hoặc MIME ngoài allowlist bị từ chối trước khi ghi storage.
- Mọi response có CSP và các security headers nền tảng.
- Outbound URL guard có test cho localhost, private IP, link-local metadata IP và protocol nguy hiểm.
- Control-plane guard và file upload policy ghi audit event riêng khi request có DB context.
