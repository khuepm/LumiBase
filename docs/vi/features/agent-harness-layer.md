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
- **Observability**: Prometheus metrics bao phủ run status, stop reason, tool latency, approval latency, evaluation status, token/cost estimate và dead-letter enqueue rate. Docker mode auto-load dashboard Grafana `Lumibase Agent Harness`.

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
