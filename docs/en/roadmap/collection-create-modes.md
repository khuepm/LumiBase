# Collection Create Modes — Roadmap Overview

> **Status:** Proposal / Roadmap (chưa triển khai). Tài liệu này là điểm vào hệ thống cho đề xuất "giao diện chọn chế độ khi tạo collection" và các tính năng phụ thuộc.
>
> Quy ước nhãn: ✅ đã có (verified, có path) · ⚠ GAP (tính năng còn thiếu) · `[Proposal]` đề xuất tương lai.

## Mục tiêu

Khi bắt đầu tạo một collection mới, giao diện cho người vận hành chọn một trong ba con đường, khớp với cách dữ liệu thực sự tồn tại:

1. **View** — chế độ chuẩn: khai báo schema + tick các field mặc định (sort, timestamps, actor, id, name, localize).
2. **Database View** — đăng ký một bảng/đối tượng DB tạo *ngoài* LumiBase; field auto-discover; cột chưa cấu hình hiện **chấm than (⚠)**, bấm để bootstrap cấu hình field (kiểu Directus).
3. **Flexible DB-backed view** — bề mặt xem/sửa linh hoạt từ SQL view/bảng (cảm hứng Directus RFC [#17265](https://github.com/directus/directus/discussions/17265)), read-only ở MVP.

Đề xuất này tham chiếu nhiều màn hình/tính năng khác — một số **chưa tồn tại**. Toàn bộ đã được break-down thành 3 spec với user story + acceptance criteria + tasks, tham chiếu chéo lẫn nhau.

## Bản đồ spec

| Spec | Phạm vi | Trạng thái | Tài liệu |
|------|---------|-----------|----------|
| **collection-create-modes** | Mode selector, Default_Field_Catalogue, Localize_Dropdown, Localize_Field, Flexible view | `[Proposal]` | [requirements](../../../.kiro/specs/collection-create-modes/requirements.md) · [design](../../../.kiro/specs/collection-create-modes/design.md) · [tasks](../../../.kiro/specs/collection-create-modes/tasks.md) |
| **db-view-introspection** | Auto-discover cột DB, chấm than ⚠, bootstrap-on-click record `fields`, Type_Map | ⚠ GAP | [requirements](../../../.kiro/specs/db-view-introspection/requirements.md) · [design](../../../.kiro/specs/db-view-introspection/design.md) · [tasks](../../../.kiro/specs/db-view-introspection/tasks.md) |
| **tenant-localization-config** | Nguồn truth Tenant_Locales + UI Settings → Languages + sửa Admin_Path | ⚠ GAP | [requirements](../../../.kiro/specs/tenant-localization-config/requirements.md) · [design](../../../.kiro/specs/tenant-localization-config/design.md) · [tasks](../../../.kiro/specs/tenant-localization-config/tasks.md) |

## Hiện trạng codebase (verified)

| Thành phần | Trạng thái | Vị trí |
|---|---|---|
| Wizard tạo collection (5 bước) | ✅ | [`apps/studio/src/modules/data-model/wizard.tsx`](../../../apps/studio/src/modules/data-model/wizard.tsx) |
| Field inspector (tabs Field/Interface/Display/Validation/Conditions/Layout/Storage) | ✅ | [`apps/studio/src/modules/data-model/field-inspector.tsx`](../../../apps/studio/src/modules/data-model/field-inspector.tsx) |
| Bảng `collections` (có `storage_mode`, `primary_key_type`) | ✅ | [`packages/database/src/schema/cms.ts:47`](../../../packages/database/src/schema/cms.ts) |
| Bảng `fields` (toàn bộ metadata trong 1 row: interface/display/options/validation/conditions/classification) | ✅ | [`packages/database/src/schema/cms.ts:88`](../../../packages/database/src/schema/cms.ts) |
| Endpoint field upsert `PUT /collections/:name/fields/:field` | ✅ | [`apps/cms/src/routes/collections.ts:210`](../../../apps/cms/src/routes/collections.ts) |
| Site config `GET/PATCH /api/v1/site` + `sites.default_language` | ✅ | [`apps/cms/src/routes/site.ts`](../../../apps/cms/src/routes/site.ts) · [`packages/database/src/schema/core.ts:36`](../../../packages/database/src/schema/core.ts) |
| Bảng `translations` (namespace ui/field/content) | ✅ | [`packages/database/src/schema/platform.ts:97`](../../../packages/database/src/schema/platform.ts) |
| **Available-locales / Tenant_Locales** | ⚠ GAP | Không có bảng/API; fallback hard-code `['en','vi']` ở [`translations/index.tsx`](../../../apps/studio/src/modules/translations/index.tsx) |
| **Field-level content localization** (`text-localized` / `item_translations`) | ⚠ GAP | Chỉ có translations cho UI/label, không có item-level value đa ngôn ngữ → cần ADR |
| **DB introspection / chấm than / bootstrap field** | ⚠ GAP | Không có; field chỉ đọc từ bảng `fields` |
| **Sửa Admin_Path sau setup** | ⚠ GAP | Chỉ đặt ở `/setup/path`, không sửa từ settings |

## Tính năng còn thiếu — tổng hợp user story

Mọi tính năng thiếu đã có user story + acceptance criteria trong spec tương ứng:

- **UI cấu hình ngôn ngữ tenant** → tenant-localization-config Req 1–3.
- **Sửa tên website / domain / admin path từ Settings** → tenant-localization-config Req 3.
- **Field-level content localization** → collection-create-modes Req 5 (cần ADR trước khi code).
- **DB auto-discovery + chấm than + bootstrap field** → db-view-introspection Req 1–4.
- **Flexible read-only DB view collection** → collection-create-modes Req 6.

## Thứ tự triển khai đề xuất

```
Phase 0 (decisions): ADR field-localization · chốt Tenant_Locales source · chốt introspection contract
Phase 1: tenant-localization-config (nền cho Localize_Dropdown)
Phase 2: collection-create-modes — mode selector + View_Mode default fields (không cần migration)
Phase 3: db-view-introspection (introspection + chấm than + bootstrap)
Phase 4: collection-create-modes — DB_View_Mode + Flexible_View_Mode (cần migration thủ công)
```

## Definition of Done

Đã ghi 3 dòng (#33–#35) vào Setup Impact Registry [`.kiro/specs/admin-setup-wizard/setup-impact.md`](../../../.kiro/specs/admin-setup-wizard/setup-impact.md) theo [`.kiro/steering/definition-of-done.md`](../../../.kiro/steering/definition-of-done.md).

## Tham chiếu ngoài

- Directus — Configuring fields: https://directus.com/docs/guides/data-model/fields#configuring-fields
- Directus RFC — Views as collections: https://github.com/directus/directus/discussions/17265
