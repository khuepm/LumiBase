---
version: 2
lastUpdated: 2026-09-08T21:14:35.111Z
sourceLang: en
translatedFrom: en
sourceHash: 9b1cd7a0097a7dee
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-09-10T05:00:35.120Z
codeVerifiedHash: 9b1cd7a0097a7dee
codeVerifiedClaims: 18
---

<!--
  check-parity: allow headings code-fences inline-code links tables bulk

  Cặp EN/VI này KHÔNG phải một bản dịch. Bản VI là một tài liệu khác — đề xuất
  8 mục có đánh số, 10 heading so với 25 của bản EN và dài khoảng 1/3 — có từ
  trước, không phải do PR nào gần đây gây ra.

  Waiver này chỉ ghi nhận hiện trạng để gate parity không chặn những thay đổi
  KHÔNG liên quan tới nó; nó không chấp nhận hiện trạng đó là đúng. Việc dịch
  lại bản VI cho khớp bản EN được theo dõi ở B60 trong
  `.kiro/steering/out-of-scope-backlog.md`.

  GỠ waiver này ngay khi B60 xong — lúc đó cặp phải qua được parity mà không
  cần miễn trừ nào.
-->

# Agent Harness Layer

LumiBase định vị thế hệ tiếp theo không chỉ là headless CMS cho con người, mà là **control plane để AI Agent làm việc cùng con người trên dữ liệu, schema, workflow và artifact của business**.

## 1. Định nghĩa sản phẩm

**Harness** là lớp bao quanh agent để agent không chạy tự do: nó nhận mục tiêu, được cấp context/quyền hạn, gọi tool theo hợp đồng chuẩn, bị quan sát, được đánh giá, cần approval khi rủi ro cao, và ghi lại kết quả để có thể audit/retry.

> LumiBase for AI is not just a CMS where humans manage content. It is a structured operating layer where humans, agents, data, workflows, and applications co-evolve.

Nói ngắn gọn: **LumiBase là AI-native backend operating system** — nơi agent hiểu thế giới business qua schema/content, nhận nhiệm vụ, bị giới hạn bởi governance, rồi trả kết quả thành artifact có thể dùng lại.

## 2. Những điểm học từ Directus

Directus có nhiều mảnh nền tảng phù hợp để làm CMS cho AI: database-first data model, Data Studio, Roles/Policies/Permissions, Flows/Operations, REST/GraphQL generated API, file library và extension system. Các nguồn chính thức cần được dùng làm baseline khi thiết kế parity/improvement:

- Directus API reference mô tả REST và GraphQL được sinh động theo kiến trúc database của project: <https://docs.directus.io/reference/introduction>.
- Directus Permissions gắn vào Policies, có collection/action, filter rules, validation, presets và fields: <https://docs.directus.io/reference/system/permissions>.
- Directus Flows là automation event-driven gồm trigger và operations: <https://docs.directus.io/app/flows>.
- Directus Extensions mở rộng app/API qua interfaces, layouts, displays, endpoints, hooks, operations, panels và modules: <https://docs.directus.io/extensions/introduction>.

LumiBase không sao chép Directus. LumiBase giữ phần tốt của CMS/database-first nhưng thêm **Agent Harness Layer** làm lớp vận hành chính cho agent.

## 3. Kiến trúc 3 tầng

```text
1. CMS Layer
   └─ schema, content, files, users, roles, policies, permissions, revisions

2. Agent Harness Layer
   └─ goals, runs, plans, tools, memory, approvals, evaluations, audit trail

3. App Generation Layer
   └─ generated apps, pages, components, datasets, API specs, migrations, docs
```

Luồng chuẩn:

```text
Goal
→ Context package
→ Plan
→ Tool calls
→ Validation & evaluation
→ Human approval if needed
→ Commit artifact/result back to LumiBase
→ Audit trail & memory update
```

## 4. Các collection hệ thống đề xuất

Các bảng hiện có (`ai_approvals`, `ai_conversations`, `ai_messages`, `ai_embeddings`) là bước đầu của harness. Lộ trình nên mở rộng thành các system collections sau:

| Collection | Mục đích | Ghi chú governance |
|---|---|---|
| `agent_goals` | Mục tiêu business do người dùng hoặc workflow tạo | Có owner, priority, deadline, status |
| `agent_runs` | Một lần thực thi goal/task | Gắn model/provider, budget, status, started/finished |
| `agent_plans` | Plan dạng steps trước khi gọi tool | Có thể require approval trước khi execute |
| `agent_tools` | Registry tool/API/extension mà agent được phép gọi | Khai báo capability, input schema, rate limit |
| `agent_tool_calls` | Log từng tool call/input/output/error | Mask secrets, lưu latency/cost |
| `agent_memory` | Memory dài hạn ngoài conversation | Có scope, expiry, source, confidence |
| `agent_artifacts` | Kết quả agent tạo ra: page, component, dataset, config, prompt, migration, API spec | Versioned, reviewable, link tới collection/item |
| `agent_evaluations` | Kết quả validate/eval output | Dùng policy, test, lint, schema diff, hallucination checks |
| `agent_approvals` | Approval tổng quát cho plan/tool/artifact | Có approver, decision, reason, expiry |
| `agent_permissions` | Mapping agent/role/policy/capability | Không cấp quyền trực tiếp qua prompt |

## 5. Contract execution

Mỗi lần agent chạy phải có envelope tối thiểu:

```json
{
  "goalId": "goal_...",
  "runId": "run_...",
  "agent": "lumibase-copilot",
  "context": {
    "siteId": "site_...",
    "collections": ["products", "orders"],
    "policySnapshot": "sha256:..."
  },
  "budget": {
    "maxToolCalls": 20,
    "maxCostUsd": 2,
    "timeoutMs": 30000
  },
  "risk": "safe | review_required | dangerous",
  "approvalPolicy": "none | before_execute | before_commit",
  "artifacts": []
}
```

Nguyên tắc:

- Tool chỉ chạy nếu được khai báo trong registry và capability của agent/session thoả mãn.
- Prompt không thể tự nâng quyền; quyền đến từ policy snapshot.
- Kết quả sinh ra không ghi thẳng vào content/schema nếu vượt risk threshold.
- Mọi tool call và artifact đều có `site_id`, audit metadata, correlation id.
- Harness phải hỗ trợ replay/retry idempotent cho run thất bại.

### 5.1. Quyết định một approval: claim, execute, quarantine

Approve không phải là đổi trạng thái — nó **thực thi** hành động đã lưu. Vì vậy
đường quyết định gồm ba bước, `claim → execute → finalize`, và mỗi bước tồn tại
vì một cách mà bản làm đơn giản sẽ sai:

- **Claim.** Quyết định trước tiên chuyển dòng sang `deciding`, bằng một
  conditional update guard trên `pending`. Kiểu read-rồi-act sẽ để hai approval
  đồng thời cùng qua bước đọc và **cùng** chạy hành động.
- **Execute.** Claim được giữ trong đúng một lần thực thi skill. Mọi đường không
  hoàn tất đều tự nhả claim — skill lỗi, kill switch, cancel, hay một exception.
- **Finalize.** Chỉ một lần thực thi hoàn tất mới ghi `approved`.

Một lỗi mà process **sống sót qua được** sẽ không quay về `pending`. Nếu skill đã
chạm tới một service trước khi lỗi thì side effect có thể đã tồn tại, và đưa nó
trở lại inbox như việc bình thường là mời gọi một side effect thứ hai. Những ca
đó vào **`failed`** — bị cách ly, ra khỏi inbox, và chỉ chạy lại được qua một
bước có con người tham gia.

Điều mà không handler in-process nào che được là **process chết giữa lúc thực
thi**: crash, bị OOM kill, Worker bị evict, hay một lần deploy cuốn pod đi. Dòng
đó sẽ ở `deciding` mãi mãi, và vì inbox filter theo pending nên nó cũng **biến
mất khỏi tầm mắt** — vừa kẹt vừa vô hình. Một sweep định kỳ
(`sweepStaleApprovalClaims`, cửa sổ 15 phút) là lưới an toàn. Nó cũng đưa các
dòng đó vào `failed` chứ không phải `pending`: một cú crash nói "không có quyết
định nào được ghi", chứ **không** nói "không có gì xảy ra" — nên một lần thực thi
bị crash ít nhất cũng mơ hồ như một lần lỗi in-process, và phải qua cùng một cửa.

Thời gian đã trôi qua **không** là bằng chứng công việc bị bỏ rơi đã dừng. Một
timeout của JavaScript reject một promise mà không cancel handler phía sau, và
một process đã crash có thể để lại một request đang bay ở provider bên ngoài.
Cửa sổ chỉ giới hạn hệ thống **chờ** bao lâu, không bao giờ giới hạn điều nó
kết luận.

### 5.2. Phục hồi một approval bị cách ly

`POST /api/v1/agent/approvals/:id/reopen` với `{ reason }` đưa một approval
`failed` trở lại `pending`. Nó đòi đúng capability `approvals:decide` như khi
quyết định, vì reopen chính là thứ làm hành động có thể thực thi lại. Bước chuyển
trạng thái và audit record `approval.reopened` của nó commit **cùng nhau**: ghi
nhận ai đã cho phép một lần thực thi thứ hai là **một phần của** sự cho phép đó,
không phải một dòng log có thể có mà cũng có thể không.

Trong Studio, tab Approvals nêu rõ có bao nhiêu approval bị ngắt giữa đường, hiện
lý do đã ghi cho từng cái, và chỉ đưa nút **Reopen** ở đúng những dòng đó — một
approval `pending` là việc bình thường, không có affordance phục hồi nào. Lý do là
**bắt buộc**: đó là điều con người tuyên bố mình đã kiểm chứng, và nó được lưu
cùng bước chuyển trạng thái.

Chỉ `failed` mới reopen được. Một approval đã quyết định thì không được hồi sinh,
còn một dòng `deciding` thuộc về một lần thực thi đang sống hoặc thuộc về sweeper.

## 6. App Generation Layer

Khi người dùng yêu cầu “build storefront”, agent không bắt đầu từ trang trắng. Nó đọc schema/content/policies trong LumiBase:

```text
collections: products, orders, customers
policies: public read products, customer owns orders
prompt/spec: build storefront
agent goal: generate frontend app from schema
agent tasks:
  - generate page/component artifact
  - create API integration docs
  - seed sample content
  - evaluate missing descriptions/images
  - request approval for schema changes
```

Artifact được commit ngược về LumiBase để con người review, version, publish hoặc rollback.

MVP hiện tại trả 4 artifact từ `/api/v1/agent/generate-app`: `page_spec`, `component_spec`, `seed_data`, `api_spec`. Publish idempotent, artifact đã publish có thể rollback, và schema/migration artifact fail evaluation không được publish nếu không có override reason.

## 6.1. Runtime limitations & operations

- **Cloudflare Workers**: route CMS và service Drizzle-backed chạy trong Worker runtime; evaluation runner MVP giữ ngắn và synchronous để tránh vượt request runtime.
- **Docker / Node.js**: cùng API và service chạy qua Docker runtime, dùng BullMQ/Redis khi cần queue.
- **Queues**: run fail lặp lại dùng runtime `QueueProvider` để enqueue `agent-dead-letter`; nếu không có queue adapter, audit trail vẫn nằm trong `agent_runs` và `agent_tool_calls`.
- **Observability**: Prometheus metrics bao phủ run status, stop reason, tool latency, approval latency, evaluation status, token/cost estimate và dead-letter enqueue rate. Docker mode auto-load dashboard Grafana `LumiBase Agent Harness`.

## 7. Roadmap ứng dụng vào LumiBase

Roadmap chi tiết theo checklist nằm ở [Roadmap triển khai Agent Harness Layer](../roadmap/agent-harness-implementation.md). Tóm tắt các chặng chính:

1. **Lifecycle DB + service** — thêm `agent_goals`, `agent_runs`, `agent_plans`, `agent_tool_calls` và `AgentRunService` để mọi hành động agent có trạng thái, audit và retry.
2. **Tool Registry** — nâng `CORE_SKILLS` thành registry có input/output schema, capabilities, rate limits, risk policy và owner.
3. **Approval tổng quát** — mở rộng HITL từ skill nguy hiểm sang plan/tool/artifact approval, có diff/eval summary trước khi duyệt.
4. **Artifact Store** — thêm `agent_artifacts` để output không chỉ là text chat mà là page/component/dataset/config/migration/API spec versioned.
5. **Evaluation Gate** — thêm eval trước khi commit artifact: schema validation, permission diff, migration dry-run, generated app smoke test, policy lint.
6. **Memory có kiểm soát** — xây RAG/memory theo scope, provenance, expiry, field mask và redaction.
7. **App Generation MVP** — kết nối schema/content/policy → generator → artifact → eval → approval → publish/rollback cho demo e-commerce đầu tiên.

## 8. Success metrics

- 100% agent runs có audit trail đầy đủ: goal, plan, tool calls, approvals, artifact hashes.
- 0 hành động schema/delete chạy ngoài approval policy.
- ≥80% artifact generated có evaluation result trước khi admin review.
- Median time từ schema có sẵn đến generated app scaffold < 5 phút.
