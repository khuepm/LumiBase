# Requirements Document — Collection Create Modes (Create-collection mode selector)

> Status: **Proposal / Roadmap**. Chưa triển khai. Tài liệu này định nghĩa hành vi mong muốn, không mô tả code hiện có.
> Reviewer note: mọi claim về codebase hiện tại đã được verify trực tiếp (đường dẫn file + bảng DB). Mọi đề xuất tương lai được đánh dấu `[Proposal]`.

## Introduction

Khi người dùng bắt đầu tạo một collection mới, hiện tại Studio mở thẳng một wizard 5 bước (Identity → Storage → System fields → Permissions → Review) tại [`apps/studio/src/modules/data-model/wizard.tsx`](apps/studio/src/modules/data-model/wizard.tsx), POST tới `POST /api/v1/collections`. Spec này thêm **một bước chọn chế độ (mode selector)** đứng *trước* wizard đó, cho phép người vận hành chọn một trong ba con đường tạo collection:

1. **View mode** (chế độ bình thường) — wizard hiện tại, được bổ sung thư viện **default fields** chọn-trước (sort, timestamps, actor, id, name, localize…).
2. **Database View mode** — đăng ký một bảng/đối tượng DB tạo ngoài giao diện LumiBase (qua migration thủ công, công cụ DBA, hoặc một SQL view) làm collection, **không** bắt buộc định nghĩa từng field trước. Field được auto-discover; field chưa có metadata LumiBase được đánh dấu **chấm than (⚠)** và có thể "configure" để bootstrap record `fields`. Chi tiết introspection nằm ở spec phụ thuộc [`db-view-introspection`](../db-view-introspection/requirements.md).
3. **Flexible DB-backed view** — bề mặt xem/sửa linh hoạt dựa trên bảng/SQL-view DB, lấy cảm hứng từ Directus RFC [directus#17265](https://github.com/directus/directus/discussions/17265): collection ánh xạ tới một SQL view read-only hoặc bảng vật lý, không yêu cầu khai báo field tĩnh như chế độ View.

Spec này **chủ yếu là UI + service mở rộng**. Nó tham chiếu chéo tới hai tính năng còn thiếu cần spec riêng:
- Cấu hình ngôn ngữ tenant (cho dropdown localize) → [`tenant-localization-config`](../tenant-localization-config/requirements.md). **GAP đã xác nhận:** không có bảng `available_locales`; `settings.get('locales')` hiện hard-code fallback `['en','vi']`.
- Auto-discovery field DB + bootstrap-on-click → [`db-view-introspection`](../db-view-introspection/requirements.md).

## Glossary

- **Create_Modes**: Bước chọn chế độ mới, đứng trước wizard tạo collection. Ba lựa chọn: `view` | `db-view` | `flexible-view`.
- **View_Mode**: Chế độ tạo collection chuẩn — schema do người dùng khai báo, lưu trong bảng `collections` + `fields` ([`packages/database/src/schema/cms.ts:47`](packages/database/src/schema/cms.ts:47)).
- **DB_View_Mode**: Đăng ký một đối tượng DB (bảng hoặc SQL view) tạo ngoài LumiBase làm collection; field auto-discover.
- **Flexible_View_Mode**: Collection ánh xạ tới một SQL view/bảng read-or-limited-write, không yêu cầu định nghĩa field tĩnh.
- **Default_Field_Catalogue**: Thư viện field chọn-trước có thể tick khi tạo ở View_Mode (sort, created_at, updated_at, created_by, updated_by, id, name, localize…).
- **Localize_Field**: Field type cho nội dung đa ngôn ngữ (`text-localized` / `relation-translations`). **GAP:** field-level content localization chưa tồn tại trong schema (xác nhận: chỉ có `translations` table cho UI/field-label, không có item-level translatable values).
- **Localize_Dropdown**: Bất kỳ dropdown chọn ngôn ngữ nào trong Studio. Yêu cầu chung: các ngôn ngữ đã cấu hình của tenant đẩy lên đầu danh sách.
- **Tenant_Locales**: Tập ngôn ngữ được bật cho site, cấu hình trong settings. Nguồn truth tương lai cho mọi Localize_Dropdown → spec [`tenant-localization-config`](../tenant-localization-config/requirements.md).
- **Uncatalogued_Field**: Cột DB có thật nhưng chưa có record trong bảng `fields` — hiển thị với chấm than (xem [`db-view-introspection`](../db-view-introspection/requirements.md)).
- **Admin_Base**: Prefix `/$adminPath` tuỳ chọn; mọi route Studio có 2 biến thể (có/không prefix) — quy ước đã có trong [`apps/studio/src/router.tsx`](apps/studio/src/router.tsx).

## Requirements

### Requirement 1: Bước chọn chế độ tạo collection

**User Story:** Là một người vận hành nội dung, tôi muốn khi bấm "Tạo collection" được chọn rõ ràng giữa "định nghĩa schema từ đầu", "đăng ký bảng/đối tượng DB có sẵn", hoặc "tạo bề mặt linh hoạt từ DB", để con đường tạo khớp với cách dữ liệu thực sự tồn tại.

#### Acceptance Criteria

1. WHEN người dùng mở route tạo collection (`/data-model/new`, cả biến thể Admin_Base), THE Studio SHALL hiển thị Create_Modes selector với ba lựa chọn: View_Mode, DB_View_Mode, Flexible_View_Mode — mỗi lựa chọn có icon (lucide), tiêu đề, mô tả một dòng, và ví dụ "khi nào nên dùng".
2. THE Create_Modes selector SHALL đặt View_Mode là lựa chọn mặc định được highlight (đường ít gây ngạc nhiên nhất cho người mới).
3. WHEN người dùng chọn một mode và bấm Continue, THE Studio SHALL điều hướng đến luồng tương ứng và ghi mode đã chọn vào search param (`?mode=view|db-view|flexible-view`) để bookmark/back-button hoạt động.
4. THE Create_Modes selector SHALL có link "Tìm hiểu thêm" trỏ tới doc giải thích khác biệt ba chế độ.
5. IF tenant chưa bật `storage_mode` phù hợp cho DB_View_Mode/Flexible_View_Mode (xác nhận: integer PK yêu cầu `storage_mode != 'jsonb'`, validate tại `assertPrimaryKeyStorageCompatible()` trong [`apps/cms/src/services/schema-service.ts`](apps/cms/src/services/schema-service.ts)), THEN THE selector SHALL hiển thị lý do disable thay vì để người dùng đi vào ngõ cụt.

### Requirement 2: View_Mode — wizard chuẩn + Default_Field_Catalogue

**User Story:** Là một biên tập viên, khi tạo collection thường, tôi muốn tick nhanh các field mặc định phổ biến (sort, ngày tạo/cập nhật, người tạo/cập nhật, id, name, localize) thay vì thêm tay từng cái, để dựng collection trong vài giây.

#### Acceptance Criteria

1. WHEN người dùng chọn View_Mode, THE Studio SHALL mở wizard hiện có ([`apps/studio/src/modules/data-model/wizard.tsx`](apps/studio/src/modules/data-model/wizard.tsx)) — KHÔNG thay thế, chỉ bổ sung.
2. THE wizard SHALL thêm một bước (hoặc panel trong bước "System fields") hiển thị Default_Field_Catalogue dạng danh sách tick được, gồm tối thiểu:
   - `sort` (integer, interface `input`, dùng làm `sort_field` của collection)
   - `created_at` / `updated_at` (timestamp, readonly)
   - `created_by` / `updated_by` (relation tới `users`, readonly)
   - `id` — với lựa chọn kiểu khớp `collections.primary_key_type`: `nanoid` | `uuid` | `integer` | `bigInteger` | `string` (xác nhận enum tại [`packages/database/src/schema/cms.ts:64`](packages/database/src/schema/cms.ts:64))
   - `name` (string, interface `input`, thường set làm `display_template`)
   - `localize` (Localize_Field — xem Req 4 và GAP)
3. WHEN một field default được tick, THE wizard SHALL nạp sẵn cấu hình hợp lý của field đó (type, interface, readonly, nullable, default_value) vào payload `PUT /api/v1/collections/:name/fields/:field` đã có, để người dùng vẫn có thể chỉnh trước khi lưu.
4. IF người dùng tick `id` kiểu `integer`/`bigInteger`, THEN THE wizard SHALL tự đặt `storage_mode` về một giá trị tương thích (`materialized`/`physical`) và giải thích lý do, theo đúng ràng buộc `assertPrimaryKeyStorageCompatible()`.
5. WHEN người dùng tick `created_by`/`updated_by`, THE wizard SHALL tạo relation tương ứng (qua endpoint relations đã có trong [`apps/cms/src/routes/collections.ts`](apps/cms/src/routes/collections.ts)) thay vì chỉ một cột text.
6. THE Default_Field_Catalogue SHALL cho phép bỏ chọn toàn bộ (tạo collection rỗng) — không field nào bị ép buộc ngoài primary key.

### Requirement 3: DB_View_Mode — đăng ký bảng/đối tượng DB có sẵn

**User Story:** Là một developer/DBA, tôi muốn đăng ký một bảng tôi đã tạo trực tiếp trong Postgres (qua migration thủ công, ngoài giao diện LumiBase) thành một collection, mà không phải khai báo lại từng field, để LumiBase quản nội dung của bảng đó ngay.

#### Acceptance Criteria

1. WHEN người dùng chọn DB_View_Mode, THE Studio SHALL hiển thị danh sách các bảng/đối tượng DB *chưa* được đăng ký làm collection (auto-discovery — chi tiết ở [`db-view-introspection`](../db-view-introspection/requirements.md) Req 1).
2. WHEN người dùng chọn một bảng và xác nhận, THE service SHALL tạo record `collections` với `storage_mode` phù hợp (`physical`/`external`) trỏ tới bảng đó, KHÔNG sinh DDL `CREATE TABLE` (bảng đã tồn tại).
3. THE collection vừa đăng ký SHALL hiển thị mọi cột DB của bảng dưới dạng field; cột chưa có record `fields` là Uncatalogued_Field và hiển thị chấm than (⚠) — hành vi chi tiết ở [`db-view-introspection`](../db-view-introspection/requirements.md) Req 2–4.
4. THE đăng ký DB_View_Mode SHALL ghi `site_id` vào record `collections` và áp ràng buộc multi-tenant (rule #2 của project) — nếu bảng nguồn không có cột `site_id`, THE Studio SHALL cảnh báo rằng collection này không thể RLS theo site và yêu cầu xác nhận rõ ràng.
5. IF tên bảng đã ứng với một collection, THEN THE Studio SHALL chặn đăng ký trùng và đề xuất mở collection hiện có.

### Requirement 4: Localize_Dropdown — ngôn ngữ tenant lên đầu (yêu cầu xuyên suốt)

**User Story:** Là một biên tập viên đa ngôn ngữ, ở *mọi* nơi có dropdown chọn ngôn ngữ, tôi muốn các ngôn ngữ đã cấu hình cho website của tôi nằm trên đầu danh sách, để không phải cuộn qua hàng trăm locale.

#### Acceptance Criteria

1. THE Studio SHALL có một component Localize_Dropdown dùng chung; mọi nơi chọn ngôn ngữ (field localize, trang Translations, settings…) dùng chung component này.
2. THE Localize_Dropdown SHALL hiển thị Tenant_Locales (ngôn ngữ đã bật của site) trong một nhóm trên cùng, ngăn cách với danh sách BCP-47 đầy đủ phía dưới.
3. THE Localize_Dropdown SHALL lấy Tenant_Locales từ nguồn truth do spec [`tenant-localization-config`](../tenant-localization-config/requirements.md) định nghĩa. **GAP hiện tại (xác nhận):** chưa có API/bảng cho available locales; [`apps/studio/src/modules/translations/index.tsx`](apps/studio/src/modules/translations/index.tsx) đọc `settings.get('locales')` với fallback hard-code `['en','vi']`.
4. WHILE Tenant_Locales chưa có nguồn truth chính thức, THE Localize_Dropdown SHALL fallback về `sites.default_language` + `['en','vi']` và log rõ là tạm thời (không coi đây là hành vi cuối).
5. THE ngôn ngữ mặc định của site (`sites.default_language`) SHALL được đánh dấu rõ (badge "default") trong nhóm trên cùng.

### Requirement 5: Localize_Field — kiểu field nội dung đa ngôn ngữ

**User Story:** Là một biên tập viên, tôi muốn một field có thể lưu giá trị theo nhiều ngôn ngữ (vd `title` có bản en và vi), để một item phục vụ nhiều locale.

#### Acceptance Criteria

1. THE Default_Field_Catalogue (Req 2) SHALL cung cấp tuỳ chọn `localize` tạo một Localize_Field.
2. WHEN người dùng thêm Localize_Field, THE field editor SHALL dùng Localize_Dropdown (Req 4) để chọn các ngôn ngữ áp dụng cho field đó, mặc định = Tenant_Locales.
3. **GAP đã xác nhận:** Schema hiện KHÔNG hỗ trợ item-level translatable values (chỉ có bảng `translations` cho UI/label namespace `ui|field|content`). THE spec SHALL ghi rõ đây là tính năng còn thiếu và yêu cầu một quyết định thiết kế:
   - (a) field type `text-localized` lưu `{ en: "...", vi: "..." }` trong `items.data` JSONB, HOẶC
   - (b) bảng `item_translations` riêng (kiểu Wagtail).
4. THE quyết định ở 5.3 SHALL được ghi vào một ADR dưới [`docs/en/architecture/decisions/`](docs/en/architecture/decisions/) trước khi implement; spec này KHÔNG tự chốt phương án.

### Requirement 6: Flexible_View_Mode — bề mặt linh hoạt từ DB (Directus #17265)

**User Story:** Là một data engineer, tôi muốn LumiBase hiển thị/duyệt một SQL view (gộp nhiều bảng, có field tính toán) như một collection chỉ-đọc, để dùng LumiBase làm data platform mà không phải vật chất hoá lại dữ liệu.

#### Acceptance Criteria

1. WHEN người dùng chọn Flexible_View_Mode, THE Studio SHALL cho đăng ký một SQL view/bảng có sẵn làm collection chỉ-đọc (read-only) — KHÔNG cho tạo SQL trong app (theo đúng kết luận bảo mật của Directus team: views tạo ngoài app, app không chạy DDL tuỳ ý).
2. THE collection Flexible_View_Mode SHALL đặt cờ read-only ở tầng service để mọi mutation (`POST`/`PATCH`/`DELETE` item) bị từ chối với thông báo rõ ràng.
3. THE field của Flexible_View_Mode SHALL auto-discover (như DB_View_Mode) và hỗ trợ Uncatalogued_Field + bootstrap-on-click (xem [`db-view-introspection`](../db-view-introspection/requirements.md)).
4. IF view có khoá duy nhất xác định (unique id), THEN THE spec MAY (tương lai) cho phép write có giới hạn — nhưng MVP của requirement này là read-only, ghi rõ giới hạn (không im lặng).
5. THE Flexible_View_Mode collection SHALL nêu rõ trong UI rằng đây là view DB (nguồn, read-only) để người dùng không nhầm với collection quản-được-schema.

### Requirement 7: Tài liệu hoá usecase & truy vết tính năng thiếu (yêu cầu meta)

**User Story:** Là người chủ sản phẩm, tôi muốn proposal này không chỉ mô tả UI tạo collection mà còn liệt kê có hệ thống mọi usecase và mọi tính năng phụ thuộc còn thiếu, để không có hạng mục nào bị rơi khi lên kế hoạch.

#### Acceptance Criteria

1. THE bộ tài liệu SHALL liệt kê đầy đủ user story cho cả tính năng phụ thuộc còn thiếu (tối thiểu: UI cấu hình ngôn ngữ tenant; field-level content localization; DB introspection + bootstrap field).
2. Mỗi tính năng thiếu SHALL có spec riêng dưới `.kiro/specs/` với requirements/design/tasks, và được tham chiếu chéo từ spec này.
3. THE spec SHALL được ghi vào Setup Impact Registry ([`.kiro/specs/admin-setup-wizard/setup-impact.md`](.kiro/specs/admin-setup-wizard/setup-impact.md)) theo Definition of Done — kể cả khi kết quả là `n/a`.
4. THE tài liệu SHALL phân biệt rõ giữa hành vi đã có (verified, có path) và hành vi đề xuất (`[Proposal]`), không trình bày đề xuất như thực tại.

## Cross-references

| Tính năng phụ thuộc | Trạng thái | Spec |
|---|---|---|
| Cấu hình ngôn ngữ tenant (Localize_Dropdown source of truth) | ⚠ GAP — chưa có bảng/API | [`tenant-localization-config`](../tenant-localization-config/requirements.md) |
| DB introspection + chấm than + bootstrap field record | ⚠ GAP — chưa có | [`db-view-introspection`](../db-view-introspection/requirements.md) |
| Field-level content localization (`text-localized` / `item_translations`) | ⚠ GAP — cần ADR | Quyết định trong [`docs/en/architecture/decisions/`](docs/en/architecture/decisions/) |
| Wizard tạo collection (View_Mode base) | ✅ Đã có | [`apps/studio/src/modules/data-model/wizard.tsx`](apps/studio/src/modules/data-model/wizard.tsx) |
| Translation memory / glossary | ✅ Đã có | [`translation-memory-ui`](../translation-memory-ui/requirements.md) |
