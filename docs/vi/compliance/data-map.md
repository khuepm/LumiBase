# Bản đồ dữ liệu — Kiểm kê dữ liệu cá nhân

> Kiểm kê nơi LumiBase lưu dữ liệu cá nhân, làm cơ sở cho thông báo quyền riêng tư
> và khai báo trên store (Google Play **Data safety**, Apple **Privacy Nutrition
> Labels**) và để khoanh vùng yêu cầu của chủ thể dữ liệu.
>
> **⚠️ Không phải tư vấn pháp lý.** Đây là tài liệu kỹ thuật. Triển khai của bạn có
> thể thêm collection/field tuỳ biến chứa dữ liệu cá nhân khác — hãy mở rộng bản đồ
> tương ứng. `[Inference]` Phân loại dưới đây phản ánh schema mặc định, không phải
> mô hình nội dung của bạn.

## 1. Định danh & truy cập

| Bảng | Dữ liệu cá nhân | Mục đích | Lưu giữ |
|------|-----------------|----------|---------|
| `users` | email, họ tên, avatar, preferences, `external_id`, `password_hash`*, `tfa`* | Xác thực, hồ sơ | Đến khi erasure (ẩn danh tại chỗ) |
| `user_sites`, `user_roles`, `user_policies` | liên kết user↔site/role/policy | Phân quyền | Xoá khi erasure |
| `api_keys` | hash token*, người tạo, IP dùng gần nhất | Truy cập lập trình | Đến khi thu hồi |
| `login_attempts` | email, IP, kết quả | Chống brute-force | `LUMIBASE_AUDIT_RETENTION_DAYS` (mặc định 90n) |
| `login_baselines` | histogram quốc gia/thiết bị/giờ per-user | Phát hiện bất thường | Xoá khi erasure |
| `admin_backup_codes` | mã khôi phục đã hash* | Khôi phục tài khoản | Xoá khi erasure |

\* Bí mật/credential — được mask trong audit log và **loại trừ** khỏi data export.

## 2. Đồng ý & liên lạc

| Bảng | Dữ liệu cá nhân | Mục đích | Lưu giữ |
|------|-----------------|----------|---------|
| `user_consents` | user id, loại consent, mốc grant/withdraw | Bản ghi đồng ý (GDPR Điều 7) | Trạng thái hiện tại; lịch sử ở `audit_log` |
| `email_suppressions` | email chuẩn hoá | Thực thi unsubscribe / opt-out | Đến khi đăng ký lại |
| `notifications` | id người nhận/gửi, tiêu đề, nội dung | Thông báo in-app | `LUMIBASE_NOTIFICATION_RETENTION_DAYS` (opt-in) |

## 3. Nội dung & hoạt động

| Bảng | Dữ liệu cá nhân | Mục đích | Lưu giữ |
|------|-----------------|----------|---------|
| `items` | nội dung do tác giả nhập; `user_created`/`user_updated` | Kho nội dung | Soft-delete (`deleted_at`) rồi dọn |
| `revisions` | `user_id` (tác giả), delta, provenance agent | Lịch sử thay đổi | Theo item |
| `activity` | `user_id`, IP, user-agent, payload | Log thao tác | `LUMIBASE_ACTIVITY_RETENTION_DAYS` (opt-in) |
| `audit_log` | email actor/target, IP, quốc gia, metadata (đã mask) | Vết audit bảo mật | `LUMIBASE_AUDIT_RETENTION_DAYS` (mặc định 90n) |

## 4. Data export gồm gì

`GET /api/v1/me/data-export` trả về của người gọi: hồ sơ (loại trừ secret), consents,
hoạt động, revisions tự viết và thông báo. Xem [gap-analysis.md](./gap-analysis.md).

## 5. Erasure xoá gì

Account erasure do feature regulated-content-readiness xử lý qua admin
`POST /api/v1/admin/erasure` (và Subject Access Request qua `/api/v1/admin/sar`),
dựa trên `erasure_requests` (`schema/regulated.ts`) và
`apps/cms/src/services/erasure-service.ts`. Xem
[user-rights-catalog.md](./user-rights-catalog.md).

## 6. Phân loại field

Field nội dung tuỳ biến có thể gắn nhãn qua `fields.classification` (`none` / `internal` /
`pii` / `phi`). Field phân loại `pii`/`phi` bắt buộc mã hoá và bị mask mặc định trừ khi
caller có `read_decrypted`; đọc giải mã được audit (`field_access_log`). Cung cấp bởi
feature regulated-content-readiness.

## 7. Bên xử lý thứ ba

`[Inference]` Tuỳ triển khai. Thường gặp: host database (Postgres/Neon/Supabase),
host edge/runtime (Cloudflare/Docker), transport SMTP/email, và sink CDC (ClickHouse)
hoặc đích Firebase sync nếu cấu hình. Liệt kê sub-processor thực tế trong DPA — xem
[dpa-template.md](./dpa-template.md).
