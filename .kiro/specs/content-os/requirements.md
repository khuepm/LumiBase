# Requirements Document — Content OS

## Introduction

Tài liệu yêu cầu cho việc nâng cấp LumiBase từ Headless CMS có AI Copilot thành **Content Operating System (Content OS)** — hệ điều hành nội dung nơi AI agent là lực lượng vận hành chính, con người giữ bốn quyền kiểm soát (observe, steer, override, stop). Spec này hiện thực hoá tầm nhìn trong `docs/en/ai-native-vision.md`, xây trực tiếp trên Agent Harness Layer hiện có (`agent_goals/runs/plans/tools/permissions/tool_calls/approvals/artifacts/evaluations/memory`).

Phạm vi gồm 5 nhóm năng lực (tương ứng Phase A–E của vision):
- **A. Foundation** — thật hoá skill, run qua queue, MCP server, provenance.
- **B. Reconciliation** — Content SLO, drift detection, reconciler, override-is-law, load-aware autonomy.
- **C. Multi-agent org** — phân rã goal, agent roles, agent-as-reviewer.
- **D. Trust ledger** — thang tự trị L0–L4, promotion/demotion, veto window, kill switch.
- **E. Mission Control** — exception inbox, constitution editor, intent composer.

## Glossary

- **Content_OS**: Tổng thể hệ thống mô tả trong spec này.
- **Harness**: Agent Harness Layer hiện có — lớp thực thi có quản trị (capability, risk, budget, audit).
- **Intent**: Bản ghi `content_intents` — khai báo desired state (SLO) cho nội dung của một collection, kèm schedule, budget và trần tự trị.
- **Drift**: Sai lệch giữa trạng thái nội dung thực tế và Intent (ví dụ: thiếu bản dịch, content stale, broken link).
- **Drift_Detector**: Job phát hiện Drift, chạy theo lịch qua Flows engine.
- **Reconciler**: Thành phần chuyển Drift thành `agent_goals` và điều phối thực thi qua Harness.
- **Pin**: Đánh dấu field-level rằng con người đã sửa tay — agent không được ghi đè (Luật số 0).
- **Provenance**: Metadata lai lịch trên mỗi revision: ai/agent nào tạo, model, nguồn, constitution hash, confidence.
- **Autonomy_Grant**: Bản ghi `agent_autonomy_grants` — mức tự trị (L0–L4) của một agent role trên một capability tại một site.
- **Trust_Ledger**: Tập dữ liệu evaluation/approval/incident dùng để promote/demote Autonomy_Grant.
- **Veto_Window**: Cơ chế L3 — hành động nguy hiểm thực thi vào staging revision, tự commit sau T giờ nếu không bị con người phủ quyết.
- **Constitution**: Tập evaluator có version + hash per site, mã hoá gu biên tập/brand voice/ràng buộc pháp lý thành kiểm tra máy chạy được.
- **Agent_Role**: Định nghĩa một vai agent (Writer, Translator, Reviewer…) với capability grant hẹp riêng.
- **Planner**: Agent role phân rã goal thành sub-goals và gán cho Agent_Role phù hợp.
- **Reviewer_Agent**: Agent_Role có capability `review:*`, được quyền quyết approval rủi ro thấp.
- **Kill_Switch**: Cơ chế dừng theo 4 mức: run → intent → role → site.
- **Load_Guard**: Cơ chế load-aware autonomy — write rate budget, maintenance window, backpressure từ anomaly module.
- **MCP_Server**: Bề mặt Model Context Protocol expose tool registry cho agent bên ngoài.
- **Mission_Control**: Giao diện Studio mặc định cho giám sát/can thiệp thay vì nhập liệu.
- **Site**: Đơn vị multi-tenancy — mọi bảng mới đều scope theo `siteId`.

## Requirements

### Requirement 1: Provenance và authorType trên revisions

**User Story:** Là một quản trị viên, tôi muốn mọi revision nội dung ghi rõ lai lịch (người hay agent nào tạo, bằng model gì, từ nguồn nào), để tôi truy được trách nhiệm của từng byte nội dung.

#### Acceptance Criteria

1. THE Content_OS SHALL bổ sung vào bảng revisions các cột: `authorType` (text, NOT NULL, `'human' | 'agent'`, default `'human'`), `createdByRunId` (text, nullable, FK → agent_runs SET NULL), `model` (text, nullable), `constitutionHash` (text, nullable), `sources` (jsonb, nullable), `confidence` (real, nullable, 0–1).
2. WHEN một agent ghi nội dung qua Harness, THE Content_OS SHALL ghi revision với `authorType='agent'` và `createdByRunId` trỏ đúng run đang thực thi.
3. WHEN con người ghi nội dung qua Studio hoặc API với session người dùng, THE Content_OS SHALL ghi revision với `authorType='human'`.
4. THE Content_OS SHALL expose provenance của revision hiện hành qua Delivery API khi request có query `?provenance=true`, không bao gồm thông tin bí mật (API key, prompt nội bộ).
5. THE Content_OS SHALL bổ sung cột `pinnedFields` (jsonb, default `[]`) trên bảng items để lưu danh sách field bị Pin.

### Requirement 2: Thật hoá các skill còn stub

**User Story:** Là một người dùng Copilot, tôi muốn các skill AI (`aiSuggestField`, `aiContentAssist`, `generateAppSpec`, `generateApiDocs`, `generateSeedData`) chạy bằng LLM thật thay vì stub, để output có giá trị sử dụng thực tế.

#### Acceptance Criteria

1. WHEN `LLM_PROVIDER` được cấu hình hợp lệ, THE Harness SHALL thực thi 5 skill nêu trên qua `llm-provider` thật, kèm RAG context từ `embedding-service` khi skill khai báo cần.
2. IF `LLM_PROVIDER` không được cấu hình hoặc provider lỗi, THEN THE Harness SHALL trả về lỗi có mã rõ ràng (không silent fallback sang stub) và ghi tool_call với status lỗi.
3. THE Harness SHALL ghi `model` và token/cost ước tính vào `agent_runs` metrics cho mọi lần gọi LLM.
4. WHEN skill sinh artifact (`generateAppSpec`, `generateApiDocs`, `generateSeedData`), THE Harness SHALL lưu output thành `agent_artifacts` có hash, đi qua evaluation gate hiện có trước khi publish.

### Requirement 3: Run qua queue cho tác vụ dài

**User Story:** Là một người vận hành, tôi muốn các run vượt giới hạn request runtime được thực thi qua queue, để goal lớn (sinh app, xử lý batch) không bị đứt giữa chừng.

#### Acceptance Criteria

1. THE Content_OS SHALL hỗ trợ run state machine: `queued → running → awaiting_approval → succeeded | failed | cancelled`, lưu trong `agent_runs.status`.
2. WHEN một goal được tạo với `execution: 'async'`, THE Content_OS SHALL enqueue run qua `QueueProvider` của runtime abstraction và trả về `runId` ngay lập tức.
3. IF runtime không có queue adapter, THEN THE Content_OS SHALL từ chối async execution với lỗi rõ ràng và vẫn cho phép sync execution trong giới hạn request.
4. WHEN run ở trạng thái `awaiting_approval` và approval được quyết, THE Content_OS SHALL resume run từ đúng bước đang chờ, không chạy lại các tool call đã hoàn thành.
5. THE Content_OS SHALL cho phép cancel một run đang `queued` hoặc `running`; cancel có hiệu lực tại tool-call boundary kế tiếp.

### Requirement 4: MCP Server

**User Story:** Là một developer dùng AI agent bên ngoài (Claude Code, agent của khách hàng), tôi muốn thao tác CMS qua chuẩn MCP, để agent ngoài là citizen hạng nhất nhưng vẫn chịu đầy đủ quản trị của Harness.

#### Acceptance Criteria

1. THE MCP_Server SHALL được mount tại `/api/v1/mcp` và expose các tool từ `agent_tools` registry đang `enabled` của site hiện tại.
2. WHEN một MCP client gọi tool, THE MCP_Server SHALL thực thi qua đúng codepath Harness (capability check, risk policy, budget, audit) như agent nội bộ — không có đường tắt.
3. THE MCP_Server SHALL xác thực bằng token có capability; token không có capability của tool thì call bị từ chối với lý do ghi vào `agent_tool_calls`.
4. WHEN tool bị Harness phân loại dangerous và autonomy hiện hành yêu cầu duyệt, THE MCP_Server SHALL trả về trạng thái `pending_approval` kèm `approvalId` thay vì block chờ.
5. THE Content_OS SHALL phục vụ `llms.txt` per site tại đường dẫn public, liệt kê các bề mặt delivery cho content consumer là agent.

### Requirement 5: Content Intents (SLO)

**User Story:** Là một quản trị viên, tôi muốn khai báo trạng thái mong muốn của nội dung (SLO) cho từng collection, để hệ thống tự duy trì nội dung đạt chuẩn thay vì tôi phải rà tay.

#### Acceptance Criteria

1. THE Content_OS SHALL lưu Intent trong bảng `content_intents` với các trường: id (nanoid), siteId (FK → sites CASCADE), name, collection, `rules` (jsonb — danh sách rule khai báo), `schedule` (cron), `budget` (jsonb — maxGoalsPerCycle, maxWritesPerMinute, maxCostUsd), `autonomyCap` (int 0–4), `maintenanceWindow` (jsonb, nullable), `status` (`active | paused | error`), createdAt/updatedAt.
2. THE Content_OS SHALL cung cấp CRUD API `/api/v1/agent/intents` scope theo siteId, yêu cầu capability `intents:write` cho create/update/delete.
3. WHEN Intent được tạo từ mô tả ngôn ngữ tự nhiên, THE Content_OS SHALL dùng LLM compile thành `rules` jsonb và trả về bản compile để người dùng xác nhận trước khi lưu — không tự kích hoạt.
4. THE Content_OS SHALL validate `rules` theo JSON Schema đã đăng ký; rule không hợp lệ bị từ chối khi lưu.
5. WHEN Intent `status='paused'`, THE Reconciler SHALL không sinh goal mới từ Intent đó; goal đang chạy được phép chạy nốt.

### Requirement 6: Drift detection

**User Story:** Là một quản trị viên, tôi muốn hệ thống tự phát hiện nội dung lệch chuẩn (stale, thiếu field, thiếu bản dịch, broken link, lệch glossary), để sai lệch được xử lý như sự cố thay vì chờ ai đó tình cờ thấy.

#### Acceptance Criteria

1. THE Drift_Detector SHALL chạy theo `schedule` của Intent thông qua Flows engine (trigger schedule) và chỉ quét items thuộc siteId + collection của Intent.
2. THE Drift_Detector SHALL hỗ trợ tối thiểu các loại rule: `required_fields`, `freshness` (maxAgeDays), `translations` (locales bắt buộc), `link_health`, `field_constraint` (min/max length, pattern), `glossary_compliance`.
3. WHEN phát hiện Drift, THE Drift_Detector SHALL sinh bản ghi drift có `fingerprint` định danh duy nhất theo (intentId, itemId, ruleType, ruleKey).
4. THE Drift_Detector SHALL bỏ qua field nằm trong `pinnedFields` của item — field bị Pin không bao giờ tạo Drift.
5. THE Drift_Detector SHALL hoàn thành một chu kỳ quét trong budget thời gian của Intent; vượt budget thì dừng, ghi partial result và tiếp tục ở chu kỳ sau.

### Requirement 7: Reconciler

**User Story:** Là một quản trị viên, tôi muốn Drift tự động được chuyển thành goal cho agent xử lý trong giới hạn tự trị tôi đã đặt, để nội dung tự hội tụ về chuẩn.

#### Acceptance Criteria

1. WHEN có Drift mới, THE Reconciler SHALL tạo `agent_goals` tương ứng, dedupe theo `fingerprint` — Drift trùng fingerprint với goal đang `open/running` không tạo goal mới.
2. THE Reconciler SHALL gán goal cho Agent_Role phù hợp với loại rule (ví dụ `translations` → Translator) và giới hạn autonomy thực thi bằng `min(autonomyCap của Intent, Autonomy_Grant hiện hành)`.
3. WHEN goal từ Reconciler thất bại N lần liên tiếp (N cấu hình được, default 3), THE Reconciler SHALL pause Intent (`status='error'`), mở incident và notify.
4. THE Reconciler SHALL ghi mọi goal tự sinh với `origin='reconciler'` và tham chiếu `intentId` + `driftFingerprint` để audit.
5. THE Reconciler SHALL không sinh quá `budget.maxGoalsPerCycle` goal trong một chu kỳ; phần dư để lại chu kỳ sau theo thứ tự ưu tiên rule.

### Requirement 8: Override-is-law (Luật số 0)

**User Story:** Là một biên tập viên, tôi muốn mọi sửa tay của tôi được tôn trọng tuyệt đối — agent không bao giờ ghi đè, để công cụ luôn theo ý tôi.

#### Acceptance Criteria

1. WHEN con người sửa một field của item đang thuộc phạm vi một Intent active, THE Content_OS SHALL thêm field đó vào `pinnedFields` của item (mặc định Pin).
2. WHEN Pin được tạo do human edit, THE Content_OS SHALL hỏi người sửa: "ngoại lệ một lần (giữ Pin) hay luật mới (gợi ý cập nhật Intent/Constitution)?" — câu hỏi không chặn việc lưu; không trả lời thì giữ Pin.
3. THE Harness SHALL từ chối mọi tool call của agent ghi vào field nằm trong `pinnedFields`, với denial reason `pinned_by_human` ghi vào `agent_tool_calls`.
4. THE Content_OS SHALL cho phép người có quyền gỡ Pin (release) qua API và UI; thao tác gỡ Pin được ghi audit với actor.
5. THE Content_OS SHALL hiển thị trạng thái Pin ở mức field trong Studio item editor.
6. WHEN một staged commit (Veto_Window) đụng field vừa bị Pin sau khi staging được tạo, THE Content_OS SHALL huỷ phần commit đụng field đó và giữ nguyên giá trị của con người.

### Requirement 9: Load-aware autonomy (Load_Guard)

**User Story:** Là một người vận hành hạ tầng, tôi muốn hoạt động tự trị của agent không gây cache churn, quá tải DB hay tranh tài nguyên với traffic người dùng thật, để autonomy không trở thành nguồn sự cố mới.

#### Acceptance Criteria

1. THE Harness SHALL gom (coalesce) các write của một run theo collection và invalidate cache theo tag đúng một lần cho mỗi (run, collection) thay vì mỗi write.
2. THE Reconciler SHALL chỉ thực thi goal của Intent trong `maintenanceWindow` nếu Intent có khai báo; ngoài window, goal xếp hàng chờ.
3. THE Harness SHALL enforce `budget.maxWritesPerMinute` per Intent; vượt ngưỡng thì run tạm dừng tại tool-call boundary và resume khi còn quota.
4. WHEN anomaly module phát signal quá tải (theo ngưỡng cấu hình: RPS, DB latency, cache hit-rate), THE Load_Guard SHALL hạ tốc hoặc pause toàn bộ run có `origin='reconciler'` của site đó và mở incident; run do người trực tiếp kích hoạt không bị pause tự động.
5. WHEN tải trở về dưới ngưỡng trong khoảng thời gian hold-down cấu hình được, THE Load_Guard SHALL tự resume các run bị pause và ghi sự kiện backpressure vào metrics.

### Requirement 10: Multi-agent delegation và Agent Roles

**User Story:** Là một quản trị viên, tôi muốn goal lớn được phân rã cho các agent vai hẹp (Writer, Translator, Reviewer…), để trách nhiệm cô lập được và một agent bị lỗi/bị tiêm prompt không kéo sập phạm vi khác.

#### Acceptance Criteria

1. THE Content_OS SHALL bổ sung `parentGoalId` (nullable, self-FK) vào `agent_goals`; sub-goal kế thừa siteId và không được vượt budget còn lại của goal cha.
2. THE Content_OS SHALL lưu Agent_Role trong bảng `agent_roles`: id, siteId, name, description, `systemPromptRef`, `model` (nullable — override), `capabilities` (jsonb), enabled.
3. THE Content_OS SHALL seed role library mặc định: Planner, Writer, Translator, Taxonomist, SEO, FactChecker, Librarian — mỗi role chỉ có capability tối thiểu cho vai của nó; Writer KHÔNG có bất kỳ capability `schema:*` nào.
4. WHEN Planner phân rã một goal, THE Planner SHALL tạo sub-goals gán `agentRole` cụ thể; Harness enforce capability của role khi sub-goal thực thi — capability thực thi là giao (intersection) của role capabilities và Autonomy_Grant.
5. IF tổng sub-goal hoàn thành nhưng goal cha không đạt acceptance criteria của nó, THEN THE Content_OS SHALL đánh dấu goal cha `failed` với lý do, không silent-success.

### Requirement 11: Agent-as-reviewer

**User Story:** Là một quản trị viên, tôi muốn approval rủi ro thấp được Reviewer agent quyết thay tôi (có ghi lý do), để tôi chỉ phải xử lý ngoại lệ thật sự.

#### Acceptance Criteria

1. THE Content_OS SHALL bổ sung `approverType` (`human | agent`) vào `agent_approvals`; quyết định của agent ghi kèm `approverRunId` và lý do.
2. THE Content_OS SHALL chỉ cho phép Reviewer_Agent quyết approval khi: risk được policy phân loại trong ngưỡng cho phép agent-review (cấu hình per site) VÀ Reviewer_Agent có capability `review:<domain>` tương ứng.
3. THE Content_OS SHALL cấm self-review: agent thuộc cùng run hoặc cùng goal-tree với hành động chờ duyệt không được quyết approval đó.
4. WHEN Reviewer_Agent từ chối hoặc không đủ confidence, THE Content_OS SHALL escalate approval cho con người với deep-link đến diff và lý do của Reviewer.
5. THE Content_OS SHALL cho phép tắt agent-review per site (mọi approval về con người) bằng một cấu hình duy nhất.

### Requirement 12: Autonomy grants L0–L4 và Trust Ledger

**User Story:** Là một quản trị viên, tôi muốn mức tự trị của từng agent role trên từng capability được cấp dựa trên thành tích đo được, và bị hạ tự động khi có sự cố, để autonomy là thứ kiếm được chứ không phải cấp bừa.

#### Acceptance Criteria

1. THE Content_OS SHALL lưu Autonomy_Grant trong bảng `agent_autonomy_grants`: id, siteId, agentRole, capability, `level` (int 0–4), `evidence` (jsonb), grantedBy, grantedAt, expiresAt (nullable); unique trên (siteId, agentRole, capability).
2. WHEN không tồn tại grant cho (site, role, capability), THE Harness SHALL áp dụng mặc định L2 cho capability an toàn và L1 cho capability nguy hiểm.
3. Ngữ nghĩa mức: L0 = chỉ ghi artifact, không tác động; L1 = mọi hành động tạo approval; L2 = safe tự chạy, dangerous chờ duyệt; L3 = dangerous thực thi vào staging với Veto_Window; L4 = tự thực thi trong capability + budget. THE Harness SHALL enforce đúng ngữ nghĩa này tại điểm quyết định risk.
4. THE Content_OS SHALL lưu incident trong bảng `agent_incidents`: id, siteId, agentRole, capability (nullable), source (`veto | eval_fail | human_report | load_guard | runtime_error`), severity, runId (nullable), detail, createdAt.
5. WHEN promotion engine xác định một (role, capability) đạt điều kiện (N runs liên tiếp pass evaluation, approval-approve rate ≥ ngưỡng, zero incident trong window — tất cả cấu hình per site), THE Content_OS SHALL tạo một approval đề xuất nâng level — promotion CHỈ có hiệu lực khi con người approve.
6. WHEN có incident mới khớp (role, capability), THE Content_OS SHALL hạ level ngay lập tức theo policy demotion (mặc định −1 level, severity cao về thẳng L1) mà KHÔNG cần con người duyệt, và notify.
7. Hành động không revert được (hard delete, gửi thông điệp ra hệ thống ngoài) SHALL không bao giờ thực thi ở mức cao hơn L2, bất kể grant.

### Requirement 13: Veto Window (L3)

**User Story:** Là một biên tập viên, tôi muốn hành động nguy hiểm ở mức L3 được thực thi vào staging và chỉ commit sau khoảng chờ phủ quyết, để tôi giữ quyền chặn mà không phải duyệt từng việc.

#### Acceptance Criteria

1. WHEN một dangerous action thực thi ở L3, THE Harness SHALL ghi kết quả vào staging revision (không ảnh hưởng nội dung live) và tạo approval dạng veto với `autoCommitAt = now + T` (T cấu hình per site, default 4 giờ).
2. THE Content_OS SHALL notify các user có quyền veto ngay khi staging được tạo, kèm deep-link diff.
3. WHEN đến `autoCommitAt` mà không có veto, THE Content_OS SHALL commit staging thành revision live qua queue job; commit ghi provenance đầy đủ.
4. WHEN có người veto trước `autoCommitAt`, THE Content_OS SHALL huỷ staging, rollback nếu đã partial-commit, mở `agent_incidents` (source `veto`) và phát demotion signal.
5. IF commit job thất bại, THEN THE Content_OS SHALL giữ staging nguyên trạng, retry theo backoff, và mở incident sau N lần thất bại.
6. THE Content_OS SHALL liệt kê mọi staging đang trong Veto_Window tại Mission_Control với thời gian còn lại.

### Requirement 14: Kill Switch

**User Story:** Là một quản trị viên, tôi muốn dừng hoạt động agent ở đúng phạm vi tôi chọn (một run, một intent, một role, hay cả site) ngay lập tức, để tôi luôn nắm quyền dừng cuối cùng.

#### Acceptance Criteria

1. THE Content_OS SHALL hỗ trợ 4 mức dừng: cancel run, pause intent, freeze role, freeze site; mỗi mức có API và nút trong Mission_Control.
2. WHEN freeze role hoặc freeze site được kích hoạt, THE Harness SHALL chặn mọi tool call mới của phạm vi đó tại tool-call boundary, kể cả run đang chạy giữa chừng — run chuyển trạng thái `cancelled` với stop reason `frozen`.
3. THE Content_OS SHALL yêu cầu capability quản trị riêng (`agents:freeze`) cho freeze role/site; cancel run và pause intent theo quyền sở hữu hoặc quyền quản trị.
4. WHEN site đang frozen, THE Content_OS SHALL từ chối tạo goal/run mới với lỗi nêu rõ trạng thái frozen; thao tác đọc (list, audit) vẫn hoạt động.
5. Mọi thao tác Kill_Switch SHALL được ghi audit với actor, phạm vi, lý do (tuỳ chọn) và timestamp.

### Requirement 15: Constitution

**User Story:** Là một biên tập viên trưởng, tôi muốn mã hoá gu biên tập, brand voice và ràng buộc pháp lý thành bộ evaluator có version, để sửa một luật là đổi hành vi của mọi agent từ đó về sau.

#### Acceptance Criteria

1. THE Content_OS SHALL lưu Constitution per site dạng versioned: bảng `constitutions` (id, siteId, version, `evaluators` jsonb, `hash`, status `draft | active | archived`, createdBy, createdAt); mỗi site tối đa một version `active`.
2. Mỗi evaluator SHALL khai báo: id, loại (`rule` — DSL máy chạy được, hoặc `llm_judge` — prompt chấm điểm), phạm vi áp dụng (collection/artifact type), ngưỡng pass, và severity.
3. WHEN một run khởi tạo, THE Harness SHALL pin `constitutionHash` của version active vào run; mọi evaluation trong run dùng đúng version đã pin kể cả khi Constitution đổi giữa chừng.
4. THE Content_OS SHALL chặn publish artifact/nội dung agent tạo khi evaluator severity `blocking` không pass, bất kể autonomy level; override cần lý do tường minh và ghi audit.
5. THE Content_OS SHALL cho phép chạy thử (dry-run) một evaluator draft trên content thật và trả kết quả mà không ảnh hưởng publish gate.
6. WHEN version mới được kích hoạt, THE Content_OS SHALL archive version cũ và ghi diff giữa hai version vào audit.

### Requirement 16: Mission Control UI

**User Story:** Là một người vận hành nội dung, tôi muốn màn hình mặc định của Studio là nơi giám sát và xử lý ngoại lệ (thay vì form nhập liệu), để công việc hằng ngày của tôi là quyết định, không phải thao tác.

#### Acceptance Criteria

1. THE Mission_Control SHALL có Exception Inbox hiển thị: approvals chờ người quyết, staging trong Veto_Window (kèm countdown), escalations từ Reviewer_Agent, incidents, và Intent đang `error` — sắp xếp theo độ khẩn.
2. Mỗi mục trong inbox SHALL có diff view và nút hành động trực tiếp (approve/reject/veto/release-pin) không cần rời màn hình.
3. THE Mission_Control SHALL hiển thị SLO health per collection (tỉ lệ items đạt Intent rules) và trust ledger per (role, capability) với lịch sử promote/demote.
4. THE Mission_Control SHALL có Constitution editor: soạn evaluator bằng natural language → compile → dry-run trên content thật → activate version; hiển thị diff giữa versions.
5. THE Mission_Control SHALL có Intent composer làm primary CTA ("Describe what you want") tạo Intent hoặc goal; form editing truyền thống vẫn truy cập được như secondary path.
6. THE Mission_Control SHALL có nút Kill_Switch theo 4 mức với confirm 2 bước cho freeze role/site.

### Requirement 17: Bất biến an ninh và multi-tenancy

**User Story:** Là một kiến trúc sư hệ thống, tôi muốn các bất biến an ninh của Harness được bảo toàn trên mọi năng lực mới, để mở rộng autonomy không mở rộng bề mặt tấn công.

#### Acceptance Criteria

1. Mọi bảng mới (`content_intents`, `agent_roles`, `agent_autonomy_grants`, `agent_incidents`, `constitutions`) SHALL có `siteId` NOT NULL FK → sites CASCADE; mọi query SHALL lọc theo siteId; truy cập chéo site trả 403 không tiết lộ existence.
2. Prompt text, nội dung item, hay tham số tool SHALL không bao giờ cấp/thay đổi capability hoặc autonomy level — chỉ Autonomy_Grant và `agent_permissions` quyết định quyền.
3. Mọi ID bảng mới SHALL dùng nanoid (domain) theo ADR-001; không serial/auto-increment.
4. Mọi quyền can thiệp của con người (veto, approve, gỡ Pin, sửa Constitution, Kill_Switch) SHALL là permission trong hệ RBAC/policy DSL hiện có.
5. Mọi hành động tự trị SHALL revert được qua revisions; thao tác không revert được tuân Requirement 12.7.
6. Secrets trong tool input/output SHALL được mask trước khi ghi audit, theo cơ chế masking hiện có của Harness.
