# Requirements Document — Deployment Integrations (Vercel / Netlify)

## Introduction

Tài liệu yêu cầu cho năng lực **Deployment Integrations** — cho phép người vận hành LumiBase **trigger, monitor và debug** các deployment trên nền tảng hosting bên ngoài (khởi đầu là **Vercel** và **Netlify**) ngay bên trong Studio, không phải nhảy qua dashboard của nhà cung cấp.

### Vấn đề cần giải (pain point)

> *"Người dùng thiếu khả năng quan sát và kiểm soát các deployment Vercel của họ, buộc phải chuyển đổi qua lại giữa các hệ thống để trigger build, theo dõi trạng thái và debug khi lỗi."*

Pain point này tách thành ba nhu cầu cốt lõi, tất cả phải thực hiện được từ trong LumiBase:

1. **Trigger** — kích hoạt build/deploy thủ công hoặc tự động khi nội dung thay đổi.
2. **Monitor** — theo dõi trạng thái deployment (queued → building → ready/error) gần thời gian thực.
3. **Debug** — xem build log, lỗi, commit/branch và link tới deployment để chẩn đoán.

### Định vị trên kiến trúc hiện có

Spec này xây trực tiếp trên các lớp đã ship của LumiBase, không phát minh lại:

- **Flows engine** (`apps/cms/src/services/flow-service.ts`) — engine tự động hoá có sẵn operation `http` với SSRF guard; bổ sung operation chuyên dụng `deploy:trigger` / `deploy:status`.
- **Runtime abstraction** (`packages/runtime`) — `QueueProvider` cho job nền, chạy trên cả Cloudflare Workers lẫn Docker.
- **Scheduler/cron** (`triggerType: 'schedule'`, `flows.nextRunAt`; `apps/cms/src/services/scheduler-worker.ts`) — pattern poll trạng thái định kỳ.
- **AI Skills registry** (`packages/ai-skills/src/skills.ts`) — expose deploy như skill agent gọi được, gated theo capability.
- **Harness + HITL** (`ai_approvals`, autonomy L0–L4) — deploy là hành động rủi ro cao, đi qua approval/veto-window.
- **Audit & Provenance** (`apps/cms/src/modules/audit/logger.ts`) — ghi lai lịch mọi hành động deploy, masking secret.
- **KeyProvider / DEK** (`encryptionKeys`, pattern `dekWrapped`) — lưu provider token đã mã hoá, không plaintext trong DB.

## Glossary

- **Deployment_Integration**: Tổng thể năng lực mô tả trong spec này.
- **Provider**: Nền tảng hosting đích — `vercel` | `netlify` (mở rộng được).
- **Deployment_Target**: Bản ghi cấu hình một kết nối tới một project trên một Provider (project id, token đã mã hoá, branch mặc định, scope site). Bảng `deployment_targets`.
- **Deployment**: Một lần build/deploy cụ thể trên Provider, có trạng thái và log. Bảng `deployments`.
- **Provider_Token**: API token/secret của Provider, lưu **đã mã hoá** qua KeyProvider/DEK, không bao giờ trả plaintext qua API.
- **Deploy_Hook**: Endpoint của Provider để kích hoạt build (Vercel Deploy Hook URL / Netlify Build Hook URL), hoặc REST API tạo deployment.
- **Status_Poller**: Job chạy theo lịch, đồng bộ trạng thái Deployment từ Provider về LumiBase. Pattern theo `scheduler-worker`.
- **Inbound_Webhook**: Endpoint LumiBase nhận sự kiện deployment-status do Provider đẩy về (thay thế/bổ trợ cho polling), có verify chữ ký.
- **Auto_Deploy_Rule**: Cấu hình "khi event nội dung X xảy ra → trigger deploy target Y", hiện thực hoá bằng Flow với `triggerType: 'event'`.
- **Site**: Đơn vị multi-tenancy — mọi bảng mới scope theo `siteId`.
- **Harness**: Agent Harness Layer — lớp thực thi có quản trị (capability, risk, budget, audit, HITL).

## Requirements

### Requirement 1: Quản lý Deployment Target (kết nối Provider)

**User Story:** Là một quản trị viên site, tôi muốn kết nối một project Vercel/Netlify vào LumiBase bằng cách lưu token và project id, để LumiBase có thể trigger và theo dõi deployment của project đó.

#### Acceptance Criteria

1. THE Deployment_Integration SHALL cung cấp bảng `deployment_targets` với các cột: `id` (nanoid, PK), `siteId` (text, NOT NULL, FK), `provider` (text, NOT NULL, `'vercel' | 'netlify'`), `name` (text, NOT NULL), `projectId` (text, NOT NULL — Vercel project id / Netlify site id), `tokenCiphertext` (text, NOT NULL — token đã mã hoá), `tokenKeyId` (text, NOT NULL — id của key đã wrap), `defaultBranch` (text, nullable), `productionUrl` (text, nullable), `status` (text, NOT NULL, `'active' | 'inactive'`, default `'active'`), `createdAt`, `updatedAt`.
2. WHEN một quản trị viên tạo Deployment_Target qua API, THE Deployment_Integration SHALL mã hoá Provider_Token qua KeyProvider trước khi lưu và KHÔNG lưu plaintext token ở bất kỳ cột nào.
3. THE Deployment_Integration SHALL KHÔNG BAO GIỜ trả về Provider_Token plaintext qua bất kỳ API nào; response chỉ được chứa metadata không nhạy cảm (provider, name, projectId, status, defaultBranch, productionUrl, thời điểm).
4. WHEN tạo hoặc cập nhật Deployment_Target, THE Deployment_Integration SHALL xác thực token với Provider (gọi 1 endpoint read-only của Provider) và IF token không hợp lệ THEN trả lỗi mã rõ ràng, không tạo bản ghi với token sai.
5. THE Deployment_Integration SHALL bảo đảm mọi truy vấn `deployment_targets` đều filter theo `siteId` (multi-tenancy non-negotiable).
6. THE Deployment_Integration SHALL cung cấp REST CRUD tại `/api/v1/deployment-targets` tuân response format `{ data: T, meta?: PaginationMeta }` / `{ errors: [...] }`.

### Requirement 2: Trigger deployment thủ công

**User Story:** Là một biên tập viên/người vận hành, tôi muốn bấm một nút để trigger build cho một Deployment_Target, để publish nội dung mới mà không cần mở dashboard Vercel/Netlify.

#### Acceptance Criteria

1. THE Deployment_Integration SHALL cung cấp endpoint `POST /api/v1/deployment-targets/:id/deploy` nhận tuỳ chọn `{ branch?: string, reason?: string }`.
2. WHEN endpoint được gọi với Deployment_Target hợp lệ, THE Deployment_Integration SHALL giải mã Provider_Token, gọi Deploy_Hook tương ứng (Vercel/Netlify) và tạo một bản ghi `deployments` với `status='queued'` và `providerDeploymentId` nếu Provider trả về.
3. IF Provider trả lỗi khi trigger, THEN THE Deployment_Integration SHALL ghi `deployments` với `status='error'` kèm `errorMessage` và trả lỗi cho client (không nuốt lỗi).
4. WHEN deploy được trigger, THE Deployment_Integration SHALL ghi một bản ghi audit (`auditLog`) với actor, target id, provider, reason — secret được mask trước khi ghi.
5. THE Deployment_Integration SHALL áp dụng SSRF guard (`validateOutboundUrl`) cho mọi outbound URL tới Provider giống chính sách của operation `http`.

### Requirement 3: Monitor trạng thái deployment

**User Story:** Là một người vận hành, tôi muốn thấy trạng thái deployment cập nhật gần thời gian thực (đang build, thành công, thất bại), để biết nội dung đã lên hay chưa mà không phải mở dashboard Provider.

#### Acceptance Criteria

1. THE Deployment_Integration SHALL cung cấp bảng `deployments` với các cột: `id` (nanoid, PK), `siteId` (text, NOT NULL, FK), `targetId` (text, NOT NULL, FK → deployment_targets), `provider` (text, NOT NULL), `providerDeploymentId` (text, nullable), `status` (text, NOT NULL, `'queued' | 'building' | 'ready' | 'error' | 'canceled'`), `branch` (text, nullable), `commitSha` (text, nullable), `commitMessage` (text, nullable), `url` (text, nullable — preview/production URL), `triggeredBy` (text, nullable — userId hoặc runId), `triggerSource` (text, NOT NULL, `'manual' | 'auto' | 'agent'`), `errorMessage` (text, nullable), `logExcerpt` (text, nullable), `createdAt`, `updatedAt`, `completedAt` (nullable).
2. THE Deployment_Integration SHALL chuẩn hoá trạng thái của từng Provider về tập trạng thái thống nhất ở trên (ví dụ Vercel `READY`→`ready`, `ERROR`→`error`; Netlify `ready`→`ready`, `error`→`error`).
3. THE Deployment_Integration SHALL cung cấp `GET /api/v1/deployments` (list, filter theo `targetId`, `status`, có phân trang) và `GET /api/v1/deployments/:id` (chi tiết).
4. THE Status_Poller SHALL chạy theo lịch qua `QueueProvider`/scheduler, đồng bộ trạng thái các Deployment chưa kết thúc (`queued`/`building`) từ Provider, idempotent (conditional UPDATE theo `providerDeploymentId`), và cập nhật `completedAt` khi đạt trạng thái cuối.
5. IF runtime không có queue/scheduler adapter, THEN THE Deployment_Integration SHALL vẫn cho phép refresh trạng thái theo yêu cầu qua `POST /api/v1/deployments/:id/refresh` (đồng bộ).
6. WHEN một Deployment chuyển sang trạng thái cuối (`ready`/`error`/`canceled`), THE Deployment_Integration SHALL phát một event nội bộ để có thể kích hoạt thông báo/flow downstream.

### Requirement 4: Debug — xem log và chi tiết lỗi

**User Story:** Là một lập trình viên/người vận hành, tôi muốn xem build log và thông điệp lỗi của một deployment thất bại ngay trong Studio, để chẩn đoán mà không cần đăng nhập Provider.

#### Acceptance Criteria

1. THE Deployment_Integration SHALL cung cấp `GET /api/v1/deployments/:id/logs` lấy build log từ Provider (theo `providerDeploymentId`) tại thời điểm yêu cầu.
2. WHEN một Deployment ở `status='error'`, THE Deployment_Integration SHALL lưu `errorMessage` và một `logExcerpt` (đoạn cuối log, giới hạn kích thước hợp lý) vào bảng `deployments`.
3. THE Deployment_Integration SHALL hiển thị trong response chi tiết deployment: branch, commitSha, commitMessage, url, thời gian từng mốc trạng thái (nếu Provider cung cấp).
4. THE Deployment_Integration SHALL mask mọi giá trị nhạy cảm có thể lẫn trong log (token, secret) trước khi lưu/trả về, dùng cơ chế masking của audit module.

### Requirement 5: Auto-deploy khi nội dung thay đổi

**User Story:** Là một quản trị viên, tôi muốn cấu hình "khi item trong collection X được publish thì tự trigger deploy target Y", để site tĩnh luôn cập nhật mà không cần thao tác tay.

#### Acceptance Criteria

1. THE Deployment_Integration SHALL cho phép tạo Auto_Deploy_Rule bằng Flow với `triggerType: 'event'` trỏ tới collection + action (ví dụ `items.publish`), với một node operation mới kích hoạt deploy.
2. THE Deployment_Integration SHALL đăng ký operation handler `deploy:trigger` qua `registerHandler()` của Flow engine, nhận options `{ targetId, branch?, reason? }`, dùng chung đường thực thi với Requirement 2.
3. WHEN Auto_Deploy_Rule kích hoạt, THE Deployment_Integration SHALL ghi `deployments.triggerSource='auto'` và liên kết tới flow run để truy vết.
4. THE Deployment_Integration SHALL hỗ trợ debounce/coalescing cấu hình được (nhiều thay đổi trong cửa sổ thời gian ngắn → một deploy) để tránh build dồn dập. IF không cấu hình, THEN mặc định mỗi event một deploy.

### Requirement 6: Skill cho Agent (AI-native) + HITL

**User Story:** Là người vận hành tin tưởng agent, tôi muốn agent có thể trigger deploy và đọc trạng thái như một skill có kiểm soát, để khép kín vòng "tạo nội dung → publish → deploy" dưới sự giám sát.

#### Acceptance Criteria

1. THE Deployment_Integration SHALL bổ sung vào AI Skills registry các skill: `triggerDeployment` (capability `deployments:write`), `listDeployments` và `getDeploymentStatus` (capability `deployments:read`), `listDeploymentTargets` (capability `deployments:read`).
2. THE Harness SHALL coi `triggerDeployment` là skill rủi ro cao: WHEN agent gọi `triggerDeployment` và autonomy grant của role dưới ngưỡng autopilot, THEN tạo bản ghi `ai_approvals` trước khi thực thi (HITL), tuân rule #4 của `CLAUDE.md`.
3. WHEN agent thực thi `triggerDeployment` (sau approval hoặc trong autopilot), THE Deployment_Integration SHALL ghi `deployments.triggerSource='agent'` và `triggeredBy` trỏ tới runId.
4. THE Deployment_Integration SHALL ghi provenance/audit cho mọi hành động deploy do agent thực hiện, đồng nhất với cơ chế provenance hiện có.

### Requirement 7: Inbound webhook từ Provider (tùy chọn, giảm polling)

**User Story:** Là người vận hành, tôi muốn LumiBase nhận thông báo trạng thái từ Provider ngay khi deployment đổi trạng thái, để giảm độ trễ và tải polling.

#### Acceptance Criteria

1. THE Deployment_Integration SHALL cung cấp endpoint Inbound_Webhook `POST /api/v1/deployments/webhook/:provider` nhận sự kiện deployment-status.
2. WHEN nhận Inbound_Webhook, THE Deployment_Integration SHALL verify chữ ký/secret của Provider trước khi xử lý; IF verify thất bại THEN trả 401 và không cập nhật dữ liệu.
3. WHEN Inbound_Webhook hợp lệ, THE Deployment_Integration SHALL cập nhật bản ghi `deployments` tương ứng (match theo `providerDeploymentId`), idempotent với Status_Poller.
4. IF không bật Inbound_Webhook, THEN THE Deployment_Integration SHALL vẫn hoạt động đầy đủ chỉ bằng Status_Poller (Requirement 3) — inbound webhook là bổ trợ, không bắt buộc.

### Requirement 8: Studio UI — Deployments dashboard

**User Story:** Là người vận hành, tôi muốn một trang trong Studio liệt kê deployment, trạng thái, và cho phép trigger/refresh/xem log, để quan sát và kiểm soát tập trung.

#### Acceptance Criteria

1. THE Deployment_Integration SHALL bổ sung module Studio `apps/studio/src/modules/deployments/` theo pattern module hiện có (list page + detail panel), dùng React Query + SDK + i18n + lucide icons.
2. THE Studio SHALL hiển thị danh sách deployment với cột: provider, target, status (badge màu), branch/commit, thời gian, url; có filter theo target và status.
3. THE Studio SHALL cung cấp nút "Deploy now" cho mỗi target và nút refresh/xem log cho mỗi deployment; xem log mở chi tiết với `logExcerpt`/full log.
4. THE Studio SHALL cung cấp trang cấu hình Deployment_Target (thêm/sửa/xoá kết nối, nhập token) tại Settings, KHÔNG hiển thị lại token đã lưu.
5. THE Studio SHALL hiển thị trạng thái cập nhật gần thời gian thực (poll nhẹ phía client hoặc dựa vào event Requirement 3.6).

### Requirement 9: Bảo mật, multi-tenancy và độ bền

**User Story:** Là người chịu trách nhiệm bảo mật, tôi muốn năng lực deploy tuân thủ chuẩn bảo mật và cô lập tenant của LumiBase, để token không rò rỉ và site không truy cập chéo nhau.

#### Acceptance Criteria

1. THE Deployment_Integration SHALL áp dụng RLS/`siteId` filter cho cả `deployment_targets` và `deployments`; KHÔNG site nào đọc/ghi được deployment của site khác.
2. THE Deployment_Integration SHALL áp dụng SSRF guard cho mọi outbound call và timeout (ví dụ 30s) như operation `http`.
3. THE Deployment_Integration SHALL gate API bằng RBAC capability `deployments:read` / `deployments:write`.
4. THE Status_Poller SHALL chịu lỗi từng phần: lỗi đồng bộ một deployment KHÔNG làm hỏng cả sweep; lỗi được log và thử lại ở vòng sau (idempotent).
5. THE Deployment_Integration SHALL giới hạn rate trigger thủ công ở mức hợp lý mỗi target để tránh lạm dụng API Provider.

## Non-functional / Constraints

- **IDs:** `nanoid()` cho `deployment_targets`, `deployments` (domain tables). Audit dùng cơ chế audit hiện có.
- **Migration:** Viết tay theo `migrations-are-hand-written` (số thứ tự ≥ migration hiện tại + cập nhật journal); chú ý đụng số khi nhiều branch song song (`parallel-feature-branches-migration-numbering`).
- **Runtime abstraction:** Không import binding CF trong business logic; dùng `c.get('runtime').queue` cho job nền.
- **Response format & TypeScript strict** theo `CLAUDE.md`.

## Out of scope (phiên bản đầu)

- Provider ngoài Vercel/Netlify (Cloudflare Pages, AWS Amplify…) — kiến trúc Provider adapter để mở rộng sau.
- Quản lý biến môi trường của Provider từ trong LumiBase.
- Rollback deployment từ LumiBase (chỉ hiển thị, chưa thao tác).
- Streaming log real-time (phiên bản đầu lấy log theo yêu cầu + logExcerpt).

## Setup Impact (bắt buộc theo Definition of Done)

Đã rà soát 6 câu hỏi của `admin-setup-wizard/setup-impact.md`:

1. **Feature có cần dữ liệu khởi tạo lúc setup không?** Không — `deployment_targets` do admin tạo sau setup; không seed mặc định.
2. **Có secret/biến môi trường mới cần khai báo lúc setup?** Không bắt buộc lúc setup (token nhập per-target qua Studio); KeyProvider đã tồn tại từ trước.
3. **Có capability/permission mới?** Có — `deployments:read`, `deployments:write`; cần thêm vào danh mục RBAC mặc định (gán role admin).
4. **Có bảng mới cần migration?** Có — `deployment_targets`, `deployments` (migration viết tay).
5. **Instance đã setup từ trước có cần backfill?** Không cần backfill dữ liệu; chỉ chạy migration idempotent tạo bảng + thêm capability vào role admin sẵn có (upgrade note trong CHANGELOG).
6. **Có ảnh hưởng wizard bootstrap?** Không thay đổi luồng wizard; chỉ thêm mục Settings sau setup.

→ Cập nhật bảng Registry trong `admin-setup-wizard/setup-impact.md`: thêm dòng `deployment-integrations` với kết quả **capability mới (deployments:*) + migration bảng mới; không seed, không backfill dữ liệu**, kèm ngày rà soát.
