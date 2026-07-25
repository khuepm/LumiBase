# Tasks — Tenant Localization & Identity Config

> Status: **Proposal / Roadmap**. Chưa bắt đầu.

## Phase 1 — Storage + API (không migration nếu dùng `settings`)
- [ ] 1.1 Chốt phương án lưu: `settings.key='locales'` (khuyến nghị) vs cột `sites.locales` (Req 1.1).
- [ ] 1.2 Mở rộng `SiteConfigUpdateSchema` ([`packages/shared/src/schemas/`](packages/shared/src/schemas/)): `locales[]`, `adminPath`, refine default ∈ locales (Req 2.2, 2.4).
- [ ] 1.3 `GET /api/v1/site` trả `data.locales` (Req 2.1).
- [ ] 1.4 `PATCH /api/v1/site` ghi `locales` + `adminPath`, filter site_id (Req 2.2–2.3).
- [ ] 1.5 Khởi tạo mặc định `[default_language]` khi chưa có (Req 4.2).

## Phase 2 — UI Settings
- [ ] 2.1 Mục "Languages" trong [`site-page.tsx`](apps/studio/src/modules/settings/site-page.tsx): list + kéo-thả + chọn default (Req 3.1).
- [ ] 2.2 Dùng `LocalizeDropdown` chung để thêm locale (Req 3.2).
- [ ] 2.3 Input Admin_Path + modal cảnh báo đổi URL (Req 3.3–3.4).
- [ ] 2.4 Cảnh báo gỡ locale đang có translations (Req 1.4).

## Phase 3 — Tích hợp tiêu thụ
- [ ] 3.1 `useTenantLocales()` hook đọc `GET /api/v1/site` (Req 2).
- [ ] 3.2 Refactor [`translations/index.tsx`](apps/studio/src/modules/translations/index.tsx) bỏ hard-code `['en','vi']`.
- [ ] 3.3 Wire `LocalizeDropdown` (spec collection-create-modes) dùng hook này làm nguồn tenant.

## Phase 4 — Setup wizard
- [ ] 4.1 Khởi tạo `settings.locales` khi setup xong (Req 4.2).
- [ ] 4.2 Admin_Path từ `/setup/path` → giá trị khởi tạo sửa được (Req 4.3).

## Phase 5 — Definition of Done
- [ ] 5.1 Setup Impact Registry update [`.kiro/specs/admin-setup-wizard/setup-impact.md`](.kiro/specs/admin-setup-wizard/setup-impact.md) (Req 4.1).
- [ ] 5.2 `turbo run typecheck` recursive ([[typecheck-recursive-vs-per-package]]).
- [ ] 5.3 Doc người dùng: "Cấu hình ngôn ngữ & danh tính website".
- [ ] 5.4 Checklist [`.kiro/steering/definition-of-done.md`](.kiro/steering/definition-of-done.md).
