# Requirements Document — Tenant Localization & Identity Config

> Status: **Proposal / Roadmap**. Tính năng còn thiếu, tách từ [`collection-create-modes`](../collection-create-modes/requirements.md) Req 4.

## Introduction

Mọi Localize_Dropdown trong Studio cần một **nguồn truth** cho "tenant này bật những ngôn ngữ nào". Hiện tại không có:

- **GAP đã xác nhận:** Không có bảng `locales`/`available_locales`. `sites.default_language` chỉ lưu *một* ngôn ngữ mặc định ([`packages/database/src/schema/core.ts:36`](packages/database/src/schema/core.ts:36)). Trang Translations đọc `settings.get('locales')` nhưng fallback hard-code `['en','vi']` ([`apps/studio/src/modules/translations/index.tsx`](apps/studio/src/modules/translations/index.tsx)). Không có API/UI để định nghĩa danh sách ngôn ngữ bật.

Spec này cung cấp:
1. **Nguồn truth Tenant_Locales** — danh sách ngôn ngữ bật cho site, có thứ tự, có một mặc định.
2. **UI cấu hình** trong settings, gộp cùng identity của tenant (tên website, domain, admin path) — vốn cũng đang rải rác/thiếu.
3. **API** để Localize_Dropdown và các tính năng khác đọc.

Trang Site Settings đã tồn tại ([`apps/studio/src/modules/settings/site-page.tsx`](apps/studio/src/modules/settings/site-page.tsx)) với Identity (displayTitle, siteUrl, domain, defaultLanguage), Branding, Theme, Custom CSS — spec này **mở rộng** trang đó, không tạo trang mới.

## Glossary

- **Tenant_Locales**: Danh sách ngôn ngữ bật cho một site (BCP-47), có thứ tự ưu tiên, có một được đánh dấu default.
- **Default_Locale**: Ngôn ngữ mặc định của site — đã có ở `sites.default_language`.
- **Locale_Source**: Nguồn truth (API + storage) cho Tenant_Locales mà mọi Localize_Dropdown đọc.
- **Identity_Settings**: Nhóm cấu hình danh tính tenant: website name (`display_title`), domain, site URL, admin path.
- **Admin_Path**: Prefix admin (`/$adminPath`). **GAP xác nhận:** đặt khi setup (`/setup/path`), KHÔNG sửa được từ settings.

## Requirements

### Requirement 1: Lưu trữ Tenant_Locales

**User Story:** Là một quản trị viên, tôi muốn khai báo website của tôi hỗ trợ những ngôn ngữ nào (vd vi, en, ja) và ngôn ngữ nào mặc định, để mọi nơi trong Studio biết tập ngôn ngữ của tenant.

#### Acceptance Criteria

1. THE hệ thống SHALL lưu Tenant_Locales theo một trong hai phương án (chốt ở design):
   - (a) **[Proposal] cột mới** `sites.locales` JSONB = mảng có thứ tự `[{ tag, label, enabled }]`, HOẶC
   - (b) dùng key chuẩn hoá trong bảng `settings` (`key='locales'`, `scope='site'`) — bảng đã tồn tại ([`packages/database/src/schema/platform.ts:123`](packages/database/src/schema/platform.ts)).
2. THE Default_Locale SHALL tiếp tục là `sites.default_language` (single source) và PHẢI nằm trong Tenant_Locales.
3. THE Tenant_Locales SHALL có thứ tự ổn định (để Localize_Dropdown đẩy lên đầu theo đúng thứ tự admin cấu hình).
4. WHEN admin gỡ một locale khỏi Tenant_Locales mà locale đó đang có translations (`translations` table) hoặc nội dung localized, THE hệ thống SHALL cảnh báo trước khi cho gỡ (không xoá im lặng).

### Requirement 2: API đọc/ghi Tenant_Locales

**User Story:** Là một developer Studio, tôi muốn một API ổn định để đọc Tenant_Locales, để Localize_Dropdown không phải hard-code `['en','vi']`.

#### Acceptance Criteria

1. THE CMS SHALL trả Tenant_Locales qua endpoint site đã có (`GET /api/v1/site`, [`apps/cms/src/routes/site.ts`](apps/cms/src/routes/site.ts)) — thêm trường `locales` vào response.
2. THE CMS SHALL cho cập nhật Tenant_Locales qua `PATCH /api/v1/site` (endpoint đã có) với validate: mọi tag hợp lệ BCP-47, Default_Locale ∈ locales, không trùng.
3. THE response SHALL theo `{ data, meta? }` (rule #5) và filter theo `site_id` (rule #2).
4. THE schema validate SHALL nằm trong [`packages/shared/src/schemas/`](packages/shared/src/schemas/) để CMS + Studio + SDK dùng chung (`SiteConfigUpdateSchema` mở rộng).

### Requirement 3: UI cấu hình ngôn ngữ + identity trong Settings

**User Story:** Là một quản trị viên, tôi muốn một màn hình trong Settings để chỉnh tên website, domain, admin path, và danh sách ngôn ngữ + ngôn ngữ mặc định, để cấu hình tenant ở một chỗ thay vì rải rác/chỉ-lúc-setup.

#### Acceptance Criteria

1. THE Site Settings page ([`apps/studio/src/modules/settings/site-page.tsx`](apps/studio/src/modules/settings/site-page.tsx)) SHALL thêm một mục "Languages" cho phép: thêm/xoá locale, kéo-thả sắp thứ tự, chọn Default_Locale.
2. THE mục Languages SHALL dùng chính component LocalizeDropdown chung (định nghĩa ở [`collection-create-modes`](../collection-create-modes/design.md) §3.5) để thêm locale — ăn ý với yêu cầu "ngôn ngữ tenant lên đầu".
3. THE Identity_Settings hiện có (displayTitle, siteUrl, domain) SHALL được giữ; spec bổ sung khả năng sửa **Admin_Path** từ đây (lấp GAP "admin path chỉ đặt lúc setup").
4. WHEN admin đổi Admin_Path, THE Studio SHALL cảnh báo rõ rằng URL admin sẽ đổi (mọi route Admin_Base dịch chuyển) và yêu cầu xác nhận.
5. THE save SHALL gọi `PATCH /api/v1/site` (đã có) và hiển thị lỗi validate inline.
6. WHEN Default_Locale bị đổi, THE UI SHALL cập nhật badge "default" trong mọi LocalizeDropdown (Req 4.5 của [`collection-create-modes`](../collection-create-modes/requirements.md)).

### Requirement 4: Tích hợp với setup wizard (Setup Impact)

**User Story:** Là người chủ sản phẩm, tôi muốn cấu hình ngôn ngữ tenant cũng xuất hiện hợp lý trong luồng setup ban đầu, để tenant mới có ngôn ngữ ngay từ đầu.

#### Acceptance Criteria

1. THE Setup Impact Registry ([`.kiro/specs/admin-setup-wizard/setup-impact.md`](.kiro/specs/admin-setup-wizard/setup-impact.md)) SHALL ghi nhận tính năng này (rule Definition of Done).
2. WHEN setup wizard chạy, THE bước ngôn ngữ (nếu thêm) SHALL khởi tạo Tenant_Locales tối thiểu = `[default_language]`; nếu không thêm bước, THE default Tenant_Locales = `[sites.default_language]`.
3. THE Admin_Path đặt ở setup (`/setup/path`) SHALL trở thành giá trị khởi tạo mà Req 3.3 cho sửa sau.

## Cross-references

| Liên quan | Spec / file |
|---|---|
| Localize_Dropdown tiêu thụ Tenant_Locales | [`collection-create-modes`](../collection-create-modes/requirements.md) Req 4 |
| Site config endpoint (mở rộng) | [`apps/cms/src/routes/site.ts`](apps/cms/src/routes/site.ts) |
| Site settings UI (mở rộng) | [`apps/studio/src/modules/settings/site-page.tsx`](apps/studio/src/modules/settings/site-page.tsx) |
| Translations UI (bỏ hard-code locales) | [`apps/studio/src/modules/translations/index.tsx`](apps/studio/src/modules/translations/index.tsx) |
| Setup wizard | [`.kiro/specs/admin-setup-wizard/`](../admin-setup-wizard/requirements.md) |
| Shared schemas | [`packages/shared/src/schemas/`](packages/shared/src/schemas/) |
