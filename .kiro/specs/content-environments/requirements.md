# Requirements Document — Content Environments

## Introduction

Tài liệu yêu cầu cho **Content Environments** trong LumiBase — khả năng **fork một site thành một môi trường cô lập** (schema + nội dung), làm việc trên đó mà không đụng production, rồi **đưa thay đổi ngược về** site gốc: schema trước, nội dung sau, có phát hiện và giải quyết xung đột (à la Contentful Environments / Sanity datasets).

Vấn đề hiện tại: một thay đổi lớn đụng **cả schema lẫn nội dung** (ví dụ đổi `author` từ string sang relation, tách `body` thành blocks, rồi viết lại 200 bài theo cấu trúc mới) không có nơi nào để thực hiện an toàn. Ba mảnh sẵn có đều dừng trước bài toán này:

- **Config-as-Code chỉ mang schema.** `code-first-config` loại content items khỏi phạm vi và manifest bỏ `id`/`siteId` (`.kiro/specs/code-first-config/requirements.md`, Introduction + Req 3).
- **Content Releases chỉ gom publish** trên cùng một schema, cùng một site; rollback còn là open question (`.kiro/specs/content-releases/requirements.md`).
- **Content Versioning là nhánh theo từng item**: `contentVersions` (`packages/database/src/schema/cms.ts:528`) lưu snapshot + `hash` để phát hiện main đã đổi, nhưng không mang schema và không gom nhiều item.

LumiBase đã có sẵn các mảnh ghép để **tái sử dụng, không phát minh mới**:

- **Cô lập theo `site_id`**: mọi bảng domain có `site_id`, mọi query lọc theo nó, RLS áp theo site. Một Environment **là một site con** → thừa hưởng cô lập dữ liệu, cache key, search index, RLS mà không sửa query nào.
- **Provisioning site**: `provisionSite()` (`apps/cms/src/services/site-provisioning.ts:27`) tạo site + role administrator/member trong transaction của caller.
- **Config diff/apply**: `buildConfigDiff` (`apps/cms/src/services/config-diff.ts:218`), `ConfigImportService.dryRun`/`apply` (`config-import-service.ts:79`, `:109`) với `ApplyMode` và `DiffRisk` → dùng cho Schema_Promote.
- **Field rename/đổi kiểu có `migrationPlan`**: `FieldInput.renameFrom`/`migrationPlan` (`apps/cms/src/services/schema-service.ts:177-178`), impact `data_migration_required`.
- **Phát hiện lệch bằng hash**: `hashData()` (`apps/cms/src/services/content-version-service.ts:30`) và cờ `mainChanged` → cùng kỹ thuật cho Base_Hash của Environment.
- **Ghi item qua một cửa**: `ItemService.patch` (`apps/cms/src/services/item-service.ts:1090`) sở hữu validation, permission, editorial gate, hooks, revision → mọi thao tác promote **ủy quyền cho `ItemService`**.

Phạm vi feature: tạo/liệt kê/xoá Environment, fork schema + nội dung, cô lập hệ thống phụ trợ, Schema_Promote, Content_Promote một chiều có phát hiện xung đột, Merge ba chiều theo field, kiểm tra phiên bản khi ghi item. **Ngoài phạm vi:** copy-on-write ở tầng storage (v1 copy hàng thật), merge giữa hai Environment anh em, rebase Environment theo production (ghi nhận open question), sao chép secrets/API keys, và agent tự mở/merge Environment (xem Req 13).

## Glossary

- **Origin**: Site gốc (thường là production) mà Environment được fork ra.
- **Environment**: Một site con cô lập, có `parentSiteId` trỏ về Origin và một `key` ổn định trong phạm vi Origin. Lưu là một dòng `sites` + một dòng `environments`.
- **Environment_Status**: `forking | ready | merging | merged | failed | archived`.
- **Fork**: Thao tác tạo Environment bằng cách sao chép schema (luôn luôn) và nội dung (tuỳ `contentScope`) từ Origin.
- **Content_Scope**: `none | collections[] | all` — phần nội dung được sao chép khi Fork.
- **Lineage**: Ánh xạ một dòng trong Environment tới dòng tương ứng ở Origin, kèm **Base_Hash** (SHA-256) và **Base_Snapshot** ghi tại thời điểm Fork và cập nhật sau mỗi promote thành công. Lưu ở bảng `environment_lineage`. Với item, hai phía dùng cùng `id` (khác `site_id`).
- **Base**: Trạng thái của một item ở Origin tại thời điểm Fork (hoặc lần promote gần nhất), lưu dưới dạng Base_Snapshot trong Lineage — tổ tiên chung cho merge ba chiều. Field mã hoá được lưu dưới dạng hash của plaintext, không lưu giá trị.
- **Schema_Promote**: Đưa khác biệt schema của Environment về Origin qua config diff/apply.
- **Content_Promote**: Đưa nội dung item từ Environment về Origin, một chiều, từ chối khi Origin đã lệch khỏi Base.
- **Merge**: Hợp nhất ba chiều theo field (Base, Origin hiện tại, Environment) có giải quyết xung đột.
- **Conflict**: Một field mà cả Origin và Environment đều đã đổi so với Base, với giá trị khác nhau.
- **Merge_Plan**: Kết quả dry-run của Schema_Promote/Content_Promote/Merge: danh sách thay đổi, rủi ro, xung đột; không ghi gì.
- **Write_Precondition**: Điều kiện phiên bản mà client gửi kèm khi ghi item (`If-Match`), ghi chỉ thành công nếu item chưa đổi.
- **Side_System**: Hệ thống phản ứng theo dữ liệu: webhooks, flows, CDC subscriptions, intents/reconciler/agent runs, deployments, email, push.

## Requirements

### Requirement 1: Mô hình dữ liệu Environment

**User Story:** Là một maintainer, tôi muốn Environment là một site con thay vì một chiều dữ liệu mới, để mọi cơ chế cô lập theo `site_id` sẵn có áp dụng nguyên vẹn.

#### Acceptance Criteria

1. THE system SHALL biểu diễn mỗi Environment bằng một dòng `sites` (cùng `organizationId` với Origin) và một dòng `environments` có `id` (nanoid), `siteId` (site con), `parentSiteId` (Origin), `key`, `name`, `status`, `contentScope`, `forkedAt`, `forkedBy`, `statusReason`, `mergedAt`.
2. THE bảng `environments` SHALL có unique index trên `(parentSiteId, key)` và unique trên `siteId`.
3. THE system SHALL từ chối tạo Environment từ một site vốn đã là Environment (`ENVIRONMENT_NESTING_UNSUPPORTED`, 409); v1 chỉ một cấp.
4. THE migration SHALL viết tay kèm sửa journal (KHÔNG drizzle-kit generate); số migration cấp lúc merge, cao hơn mọi nhánh đang mở.
5. THE `environments` và `environment_lineage` SHALL có RLS policy theo `site_id` tương tự các bảng domain khác.

### Requirement 2: Tạo Environment (Fork)

**User Story:** Là một admin, tôi muốn fork production thành một môi trường thử nghiệm có đủ schema và phần nội dung tôi chọn, để thử thay đổi lớn mà không rủi ro.

#### Acceptance Criteria

1. THE CMS SHALL expose `POST /api/v1/environments` nhận `{ key, name, contentScope }` và trả `{ data: Environment }` với `status: 'forking'`; Fork chạy nền qua `QueueProvider`.
2. THE Fork SHALL luôn sao chép toàn bộ schema (collections, fields, relations), settings không nhạy cảm, roles và permissions của Origin sang Environment.
3. WHERE `contentScope` là `all` hoặc `collections[]`, THE Fork SHALL sao chép items (không gồm item đã soft-delete) của các collection trong phạm vi, kèm các dòng junction/quan hệ cần thiết để relation trong phạm vi không gãy.
4. THE Fork SHALL **giữ nguyên `id` của item** (cùng `id`, khác `site_id`) và sinh `id` mới (nanoid) cho collection, field, relation, file và folder; SHALL ghi một dòng Lineage cho mỗi collection, field, relation, file, folder và item đã sao chép. Yêu cầu này phụ thuộc khoá `(site_id, id)` của PR #811.
5. THE Fork SHALL giữ nguyên tham chiếu item→item trong `items.data` (m2o, o2m, m2m, m2a, junction) vì id item không đổi, và SHALL viết lại tham chiếu tới file/folder từ id Origin sang id Environment theo Lineage; tham chiếu tới item ngoài `contentScope` SHALL được đánh dấu là **external reference** chỉ đọc.
6. THE Fork SHALL chia lô có giới hạn và resumable: thất bại giữa chừng đặt `status='failed'` kèm `statusReason`, và chạy lại không nhân bản dòng đã sao chép.
7. WHEN Fork hoàn tất, THE system SHALL đặt `status='ready'` và ghi audit `environment_forked` với `{ environmentId, contentScope, itemCount }`.
8. THE Fork SHALL KHÔNG sao chép: API keys, secrets/credential của webhook/deployment/extension, session, audit log, revisions, agent memory, trust ledger.
9. THE Fork SHALL gán người tạo làm administrator của Environment; thành viên khác của Origin KHÔNG tự động có quyền vào Environment.

### Requirement 3: Files và media

**User Story:** Là một editor, tôi muốn ảnh và file dùng được trong Environment mà không nhân đôi dung lượng lưu trữ.

#### Acceptance Criteria

1. THE Fork SHALL sao chép dòng metadata của file/folder được tham chiếu trong phạm vi, **dùng chung object storage** với Origin (không copy bytes).
2. THE system SHALL KHÔNG xoá object storage khi một file bị xoá trong Environment nếu object đó còn được tham chiếu bởi Origin hoặc Environment khác.
3. WHEN một file mới được upload trong Environment, THE file SHALL chỉ thuộc Environment cho tới khi được đưa về Origin qua Content_Promote/Merge.

### Requirement 4: Cô lập Side_System

**User Story:** Là một admin, tôi muốn dữ liệu thử nghiệm không bao giờ kích hoạt webhook, flow hay agent của production.

#### Acceptance Criteria

1. THE Fork SHALL sao chép webhooks, flows, CDC subscriptions và deployments ở trạng thái **disabled**, không kèm secret.
2. THE Fork SHALL sao chép intents ở trạng thái `paused`; reconciler, planner và agent runs SHALL không tự chạy trên Environment cho tới khi admin bật rõ ràng từng cái.
3. THE system SHALL không gửi email/push giao dịch từ Environment trừ khi admin bật rõ ràng.
4. THE delivery API của Environment SHALL trả header `X-Robots-Tag: noindex` và chỉ phục vụ qua host/`site` riêng của Environment; cache key và search index SHALL tách theo `siteId` của Environment.
5. THE Studio SHALL hiển thị nhãn Environment (key + tên Origin) cố định trên mọi màn hình khi đang ở trong một Environment.

### Requirement 5: Liệt kê, xem, xoá Environment

**User Story:** Là một admin, tôi muốn thấy các Environment của site và dọn chúng khi xong việc.

#### Acceptance Criteria

1. THE CMS SHALL expose `GET /api/v1/environments` (scoped theo Origin, phân trang `{ data, meta }`) và `GET /api/v1/environments/:key` trả trạng thái, `contentScope`, số item đã đổi, và cờ `originChanged`.
2. THE CMS SHALL expose `DELETE /api/v1/environments/:key`: xoá site con và mọi dữ liệu của nó; KHÔNG chạm dữ liệu Origin; tôn trọng Req 3.2.
3. THE system SHALL từ chối xoá khi `status` là `forking` hoặc `merging` (`ENVIRONMENT_BUSY`, 409).
4. THE system SHALL giới hạn số Environment đồng thời mỗi Origin bằng settings key `environments.maxPerSite` (mặc định 3); vượt quá trả `ENVIRONMENT_LIMIT_REACHED` (409).
5. Mọi endpoint quản lý Environment SHALL yêu cầu quyền admin trên Origin và scope theo `site_id` của request.

### Requirement 6: Write_Precondition khi ghi item

**User Story:** Là một editor, tôi muốn được báo khi người khác đã sửa item tôi đang mở, thay vì ghi đè âm thầm.

#### Acceptance Criteria

1. THE `GET /api/v1/items/:collection/:id` SHALL trả `ETag` strong bằng giá trị cột `version` của item; `version` SHALL tăng trong mọi thao tác ghi làm đổi `data` hoặc `status` của item.
2. WHEN `PATCH`/`PUT` item mang header `If-Match`, THE ItemService SHALL chỉ ghi nếu phiên bản hiện tại khớp; nếu không SHALL trả 412 `{ errors: [{ code: 'PRECONDITION_FAILED' }] }` và không ghi gì.
3. WHEN không có `If-Match`, THE ItemService SHALL giữ hành vi hiện tại (tương thích ngược).
4. THE kiểm tra SHALL nguyên tử với thao tác ghi (conditional UPDATE), không phải đọc-rồi-ghi.
5. THE Content_Promote và Merge SHALL luôn dùng Write_Precondition khi ghi vào Origin.

### Requirement 7: Schema_Promote

**User Story:** Là một admin, tôi muốn đưa thay đổi schema từ Environment về production có xem trước rủi ro.

#### Acceptance Criteria

1. THE CMS SHALL expose `POST /api/v1/environments/:key/promote/schema` với `{ dryRun }`; `dryRun=true` trả Merge_Plan, không ghi.
2. THE Schema_Promote SHALL dựng manifest từ Environment và tính diff với Origin bằng `buildConfigDiff`, ghép collection/field theo **Lineage** (không theo tên) để nhận ra rename.
3. WHEN diff chứa thay đổi `risk='high'` hoặc impact `data_migration_required`, THE apply SHALL yêu cầu `confirmRiskyChange` và `migrationPlan` cho từng field liên quan; thiếu thì từ chối 422.
4. WHEN schema của Origin đã đổi so với thời điểm Fork ở cùng một collection/field mà Environment cũng đổi, THE Merge_Plan SHALL liệt kê đó là **schema conflict** và apply SHALL từ chối cho tới khi admin chọn bên thắng cho từng mục.
5. THE apply SHALL chạy `migrationPlan` trên **toàn bộ** item hiện có ở Origin, kể cả item tạo sau thời điểm Fork.
6. THE Schema_Promote SHALL ghi audit `environment_schema_promoted` kèm tóm tắt diff (không kèm nội dung item).

### Requirement 8: Content_Promote một chiều

**User Story:** Là một editor, tôi muốn đẩy các item đã sửa trong Environment về production, và được báo rõ item nào không đẩy được vì production đã đổi.

#### Acceptance Criteria

1. THE CMS SHALL expose `POST /api/v1/environments/:key/promote/content` với `{ dryRun, items?: [{ collection, itemId }] }`; bỏ `items` nghĩa là mọi item đã đổi.
2. THE system SHALL xác định một item là **đã đổi trong Environment** khi hash hiện tại khác Base_Hash, là **mới** khi không có Lineage, là **đã xoá** khi đã soft-delete trong Environment.
3. WHEN Origin của một item vẫn khớp Base_Hash, THE Content_Promote SHALL ghi data của Environment vào item cùng `id` ở Origin qua `ItemService` (chỉ viết lại tham chiếu file/folder từ id Environment về id Origin theo Lineage).
4. WHEN Origin của một item đã lệch khỏi Base_Hash, THE Content_Promote SHALL bỏ qua item đó với outcome `conflict` và KHÔNG ghi đè.
5. WHEN schema Environment và Origin còn khác nhau ở collection của một item, THE Content_Promote SHALL từ chối item đó với `SCHEMA_NOT_PROMOTED`.
6. THE item mới SHALL được tạo ở Origin với **cùng `id`** như ở Environment và Lineage được cập nhật; item mới tham chiếu item mới khác SHALL được tạo theo thứ tự phụ thuộc.
7. THE Content_Promote SHALL tôn trọng permission, validation, editorial gate và `pinnedFields` của Origin như một thao tác ghi thông thường của người gọi.
8. THE kết quả SHALL trả outcome từng item: `promoted | created | deleted | conflict | skipped | failed` kèm lý do; sau khi promote thành công, Base_Hash của item SHALL được cập nhật về trạng thái mới của Origin.

### Requirement 9: Merge ba chiều theo field

**User Story:** Là một editor, tôi muốn hợp nhất item mà cả hai bên đều đã sửa, tự động ở những field không đụng nhau và hỏi tôi ở những field xung đột.

#### Acceptance Criteria

1. THE CMS SHALL expose `POST /api/v1/environments/:key/merge` với `{ dryRun, resolutions? }`; `dryRun=true` trả Merge_Plan gồm danh sách Conflict.
2. THE Merge SHALL so sánh theo từng field top-level của `data`; với field đa ngôn ngữ (`data[field][locale]`) SHALL so sánh theo từng locale.
3. WHEN chỉ một bên đổi một field so với Base, THE Merge SHALL lấy giá trị bên đã đổi; WHEN cả hai đổi về cùng giá trị, không phải Conflict.
4. WHEN cả hai bên đổi một field về giá trị khác nhau, THE Merge SHALL coi là Conflict và yêu cầu `resolutions[{ collection, itemId, field, locale?, take: 'origin' | 'environment' | 'custom', value? }]`.
5. WHEN một bên xoá item mà bên kia sửa, THE Merge SHALL coi là Conflict cấp item (`take: 'keep' | 'delete'`).
6. THE apply SHALL từ chối (422 `UNRESOLVED_CONFLICTS`) khi còn Conflict chưa có resolution, và không ghi gì.
7. THE Merge SHALL lấy Base từ Base_Snapshot của Lineage; WHERE Base không có, item đó SHALL được xử lý như Conflict toàn bộ field đã khác nhau. Field mã hoá SHALL được so sánh bằng hash, và Conflict trên field mã hoá SHALL chỉ nhận resolution `origin` hoặc `environment`.
8. THE field có trong `pinnedFields` của Origin SHALL chỉ bị ghi đè khi người gọi là human có quyền ghi field đó.

### Requirement 10: Tính nguyên tử, khoá và phục hồi

**User Story:** Là một admin, tôi muốn một lần merge hoặc thành công trọn vẹn hoặc để lại trạng thái tôi hiểu được và chạy tiếp được.

#### Acceptance Criteria

1. WHILE một Environment ở `status='merging'`, THE system SHALL từ chối promote/merge khác trên cùng Origin (`ENVIRONMENT_BUSY`, 409).
2. THE apply SHALL chạy **pre-flight** toàn bộ (permission, validation, editorial gate, precondition) trước khi ghi item đầu tiên; bất kỳ blocker nào SHALL dừng trước khi ghi.
3. THE apply SHALL ghi một `merge_runs` record với outcome từng item; thất bại giữa chừng đặt `status='failed'` và chạy lại SHALL bỏ qua item đã áp dụng (idempotent theo Base_Hash).
4. THE system SHALL lưu id revision được tạo ở Origin cho mỗi item trong `merge_runs`, để một lần merge có thể được **hoàn tác** bằng cách revert từng revision khi Origin chưa đổi thêm.
5. THE CMS SHALL expose `POST /api/v1/environments/:key/merge-runs/:id/revert`; item ở Origin đã đổi sau merge SHALL bị bỏ qua với outcome `conflict`.

### Requirement 11: Multi-tenancy, quyền và route guard

**User Story:** Là một maintainer, tôi muốn Environment không mở đường rò rỉ dữ liệu giữa các site.

#### Acceptance Criteria

1. THE mọi thao tác xuyên site (Fork, promote, merge) SHALL chỉ được phép giữa một Environment và **chính Origin của nó**, và cả hai phải cùng `organizationId`; kiểm tra ở service, không tin tham số request.
2. THE thao tác xuyên site SHALL dùng hai service instance scoped riêng (một cho Origin, một cho Environment); KHÔNG có query nào bỏ lọc `site_id`.
3. THE người gọi SHALL có quyền tương ứng ở **cả hai** site: đọc ở Environment, ghi ở Origin.
4. THE route mới SHALL mount sau auth và site-admin guard, và có test route-guard theo DoD §2c.
5. THE API key SHALL không được tạo/xoá Environment hay chạy merge; chỉ staff user.

### Requirement 12: Audit

**User Story:** Là một admin, tôi muốn truy vết ai đã fork, promote, merge, hoàn tác gì và khi nào.

#### Acceptance Criteria

1. THE CMS SHALL ghi audit cho `environment_forked`, `environment_deleted`, `environment_schema_promoted`, `environment_content_promoted`, `environment_merged`, `environment_merge_reverted` qua `AuditLogger` sẵn có.
2. THE metadata audit SHALL gồm `{ environmentId, originSiteId, counts theo outcome, actor }` và KHÔNG gồm nội dung item hay secret.
3. THE revision tạo ở Origin bởi promote/merge SHALL mang provenance chỉ rõ nguồn là Environment (environment id + merge run id).

### Requirement 13: HITL / Autonomy boundary

**User Story:** Là một maintainer, tôi muốn xác định rõ ranh giới agent với Environment.

#### Acceptance Criteria

1. THE Fork, Schema_Promote, Content_Promote và Merge SHALL là hành động do **người** khởi tạo; v1 KHÔNG đăng ký chúng làm agent skill.
2. WHERE trong tương lai agent đề xuất Schema_Promote hoặc xoá Environment, THAT path SHALL đi qua `ai_approvals` (capability `schema:write` / tên bắt đầu `delete`).
3. THE agent được admin bật trong Environment SHALL hoạt động theo autonomy level và constitution của Environment, độc lập với Origin; trust ledger của Environment KHÔNG được merge về Origin.

### Requirement 14: Rollout, Setup Impact và shell

**User Story:** Là một maintainer, tôi muốn feature bật dần và được rà soát theo các registry của repo.

#### Acceptance Criteria

1. THE feature SHALL nằm sau một feature flag theo site, mặc định OFF; khi OFF mọi route Environment trả 404 và hành vi hiện tại không đổi (trừ Req 6, vốn tương thích ngược).
2. WHEN feature hoàn thành, THE feature SHALL được rà soát theo `.kiro/specs/admin-setup-wizard/setup-impact.md` và ghi một dòng Registry; ID cấp lúc merge, cao hơn mọi nhánh đang mở.
3. THE feature SHALL được rà soát theo DoD §2d: Studio chuyển Environment bằng cách đổi site đang chọn, không đổi API base URL hay luồng token mà `apps/shell` phụ thuộc.
4. THE docs người dùng SHALL có ở cả `docs/en/` và `docs/vi/` trong cùng commit.
