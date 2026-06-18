# Checklist triển khai

> Backlog ưu tiên để lấp khoảng trống trong [gap-analysis.md](./gap-analysis.md).
> Đây là **định hướng**, không phải code — mỗi mục nêu các điểm chạm schema/module để
> đội kỹ thuật ước lượng. Tuân thủ các quy tắc bất di bất dịch của dự án (xem
> `CLAUDE.md`): ID `nanoid()`/`uuidv7()`, `site_id` trên mọi bảng domain, RLS, trừu
> tượng runtime, và HITL cho skill `schema:write`/`delete`.
>
> **⚠️ Đây không phải tư vấn pháp lý.** Việc xếp ưu tiên là đánh giá kỹ thuật, không
> phải xác định pháp lý về điều gì bắt buộc cho triển khai của bạn.

## P0 — Bắt buộc cho tuân thủ pháp lý + store cơ bản

### P0.1 Xoá tài khoản / quyền được lãng quên
- **Vì sao:** GDPR Điều 17, CCPA delete, PDPD, Apple 5.1.1(v), Google data deletion.
- **Làm gì:** Endpoint tự phục vụ (và bản admin tương ứng) thực hiện xoá đầy đủ tài
  khoản + dữ liệu cá nhân — không chỉ xoá `userSites` như `apps/cms/src/routes/users.ts`
  hiện tại.
- **Điểm chạm:**
  - Cascade/ẩn danh hoá xuyên `users` và các bảng con trong
    `packages/database/src/schema/core.ts` và `access.ts` (user_roles, user_policies,
    api_keys created_by, v.v.).
  - Ẩn danh hoá tham chiếu phải tồn tại (ví dụ `items.userCreated`,
    `revisions.userId`) thay vì để mồ côi.
  - Phát một audit event riêng qua `apps/cms/src/modules/audit/logger.ts`.
  - Cân nhắc **thời gian ân hạn** (cờ soft, rồi dọn) tái dùng mẫu soft-delete
    (`items.deletedAt`).
- **URL web:** cung cấp luồng yêu cầu xoá truy cập công khai (yêu cầu Google Play),
  tách biệt với lối trong ứng dụng.

### P0.2 Xuất dữ liệu cá nhân ("download my data")
- **Vì sao:** GDPR Điều 20, yêu cầu truy cập.
- **Làm gì:** Endpoint gom dữ liệu chính người dùng yêu cầu (hồ sơ, preferences, hoạt
  động, revisions đã tạo, notifications, hội thoại AI) thành JSON/CSV có cấu trúc (có
  thể nén ZIP).
- **Điểm chạm:** service mới phản chiếu mẫu streaming trong
  `apps/cms/src/modules/audit/routes.ts` và `apps/cms/src/services/access-export.ts`.

### P0.3 Quản lý đồng ý
- **Vì sao:** GDPR Điều 7, PDPD.
- **Làm gì:** Bảng `user_consents` — `id` (nanoid), `site_id`, `user_id`,
  `consent_type` (marketing, analytics, personalization, …), `granted` (bool),
  `granted_at`, `withdrawn_at`, `source`/`version`. API đọc/cập nhật; audit mọi thay
  đổi. **Không** nhồi consent có ý nghĩa pháp lý vào JSONB tự do `users.preferences`
  (`core.ts:62`).
- **Điểm chạm:** file schema mới dưới `packages/database/src/schema/`, route + service
  mới, ghi audit.

### P0.4 Huỷ đăng ký email + suppression
- **Vì sao:** CAN-SPAM (bắt buộc), ePrivacy.
- **Làm gì:** Liên kết/token unsubscribe trong mọi email thương mại; danh sách
  suppression kiểm tra trước mỗi lần gửi; xử lý opt-out kịp thời; gồm danh tính người
  gửi + địa chỉ bưu chính trong template.
- **Điểm chạm:** `email_templates`/`email_layouts`, đường gửi của `flows`, và kho
  `user_consents`/suppression mới.

## P1 — Nên làm sớm

### P1.1 Opt-out bán/chia sẻ ("Do Not Sell or Share")
- Lưu cờ opt-out (mở rộng `user_consents`); tôn trọng tín hiệu tuỳ chọn (Global
  Privacy Control); hiển thị liên kết/thông báo bắt buộc.

### P1.2 Chính sách retention dữ liệu tổng quát
- Mở rộng khái niệm retention của `rotator.ts` (`LUMIBASE_AUDIT_RETENTION_DAYS`) sang
  các bảng chứa PII khác (item cũ, hội thoại AI cũ) với mốc cấu hình được và lịch trình
  tài liệu hoá.

### P1.3 Bản đồ dữ liệu cho minh bạch / nhãn store
- Duy trì bản kiểm kê dữ liệu cá nhân mỗi tính năng thu thập và chia sẻ, để khai báo
  Google Data-safety và nhãn Apple chính xác cùng thông báo quyền riêng tư.
  `[Inference]` Có thể là một artifact sinh từ metadata schema.

### P1.4 Nhận thức chuyển dữ liệu xuyên biên giới / data-residency
- Tài liệu hoá và, khi cần, ghim vùng lưu trữ trên hạ tầng edge; hiển thị cấu hình
  data-residency cho nghĩa vụ nội địa hoá (PDPD/Nghị định 53).

## P2 — Mức trưởng thành / nên có

- **P2.1 Trạng thái hạn chế xử lý** — cờ "restricted" được service tôn trọng.
- **P2.2 Lối con người xem xét cho hành động agent** — hiển thị provenance sẵn có
  (`revisions.authorType/model/sources`) và HITL `ai_approvals` cho người dùng bị ảnh
  hưởng bởi quyết định tự động (GDPR Điều 22).
- **P2.3 Che field khi xuất** — ẩn các trường nhạy cảm trong bản xuất.
- **P2.4 Phân loại dữ liệu** — gắn nhãn field là PII/nhạy cảm để điều khiển retention,
  che khi xuất, và bản đồ dữ liệu.
- **P2.5 Mẫu DPA** — cho bất kỳ bản host/quản lý nào (Điều 28).

## Gợi ý trình tự

1. P0.3 bảng consent + P0.4 unsubscribe (mô hình dữ liệu nền tảng).
2. P0.1 xoá + P0.2 xuất (hai luồng DSR nặng nhất; tái dùng consent + audit).
3. Các mục P1 sau khi đường ống DSR cốt lõi đã có.

> Mỗi bảng/endpoint mới còn phải được đánh giá theo **Setup Impact Registry**
> (`.kiro/specs/admin-setup-wizard/setup-impact.md`) theo Definition of Done khi thực
> sự triển khai.
