# Requirements Document

## Introduction

Tài liệu yêu cầu cho **Git Integration (GitHub / GitLab)** trong LumiBase. Tính năng cho phép một instance LumiBase đã deploy lên production kết nối tới các repository trên GitHub hoặc GitLab **theo từng site/tenant**, để:

1. **Kết nối repo qua UI** — admin của một site cấu hình một hoặc nhiều kết nối repo, xác thực qua GitHub App / GitLab App hoặc OAuth/PAT.
2. **Theo dõi Pull Request / Merge Request** — khi có PR/MR, hiển thị trạng thái, kết quả CI, reviewers, khả năng merge, và đường dẫn tới trang preview.
3. **Hiển thị & lưu log CI** — kéo log từ GitHub Actions / GitLab CI, hiển thị timeline run/job và lưu lại để xem khi provider đã xoá log.
4. **Preview environment tự tạo** — mỗi PR/MR sinh một site preview tạm thời (ephemeral) trong chính LumiBase, dọn dẹp khi PR đóng/merge.
5. **Config-as-Code & Earned autonomy** — đặt nền cho việc đồng bộ schema/intent hai chiều với repo và để agent `git-sync` thao tác theo mức autonomy được cấp (L0–L4).

Tính năng tuân thủ các non-negotiable rules của LumiBase: ID bằng `nanoid()` (domain) / `uuidv7()` (audit), mọi bảng domain có `site_id` và mọi query lọc theo site, không import binding CF trong business logic (dùng `c.get('runtime')`), thao tác `schema:write`/delete phải qua HITL (`ai_approvals`), response theo `{ data, meta? }` / `{ errors: [...] }`.

## Glossary

- **Git_Provider**: Nguồn quản lý mã nguồn được hỗ trợ — `github` hoặc `gitlab`. Trừu tượng hoá qua interface `GitProvider` để business logic không phụ thuộc provider cụ thể.
- **Git_Integration**: Một kết nối giữa một site (`site_id`) và một repository cụ thể trên một Git_Provider. Một site có thể có nhiều Git_Integration.
- **Auth_Method**: Cách xác thực với provider — `app` (GitHub App / GitLab App, dùng installation token ngắn hạn) hoặc `pat` (Personal Access Token / OAuth token do user cấp).
- **Installation_Token**: Token ngắn hạn cấp cho một installation của GitHub/GitLab App, tự gia hạn (refresh) khi hết hạn.
- **PAT**: Personal Access Token hoặc OAuth access token mà user dán hoặc cấp qua OAuth flow; lưu mã hoá at-rest.
- **Pull_Request** (PR/MR): Pull Request (GitHub) hoặc Merge Request (GitLab). Trong tài liệu này dùng "PR" cho cả hai.
- **Check_Run**: Một status check / commit status đặt trên một commit hoặc PR (GitHub Check Run / GitLab Commit Status).
- **CI_Run**: Một lần chạy workflow/pipeline (GitHub Actions run / GitLab pipeline) gồm nhiều job.
- **CI_Log**: Log đầu ra của một job trong CI_Run, kéo từ provider và lưu lại.
- **Webhook_Event**: Sự kiện do provider gửi tới LumiBase (push, pull_request/merge_request, workflow_run/pipeline, check_run, …), lưu nguyên payload để xử lý bất đồng bộ và replay.
- **Preview_Env**: Site tạm thời (ephemeral `site_id` phái sinh từ site gốc) tạo cho một PR để xem trước nội dung; có vòng đời gắn với PR.
- **Provenance**: Liên kết giữa một thay đổi nội dung/schema trong LumiBase với `commit_sha`/`pr_number` đã tạo ra nó.
- **Drift**: Sai khác giữa trạng thái khai báo trong repo (Config-as-Code) và trạng thái thực trong DB của site.
- **Autonomy_Level**: Mức tự chủ của agent `git-sync` từ L0 (shadow) đến L4 (autopilot), điều khiển qua `agent_autonomy_grants`.
- **Webhook_Secret**: Bí mật dùng để xác minh chữ ký webhook (GitHub `X-Hub-Signature-256` HMAC-SHA256 / GitLab `X-Gitlab-Token`), lưu mã hoá theo từng Git_Integration.

## Requirements

### Requirement 1: Kết nối repo theo tenant

**User Story:** Là một admin của một site, tôi muốn kết nối một hoặc nhiều repository GitHub/GitLab vào site của mình, để LumiBase có thể theo dõi và quản lý cập nhật trong các repo đó.

#### Acceptance Criteria

1. THE Git_Integration service SHALL cho phép tạo một Git_Integration gắn với `site_id` của caller, gồm `provider`, `repoFullName` (ví dụ `org/repo`), `authMethod`, và `displayName`.
2. THE Git_Integration service SHALL cho phép một site có nhiều Git_Integration tới nhiều repo khác nhau.
3. WHEN một Git_Integration được tạo hoặc cập nhật, THE service SHALL lưu trạng thái kết nối là một trong `connected | error | disconnected`.
4. THE Git_Integration service SHALL chỉ trả về và thao tác trên các Git_Integration có `site_id` khớp với site của caller (đa tenant cách ly).
5. WHEN một Git_Integration bị xoá, THE service SHALL thu hồi/forget token liên quan và đánh dấu mọi Preview_Env còn sống của nó để dọn dẹp.
6. THE Git_Integration service SHALL từ chối tạo Git_Integration trùng `(site_id, provider, repoFullName)` đã tồn tại với HTTP 409.

### Requirement 2: Xác thực đa phương thức (App + PAT/OAuth)

**User Story:** Là một admin, tôi muốn chọn cách xác thực phù hợp — GitHub App/GitLab App cho tổ chức, hoặc PAT/OAuth cho dự án cá nhân — để kết nối an toàn theo bối cảnh của mình.

#### Acceptance Criteria

1. THE Git_Integration service SHALL hỗ trợ `authMethod = 'app'` dùng Installation_Token và `authMethod = 'pat'` dùng PAT/OAuth token.
2. WHEN `authMethod = 'app'`, THE service SHALL lưu `installationId` và tự lấy/gia hạn Installation_Token khi hết hạn mà không cần can thiệp thủ công.
3. WHEN `authMethod = 'pat'`, THE service SHALL nhận token qua OAuth callback hoặc nhập trực tiếp, và lưu token đã mã hoá at-rest (không bao giờ lưu plaintext).
4. THE Git_Integration service SHALL mã hoá mọi token và Webhook_Secret bằng cơ chế mã hoá hiện có của LumiBase (`CryptoService` + `encryption_keys`), gắn AAD theo `{ siteId, integrationId }`.
5. THE Git_Integration service SHALL KHÔNG bao giờ ghi token/Webhook_Secret ở dạng plaintext vào log, audit, hoặc response API; giá trị nhạy cảm SHALL bị mask.
6. WHEN một token hết hạn hoặc bị thu hồi ở phía provider, THE service SHALL đặt trạng thái Git_Integration thành `error` kèm lý do và KHÔNG làm sập các luồng khác.
7. THE Git_Integration service SHALL yêu cầu scope/quyền tối thiểu cần thiết (đọc PR, đọc CI log, ghi commit status) theo nguyên tắc least-privilege và ghi rõ scope đã cấp trong UI.

### Requirement 3: Trừu tượng hoá provider (GitProvider)

**User Story:** Là một developer của LumiBase, tôi muốn một interface chung cho GitHub và GitLab, để business logic không phải rẽ nhánh theo provider và dễ thêm provider mới.

#### Acceptance Criteria

1. THE codebase SHALL định nghĩa một interface `GitProvider` với các phương thức tối thiểu: `listPullRequests`, `getPullRequest`, `listCheckRuns`, `getCiRun`, `getJobLogs`, `postCommitStatus`, `getFileContents`, và `verifyWebhook`.
2. THE codebase SHALL cung cấp adapter `GitHubProvider` và `GitLabProvider` cùng cài đặt interface `GitProvider`.
3. THE business logic (service, routes) SHALL chỉ phụ thuộc vào interface `GitProvider`, KHÔNG import trực tiếp SDK/HTTP của một provider cụ thể ngoài lớp adapter.
4. WHEN một phương thức không được provider hỗ trợ, THE adapter SHALL trả lỗi có mã rõ ràng (`PROVIDER_UNSUPPORTED`) thay vì ném lỗi không xác định.
5. THE GitProvider adapter SHALL dùng abstraction runtime của LumiBase cho mọi I/O mạng/cache (`c.get('runtime')`), KHÔNG import binding Cloudflare trực tiếp.

### Requirement 4: Nhận & xác minh webhook

**User Story:** Là một admin, tôi muốn LumiBase nhận sự kiện từ GitHub/GitLab một cách an toàn, để dashboard luôn cập nhật trạng thái PR/CI mà không cần polling.

#### Acceptance Criteria

1. THE service SHALL expose endpoint công khai `POST /api/v1/integrations/git/webhook/:provider` không yêu cầu auth thông thường, nhưng SHALL xác minh tính xác thực bằng chữ ký.
2. WHEN provider là `github`, THE service SHALL xác minh header `X-Hub-Signature-256` bằng HMAC-SHA256 với Webhook_Secret và so sánh constant-time.
3. WHEN provider là `gitlab`, THE service SHALL xác minh header `X-Gitlab-Token` khớp Webhook_Secret bằng so sánh constant-time.
4. WHEN chữ ký không hợp lệ, THE service SHALL trả HTTP 401 và KHÔNG xử lý payload.
5. THE service SHALL chống replay bằng cách bỏ qua sự kiện trùng (idempotency theo delivery id của provider) và ghi mỗi sự kiện vào Webhook_Event log đúng một lần.
6. THE service SHALL lưu Webhook_Event với payload thô, đánh dấu `processed=false`, rồi xử lý bất đồng bộ; lỗi xử lý SHALL được ghi lại để retry/replay mà không mất sự kiện.
7. THE service SHALL phân giải đúng `site_id`/`integrationId` từ ngữ cảnh webhook (theo repo + secret) trước khi ghi, đảm bảo cách ly tenant.

### Requirement 5: PR Dashboard theo site

**User Story:** Là một admin, tôi muốn xem danh sách PR đang mở của repo đã kết nối, để nắm trạng thái và truy cập nhanh từng PR.

#### Acceptance Criteria

1. THE service SHALL expose `GET /api/v1/integrations/git/:integrationId/pull-requests` trả danh sách PR của site, theo định dạng `{ data: PullRequest[], meta: PaginationMeta }`.
2. THE PR record SHALL gồm tối thiểu: `number`, `title`, `state`, `ciStatus`, `mergeable`, `headSha`, `previewUrl`, `author`, `updatedAt`.
3. THE service SHALL cập nhật cache PR khi nhận Webhook_Event liên quan, và SHALL hỗ trợ refresh thủ công kéo trạng thái mới nhất từ provider.
4. THE Studio UI SHALL hiển thị danh sách PR với trạng thái CI trực quan và liên kết tới PR trên provider cũng như tới Preview_Env (nếu có).
5. THE service SHALL chỉ trả PR thuộc Git_Integration của site caller.

### Requirement 6: CI status & log viewer

**User Story:** Là một admin, tôi muốn xem trạng thái và log CI của một PR ngay trong LumiBase, để chẩn đoán lỗi mà không phải rời khỏi hệ thống.

#### Acceptance Criteria

1. THE service SHALL expose `GET /api/v1/integrations/git/:integrationId/pull-requests/:number/ci` trả timeline CI_Run gồm các job với `status`, `startedAt`, `completedAt`, `durationMs`.
2. THE service SHALL expose `GET /api/v1/integrations/git/:integrationId/ci-runs/:runId/logs` kéo CI_Log từ provider.
3. THE service SHALL lưu CI_Log đã kéo (hoặc tham chiếu blob qua runtime storage) để xem lại kể cả khi provider đã xoá log gốc.
4. THE Studio UI SHALL hiển thị log với highlight dòng/khối lỗi và trạng thái từng job.
5. WHEN kéo log thất bại (token hết hạn, provider lỗi), THE service SHALL trả lỗi có mã rõ ràng và giữ nguyên dữ liệu đã lưu trước đó.

### Requirement 7: Status check ngược về provider

**User Story:** Là một admin, tôi muốn LumiBase tự kiểm tra nội dung/schema trong PR và báo kết quả về provider như một status check, để biến CMS thành một cổng (gate) trong quy trình CI.

#### Acceptance Criteria

1. WHEN nhận Webhook_Event PR mở/cập nhật, THE service SHALL có thể chạy validation nội dung/schema do site cấu hình.
2. WHEN validation hoàn tất, THE service SHALL post một Check_Run/commit status về provider với tên `lumibase/content-validation` và trạng thái `success | failure | pending` kèm summary.
3. THE service SHALL chỉ post status khi Git_Integration có quyền ghi commit status; nếu thiếu quyền, SHALL ghi cảnh báo và bỏ qua mà không sập luồng.
4. THE validation SHALL chạy với scope đúng site và KHÔNG rò rỉ dữ liệu của site khác trong summary.

### Requirement 8: Preview environment tự tạo

**User Story:** Là một editor/reviewer, tôi muốn mỗi PR có một trang preview tạm thời, để xem trước nội dung trước khi merge.

#### Acceptance Criteria

1. WHEN một PR được mở, THE service SHALL tạo một Preview_Env gắn với PR, sinh một `site_id` ephemeral phái sinh từ site gốc (branch-scoped), và lưu `previewUrl`.
2. WHEN PR có push mới (head commit thay đổi), THE service SHALL cập nhật nội dung của Preview_Env tương ứng.
3. WHEN PR đóng hoặc merge, THE service SHALL huỷ Preview_Env và giải phóng tài nguyên (ephemeral site, blob), idempotent.
4. THE service SHALL gắn `previewUrl` vào PR record và (nếu được phép) đăng `previewUrl` như một comment hoặc deployment status trên PR.
5. THE Preview_Env SHALL có thời hạn (`expiresAt`); env quá hạn mà PR vẫn mở SHALL được làm mới hoặc dọn theo chính sách cấu hình.
6. THE Preview_Env SHALL cách ly dữ liệu: ghi/đọc của preview KHÔNG ảnh hưởng dữ liệu production của site gốc.

### Requirement 9: Webhook event log & audit

**User Story:** Là một người vận hành, tôi muốn mọi sự kiện Git được lưu lại và truy vết, để audit và xử lý lại khi cần.

#### Acceptance Criteria

1. THE service SHALL lưu mọi Webhook_Event với `event`, `payload`, `processed`, `processedAt`, `error`, gắn `site_id` và `integrationId`.
2. THE service SHALL ghi các hành động quan trọng (kết nối/ngắt repo, post status, tạo/huỷ preview) vào audit trail hiện có (`modules/audit`), với giá trị nhạy cảm đã mask.
3. THE service SHALL hỗ trợ replay một Webhook_Event đã lưu một cách idempotent (không tạo trùng PR/CI record).
4. THE Webhook_Event log SHALL chịu chính sách retention (TTL) để không phình vô hạn.

### Requirement 10: Provenance commit ↔ content

**User Story:** Là một admin, tôi muốn biết commit/PR nào đã tạo ra một thay đổi nội dung hoặc schema, để truy vết trách nhiệm và rà soát.

#### Acceptance Criteria

1. WHEN một thay đổi nội dung/schema bắt nguồn từ một sự kiện Git (merge, GitOps reconcile), THE service SHALL ghi liên kết Provenance gồm `commitSha`, `prNumber`, và `itemId`/`collection` bị ảnh hưởng.
2. THE service SHALL cho phép truy vấn Provenance theo item/collection để trả lời "thay đổi này đến từ commit/PR nào".
3. THE Provenance record SHALL gắn `site_id` và lọc theo site khi truy vấn.

### Requirement 11: Notification & incident

**User Story:** Là một admin, tôi muốn được cảnh báo khi CI thất bại hoặc có bất thường, để phản ứng kịp thời.

#### Acceptance Criteria

1. WHEN một CI_Run kết thúc với trạng thái `failure`, THE service SHALL gửi thông báo qua các kênh notifications hiện có (`modules/notifications`) theo cấu hình site.
2. WHEN phát hiện bất thường lặp lại (ví dụ CI fail liên tục, build time tăng đột biến), THE service SHALL có thể tạo một `agent_incident` để hệ autonomy ghi nhận.
3. THE notification SHALL KHÔNG chứa giá trị token/secret và SHALL tôn trọng chính sách suppression/consent hiện có.

### Requirement 12: Config-as-Code / GitOps & Drift

**User Story:** Là một admin, tôi muốn khai báo collections/fields/intents trong repo và để LumiBase đồng bộ, để cấu hình nội dung được quản lý như mã nguồn.

#### Acceptance Criteria

1. THE service SHALL có thể đọc các file khai báo (YAML/JSON) cho `collections`, `fields`, `content_intents` từ repo qua `GitProvider.getFileContents`.
2. WHEN nhánh chính được merge, THE service SHALL reconcile khai báo vào DB của site theo cơ chế intent/reconciliation hiện có (`content_intents`).
3. WHEN trạng thái repo lệch với DB, THE service SHALL tạo `content_drift` và `agent_goal` tương ứng để xử lý, theo đúng pipeline reconciler hiện có.
4. THE reconcile/GitOps SHALL chạy với scope site và tuân thủ HITL cho các thao tác `schema:write`/delete.

### Requirement 13: Agent role `git-sync` theo autonomy L0–L4

**User Story:** Là một admin, tôi muốn cấp dần quyền tự chủ cho agent đồng bộ Git, để tự động hoá an toàn theo mức độ tin cậy đã chứng minh.

#### Acceptance Criteria

1. THE codebase SHALL định nghĩa một agent role `git-sync` với các capability có phân loại rủi ro (ví dụ `git:read` an toàn, `git:write`/`schema:write` nguy hiểm).
2. THE autonomy của `git-sync` SHALL điều khiển qua `agent_autonomy_grants` với mức L0–L4 như cơ chế hiện có (`AutonomyService`).
3. WHEN một thao tác có capability `schema:write` hoặc bắt đầu bằng `delete`, THE service SHALL tạo bản ghi `ai_approvals` trước khi thực thi (HITL), bất kể mức autonomy.
4. WHEN xảy ra veto/eval-fail/incident, THE hệ thống SHALL hạ mức autonomy theo trust ledger hiện có.

### Requirement 14: Multi-tenancy & RLS

**User Story:** Là một người vận hành multi-tenant, tôi muốn dữ liệu Git của mỗi site được cách ly hoàn toàn, để không có rò rỉ chéo tenant.

#### Acceptance Criteria

1. THE mọi bảng domain của tính năng SHALL có cột `site_id` và mọi truy vấn SHALL lọc theo `site_id` của caller.
2. THE mọi bảng mới SHALL được đăng ký vào RLS policies (`rls-policies.sql`) để thực thi cách ly ở tầng DB.
3. THE ID domain SHALL dùng `nanoid()`; ID audit SHALL dùng `uuidv7()`. KHÔNG dùng serial/auto-increment.

### Requirement 15: Bảo mật token & least-privilege

**User Story:** Là một người chịu trách nhiệm bảo mật, tôi muốn token kết nối được bảo vệ và có thể xoay vòng, để giảm thiểu rủi ro khi bị lộ.

#### Acceptance Criteria

1. THE service SHALL hỗ trợ rotation token/Webhook_Secret mà không mất kết nối (cập nhật giá trị mã hoá mới, giữ tính liên tục).
2. THE service SHALL mask token/secret trong mọi log/audit (dùng pattern masking hiện có `modules/audit/path-mask.ts`).
3. THE service SHALL cho phép thu hồi (disconnect) một Git_Integration và xoá token đã lưu.
4. THE service SHALL validate cấu hình bắt buộc (ví dụ khoá mã hoá khả dụng) ở production và degrade an toàn khi thiếu (đặt trạng thái `error`, không lưu plaintext).
