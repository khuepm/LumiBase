# Requirements Document

## Introduction

Tài liệu yêu cầu cho **Foreign Key Dependent Records Handler** trong LumiBase — khả năng phát hiện và giải quyết các **bản ghi phụ thuộc** (records ở collection khác đang tham chiếu tới một item) khi người dùng cố xoá item đó. Mục tiêu: thay vì để thao tác xoá thất bại bằng một lỗi DB thô (hoặc âm thầm để lại reference mồ côi), backend trả về một **response có cấu trúc** liệt kê các bản ghi phụ thuộc theo từng relation, để Studio render một dialog cho phép người dùng **cập nhật hàng loạt** (set null / reassign) hoặc **xoá hàng loạt** các bản ghi liên quan — tương tự luồng "delete blocked by related items" của Directus.

Hiện trạng (gap):
- Quan hệ giữa collection được khai báo trong bảng `relations` (`packages/database/src/schema/cms.ts:149-177`); cột `onDelete` đã **cấu hình được** per-relation với các giá trị `'restrict' | 'cascade' | 'set null' | 'no action'` (`cms.ts:168-169`), validate qua `SchemaService.assertRelationOnDeleteCompatible()` (`apps/cms/src/services/schema-service.ts:723`). Tuy nhiên `onDelete` mới chỉ là **metadata khai báo** — chưa có service nào *thực thi* nó khi xoá item.
- Xoá item mặc định là **soft-delete** (`ItemService.softDelete`, `apps/cms/src/services/item-service.ts:837-888`) — chỉ set `deletedAt`, **không chạm tới FK constraint**, nên reference vẫn trỏ tới item đã "xoá" (orphan tiềm ẩn). `hardDelete()` (`item-service.ts:955-964`) xoá vật lý nhưng **không có try/catch** quanh lỗi constraint Postgres.
- Expansion quan hệ hiện tại **chỉ forward** (`expandManyToOne` / `expandOneToMany` / `expandManyToMany`, `item-service.ts:1041-1165`): trả lời "item này trỏ tới ai". **Không có** API trả lời "ai đang trỏ tới item này" (reverse-dependency).

Phạm vi feature:
1. **Reverse-dependency resolver** — cho `(collection, itemId)`, tìm mọi relation nơi collection này là `oneCollection`, đếm/liệt kê các item đang tham chiếu, scoped theo `siteId`, có phân trang.
2. **Preflight endpoint** — `GET /api/v1/items/:collection/:id/dependents` trả cấu trúc dependents để Studio hiển thị dialog *trước khi* xoá.
3. **Delete behavior** — khi xoá vi phạm toàn vẹn (hard-delete chạm FK, hoặc soft-delete một record bị relation `restrict` trỏ tới), trả HTTP 409 có cấu trúc thay vì lỗi DB thô; bắt Postgres FK violation (SQLSTATE `23503`) trên hard-delete và dịch sang lỗi chuẩn.
4. **Batch resolution actions** — `POST /api/v1/items/:collection/:id/resolve-dependents` với `action: 'set_null' | 'delete' | 'reassign'`, transactional, scoped theo `siteId`, tôn trọng `onDelete` của từng relation và các cổng quyền/editorial.
5. **Studio dialog** — component hiển thị dependents và phát các batch action (backend là phần lõi; Studio UI là một phase).

**Ngoài phạm vi:** thay đổi cơ chế soft-delete mặc định của LumiBase (chỉ *làm rõ* và *tôn trọng* nó); cascade xoá đệ quy nhiều cấp ngoài một cấp dependents (v1 giải quyết một cấp; nhiều cấp ghi vào Open questions); quan hệ `m2a` (polymorphic, hiện reserved). Không thêm bảng DB mới (tái dùng bảng `relations`).

## Glossary

- **CMS**: Backend Hono tại `apps/cms` phục vụ REST API ở prefix `/api/v1`.
- **Studio**: Ứng dụng Admin UI tại `apps/studio` (React + TanStack Router).
- **Target_Item**: Item đang được xoá (hoặc kiểm tra), xác định bởi `(collection, itemId)`.
- **Dependent_Record**: Một item ở collection khác có một field trỏ (tham chiếu) tới `Target_Item` qua một `Relation`.
- **Relation**: Một dòng trong bảng `relations` (`cms.ts:149-177`), gồm `manyCollection`, `manyField`, `oneCollection`, `type` (`m2o|o2m|m2m`), và `onDelete`.
- **On_Delete_Policy**: Giá trị cột `relations.on_delete` (`cms.ts:168-169`): `'restrict' | 'cascade' | 'set null' | 'no action'`. Khai báo hành vi mong muốn khi `Target_Item` (phía `oneCollection`) bị xoá.
- **Reverse_Dependency_Resolver**: Service/method trong CMS nhận `(collection, itemId)`, tìm mọi `Relation` nơi `oneCollection = collection`, rồi với mỗi relation truy vấn các item ở `manyCollection` có `manyField` tham chiếu `itemId`, gom thành danh sách `Dependent_Group`.
- **Dependent_Group**: Một nhóm `Dependent_Record` thuộc cùng một `Relation`, gồm `{ relation, collection, field, onDelete, count, sample[] }`.
- **Dependents_Report**: Cấu trúc tổng hợp `{ dependents: Dependent_Group[] , blocking: boolean }` mà preflight endpoint trả về.
- **Preflight_Endpoint**: `GET /api/v1/items/:collection/:id/dependents` — trả `Dependents_Report` mà không thực hiện xoá.
- **Resolve_Endpoint**: `POST /api/v1/items/:collection/:id/resolve-dependents` — thực thi một `Resolution_Action` trên các `Dependent_Record`.
- **Resolution_Action**: Một trong `'set_null'` (đặt `manyField` = null trên dependents), `'delete'` (xoá dependents — cascade thủ công), `'reassign'` (trỏ `manyField` của dependents sang `newTargetId` khác).
- **Soft_Delete**: Hành vi xoá mặc định của LumiBase — set `deletedAt`, không xoá vật lý (`item-service.ts:837`).
- **Hard_Delete**: Xoá vật lý dòng (`item-service.ts:955`), có thể chạm FK constraint Postgres.
- **FK_Violation**: Lỗi Postgres `foreign_key_violation`, SQLSTATE `23503`, phát ra khi hard-delete một dòng còn bị tham chiếu bởi FK `RESTRICT`/`NO ACTION` vật lý.
- **Blocking_Relation**: Một `Relation` mà `onDelete = 'restrict'` (hoặc `'no action'` ở mức DB) — sự tồn tại của `Dependent_Record` qua relation này **chặn** việc xoá `Target_Item`.
- **Permission_Service**: `PermissionService` (`apps/cms/src/services/permission-service.ts:104`) — cung cấp `canAccess`/`whereFor` và cờ `adminAccess` (`permission-service.ts:175`) dùng để gate thao tác trên collection của dependents.
- **Audit_Log**: Bảng lưu sự kiện; ghi lại mỗi lần `resolve-dependents` thực thi.

## Requirements

### Requirement 1: Reverse-dependency resolver

**User Story:** Là một editor, tôi muốn hệ thống biết được bản ghi nào đang tham chiếu tới một item, để khi tôi định xoá item đó tôi thấy rõ điều gì sẽ bị ảnh hưởng.

#### Acceptance Criteria

1. THE Reverse_Dependency_Resolver SHALL nhận `(collection, itemId)` và tìm mọi `Relation` trong bảng `relations` nơi `oneCollection = collection`, scoped theo `siteId` của request qua `scopeSite(relations.siteId, siteId)`.
2. FOR EACH `Relation` tìm được, THE Reverse_Dependency_Resolver SHALL truy vấn các item ở `manyCollection` có giá trị `manyField` (đọc qua `items.data->>manyField`) bằng `itemId`, loại trừ item đã soft-deleted (`isNull(items.deletedAt)`), và scoped theo `siteId`.
3. THE Reverse_Dependency_Resolver SHALL trả về một danh sách `Dependent_Group`, mỗi nhóm gồm `{ relation: <relationId>, collection: manyCollection, field: manyField, onDelete, count, sample[] }`.
4. THE Reverse_Dependency_Resolver SHALL giới hạn `sample[]` ở tối đa N item per group (mặc định N=10) trong khi `count` phản ánh tổng số thực tế (không bị giới hạn bởi N).
5. WHERE một `Relation` là `m2m` (qua `junctionCollection`), THE Reverse_Dependency_Resolver SHALL coi các dòng junction tham chiếu `itemId` (qua `junctionOneField`) là `Dependent_Record` của nhóm tương ứng.
6. THE Reverse_Dependency_Resolver SHALL KHÔNG bao giờ truy vấn hoặc trả về dependents của site khác (`siteId` cô lập tuyệt đối).
7. WHEN không có `Relation` nào trỏ tới `collection`, THE Reverse_Dependency_Resolver SHALL trả về danh sách rỗng (không lỗi).

### Requirement 2: Preflight dependents endpoint

**User Story:** Là một editor dùng Studio, tôi muốn xem trước những bản ghi phụ thuộc trước khi xác nhận xoá, để quyết định cách xử lý chúng.

#### Acceptance Criteria

1. THE CMS SHALL expose endpoint authenticated `GET /api/v1/items/:collection/:id/dependents` trả `{ data: Dependents_Report }` với `Dependents_Report = { dependents: Dependent_Group[], blocking: boolean }`.
2. THE Preflight_Endpoint SHALL gán `blocking = true` khi tồn tại ít nhất một `Dependent_Record` qua một `Blocking_Relation` (`onDelete = 'restrict'`); ngược lại `blocking = false`.
3. THE Preflight_Endpoint SHALL KHÔNG thực hiện bất kỳ thao tác xoá hay ghi nào — nó chỉ đọc.
4. WHEN `Target_Item` không tồn tại (hoặc đã soft-deleted) trong `siteId` của request, THE Preflight_Endpoint SHALL trả HTTP 404 `{ errors: [{ code: 'NOT_FOUND' }] }`.
5. THE Preflight_Endpoint SHALL yêu cầu caller có quyền `read` trên `collection` của `Target_Item` (qua Permission_Service); thiếu quyền → HTTP 403 `{ errors: [{ code: 'FORBIDDEN' }] }`.
6. WHERE query `?limit=<n>` được truyền, THE Preflight_Endpoint SHALL dùng `n` làm kích thước `sample[]` mỗi nhóm (clamp về một trần hợp lý, ví dụ ≤ 100); mặc định 10.
7. THE Preflight_Endpoint SHALL gắn `onDelete` của mỗi nhóm để Studio biết hành vi mặc định (restrict/cascade/set null/no action) khi render dialog.

### Requirement 3: Cấu trúc 409 khi xoá bị chặn bởi dependents

**User Story:** Là một client của API (Studio hoặc SDK), tôi muốn khi xoá thất bại vì còn bản ghi phụ thuộc thì nhận một lỗi có cấu trúc, để render UI xử lý thay vì hiển thị lỗi DB khó hiểu.

#### Acceptance Criteria

1. WHEN một thao tác Hard_Delete trên `Target_Item` còn bị tham chiếu qua một `Blocking_Relation`, THE CMS SHALL trả HTTP 409 với body `{ errors: [{ code: 'DEPENDENT_RECORDS_EXIST', dependents: Dependent_Group[] }] }` thay vì lỗi DB thô.
2. WHEN một thao tác Soft_Delete trên `Target_Item` còn bị tham chiếu qua một `Blocking_Relation` (`onDelete = 'restrict'`), THE CMS SHALL trả HTTP 409 `DEPENDENT_RECORDS_EXIST` và KHÔNG set `deletedAt` (giữ nguyên item).
3. THE CMS SHALL bắt lỗi Postgres FK_Violation (SQLSTATE `23503`) phát ra trong Hard_Delete và dịch nó sang `{ errors: [{ code: 'DEPENDENT_RECORDS_EXIST', dependents }] }` (HTTP 409) — không để lỗi 500 thô lọt ra client.
4. WHILE xác định `blocking`, THE CMS SHALL chỉ coi `Relation` có `onDelete = 'restrict'` (hoặc `'no action'` ở tầng DB vật lý) là chặn; relation `cascade` hoặc `set null` SHALL không tự chặn (sẽ được resolver xử lý theo §Requirement 8).
5. THE 409 response SHALL chứa `dependents` đủ để Studio render dialog mà không cần gọi lại Preflight_Endpoint (cùng shape `Dependent_Group[]`).
6. THE CMS SHALL scope mọi truy vấn dependents trong luồng này theo `siteId`; lỗi 409 của site này không bao giờ rò rỉ dependents của site khác.

### Requirement 4: Làm rõ ngữ nghĩa soft-delete vs restrict

**User Story:** Là một maintainer, tôi muốn hành vi xoá được định nghĩa rõ ràng giữa soft-delete (mặc định của LumiBase) và `onDelete=restrict`, để không có trạng thái mơ hồ giữa "đã xoá" và "vẫn bị tham chiếu".

#### Acceptance Criteria

1. THE feature SHALL định nghĩa: Soft_Delete đặt `deletedAt` nhưng **không** xoá dòng vật lý, do đó FK vật lý **không** kích hoạt; vì vậy enforcement của `onDelete=restrict` cho luồng soft-delete SHALL được thực thi ở **tầng ứng dụng** (application-level check), không dựa vào FK DB.
2. WHEN một `Target_Item` bị soft-delete trong khi vẫn còn `Dependent_Record` qua relation `onDelete = 'set null' | 'no action' | 'cascade'` (không phải `restrict`), THE CMS SHALL cho phép soft-delete tiến hành VÀ tài liệu hoá rõ rằng các reference trỏ tới item soft-deleted trở thành **orphan có thể giải quyết sau** (không tự động set null khi soft-delete).
3. THE feature SHALL tài liệu hoá (trong design + API spec) rằng: chỉ `restrict` mới *chặn* xoá ở tầng ứng dụng; `set null`/`cascade` *không tự thực thi khi soft-delete* mà chỉ áp dụng khi gọi Resolve_Endpoint hoặc Hard_Delete.
4. WHERE một editor muốn dọn các reference trỏ tới item đã soft-deleted, THE feature SHALL cho phép gọi Resolve_Endpoint trên item đó (kể cả khi nó đã ở trạng thái soft-deleted) để set_null/reassign/delete dependents.
5. THE behavior chosen trong (1)–(4) SHALL được ghi tường minh là một **quyết định thiết kế** trong `design.md` (mục Open questions / decision), không để ẩn ý.

### Requirement 5: Batch action — SET NULL

**User Story:** Là một editor, tôi muốn gỡ liên kết hàng loạt các bản ghi phụ thuộc khỏi một item, để xoá được item mà không phá vỡ các bản ghi kia.

#### Acceptance Criteria

1. THE CMS SHALL expose endpoint authenticated `POST /api/v1/items/:collection/:id/resolve-dependents` nhận body `{ action: 'set_null', relation: <relationId> }`.
2. WHEN `action = 'set_null'`, THE Resolve_Endpoint SHALL với mọi `Dependent_Record` của `Relation` chỉ định, đặt `items.data[manyField] = null` (xoá khoá tham chiếu) trong một DB transaction Drizzle duy nhất, scoped theo `siteId`.
3. THE Resolve_Endpoint SHALL từ chối `set_null` nếu field `manyField` là bắt buộc (non-nullable theo định nghĩa `fields`) với `{ errors: [{ code: 'FIELD_REQUIRED', field }] }` HTTP 409 (không thể null hoá field required).
4. WHEN transaction `set_null` thành công, THE Resolve_Endpoint SHALL trả `{ data: { action: 'set_null', relation, affected: <count> } }`.
5. THE Resolve_Endpoint SHALL kiểm tra caller có quyền `update` trên `manyCollection` của relation (qua Permission_Service); thiếu quyền → HTTP 403 `FORBIDDEN`, không thực hiện thay đổi nào.
6. WHEN bất kỳ update nào trong transaction thất bại, THE Resolve_Endpoint SHALL rollback toàn bộ và trả `{ errors: [...] }`; không dependent nào bị thay đổi một phần.

### Requirement 6: Batch action — DELETE dependents (cascade thủ công)

**User Story:** Là một editor, tôi muốn xoá hàng loạt các bản ghi phụ thuộc cùng lúc với item gốc, để dọn sạch dữ liệu liên quan trong một thao tác.

#### Acceptance Criteria

1. WHEN body là `{ action: 'delete', relation: <relationId> }`, THE Resolve_Endpoint SHALL xoá mọi `Dependent_Record` của relation chỉ định, mặc định bằng Soft_Delete (set `deletedAt`) — đồng nhất với ngữ nghĩa xoá mặc định của LumiBase.
2. WHERE query `?hard=true` được truyền, THE Resolve_Endpoint SHALL Hard_Delete các dependent (xoá vật lý), và SHALL đệ quy kiểm tra dependents-of-dependents một cấp; nếu một dependent lại bị chặn bởi `Blocking_Relation` của chính nó, THE Resolve_Endpoint SHALL trả 409 `DEPENDENT_RECORDS_EXIST` (nested) và rollback.
3. THE Resolve_Endpoint SHALL thực hiện toàn bộ thao tác `delete` trong một DB transaction Drizzle duy nhất, scoped theo `siteId`.
4. THE Resolve_Endpoint SHALL kiểm tra caller có quyền `delete` trên `manyCollection` của relation (qua Permission_Service); thiếu quyền → HTTP 403 `FORBIDDEN`.
5. WHEN transaction `delete` thành công, THE Resolve_Endpoint SHALL trả `{ data: { action: 'delete', relation, affected: <count>, mode: 'soft' | 'hard' } }`.
6. THE Resolve_Endpoint SHALL phát đúng các hook/side-effect xoá item như đường xoá thông thường (`items.delete.before`/`items.delete.after`, deindex search, realtime event) cho mỗi dependent bị xoá, tái dùng cơ chế của `ItemService.softDelete` thay vì viết lại.

### Requirement 7: Batch action — REASSIGN

**User Story:** Là một editor, tôi muốn trỏ lại hàng loạt bản ghi phụ thuộc sang một item khác, để gộp/thay thế một item trước khi xoá nó.

#### Acceptance Criteria

1. WHEN body là `{ action: 'reassign', relation: <relationId>, newTargetId: <id> }`, THE Resolve_Endpoint SHALL đặt `items.data[manyField] = newTargetId` cho mọi `Dependent_Record` của relation, trong một transaction, scoped theo `siteId`.
2. THE Resolve_Endpoint SHALL xác thực `newTargetId` tồn tại (chưa soft-deleted) trong `oneCollection` của relation và cùng `siteId`; nếu không → HTTP 422 `{ errors: [{ code: 'INVALID_TARGET', message }] }` và không thay đổi gì.
3. THE Resolve_Endpoint SHALL từ chối `reassign` khi `newTargetId === id` (trỏ về chính item đang xử lý) với `{ errors: [{ code: 'INVALID_TARGET' }] }`.
4. THE Resolve_Endpoint SHALL kiểm tra caller có quyền `update` trên `manyCollection` (qua Permission_Service); thiếu quyền → HTTP 403 `FORBIDDEN`.
5. WHEN transaction `reassign` thành công, THE Resolve_Endpoint SHALL trả `{ data: { action: 'reassign', relation, affected: <count>, newTargetId } }`.
6. WHEN bất kỳ update nào thất bại, THE Resolve_Endpoint SHALL rollback toàn bộ.

### Requirement 8: Tôn trọng On_Delete_Policy của relation

**User Story:** Là một maintainer, tôi muốn hành vi resolve tôn trọng `onDelete` đã khai báo trên từng relation, để cấu hình schema và hành vi runtime nhất quán.

#### Acceptance Criteria

1. THE Resolve_Endpoint SHALL cho phép một `action` ghi đè chủ động (explicit override) On_Delete_Policy của relation — ví dụ editor chọn `set_null` ngay cả khi relation khai báo `restrict` — nhưng SHALL ghi `policyOverridden: true` vào audit khi action ≠ hành vi mặc định của `onDelete`.
2. WHERE Preflight_Endpoint trả về một nhóm có `onDelete = 'cascade'`, THE Studio SHALL được phép gợi ý mặc định `action = 'delete'`; với `onDelete = 'set null'` gợi ý `action = 'set_null'`; với `restrict`/`no action` không gợi ý mặc định (yêu cầu lựa chọn tường minh).
3. THE Reverse_Dependency_Resolver SHALL bao gồm `onDelete` trong mỗi `Dependent_Group` để client áp dụng (2).
4. WHEN `action = 'set_null'` nhưng `onDelete = 'cascade'` (mâu thuẫn về ý định), THE Resolve_Endpoint SHALL vẫn thực hiện theo `action` được yêu cầu (action thắng), và đánh dấu `policyOverridden: true`.

### Requirement 9: Permissions & multi-tenancy

**User Story:** Là một admin, tôi muốn việc cập nhật/xoá bản ghi phụ thuộc tuân thủ quyền của người gọi trên đúng collection chứa chúng, để không ai vượt quyền qua đường resolve.

#### Acceptance Criteria

1. THE Resolve_Endpoint SHALL kiểm tra quyền của caller trên **collection của dependents** (`manyCollection`), không chỉ trên collection của `Target_Item` — `set_null`/`reassign` cần `update`, `delete` cần `delete`.
2. THE Resolve_Endpoint SHALL áp dụng `Permission_Service.whereFor()` cho mọi truy vấn dependents để không thao tác trên dòng mà caller không được phép thấy (row-level), tái dùng cơ chế của `ItemService`.
3. THE Preflight_Endpoint và Resolve_Endpoint SHALL scope mọi query theo `site_id` của request; tuyệt đối không cross-site.
4. WHERE caller có `adminAccess=true` (`permission-service.ts:175`), THE endpoints SHALL theo cùng quy tắc admin như các route item hiện hữu (không nới lỏng tenancy).
5. THE endpoints SHALL áp dụng cùng quy tắc non-negotiable của CLAUDE.md: `id` nanoid cho mọi dòng mới (không áp dụng vì không tạo dòng mới), scope `site_id`, runtime abstraction cho cache, response `{ data }` / `{ errors }`.

### Requirement 10: Audit thao tác resolve

**User Story:** Là một admin, tôi muốn mọi lần resolve dependents được ghi audit, để truy vết ai đã cập nhật/xoá hàng loạt bản ghi và theo cách nào.

#### Acceptance Criteria

1. WHEN một `Resolution_Action` hoàn tất thành công, THE CMS SHALL ghi Audit_Log entry `dependents_resolved` với metadata `{ targetCollection, targetId, relation, action, affected, mode?, newTargetId?, policyOverridden }`.
2. WHEN một `Resolution_Action` bị rollback, THE CMS SHALL ghi Audit_Log entry `dependents_resolve_failed` với lý do (không kèm dữ liệu nhạy cảm).
3. THE Audit_Log entry SHALL KHÔNG chứa nội dung field nhạy cảm của dependents (chỉ đếm + định danh + relation).
4. THE audit SHALL dùng cùng cơ chế audit logger sẵn có trong CMS (không thêm bảng audit riêng cho feature này).

### Requirement 11: Studio dialog xử lý dependents

**User Story:** Là một editor, tôi muốn một dialog hiển thị khi xoá bị chặn bởi bản ghi phụ thuộc, cho phép tôi chọn cập nhật/xoá/đổi target hàng loạt, để giải quyết ngay trong một màn hình.

#### Acceptance Criteria

1. WHEN người dùng kích hoạt xoá một item trong Studio VÀ backend trả 409 `DEPENDENT_RECORDS_EXIST` (hoặc Preflight cho `blocking=true`), THE Studio SHALL mở một dialog liệt kê từng `Dependent_Group` (collection, field, count, sample, onDelete).
2. THE dialog SHALL cho phép người dùng chọn một `Resolution_Action` per group: Set null / Delete / Reassign (Reassign mở picker chọn `newTargetId` trong `oneCollection`).
3. WHEN người dùng xác nhận, THE Studio SHALL gọi `POST /api/v1/items/:collection/:id/resolve-dependents` cho từng group đã chọn, hiển thị tiến trình và lỗi per group.
4. WHEN tất cả group được resolve thành công, THE Studio SHALL thử lại thao tác xoá `Target_Item` và đóng dialog khi xoá thành công.
5. THE dialog SHALL disable action `set_null` cho group có `manyField` required (phản ánh lỗi `FIELD_REQUIRED` từ backend) và giải thích lý do.
6. THE dialog SHALL hiển thị cảnh báo destructive rõ ràng cho action `delete` (đặc biệt khi `?hard=true`).

### Requirement 12: Setup Impact Registry

**User Story:** Là một maintainer, tôi muốn feature này được rà soát theo Setup Impact Registry, để biết nó có yêu cầu khởi tạo gì khi setup instance mới không.

#### Acceptance Criteria

1. WHEN feature fk-dependent-records hoàn thành, THE feature SHALL được rà soát theo 6 câu hỏi trong `.kiro/specs/admin-setup-wizard/setup-impact.md` và ghi một dòng vào bảng Registry (kể cả `n/a`).
2. THE rà soát SHALL xác định: feature không thêm bảng cần seed (tái dùng bảng `relations` sẵn có), không thêm settings key bắt buộc, không cần bước UI wizard mới, không capability flag mới, và không cần backfill (endpoint là surface mới đọc trên dữ liệu relation/item hiện hữu; không cần migration vì không thêm/đổi cột).
