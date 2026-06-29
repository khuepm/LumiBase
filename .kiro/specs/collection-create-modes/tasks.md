# Tasks — Collection Create Modes

> Status: **Proposal / Roadmap**. Chưa bắt đầu. Checkbox = trạng thái triển khai.

## Phase 0 — Quyết định thiết kế (chặn các phase sau)
- [ ] 0.1 Viết ADR cho field-level content localization: chọn `text-localized` JSONB vs bảng `item_translations` → [`docs/en/architecture/decisions/`](docs/en/architecture/decisions/). _(Chặn Req 5)_
- [ ] 0.2 Chốt nguồn truth Tenant_Locales với spec [`tenant-localization-config`](../tenant-localization-config/tasks.md). _(Chặn Req 4)_
- [ ] 0.3 Chốt hợp đồng introspection với spec [`db-view-introspection`](../db-view-introspection/tasks.md). _(Chặn Req 3, 6)_

## Phase 1 — Mode selector + View_Mode default fields (không cần migration)
- [ ] 1.1 `[Proposal]` `mode-selector.tsx` — 3 card, default `view`, disable kèm lý do (Req 1).
- [ ] 1.2 Thêm search param `mode` + route wiring cả biến thể Admin_Base (Req 1.3).
- [ ] 1.3 `default-field-catalogue.tsx` — danh sách tick, preset payload (Req 2.2–2.3).
- [ ] 1.4 Wire `created_by`/`updated_by` → relations endpoint (Req 2.5).
- [ ] 1.5 Ràng buộc integer PK ↔ storage_mode trong UI (Req 2.4).
- [ ] 1.6 Test: tạo collection với từng tổ hợp default fields; bỏ chọn hết vẫn hợp lệ (Req 2.6).

## Phase 2 — Localize dropdown dùng chung
- [ ] 2.1 `LocalizeDropdown` component (`apps/studio/src/components/localize-dropdown.tsx`) — nhóm tenant trên cùng, badge default (Req 4.1–4.5).
- [ ] 2.2 `useTenantLocales()` hook + fallback tạm `[default_language,'en','vi']` có log (Req 4.4).
- [ ] 2.3 Refactor [`apps/studio/src/modules/translations/index.tsx`](apps/studio/src/modules/translations/index.tsx) dùng component chung (bỏ hard-code `['en','vi']`).
- [ ] 2.4 `localize` entry trong catalogue đánh dấu "coming soon" cho tới khi ADR 0.1 xong (Req 5.4).

## Phase 3 — DB_View_Mode (cần migration thủ công)
- [ ] 3.1 Migration viết tay: thêm `collections.read_only`, `collections.source_object` + sửa journal ([[migrations-are-hand-written]]).
- [ ] 3.2 `db-object-picker.tsx` — list bảng/view chưa đăng ký (dùng introspection từ spec phụ thuộc).
- [ ] 3.3 `registerDbCollection()` trong [`schema-service.ts`](apps/cms/src/services/schema-service.ts) — không sinh DDL, set site_id (Req 3.2–3.4).
- [ ] 3.4 Cảnh báo bảng thiếu `site_id` + xác nhận bắt buộc + audit (Req 3.4).
- [ ] 3.5 Chặn đăng ký trùng (Req 3.5).
- [ ] 3.6 Test multi-tenant: bảng có/không `site_id`.

## Phase 4 — Flexible_View_Mode (read-only)
- [ ] 4.1 `registerDbView()` set `read_only=true` (Req 6.1).
- [ ] 4.2 Guard mutation: item route đọc `collections.read_only`, từ chối với lỗi rõ ràng (Req 6.2).
- [ ] 4.3 UI nhãn "DB view (read-only)" trên collection (Req 6.5).
- [ ] 4.4 Test: mọi POST/PATCH/DELETE item bị chặn.

## Phase 5 — Definition of Done
- [ ] 5.1 Cập nhật Setup Impact Registry [`.kiro/specs/admin-setup-wizard/setup-impact.md`](.kiro/specs/admin-setup-wizard/setup-impact.md) (Req 7.3).
- [ ] 5.2 `turbo run typecheck` (recursive) trước commit ([[typecheck-recursive-vs-per-package]]).
- [ ] 5.3 Doc người dùng: trang giải thích 3 mode (link từ Req 1.4).
- [ ] 5.4 Chạy checklist [`.kiro/steering/definition-of-done.md`](.kiro/steering/definition-of-done.md).
