# Requirements Document — DB View Introspection & Field Bootstrap

> Status: **Proposal / Roadmap**. Tính năng còn thiếu, tách từ [`collection-create-modes`](../collection-create-modes/requirements.md) Req 3 & 6.
> Cảm hứng: Directus field configuration ([guide](https://directus.com/docs/guides/data-model/fields#configuring-fields)) và RFC views [directus#17265](https://github.com/directus/directus/discussions/17265).

## Introduction

Người dùng có thể tạo bảng trực tiếp trong Postgres (migration thủ công, công cụ DBA) mà không qua giao diện LumiBase. Khi đăng ký bảng đó làm collection (DB_View_Mode / Flexible_View_Mode), LumiBase cần:

1. **Auto-discover** các cột vật lý của bảng/view qua introspection.
2. Hiển thị mỗi cột chưa có metadata LumiBase là **Uncatalogued_Field** với một **chấm than (⚠)** — giống Directus đánh dấu field chưa cấu hình.
3. Cho phép **bootstrap-on-click**: bấm vào field có chấm than → mở field inspector → lưu sẽ tạo record `fields` (interface/display/options/validation/permissions) cho cột đó, biến nó thành **Catalogued_Field**.

**Xác nhận từ codebase:** LumiBase lưu *toàn bộ* metadata field trong một row bảng `fields` ([`packages/database/src/schema/cms.ts:88`](packages/database/src/schema/cms.ts:88)) — `interface`, `display`, `options` (JSONB), `display_options`, `validation`, `conditions`, `width`, `group`, `classification`… Khác Directus (tách `field_options`/`field_displays`), nên "bootstrap record" ở LumiBase = **insert một row `fields`** với cấu hình suy ra từ kiểu cột DB. Field inspector đã tồn tại tại [`apps/studio/src/modules/data-model/field-inspector.tsx`](apps/studio/src/modules/data-model/field-inspector.tsx) với các tab Field/Interface/Display/Validation/Conditions/Layout/Storage.

**GAP đã xác nhận:** Hiện KHÔNG có endpoint introspection DB nào; collection hiện chỉ đọc field từ bảng `fields`, không đối chiếu với cột vật lý thật.

## Glossary

- **Introspection**: Đọc metadata schema vật lý của DB (cột, kiểu, nullable, default, PK) cho một bảng/view.
- **Source_Object**: Bảng hoặc SQL view DB được đăng ký làm collection (`collections.source_object` — cột [Proposal] từ [`collection-create-modes`](../collection-create-modes/design.md)).
- **Uncatalogued_Field**: Cột DB có thật nhưng KHÔNG có record tương ứng trong bảng `fields`. Hiển thị chấm than (⚠).
- **Catalogued_Field**: Cột DB đã có record `fields` (đã configure interface/display/…).
- **Type_Map**: Bảng ánh xạ kiểu cột Postgres → `fields.type` + `fields.interface` + `fields.display` mặc định.
- **Bootstrap**: Hành động insert một row `fields` cho một Uncatalogued_Field, chuyển nó thành Catalogued_Field.
- **Drift**: Khác biệt giữa cột DB vật lý và record `fields` (cột bị xoá ngoài UI, đổi kiểu, thêm mới…).

## Requirements

### Requirement 1: Endpoint introspection cho Source_Object

**User Story:** Là một developer, tôi muốn LumiBase đọc được cấu trúc thật của bảng tôi tạo trong DB, để Studio liệt kê đúng cột của bảng đó.

#### Acceptance Criteria

1. THE CMS SHALL cung cấp endpoint `[Proposal] GET /api/v1/collections/:name/introspect` trả về danh sách cột vật lý của Source_Object: tên cột, kiểu Postgres, nullable, default, có phải PK, độ dài/precision.
2. THE CMS SHALL cung cấp `[Proposal] GET /api/v1/db/objects?registered=false` liệt kê bảng/view trong schema *chưa* được đăng ký làm collection (dùng cho DB picker của [`collection-create-modes`](../collection-create-modes/requirements.md) Req 3.1).
3. THE introspection SHALL chạy qua lớp runtime abstraction — KHÔNG import binding CF/Postgres trực tiếp trong business logic (rule #3). Adapter introspection sống cạnh runtime ([`packages/runtime/src/`](packages/runtime/src/)).
4. THE introspection SHALL chỉ đọc bảng trong schema mà site được phép (multi-tenant) và KHÔNG bao giờ trả nội dung dữ liệu, chỉ metadata schema.
5. IF DB là SQLite (Docker dev) hay Postgres (CF Hyperdrive/Neon), THEN THE introspection SHALL hoạt động trên cả hai qua adapter tương ứng (xác nhận: dual deployment CF + Docker).

### Requirement 2: Hiển thị Uncatalogued_Field với chấm than (⚠)

**User Story:** Là một quản trị viên, khi mở một collection ánh xạ bảng DB, tôi muốn thấy ngay cột nào chưa được LumiBase cấu hình (chấm than) để không tưởng nhầm field đã sẵn sàng dùng trên UI.

#### Acceptance Criteria

1. WHEN mở collection có Source_Object, THE field list ([`apps/studio/src/modules/data-model/fields-tab.tsx`](apps/studio/src/modules/data-model/fields-tab.tsx)) SHALL hợp nhất hai nguồn: record `fields` (Catalogued) và cột introspect (vật lý).
2. THE field list SHALL hiển thị mỗi Uncatalogued_Field với icon chấm than (lucide `triangle-alert`) + tooltip giải thích "Cột DB chưa được cấu hình trong LumiBase — bấm để configure".
3. THE Catalogued_Field SHALL hiển thị bình thường (không chấm than).
4. WHEN một record `fields` trỏ tới cột KHÔNG còn trong DB (Drift), THE field list SHALL đánh dấu cảnh báo khác (vd "cột nguồn đã biến mất") — phân biệt với Uncatalogued (cột thừa) vs missing (record thừa).
5. THE field list SHALL hiển thị bộ đếm tổng quan: bao nhiêu cột uncatalogued / catalogued / drift.

### Requirement 3: Type_Map — suy ra cấu hình mặc định từ kiểu cột

**User Story:** Là một quản trị viên, khi bootstrap một field DB, tôi muốn LumiBase đề xuất sẵn interface/display hợp lý theo kiểu cột (vd `timestamptz` → datetime), để tôi không phải cấu hình mọi thứ từ số 0.

#### Acceptance Criteria

1. THE hệ thống SHALL có Type_Map ánh xạ kiểu Postgres → `{ type, interface, display }` mặc định, tối thiểu phủ: `text/varchar`→`string`/`input`; `int/bigint`→`integer`/`input`; `bool`→`boolean`/`toggle`; `timestamptz/date`→`timestamp`/`datetime`; `jsonb`→`json`/`code`; `uuid`→`uuid`/`input`; cột FK→`relation`/`relation-m2o`.
2. WHEN người dùng bootstrap một Uncatalogued_Field, THE field inspector SHALL nạp sẵn giá trị từ Type_Map nhưng cho phép chỉnh trước khi lưu.
3. THE Type_Map SHALL suy ra `nullable`, `length`, `precision`, `scale`, `unique`, `indexed` từ metadata introspect (Req 1.1) vào record `fields` tương ứng.
4. IF kiểu cột không nằm trong Type_Map, THEN THE field inspector SHALL mặc định `type='string'`, `interface='input'` và cảnh báo rằng kiểu này chưa có ánh xạ.

### Requirement 4: Bootstrap-on-click — tạo record cấu hình field

**User Story:** Là một quản trị viên, tôi muốn bấm vào field có chấm than và lưu là LumiBase tạo đầy đủ cấu hình (interface, display, permissions…) cho field đó, để field hiển thị và sửa được đúng trên UI — giống cách Directus configure field.

#### Acceptance Criteria

1. WHEN người dùng bấm một Uncatalogued_Field, THE Studio SHALL mở field inspector hiện có ([`apps/studio/src/modules/data-model/field-inspector.tsx`](apps/studio/src/modules/data-model/field-inspector.tsx)) nạp sẵn Type_Map (Req 3.2), ở chế độ "configure existing column" (KHÔNG cho đổi tên cột/kiểu vật lý vì cột đã tồn tại trong DB).
2. WHEN người dùng lưu, THE CMS SHALL `PUT /api/v1/collections/:name/fields/:field` (endpoint đã có, [`apps/cms/src/routes/collections.ts:210`](apps/cms/src/routes/collections.ts)) tạo row `fields` với metadata đã chọn — KHÔNG chạy DDL `ALTER TABLE` (cột đã tồn tại).
3. THE bootstrap SHALL điền `interface`, `display`, `options`, `display_options`, `validation`, `conditions`, `width`, `group`, `classification` như mọi field tạo qua UI — tức cùng đường `SchemaService.createField()` ([`apps/cms/src/services/schema-service.ts:400`](apps/cms/src/services/schema-service.ts)), bao gồm audit `classification` nếu ≠ `none`.
4. WHEN field được bootstrap với `classification` = `pii|phi`, THE service SHALL áp ràng buộc encrypted + audit như field thường (xác nhận: ràng buộc tại [`packages/database/src/schema/cms.ts:130`](packages/database/src/schema/cms.ts)).
5. AFTER bootstrap, THE field list SHALL bỏ chấm than cho field đó (giờ là Catalogued_Field) và invalidate schema cache (`schema:<siteId>:<collectionName>` — cơ chế đã có).
6. IF field có capability `schema:write` hoặc liên quan thay đổi quyền nhạy cảm, THEN THE thao tác SHALL đi qua HITL `ai_approvals` nếu do agent thực hiện (rule #4) — bootstrap thủ công bởi người dùng có quyền thì không cần.

### Requirement 5: An toàn & quyền

**User Story:** Là người chịu trách nhiệm bảo mật, tôi muốn introspection và bootstrap không vượt rào multi-tenant hay lộ dữ liệu, để tính năng tiện lợi không tạo lỗ hổng.

#### Acceptance Criteria

1. THE introspection + bootstrap SHALL yêu cầu quyền quản trị schema (capability tương đương với tạo field qua UI).
2. THE introspection SHALL KHÔNG trả về bảng hệ thống nội bộ của LumiBase (collections, fields, users, ai_approvals…) trong danh sách "đăng ký được".
3. WHEN đăng ký một Source_Object thiếu cột `site_id`, THE collection SHALL bị đánh dấu không-RLS-được và yêu cầu xác nhận rõ ràng (đồng bộ [`collection-create-modes`](../collection-create-modes/requirements.md) Req 3.4).
4. THE mọi bootstrap SHALL được ghi vào bảng `activity` (provenance), nêu rõ ai configure cột nào, khi nào.

## Cross-references

| Liên quan | Spec / file |
|---|---|
| Mode selector gọi tính năng này | [`collection-create-modes`](../collection-create-modes/requirements.md) Req 3, 6 |
| Field inspector tái dùng | [`apps/studio/src/modules/data-model/field-inspector.tsx`](apps/studio/src/modules/data-model/field-inspector.tsx) |
| Endpoint field upsert | [`apps/cms/src/routes/collections.ts:210`](apps/cms/src/routes/collections.ts) |
| Bảng `fields` (đích bootstrap) | [`packages/database/src/schema/cms.ts:88`](packages/database/src/schema/cms.ts:88) |
| Runtime abstraction (adapter introspect) | [`packages/runtime/src/`](packages/runtime/src/) |
