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

### P0.1 Xoá tài khoản / quyền được lãng quên — ✅ Đã làm (v0.8.x)
- **Vì sao:** GDPR Điều 17, CCPA delete, PDPD, Apple 5.1.1(v), Google data deletion.
- **Đã giao:**
  - Bảng `erasure_requests` (`packages/database/src/schema/compliance.ts`) +
    migration `0033_erasure_requests.sql` + RLS.
  - `ErasureService` (`apps/cms/src/modules/data-rights/erasure-service.ts`):
    `request` (ân hạn), `cancel`, `getStatus`, `eraseNow` (ẩn danh hoá tại chỗ trong
    transaction: null PII, xoá membership/credential, suppress email), và `processDue`
    (processor ân hạn).
  - Tự phục vụ `GET`/`POST`/`DELETE /api/v1/me/erasure`; admin force-erase
    `POST /api/v1/erasure/:userId` + `POST /api/v1/erasure/process-due`
    (`apps/cms/src/routes/erasure.ts`). Audit `erasure_requested`/`erasure_cancelled`/
    `account_erased`.
  - **Ẩn danh chứ không xoá:** dòng `users` được giữ để provenance nội dung
    (`items.userCreated`, `revisions.userId`) còn nguyên trong khi PII bị loại bỏ.
- **Tiếp theo:** lên lịch `processDue` trên cron rotation sẵn có; cung cấp URL yêu cầu
  xoá công khai cho listing Google Play.

### P0.2 Xuất dữ liệu cá nhân ("download my data") — ✅ Đã làm (v0.8.x)
- **Vì sao:** GDPR Điều 15/20, yêu cầu truy cập.
- **Đã giao:** `DataExportService` (`apps/cms/src/modules/data-rights/export-service.ts`)
  gom hồ sơ, consents, hoạt động, revisions tự viết và thông báo của người gọi (loại trừ
  secret, mỗi mục giới hạn kèm cờ `truncated`); `GET /api/v1/me/data-export`
  (`apps/cms/src/routes/data-export.ts`) trả JSON có cấu trúc kèm header tải
  `Content-Disposition`; audit `data_exported`.
- **Tiếp theo:** biến thể CSV/zip; thêm hội thoại AI khi bảng đó vào phạm vi.

### P0.3 Quản lý đồng ý — ✅ Đã làm (v0.8.x)
- **Vì sao:** GDPR Điều 7, PDPD.
- **Làm gì:** Bảng `user_consents` — `id` (nanoid), `site_id`, `user_id`,
  `consent_type` (marketing, analytics, personalization, functional), `granted` (bool),
  `granted_at`, `withdrawn_at`, `source`/`version`. API đọc/cập nhật; audit mọi thay
  đổi. **Không** nhồi consent có ý nghĩa pháp lý vào JSONB tự do `users.preferences`.
- **Đã giao:**
  - Schema `packages/database/src/schema/consent.ts` (+ migration
    `drizzle/0031_user_consents.sql`, RLS trong `migrations/rls-policies.sql`).
  - DTO `packages/shared/src/schemas/consent.ts` (`CONSENT_TYPES`, `ConsentSetSchema`).
  - `ConsentService` (`apps/cms/src/modules/consent/service.ts`) — upsert theo unique
    index `(site,user,type)`.
  - Route `apps/cms/src/routes/consent.ts` — `GET /api/v1/me/consents`,
    `PUT /api/v1/me/consents/:type`; audit `consent_granted`/`consent_withdrawn`.
- **Tiếp theo:** preference center ở Studio/frontend; tái dùng store này cho P0.4 và P1.1.

### P0.4 Huỷ đăng ký email + suppression — ✅ Đã làm (v0.8.x)
- **Vì sao:** CAN-SPAM (bắt buộc), ePrivacy.
- **Đã giao:**
  - Bảng `email_suppressions` (`packages/database/src/schema/compliance.ts`) +
    migration `0032_email_suppressions.sql` + RLS.
  - `SuppressionService` (`apps/cms/src/modules/email/suppression.ts`):
    `isSuppressed`/`filter`/`suppress`/`unsuppress`/`list` + token unsubscribe ký
    không trạng thái (`createUnsubscribeToken`/`verifyUnsubscribeToken`).
  - Endpoint one-click công khai `GET`/`POST /api/v1/email/unsubscribe`
    (`apps/cms/src/routes/email-public.ts`); audit `email_unsubscribed`.
  - Quản trị `GET`/`POST`/`DELETE /api/v1/email/suppressions`.
  - Send path: `EmailModuleService.send({ category: 'marketing' })` lọc người nhận
    đã opt-out trước khi gửi.
- **Tiếp theo:** thêm header SMTP `List-Unsubscribe` (cần `OutboundEmail` mang custom
  header); gồm địa chỉ bưu chính người gửi trong template marketing.

## P1 — Nên làm sớm

### P1.1 Opt-out bán/chia sẻ ("Do Not Sell or Share") — ✅ Đã làm (v0.8.x)
- Triển khai bằng loại consent `sale_share` (`packages/shared/src/schemas/consent.ts`),
  ghi qua `PUT /api/v1/me/consents/sale_share`. Ngữ nghĩa: `granted: false` (hoặc không
  có bản ghi) = đã opt-out — mặc định an toàn theo CCPA.
- **Tiếp theo:** hiển thị link "Do Not Sell or Share" bắt buộc và tôn trọng tín hiệu
  Global Privacy Control của trình duyệt ở frontend.

### P1.2 Chính sách retention dữ liệu tổng quát — ✅ Đã làm (v0.8.x)
- **Đã giao:** `RetentionService` (`apps/cms/src/modules/data-rights/retention-service.ts`)
  dọn log `activity` và `notifications` đã đọc/lưu quá mốc do operator cấu hình
  (`LUMIBASE_ACTIVITY_RETENTION_DAYS` / `LUMIBASE_NOTIFICATION_RETENTION_DAYS`;
  `0`/không đặt = tắt). Trigger admin `GET`/`POST /api/v1/retention/run`
  (`apps/cms/src/routes/retention.ts`); audit `retention_pruned`.
- **Tiếp theo:** mở rộng mốc cho nhiều bảng PII (hội thoại AI); lên lịch trên cron
  rotation sẵn có thay vì trigger thủ công.

### P1.3 Bản đồ dữ liệu cho minh bạch / nhãn store — ✅ Đã làm (v0.8.x, doc)
- Tài liệu hoá ở [data-map.md](./data-map.md): kiểm kê cấp field dữ liệu cá nhân theo
  bảng, export gồm gì, erasure xoá gì, và sub-processor thường gặp. `[Inference]`
  Artifact sinh từ schema vẫn là cải tiến tương lai.

### P1.4 Nhận thức chuyển dữ liệu xuyên biên giới / data-residency — ✅ Đã làm (v0.8.x, doc)
- Tài liệu hoá ở [data-residency.md](./data-residency.md): dữ liệu ở đâu, cách ghim khu
  vực (ưu tiên database), cơ chế chuyển (SCCs), và lưu ý NĐ 53 của VN. Chưa có routing
  khu vực theo bản ghi; đa khu vực = triển khai riêng.

## P2 — Mức trưởng thành / nên có

- **P2.1 Trạng thái hạn chế xử lý** — ✅ Đã làm (v0.8.x). Bảng `processing_restrictions`
  + `RestrictionService` + tự phục vụ `GET`/`PUT /api/v1/me/restriction`; audit
  `processing_restricted`/`processing_unrestricted`. Helper `isRestricted` là hook thực
  thi cho service (agent run, marketing); gắn các call site đó là bước tích hợp còn lại.
- **P2.2 Lối con người xem xét cho hành động agent** — ⬜ Chưa làm. Provenance đã có
  (`revisions.authorType/model/sources`) + HITL `ai_approvals`; hiển thị cho người dùng
  bị ảnh hưởng (GDPR Điều 22) là việc tương lai.
- **P2.3 Che field khi xuất** — ✅ Đã làm (v0.8.x). `redactByClassification`
  (`apps/cms/src/modules/data-rights/redaction.ts`) che giá trị field `pii`/`sensitive`;
  export dữ liệu cá nhân cũng loại trừ secret credential (`passwordHash`, `tfa`). Gắn
  utility vào bất kỳ content export/support view nào không được hiển thị PII thô.
- **P2.4 Phân loại dữ liệu** — ✅ Đã làm (v0.8.x). `fields.classification`
  (`none`/`pii`/`sensitive`, migration `0035`) expose qua API tạo/sửa field
  (`apps/cms/src/routes/collections.ts`) và trong `CompiledField`; điều khiển redaction
  P2.3 và bản đồ dữ liệu.
- **P2.5 Mẫu DPA** — ✅ Đã làm (v0.8.x, doc). Xem [dpa-template.md](./dpa-template.md).

## Gợi ý trình tự

1. P0.3 bảng consent + P0.4 unsubscribe (mô hình dữ liệu nền tảng).
2. P0.1 xoá + P0.2 xuất (hai luồng DSR nặng nhất; tái dùng consent + audit).
3. Các mục P1 sau khi đường ống DSR cốt lõi đã có.

> Mỗi bảng/endpoint mới còn phải được đánh giá theo **Setup Impact Registry**
> (`.kiro/specs/admin-setup-wizard/setup-impact.md`) theo Definition of Done khi thực
> sự triển khai.
