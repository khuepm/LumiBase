# Requirements Document

## Introduction

Tài liệu yêu cầu cho **Content Releases** trong LumiBase — khả năng gom (collate) các phiên bản nội dung của nhiều item thuộc **những collection khác nhau** vào một đơn vị duy nhất (a *Release*) và **publish tất cả cùng một thời điểm**, hoặc thủ công (manual) hoặc hẹn lịch (scheduled) cho một mốc thời gian cụ thể (à la Directus Releases).

Vấn đề hiện tại: LumiBase chỉ có **scheduling theo từng item** — `items.publishAt`/`unpublishAt` (`packages/database/src/schema/cms.ts:208-209`) và một Scheduler sweep (`apps/cms/src/services/scheduler-worker.ts:265-269`) đẩy mỗi item lên `published` độc lập. **Không có cơ chế publish nhiều item nguyên tử (atomic) cùng lúc**, và không có cách "đóng băng" một tập thay đổi xuyên-collection để review rồi phát hành đồng loạt (ví dụ: một bài viết + ảnh hero + một mục FAQ + một banner trang chủ phải lên sóng cùng giây — một chiến dịch ra mắt sản phẩm).

LumiBase đã có sẵn các mảnh ghép để **tái sử dụng, không phát minh mới**:
- **Revision history** per-item: bảng `revisions` (`cms.ts:244-286`) với `delta` (RFC6902), `parentId` (linked-list), `staged`+`autoCommitAt` (veto window), `authorType` human|agent — cho phép một Release **ghim (pin) một revision cụ thể** của mỗi item, đúng ngữ nghĩa Directus "collate versions".
- **Scheduler sweep pattern**: `registerSchedulerWorker()` trên queue `'content-scheduler'` (`scheduler-worker.ts:265-269`) — periodic tick + conditional UPDATE (chỉ đổi khi `status != target`), idempotent, dispatch revalidation. **Tái dùng pattern này cho due-release sweep.**
- **Editorial gate**: item phải `approved` trước khi `published` (`item-service.ts:717-736`, lỗi `EDITORIAL_GATE_REQUIRED` 409).
- **Time-bound intent analog**: `contentIntents` (`content-os.ts:81-119`) với `schedule`, `maintenanceWindow` `{tz, windows[{dow,start,end}]}`, `status` active|paused|error, `statusReason` (circuit breaker) — một scheduled Release giống một intent có khung thời gian; mượn khái niệm `maintenanceWindow` + `status`/circuit-breaker.
- **Queue abstraction dual-runtime**: `QueueProvider` (`packages/runtime/src/interfaces/queue.ts`) — CF Queues adapter (`getStatus` trả null) + Docker BullMQ adapter; service nhận provider qua deps injection, **không bao giờ import CF bindings**.

Phạm vi feature: tạo/sửa/xoá Release, gom item xuyên-collection với revision pin, publish thủ công + hẹn lịch, hành vi khi một phần thất bại (`partially_failed`), tôn trọng editorial gate, multi-tenancy scoping. **Ngoài phạm vi:** versioning của bản thân Release content (mỗi item đã có revision riêng), rollback một Release đã publish (ghi nhận open question), schema config (đó là `code-first-config`), và biến Release thành một agent skill (publish là hành động do người/lịch khởi tạo — xem Req 13 về HITL/`ai_approvals`).

## Glossary

- **CMS**: Backend Hono tại `apps/cms` phục vụ REST API ở prefix `/api/v1`.
- **Release**: Một đơn vị phát hành gom nhiều `Release_Item` thuộc các collection khác nhau, có thể publish cùng lúc (manual hoặc scheduled). Lưu ở bảng `releases`.
- **Release_Item**: Một dòng junction nối một Release với một item cụ thể (`collection` + `itemId`), kèm `targetStatus` mong muốn và **một pin tới `revisionId`** — phiên bản chính xác của item sẽ được phát hành.
- **Release_Status**: Trạng thái vòng đời của Release: `draft` | `scheduled` | `published` | `failed` | `partially_failed`.
- **Release_Service**: Service trong CMS quản lý CRUD Release + thực thi publish (`apps/cms/src/services/release-service.ts`).
- **Manual_Publish**: Hành động người dùng (admin/editor có quyền) gọi `POST /api/v1/releases/:id/publish` để publish ngay.
- **Scheduled_Publish**: Cơ chế tự động publish một Release khi `publishAt <= now()`, thực thi bởi **Release_Sweep** tái dùng Scheduler queue.
- **Release_Sweep**: Một quét định kỳ (tái dùng pattern `runSchedulerTick`/`registerSchedulerWorker`) tìm các Release `scheduled` đã đến hạn và thực thi publish; idempotent (conditional UPDATE `status != target`).
- **Revision_Pin**: `release_items.revisionId` trỏ tới một dòng `revisions` (`cms.ts:244`) — phiên bản item được "đóng băng" vào Release. Null = dùng trạng thái live hiện tại của item tại thời điểm publish (xem Req 4).
- **Editorial_Gate**: Quy tắc `item-service.ts:717-736` — item trên collection có `editorialWorkflow=true` chỉ lên `published` qua trạng thái `approved`; vi phạm → `EDITORIAL_GATE_REQUIRED`.
- **Publish_Outcome**: Kết quả mỗi `Release_Item` sau publish: `published | skipped | failed` kèm lý do; tổng hợp quyết định `Release_Status`.
- **Atomicity_Mode**: Chế độ xử lý lỗi khi publish nhiều item: `all_or_nothing` (transaction, một lỗi → rollback toàn bộ) hoặc `best_effort` (publish được item nào hay item đó, Release thành `partially_failed`). Mặc định và ràng buộc xem Req 5.
- **Maintenance_Window**: `{ tz, windows: [{ dow, start, end }] }` — khung thời gian cho phép publish, mượn từ `contentIntents.maintenanceWindow` (`content-os.ts:100`). Null = luôn cho phép.
- **Audit_Log**: Bảng/cơ chế ghi sự kiện bảo mật & vận hành (như `scheduler-worker.ts:252` dùng `AuditLogger`).
- **QueueProvider**: Abstraction queue dual-runtime (`packages/runtime/src/interfaces/queue.ts`); service nhận qua deps injection.

## Requirements

### Requirement 1: Tạo một Release rỗng

**User Story:** Là một editor/admin vận hành nội dung, tôi muốn tạo một Release có tên và mô tả, để gom các thay đổi xuyên-collection cho một chiến dịch và phát hành chúng cùng lúc.

#### Acceptance Criteria

1. THE CMS SHALL expose endpoint authenticated `POST /api/v1/releases` nhận `{ name, description?, publishAt? }` và trả `{ data: Release }` với `status: 'draft'` (hoặc `'scheduled'` nếu `publishAt` được truyền — xem Req 6).
2. THE Release_Service SHALL sinh `id` bằng `nanoid()` (helper `id()` tại `cms.ts:23`); KHÔNG dùng serial/auto-increment.
3. THE Release_Service SHALL gán `siteId` từ context của request và lưu `createdBy` = user id hiện tại.
4. WHEN `name` rỗng hoặc thiếu, THE Release_Service SHALL từ chối với HTTP 422 và body `{ errors: [{ code: 'VALIDATION', path: 'name' }] }`.
5. THE Release_Service SHALL scope mọi query theo `site_id` của request; một Release luôn thuộc đúng một site.

### Requirement 2: Thêm item xuyên-collection vào Release

**User Story:** Là một editor, tôi muốn thêm các item thuộc những collection khác nhau vào một Release, để chúng được phát hành đồng loạt.

#### Acceptance Criteria

1. THE CMS SHALL expose endpoint authenticated `PATCH /api/v1/releases/:id` chấp nhận thao tác `addItems: [{ collection, itemId, targetStatus?, revisionId? }]` và `removeItems: [{ collection, itemId }]`.
2. THE Release_Service SHALL cho phép một Release chứa item từ **nhiều collection khác nhau** (đây là tính năng cốt lõi — collate versions across collections).
3. WHEN một item được thêm mà item đó không tồn tại trong site (theo `collection` + `itemId`), THE Release_Service SHALL từ chối với `{ errors: [{ code: 'ITEM_NOT_FOUND', path }] }` và không thêm dòng nào.
4. THE Release_Service SHALL enforce uniqueness `(releaseId, collection, itemId)`; thêm trùng một item SHALL cập nhật dòng hiện có (upsert `targetStatus`/`revisionId`) thay vì tạo bản sao.
5. WHEN `targetStatus` không thuộc tập hợp lệ của item (`draft | published | archived`, theo `items.status` `cms.ts:195`), THE Release_Service SHALL từ chối với `{ errors: [{ code: 'INVALID_TARGET_STATUS' }] }`; mặc định `targetStatus='published'` nếu không truyền.
6. THE Release_Service SHALL chỉ cho phép sửa danh sách item KHI `Release_Status` là `draft` hoặc `scheduled`; nếu Release đã `published`, thao tác SHALL trả HTTP 409 `{ errors: [{ code: 'RELEASE_IMMUTABLE' }] }`.
7. THE Release_Service SHALL scope mọi query theo `site_id`; không cho phép thêm item của site khác vào Release.

### Requirement 3: Ghim phiên bản (Revision Pin) cho mỗi item

**User Story:** Là một editor, tôi muốn ghim một phiên bản cụ thể của mỗi item vào Release, để Release phát hành đúng nội dung đã review chứ không phải bản nháp mới nhất bị sửa sau đó.

#### Acceptance Criteria

1. THE Release_Item SHALL có trường `revisionId` (nullable) trỏ tới một dòng `revisions` (`cms.ts:244`); khi set, đây là phiên bản được "đóng băng" để phát hành.
2. WHEN `revisionId` được truyền lúc thêm item, THE Release_Service SHALL xác minh revision đó tồn tại, thuộc đúng `itemId`, và thuộc đúng `site_id`; nếu không, từ chối với `{ errors: [{ code: 'REVISION_NOT_FOUND' }] }`.
3. WHERE `revisionId` là null cho một Release_Item, THE Release_Service SHALL diễn giải là "phát hành trạng thái live hiện tại của item tại thời điểm publish" (late-binding) thay vì một phiên bản đóng băng.
4. WHEN Release được publish và một Release_Item có `revisionId` set, THE Release_Service SHALL áp dụng nội dung của revision đó vào item (materialize delta) trước khi đổi status sang `targetStatus`.
5. THE Release_Service SHALL không cho phép ghim một `revisionId` đang `staged=true` (trong veto window, `cms.ts:275`) trừ khi nó đã được commit; revision staged chưa live SHALL bị từ chối với `{ errors: [{ code: 'REVISION_STAGED' }] }`.

### Requirement 4: Liệt kê và xem chi tiết Release

**User Story:** Là một editor/admin, tôi muốn xem danh sách các Release và chi tiết từng Release (gồm các item và phiên bản đã ghim), để review trước khi phát hành.

#### Acceptance Criteria

1. THE CMS SHALL expose endpoint authenticated `GET /api/v1/releases` trả `{ data: Release[], meta: PaginationMeta }`, hỗ trợ filter `?status=` và phân trang (cùng convention các list endpoint hiện có).
2. THE CMS SHALL expose endpoint authenticated `GET /api/v1/releases/:id` trả `{ data: Release & { items: Release_Item[] } }`.
3. THE Release_Service SHALL bao gồm trong chi tiết mỗi Release_Item: `collection`, `itemId`, `targetStatus`, `revisionId`, và (nếu đã publish) `Publish_Outcome`.
4. WHEN Release `:id` không tồn tại trong site, THE Release_Service SHALL trả HTTP 404 `{ errors: [{ code: 'RELEASE_NOT_FOUND' }] }`.
5. THE Release_Service SHALL scope mọi query theo `site_id`; không bao giờ trả Release của site khác.

### Requirement 5: Publish nguyên tử nhiều item (Atomicity)

**User Story:** Là một editor phát hành một chiến dịch, tôi muốn biết chính xác điều gì xảy ra khi một item trong Release không publish được, để Release không để hệ thống ở trạng thái nửa vời ngoài ý muốn.

#### Acceptance Criteria

1. THE Release_Service SHALL hỗ trợ `Atomicity_Mode` ∈ `{ all_or_nothing, best_effort }`, lưu trên Release (mặc định `all_or_nothing`).
2. WHERE `Atomicity_Mode='all_or_nothing'`, THE Release_Service SHALL thực thi toàn bộ thao tác publish trong một DB transaction Drizzle duy nhất; nếu bất kỳ Release_Item nào fail, THE Release_Service SHALL rollback toàn bộ và đặt `Release_Status='failed'`, trạng thái mọi item SHALL không đổi.
3. WHERE `Atomicity_Mode='best_effort'`, THE Release_Service SHALL cố publish từng item độc lập; nếu một số thành công và một số fail, THE Release_Service SHALL đặt `Release_Status='partially_failed'` và lưu `Publish_Outcome` per item.
4. WHEN tất cả Release_Item publish thành công (bất kể mode), THE Release_Service SHALL đặt `Release_Status='published'` và `publishedAt=now()`.
5. THE Release_Service SHALL ghi `Publish_Outcome` (`published | skipped | failed` + lý do) cho mỗi Release_Item ở cả hai mode, để chi tiết Release phản ánh kết quả per item.
6. WHEN một Release_Item trỏ tới item đã bị xoá (soft-deleted, `items.deletedAt` not null) tại thời điểm publish, THE Release_Service SHALL đánh dấu item đó `Publish_Outcome='skipped'` với lý do `ITEM_DELETED` (không coi là fail cứng ở `best_effort`; ở `all_or_nothing` SHALL khiến rollback).

### Requirement 6: Hẹn lịch publish (Scheduled Release)

**User Story:** Là một editor, tôi muốn hẹn một Release publish vào một ngày/giờ cụ thể, để chiến dịch lên sóng đúng thời điểm mà không cần ai trực tay bấm nút.

#### Acceptance Criteria

1. THE Release_Service SHALL chấp nhận `publishAt` (timestamp, nullable) trên Release; khi set một thời điểm tương lai, `Release_Status` SHALL chuyển sang `scheduled`.
2. WHEN `publishAt` được set cho thời điểm trong **quá khứ** lúc tạo/sửa, THE Release_Service SHALL từ chối với `{ errors: [{ code: 'PUBLISH_AT_IN_PAST' }] }` (không tự publish ngay; người dùng phải dùng Manual_Publish).
3. THE Release_Service SHALL cho phép gỡ lịch: PATCH `publishAt=null` trên Release `scheduled` SHALL chuyển nó về `draft`.
4. THE Release_Sweep SHALL chạy định kỳ (tái dùng `registerSchedulerWorker` trên queue `'content-scheduler'`, `scheduler-worker.ts:265-269`) và tìm các Release có `status='scheduled'` AND `publishAt <= now()` AND scoped per `site_id`.
5. THE Release_Sweep SHALL thực thi publish mỗi Release đến hạn qua cùng đường code của Manual_Publish (Req 5), để hành vi atomic/outcome đồng nhất giữa manual và scheduled.
6. THE Release_Sweep SHALL idempotent: dùng conditional UPDATE (`status != 'published'`) để hai tick chồng nhau hoặc retry không publish hai lần (cùng kỹ thuật `scheduler-worker.ts`).
7. WHERE `Maintenance_Window` được cấu hình trên Release và `now()` nằm ngoài cửa sổ cho phép, THE Release_Sweep SHALL hoãn publish tới tick kế tiếp trong cửa sổ thay vì publish ngay (mượn ngữ nghĩa `contentIntents.maintenanceWindow`, `content-os.ts:100`).
8. THE Release_Sweep SHALL dispatch revalidation cho các route bị ảnh hưởng sau publish (cùng cơ chế dispatch của Scheduler hiện có).

### Requirement 7: Manual Publish

**User Story:** Là một editor, tôi muốn bấm "Publish now" trên một Release, để phát hành ngay lập tức mọi item trong đó.

#### Acceptance Criteria

1. THE CMS SHALL expose endpoint authenticated `POST /api/v1/releases/:id/publish` thực thi publish ngay theo `Atomicity_Mode` của Release (Req 5) và trả `{ data: { status, outcomes: Publish_Outcome[] } }`.
2. WHEN Release `:id` đang `published`, THE Release_Service SHALL trả HTTP 409 `{ errors: [{ code: 'ALREADY_PUBLISHED' }] }` (idempotent — không publish lại).
3. WHEN Release `:id` rỗng (không có Release_Item), THE Release_Service SHALL trả HTTP 422 `{ errors: [{ code: 'EMPTY_RELEASE' }] }`.
4. THE Release_Service SHALL cho phép Manual_Publish trên Release đang `scheduled` (publish sớm hơn lịch); khi đó nó SHALL bỏ qua `publishAt` còn lại và publish ngay.
5. WHEN Manual_Publish thất bại một phần ở mode `best_effort`, THE Release_Service SHALL trả HTTP 207-style payload `{ data: { status: 'partially_failed', outcomes } }` (HTTP 200 với body phản ánh per-item, không phải lỗi toàn cục).

### Requirement 8: Tôn trọng Editorial Gate khi publish

**User Story:** Là một maintainer, tôi muốn Release không thể vượt mặt quy trình duyệt biên tập, để một item chưa được approve không bị phát hành lén qua Release.

#### Acceptance Criteria

1. WHEN publish một Release_Item lên `published` mà item thuộc collection có `editorialWorkflow=true` và item chưa ở trạng thái cho phép (`approved`/`scheduled`), THE Release_Service SHALL áp dụng cùng Editorial_Gate của `item-service.ts:717-736` và coi item đó là fail với lý do `EDITORIAL_GATE_REQUIRED`.
2. WHERE `Atomicity_Mode='all_or_nothing'` và bất kỳ item nào vi phạm Editorial_Gate, THE Release_Service SHALL rollback toàn bộ Release (`status='failed'`) và không publish item nào.
3. WHERE `Atomicity_Mode='best_effort'`, THE Release_Service SHALL skip/mark-fail item vi phạm gate và vẫn publish các item hợp lệ còn lại (`partially_failed`).
4. THE Release_Service SHALL tái dùng logic gate hiện có (không sao chép lại `assertEditorialGate`); publish đi qua hoặc gọi lại `ItemService` để mọi quy tắc validation/permission/hook của item được áp dụng nhất quán.

### Requirement 9: Xoá Release

**User Story:** Là một editor, tôi muốn xoá một Release nháp không còn cần, để dọn dẹp danh sách.

#### Acceptance Criteria

1. THE CMS SHALL expose endpoint authenticated `DELETE /api/v1/releases/:id` trả HTTP 204 khi thành công.
2. THE Release_Service SHALL xoá kèm mọi `Release_Item` của Release đó (cascade qua FK `release_items.releaseId`).
3. WHEN xoá một Release đang `scheduled`, THE Release_Service SHALL đảm bảo Release_Sweep không còn pick nó (xoá khỏi DB là đủ vì sweep query theo `status='scheduled'`).
4. THE Release_Service SHALL cho phép xoá Release ở mọi trạng thái; xoá một Release `published` SHALL chỉ xoá bản ghi Release (không revert nội dung item đã phát hành — xem open question rollback).
5. THE Release_Service SHALL scope DELETE theo `site_id`; không xoá được Release của site khác.

### Requirement 10: Circuit-breaker & xử lý lỗi lặp khi scheduled publish

**User Story:** Là một maintainer, tôi muốn một scheduled Release liên tục fail không bị quét retry vô hạn, để tránh tiêu hao tài nguyên và log nhiễu.

#### Acceptance Criteria

1. WHEN một Release scheduled fail publish (toàn bộ ở `all_or_nothing`), THE Release_Service SHALL giữ `Release_Status='failed'` và ghi `statusReason` (mượn pattern `contentIntents.statusReason`, `content-os.ts:104`).
2. THE Release_Sweep SHALL không tự retry một Release đã `failed`; người dùng phải sửa và đặt lại lịch (PATCH `publishAt`) để chuyển nó về `scheduled`.
3. WHEN Release_Sweep gặp lỗi hệ thống thoáng qua (transient — ví dụ DB timeout) trên một tick, THE Release_Sweep SHALL để Release ở `scheduled` (không đổi sang `failed`) để tick kế tiếp thử lại, phân biệt với lỗi nghiệp vụ (gate/validation) là cố định.
4. THE Release_Sweep SHALL bound số Release xử lý mỗi tick (batch limit) để một tick không chạy vô hạn (mượn ngữ nghĩa budget của reconciler).

### Requirement 11: Multi-tenancy & ID conventions

**User Story:** Là một maintainer, tôi muốn Release tuân thủ các quy tắc non-negotiable của LumiBase, để không phá vỡ multi-tenancy và provenance.

#### Acceptance Criteria

1. THE `releases` table và `release_items` table SHALL có cột `site_id` (FK tới `sites`, `onDelete: 'cascade'`); mọi query SHALL `.where(eq(table.siteId, siteId))`.
2. THE Release_Service SHALL nhận `siteId` qua constructor/deps (như `ItemService`) và không bao giờ truy cập site khác.
3. THE `releases.id` và `release_items.id` SHALL dùng `nanoid()` (helper `id()`); KHÔNG serial.
4. THE Release_Service SHALL dùng runtime abstraction cho queue (`QueueProvider` qua deps) và cache; KHÔNG import CF bindings trong business logic.
5. THE Release endpoints SHALL trả format `{ data: T, meta? }` hoặc `{ errors: [...] }` nhất quán toàn API.

### Requirement 12: Audit & provenance

**User Story:** Là một admin, tôi muốn mọi lần publish Release được ghi audit, để truy vết ai phát hành gì và khi nào.

#### Acceptance Criteria

1. WHEN một Release publish thành công, THE CMS SHALL ghi Audit_Log entry `release_published` với metadata `{ releaseId, itemCount, mode, trigger: 'manual' | 'scheduled', publishedBy }` (KHÔNG ghi nội dung item chi tiết).
2. WHEN một Release publish thất bại hoặc một phần, THE CMS SHALL ghi `release_publish_failed` / `release_partially_published` với `{ releaseId, failedCount, reasons[] }` (không kèm secret/nội dung nhạy cảm).
3. THE Release_Service SHALL ghi `trigger='manual'` cho Manual_Publish và `trigger='scheduled'` cho Release_Sweep, để phân biệt nguồn phát hành trong audit.
4. THE Audit_Log SHALL dùng cùng `AuditLogger` mà Scheduler đang dùng (`scheduler-worker.ts:252`); không thêm cơ chế audit mới.

### Requirement 13: HITL / Autonomy boundary

**User Story:** Là một maintainer, tôi muốn xác định rõ Release có cần human-in-the-loop approval (`ai_approvals`) hay không, để tuân thủ quy tắc earned-autonomy của LumiBase.

#### Acceptance Criteria

1. THE Content Releases feature SHALL coi publish là một **hành động do người khởi tạo (Manual_Publish) hoặc do lịch người đặt (Scheduled_Publish)**, KHÔNG phải một agent skill tự sinh.
2. THEREFORE THE Release_Service SHALL không yêu cầu ghi `ai_approvals` cho publish, vì quy tắc HITL của CLAUDE.md áp cho skill có capability `schema:write` hoặc tên bắt đầu `delete` do **agent** chạy — không áp cho hành động người dùng.
3. WHERE trong tương lai một agent đề xuất tạo/publish Release thay người, THAT path SHALL đi qua `ai_approvals` như mọi skill agent khác; v1 không mở path này (ghi nhận để Setup Impact và open question).
4. THE editorial gate (Req 8) SHALL vẫn là hàng rào duyệt nội dung cho Release, độc lập với `ai_approvals`.

### Requirement 14: Setup Impact Registry

**User Story:** Là một maintainer, tôi muốn feature này được rà soát theo Setup Impact Registry, để biết nó có yêu cầu khởi tạo gì khi setup instance mới không.

#### Acceptance Criteria

1. WHEN feature content-releases hoàn thành, THE feature SHALL được rà soát theo 6 câu hỏi trong `.kiro/specs/admin-setup-wizard/setup-impact.md` và ghi một dòng vào bảng Registry (kể cả `n/a`).
2. THE rà soát SHALL xác định: feature thêm hai bảng mới (`releases`, `release_items`) nhưng **rỗng khi init** (không seed), không thêm settings key bắt buộc, không cần bước UI wizard mới, không capability flag mới, và không cần backfill (instance hiện hữu chỉ thiếu bảng → migration `CREATE TABLE IF NOT EXISTS` lấp đầy, dữ liệu cũ không cần đổi).
3. THE migration thêm hai bảng SHALL theo quy ước repo: migrations 0012+ là **hand-written** (không drizzle-kit generate) kèm sửa journal.
