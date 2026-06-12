# Requirements Document — Content OS UI (Mission Control v2)

## Introduction

Spec nâng cấp bề mặt người dùng của Content OS trong Studio. Backend Content OS đã hoàn chỉnh (spec [`content-os`](../content-os/requirements.md), tasks 1–20 ✅) và Mission Control v1 đã tồn tại (`apps/studio/src/modules/mission-control/`) ở dạng 1 trang 5 tab. Spec này biến v1 thành **operator console thật sự**: dashboard tổng quan, inbox có diff thực, provenance hiển thị trên content editor, intent có trang chi tiết, và exception count hiện diện toàn Studio.

Phạm vi: **UI-only** — không tạo endpoint backend mới; chỉ dùng các API đã có trong `mission-control/api.ts` và items/revisions/pins API hiện hành. SDK chỉ được mở rộng type (backward-compatible).

## Glossary

- **Mission_Control**: Module Studio tại `/mission-control` — operator console của Content OS.
- **Exception**: Một mục cần con người: approval chờ quyết, staging trong Veto_Window, incident mở, Intent ở trạng thái `error`.
- **Inbox_Entry**: Một Exception đã chuẩn hoá (kind, urgency, id ổn định) để hiển thị/sắp xếp/deep-link.
- **Staged_Change**: Revision staging do agent tạo ở L3, chờ auto-commit tại `autoCommitAt` trừ khi bị veto.
- **Field_Diff**: Diff mức field (before/after per top-level key) — render bằng component `RevisionsDiff` hiện có.
- **Provenance**: Các cột lai lịch trên revision (`authorType`, `createdByRunId`, `model`, `constitutionHash`, `confidence`, `sources`) — backend đã trả qua `GET /items/:collection/:id/revisions`.
- **Sub_Route**: Route con của Mission Control (`/inbox`, `/intents`, `/trust`, `/constitution`).
- **Admin_Base**: Prefix `/$adminPath` tuỳ chọn — mọi route Studio có 2 biến thể (có/không prefix).

## Requirements

### Requirement 1: Điều hướng sub-route — URL là nguồn truth

**User Story:** Là một người vận hành, tôi muốn mỗi khu vực của Mission Control có URL riêng, để tôi bookmark/chia sẻ được và notification deep-link thẳng vào đúng chỗ.

#### Acceptance Criteria

1. THE Mission_Control SHALL có các Sub_Route: `/mission-control` (dashboard), `/mission-control/inbox`, `/mission-control/intents`, `/mission-control/intents/$id`, `/mission-control/trust`, `/mission-control/constitution` — mỗi route có cả hai biến thể Admin_Base.
2. THE Mission_Control SHALL render mọi Sub_Route trong một layout chung có sub-navigation; mục đang active xác định từ URL (không dùng `useState` tab).
3. THE Mission_Control layout header SHALL luôn hiển thị: nút "Compose intent" (primary CTA) và nút Kill switch — Kill switch mở panel 4 mức hiện có dưới dạng modal, truy cập được từ mọi Sub_Route mà không điều hướng.
4. WHEN người dùng mở `/mission-control/inbox?entry=<entryId>`, THE Mission_Control SHALL tự chọn và hiển thị chi tiết Inbox_Entry tương ứng nếu còn tồn tại.

### Requirement 2: Dashboard tổng quan

**User Story:** Là một người vận hành, tôi muốn mở Mission Control là thấy ngay "hệ có ổn không, có gì cần tôi không" trong vài giây, để tôi quyết định có cần can thiệp hay không.

#### Acceptance Criteria

1. THE Dashboard (route `/mission-control`) SHALL hiển thị hàng stat cards: (a) số exception chờ người quyết, (b) countdown của Staged_Change gần auto-commit nhất, (c) SLO health tổng hợp (% trung bình trên các intent active), (d) số freeze đang active, (e) số incident đang mở.
2. Mỗi stat card SHALL điều hướng đến Sub_Route tương ứng khi click ((a)→inbox, (b)→inbox, (c)→intents, (d)→mở Kill switch modal, (e)→inbox).
3. THE Dashboard SHALL hiển thị preview Exception Inbox (tối đa 5 entry khẩn nhất, hành động inline giữ nguyên) kèm link "Open inbox".
4. THE Dashboard SHALL hiển thị bảng SLO health per intent (tái dùng dữ liệu/logic hiện có) kèm link sang trang intents.
5. WHEN không có exception nào, THE Dashboard SHALL hiển thị trạng thái inbox-zero rõ ràng.

### Requirement 3: Inbox split-pane với Field_Diff

**User Story:** Là một biên tập viên, tôi muốn duyệt thay đổi staged của agent như review một PR — thấy diff từng field, không phải đọc JSON thô, để tôi veto/chấp nhận trong vài giây với đầy đủ thông tin.

#### Acceptance Criteria

1. THE Inbox page (`/mission-control/inbox`) SHALL hiển thị split-pane: danh sách Inbox_Entry bên trái (sắp theo urgency), chi tiết entry được chọn bên phải; chọn entry cập nhật search param `entry`.
2. WHEN entry là Staged_Change, THE detail pane SHALL render Field_Diff: before = data hiện hành của item (fetch qua items API), after = before áp patch (shallow merge) — dùng `RevisionsDiff`, không hiển thị JSON thô mặc định.
3. IF không fetch được item hiện hành, THEN THE detail pane SHALL fallback hiển thị các field trong patch ở trạng thái "added" kèm thông báo không tải được bản hiện hành.
4. THE Staged_Change detail SHALL hiển thị: collection/itemId (link đến item editor), agentRole, countdown đến `autoCommitAt`, và nút Veto kèm ô lý do (lý do tuỳ chọn, được gửi vào API veto).
5. Mỗi Inbox_Entry SHALL có id ổn định dạng `<kind>:<sourceId>` dùng cho deep-link (Req 1.4) và React key (thay index hiện tại).
6. Hành động inline (approve/reject/veto/resume) trên danh sách SHALL giữ nguyên hành vi hiện có — split-pane là bổ sung, không thay thế.

### Requirement 4: Provenance trên content editor

**User Story:** Là một quản trị viên, tôi muốn nhìn vào một item là biết revision nào do người, revision nào do agent tạo (model gì, run nào, pass constitution nào, confidence bao nhiêu), để lai lịch nội dung hữu hình thay vì chỉ nằm trong DB.

#### Acceptance Criteria

1. THE SDK `RevisionRow` type SHALL được mở rộng với các trường optional: `authorType`, `createdByRunId`, `model`, `constitutionHash`, `confidence`, `sources`, `staged`, `autoCommitAt` — backward-compatible, không đổi runtime.
2. THE Revisions panel (item editor) SHALL hiển thị badge `human`/`agent` trên mỗi revision trong danh sách.
3. WHEN revision được chọn có `authorType='agent'`, THE Revisions panel SHALL hiển thị khối Provenance: model, run id, constitution hash (rút gọn), confidence — chỉ hiển thị trường có giá trị.
4. THE Item editor header SHALL hiển thị badge provenance của revision mới nhất (nếu có revision), tooltip nêu chi tiết.

### Requirement 5: Trang Intents — danh sách và chi tiết

**User Story:** Là một quản trị viên, tôi muốn xem từng intent đang quản gì (rules, budget, mức tự trị), đang lệch chuẩn ở đâu (drift), và tạm dừng/tiếp tục nó, để tôi "steer" hệ thống mà không cần đọc DB.

#### Acceptance Criteria

1. THE Intents page (`/mission-control/intents`) SHALL liệt kê intents với SLO health per intent (chuyển bảng SLO health hiện có sang đây); mỗi row link đến trang chi tiết.
2. THE Intent detail page (`/mission-control/intents/$id`) SHALL hiển thị: name, collection, status (+statusReason), schedule, autonomyCap (kèm nhãn mức L0–L4), budget, và danh sách rules dạng card (ruleType + tham số) thay vì JSON thô.
3. THE Intent detail page SHALL liệt kê drifts của intent với ruleType/ruleKey/status; drift row có link đến item editor của item tương ứng.
4. THE Intent detail page SHALL có nút Pause (gọi kill-switch scope `intent`) khi intent `active`, và nút Resume (gọi resume API) khi intent `paused`/`error`.
5. IF intent id trong URL không tồn tại trong site hiện tại, THEN THE page SHALL hiển thị not-found rõ ràng kèm link quay về danh sách.

### Requirement 6: Exception badge trên AppShell

**User Story:** Là một biên tập viên đang làm việc ở module khác, tôi muốn thấy số exception đang chờ ngay trên sidebar, để tôi không bỏ lỡ veto window đang đếm ngược.

#### Acceptance Criteria

1. THE AppShell sidebar SHALL hiển thị badge số lượng trên icon Mission Control = tổng (approvals pending + Staged_Change + incidents mở + intents `error`).
2. THE badge SHALL ẩn hoàn toàn khi tổng bằng 0 hoặc khi dữ liệu chưa/không tải được (không hiển thị "0" hay trạng thái lỗi).
3. THE badge data SHALL được poll với chu kỳ ≥ 60 giây và dùng chung query cache với Mission Control (không nhân đôi request khi đang ở trong Mission Control).
4. THE badge SHALL hiển thị "9+" khi tổng vượt 9 để giữ kích thước icon.

### Requirement 7: Tương thích và chất lượng

**User Story:** Là một maintainer, tôi muốn lần tái cấu trúc UI này không phá hành vi đã có và giữ chuẩn chất lượng repo, để rollout an toàn.

#### Acceptance Criteria

1. THE thay đổi SHALL không thêm endpoint backend mới; mọi dữ liệu lấy qua API đã tồn tại. Ngoại lệ duy nhất: Requirement 8 (enrich response của `GET /agent/staged` — bổ sung field, không đổi field đã có).
2. Toàn bộ test hiện có của Studio SHALL pass sau tái cấu trúc; component test mới SHALL cover: sắp xếp/đếm Inbox_Entry, Field_Diff của Staged_Change (kể cả fallback), provenance badge, pause/resume trên intent detail.
3. `pnpm typecheck` SHALL pass; không dùng `any`; dùng `import type` cho type-only imports.
4. Sub-navigation và các nút hành động SHALL có aria attributes tương đương chuẩn hiện có của module (aria-current, aria-label).
5. THE các component bị thay thế (tab navigation cũ) SHALL được gỡ bỏ — không để chết code song song hai hệ điều hướng.

### Requirement 8: Enrich `GET /agent/staged` cho diff review

**User Story:** Là một biên tập viên, tôi muốn danh sách staged change chứa đủ ngữ cảnh (collection, item, patch, agent), để inbox hiển thị diff thật thay vì `?/?` — hiện `listPending` trả raw `agent_approvals` vốn không có các field này dù staging revision (qua `subjectId`) có đủ.

#### Acceptance Criteria

1. THE `VetoService.listPending` SHALL join staging revision (`subjectId` → `revisions.id`) và collection để mỗi phần tử trả thêm: `approvalId` (= approval id), `collection` (tên collection), `itemId`, `patch` (từ `delta.patch`), `agentRole` (= `requestedByAgent`) — các field của approval giữ nguyên.
2. IF staging revision đã bị xoá/không tìm thấy, THEN phần tử SHALL vẫn được trả về với các field enrich là `null` — không làm rỗng danh sách vì một staging hỏng.
3. THE enrichment SHALL scope theo `siteId` trên mọi join (bất biến content-os Req 17.1).
4. Service test SHALL cover: shape enrich đầy đủ và trường hợp staging mất (8.2).

### Requirement 9: Seed demo Content OS

**User Story:** Là một developer/reviewer, tôi muốn một seed script dựng dữ liệu demo (intents, drifts, staged change, incidents, grants, constitution, revisions có provenance), để xem Mission Control v2 hoạt động trên môi trường local thay vì "Inbox zero" trống trơn.

#### Acceptance Criteria

1. THE seed script SHALL chạy được qua `pnpm --filter @lumibase/database seed:content-os-demo`, theo pattern `seed-dev.ts` hiện có (id ổn định, upsert, re-run an toàn, yêu cầu `DATABASE_URL`).
2. THE seed SHALL tạo trên `site_demo`: 1 collection demo + items; 2 content intents (1 active có drift mở + resolved, 1 `error` có `statusReason`); 1 staged revision + approval `kind='veto'` đang trong window; ≥2 incidents mở; ≥3 autonomy grants ở các level khác nhau; 1 constitution active; revisions có provenance agent trên item demo.
3. THE seed SHALL không đụng dữ liệu ngoài các id ổn định nó sở hữu (prefix `cosdemo_`).

### Requirement 10: Activity feed trên Dashboard

**User Story:** Là một người vận hành, tôi muốn thấy dòng hoạt động gần đây của agent (run nào, vai gì, model gì, kết quả ra sao, phục vụ goal nào) ngay trên dashboard, để cảm nhận được hệ thống đang "sống" mà không phải đào bảng.

#### Acceptance Criteria

1. THE Dashboard SHALL hiển thị Activity feed: các run mới nhất (tối đa 12) từ `GET /api/v1/agent/runs`, mỗi dòng gồm agent, model, status (badge màu theo trạng thái), tiêu đề goal (join client-side từ `GET /api/v1/agent/goals`) và thời gian.
2. THE feed SHALL poll cùng chu kỳ với dashboard (≥60s) và có trạng thái loading/empty rõ ràng.
3. WHEN một run thuộc goal không còn trong trang goals trả về, THE feed SHALL hiển thị run với goal id rút gọn thay vì bỏ dòng.

### Requirement 11: Intent Composer v2 — rule cards

**User Story:** Là một biên tập viên, tôi muốn duyệt và chỉnh intent đã compile bằng form có cấu trúc theo từng rule, để xác nhận desired state mà không phải đọc/sửa JSON thô.

#### Acceptance Criteria

1. THE Composer SHALL yêu cầu chọn `collection` (load từ schema API, có fallback nhập tay khi load lỗi) trước khi compile, và gọi `POST /intents/compile` với body `{description, collection}` — sửa lỗi v1 gửi `{text}` không đúng contract.
2. THE Composer SHALL render `rules` đã compile thành rule cards theo đúng 6 loại của `intent-rule.v1`; mỗi card có form tham số đúng loại (fields/locales nhập dạng danh sách phân tách dấu phẩy; số dùng number input), nút xoá card và menu "Add rule" với default hợp lệ per loại.
3. THE Composer SHALL có form metadata: name, schedule (cron), autonomyCap (0–4 kèm nhãn mức), budget (maxGoalsPerCycle/maxWritesPerMinute/maxCostUsd với default theo schema backend).
4. THE Composer SHALL hiển thị `warnings` từ compile response (nếu có) phía trên rule cards.
5. THE Composer SHALL giữ lối thoát raw JSON (toggle) đồng bộ hai chiều với form — form là đường chính, JSON là secondary path (kế thừa content-os Req 16.5).
6. WHEN người dùng confirm, THE Composer SHALL gọi create intent với object có `rules` là array đã chỉnh (không phải chuỗi JSON), và validation lỗi từ backend hiển thị tại chỗ.

### Requirement 12: Goal tree — toà soạn agent

**User Story:** Là một quản trị viên, tôi muốn nhìn thấy cây phân rã goal (Planner → sub-goals theo role) với trạng thái từng nhánh, để hiểu toà soạn agent đang tổ chức công việc thế nào.

#### Acceptance Criteria

1. THE Mission_Control SHALL có Sub_Route `/mission-control/goals` (cả hai biến thể Admin_Base, thêm mục "Goals" vào sub-nav) hiển thị cây goal dựng từ `parentGoalId` của `GET /api/v1/agent/goals`.
2. Mỗi node SHALL hiển thị: title, badge role (`agentRole`, fallback `assigneeAgent`), badge status, origin (user/reconciler/planner/flow) và trạng thái run mới nhất của goal đó (join client-side từ `GET /api/v1/agent/runs`).
3. WHEN goal có `intentId`, THE node SHALL link đến trang intent detail tương ứng.
4. THE cây SHALL render goal mồ côi (có `parentGoalId` không nằm trong trang kết quả) như root — không bỏ rơi node nào.

### Requirement 13: Icon convention

**User Story:** Là một designer, tôi muốn hệ icon nhất quán dùng lucide dạng fill, để UI mới có ngôn ngữ hình ảnh đồng nhất.

#### Acceptance Criteria

1. THE Studio SHALL có helper `FillIcon` render lucide icon với `fill="currentColor"`; mọi icon trang trí chính trong các surface mới của spec này (activity feed, composer v2, goal tree) dùng helper này.
