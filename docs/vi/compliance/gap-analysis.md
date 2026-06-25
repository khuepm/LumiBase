# Phân tích khoảng trống — Quyền ↔ Tính năng LumiBase

> Ánh xạ mỗi quyền/nghĩa vụ của người dùng vào hiện trạng triển khai của LumiBase,
> kèm bằng chứng đường dẫn file và phần việc cần làm để lấp.
>
> Chú giải trạng thái: ✅ đã có · ⚠️ một phần · ❌ thiếu.
>
> **⚠️ Đây không phải tư vấn pháp lý.** Đây là đánh giá mức độ sẵn sàng về kỹ thuật.
> Việc có một nguyên thuỷ kỹ thuật không tự nó chứng minh tuân thủ pháp lý.

## 1. Bảng tóm tắt

| Quyền / nghĩa vụ | Trạng thái | Bằng chứng (đường dẫn) | Việc cần làm để lấp |
|------------------|:----------:|------------------------|---------------------|
| Xoá / quyền được lãng quên | ⚠️ | `packages/database/src/schema/cms.ts` (`items.deletedAt`, dòng 201); `apps/cms/src/routes/users.ts` (chỉ xoá khỏi `userSites`) | Quy trình xoá tài khoản toàn cục cascade/ẩn danh hoá xuyên `users` và tham chiếu; audit event; thời gian ân hạn. |
| Truy cập / quyền được biết | ✅ | `apps/cms/src/modules/data-rights/export-service.ts`; `GET /api/v1/me/data-export` (hồ sơ, consents, hoạt động, revisions tự viết, thông báo) | Mở rộng khi thêm bảng chứa PII mới. |
| Di chuyển dữ liệu (portability) | ✅ | `apps/cms/src/routes/data-export.ts` — JSON có cấu trúc của dữ liệu chính người dùng, kèm header tải `Content-Disposition` | Bổ sung biến thể CSV nếu cần; tái dùng cho preview erasure. |
| Chỉnh sửa (rectification) | ✅ | `apps/cms/src/routes/users.ts` (cập nhật user); sửa hồ sơ | Không cần cho hồ sơ; đảm bảo mọi trường PII người dùng sửa được. |
| Hạn chế xử lý | ❌ | — | Cờ trạng thái "restricted"/"đóng băng" và thực thi. |
| Phản đối / opt-out (bán/chia sẻ) | ✅ | Loại consent `sale_share` qua `PUT /api/v1/me/consents/sale_share` (`packages/shared/src/schemas/consent.ts`) | Gắn link "Do Not Sell or Share" + tín hiệu Global Privacy Control ở frontend. |
| Đồng ý + rút lại | ✅ | `packages/database/src/schema/consent.ts` (`user_consents`); `apps/cms/src/modules/consent/service.ts`; `apps/cms/src/routes/consent.ts` (`GET`/`PUT /api/v1/me/consents`); audit `consent_granted`/`consent_withdrawn` | Thêm UI preference center. |
| Đồng ý cookie / theo dõi | ⚠️ | Đã có store backend (`user_consents`, loại `analytics`/`functional`); chưa có thu thập ở frontend | Banner đồng ý + thu thập cho cookie/theo dõi không thiết yếu, ghi qua `/me/consents`. |
| Huỷ đăng ký email | ✅ | `packages/database/src/schema/compliance.ts` (`email_suppressions`); `apps/cms/src/modules/email/suppression.ts`; public `GET`/`POST /api/v1/email/unsubscribe`; send path lọc người nhận marketing | Thêm header SMTP `List-Unsubscribe` (RFC 8058) khi `OutboundEmail` hỗ trợ custom header. |
| Xoá tài khoản (in-app/web) | ❌ | — | Endpoint xoá tự phục vụ (phục vụ Apple 5.1.1(v) / yêu cầu URL web của Google). |
| Minh bạch / thông báo quyền riêng tư | ⚠️ | Trang privacy tại `apps/landing/src/app/privacy/page.tsx` (chung chung) | Bản đồ dữ liệu để khai báo "data safety"/nhãn chính xác; thông báo theo từng triển khai. |
| Thông báo vi phạm | ⚠️ | `apps/cms/src/modules/audit/` cung cấp dấu vết phát hiện; `modules/anomaly` | Quy trình ứng phó sự cố + thông báo cơ quan trong 72h (mức tổ chức). |
| Chuyển dữ liệu xuyên biên giới / nội địa hoá | ⚠️ | Runtime edge; `apps/cms/src/middleware/rls.ts` cô lập tenant | Cấu hình ghim vùng / data-residency + tài liệu. |
| Quyết định tự động / con người xem xét | ⚠️ | Provenance trong `revisions` (authorType, model, sources, confidence); HITL qua `ai_approvals` | Hiển thị lối con người xem xét cho hành động agent ảnh hưởng người dùng. |
| Biện pháp an ninh (mã hoá/truy cập) | ✅ | `apps/cms/src/services/crypto-service.ts` (AES-256-GCM); `fields.encrypted` (`cms.ts:124`); `middleware/rls.ts`; RBAC `schema/access.ts` | Duy trì; tài liệu hoá quản lý khoá. |
| Retention / tự động dọn | ⚠️ | `apps/cms/src/modules/audit/rotator.ts` (`LUMIBASE_AUDIT_RETENTION_DAYS`, mặc định 90) — **chỉ audit** | Chính sách retention tổng quát cho bảng chứa PII (users, items, conversations). |

## 2. Những điều LumiBase đã làm tốt

Các nguyên thuỷ này là thật và tái sử dụng được khi xây tính năng tuân thủ:

- **Audit & provenance.** `apps/cms/src/modules/audit/logger.ts` ghi sự kiện
  append-only, che bí mật; `routes.ts` cho truy vấn phân trang cursor và xuất NDJSON;
  `rotator.ts` dọn theo mốc cấu hình được. Hỗ trợ mạnh bằng chứng GDPR Điều 30/32 và
  dấu vết phát hiện vi phạm.
- **Cô lập đa tenant.** `apps/cms/src/middleware/rls.ts` thực thi row-level security
  qua `SET LOCAL app.site_id`, bổ sung cho lọc `site_id` mức ứng dụng — phòng thủ
  nhiều lớp chống rò rỉ liên tenant.
- **Mã hoá.** `apps/cms/src/services/crypto-service.ts` cung cấp AES-256-GCM; field có
  thể đánh dấu `encrypted` (`packages/database/src/schema/cms.ts:124`).
- **Kiểm soát truy cập chi tiết.** `packages/database/src/schema/access.ts` định nghĩa
  role, policy, permission (mức row + field), API key, và share.
- **Soft delete.** `items.deletedAt` (`packages/database/src/schema/cms.ts:201`) với
  index một phần lọc `deleted_at is null` — cửa sổ phục hồi trước khi dọn.

## 3. Các khoảng trống lớn nhất (và vì sao quan trọng)

1. **Xoá tài khoản toàn cục (quyền được lãng quên).** `DELETE` user hiện chỉ xoá một
   dòng thành viên `userSites` — bản ghi `users` và PII vẫn còn. Bắt buộc bởi GDPR
   Điều 17, CCPA delete, PDPD, và cả hai store. **Ưu tiên cao nhất.**
2. **Xuất dữ liệu cá nhân ("download my data").** ✅ *Đã triển khai (v0.8.x).*
   `GET /api/v1/me/data-export` (`apps/cms/src/modules/data-rights/export-service.ts`)
   gom hồ sơ, consents, hoạt động, revisions tự viết và thông báo của chính người gọi
   thành JSON tải về có cấu trúc (loại trừ secret). Thoả GDPR Điều 15/20.
3. **Quản lý đồng ý.** ✅ *Đã triển khai (v0.8.x).* Bảng `user_consents`
   (`packages/database/src/schema/consent.ts`) lưu quyết định hiện tại theo
   `(site_id, user_id, type)` kèm mốc thời gian grant/withdraw; `ConsentService` +
   `GET`/`PUT /api/v1/me/consents` cho phép tự quản lý; mọi thay đổi đều được audit
   (`consent_granted`/`consent_withdrawn`). Thoả nguyên thuỷ storage + API + audit cho
   GDPR Điều 7 / PDPD. Còn lại: preference center ở frontend.
4. **Huỷ đăng ký email / trung tâm tuỳ chọn.** ✅ *Đã triển khai (v0.8.x).* Danh sách
   `email_suppressions` per-site (`packages/database/src/schema/compliance.ts`), endpoint
   one-click công khai (`GET`/`POST /api/v1/email/unsubscribe`) dùng token ký không trạng
   thái, và bộ lọc ở send path loại bỏ người nhận đã opt-out cho email `marketing`
   (`apps/cms/src/modules/email/suppression.ts`). Thoả cơ chế CAN-SPAM; header
   `List-Unsubscribe` còn là follow-up.
5. **Retention dữ liệu tổng quát.** Chỉ dữ liệu audit/login tự động dọn; các bảng PII
   khác chưa có chính sách retention.

## 4. Ghi chú về vai trò

`[Inference]` Phần lớn triển khai LumiBase là **self-host**, khiến đơn vị vận hành trở
thành **bên kiểm soát dữ liệu** và do đó là bên chịu trách nhiệm pháp lý đáp ứng các
quyền này. Nhiệm vụ của LumiBase là cung cấp **năng lực** (endpoint, lưu trữ, audit) để
đơn vị vận hành tuân thủ. Checklist tiếp cận phần việc từ góc đó.

---

**Tiếp theo:** xem [implementation-checklist.md](./implementation-checklist.md) cho
backlog ưu tiên.
