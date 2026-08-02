---
version: 1
lastUpdated: 2026-07-25T08:14:17.856Z
sourceLang: vi
contentHash: 8e804b343329c625
codeVerified: 2026-07-25T08:14:17.856Z
codeVerifiedHash: 8e804b343329c625
codeVerifiedClaims: 2
---

# Roadmap triển khai Agent Harness Layer

Tài liệu này trả lời câu hỏi: sau khi đã định vị LumiBase là “structured operating layer where humans, agents, data, workflows, and applications co-evolve”, những việc cần làm cụ thể là gì?

Mục tiêu không phải “thêm chat AI” nữa. Mục tiêu là biến mọi hành động của agent thành một vòng đời có cấu trúc: **Goal → Run → Plan → Tool calls → Evaluation → Approval → Artifact commit → Audit/Memory**.

## 0. Nguyên tắc ưu tiên

1. **Không cho agent ghi thẳng vào schema/content khi chưa có harness state.** Mọi hành động có rủi ro phải gắn với `goalId`, `runId`, policy snapshot và approval/evaluation.
2. **Tách tool registry khỏi prompt.** Tool nào được gọi, input schema, capability, risk policy và rate limit phải đến từ database/config, không đến từ lời agent tự khai.
3. **Artifact là output chính, chat chỉ là interface.** Kết quả quan trọng phải được lưu thành artifact versioned: page, component, dataset, config, prompt, migration, API spec, workflow.
4. **Evaluation trước approval, approval trước commit.** Admin không nên duyệt “text”; admin duyệt diff/artifact kèm test/eval result.
5. **Audit/replay là first-class.** Một run thất bại phải xem lại được plan, tool calls, input/output đã mask secret, lỗi, cost và retry policy.

## 1. Phase A — Chuẩn hoá nền tảng DB và lifecycle

Mục tiêu: biến AI Copilot hiện tại từ chat/HITL rời rạc thành lifecycle có goal/run rõ ràng.

- [x] `[DB]` Thêm `agent_goals` với `siteId`, `title`, `description`, `source` (`user`/`flow`/`api`/`schedule`), `createdBy`, `assigneeAgent`, `priority`, `deadline`, `status`, `successCriteria jsonb`, `createdAt`, `updatedAt`.
- [x] `[DB]` Thêm `agent_runs` với `goalId`, `siteId`, `agentName`, `provider`, `model`, `status`, `budget jsonb`, `policySnapshotHash`, `risk`, `startedAt`, `finishedAt`, `error`.
- [x] `[DB]` Thêm `agent_plans` với `runId`, `steps jsonb`, `status`, `risk`, `approvalPolicy`, `createdAt`, `approvedAt`, `approvedBy`.
- [x] `[DB]` Thêm `agent_tool_calls` với `runId`, `toolName`, `input jsonb`, `output jsonb`, `error`, `status`, `latencyMs`, `cost jsonb`, `createdAt`; input/output phải hỗ trợ secret masking.
- [x] `[DB]` Thêm indexes `(siteId, status)`, `(goalId, createdAt)`, `(runId, createdAt)` và cascade theo `siteId`/`goalId` hợp lý.
- [x] `[BE]` Tạo `AgentRunService` để mở run, append plan/tool call, close run, fail run, retry run.
- [x] `[BE]` Refactor `AISecureHarness.execute()` để nếu request chưa có `goalId/runId` thì tự tạo transient goal/run thay vì chỉ tạo approval rời rạc.
- [ ] `[TEST]` Property tests đảm bảo mọi tool call luôn thuộc đúng `siteId/runId`, run failed vẫn giữ audit trail, cross-site không đọc được run/goal.

## 2. Phase B — Tool Registry và capability policy

Mục tiêu: nâng `CORE_SKILLS` từ hằng số trong package thành registry vận hành được.

- [ ] `[DB]` Thêm `agent_tools` với `name`, `description`, `inputSchema`, `outputSchema`, `requiredCapabilities`, `riskPolicy`, `rateLimit`, `enabled`, `owner`, `extensionId?`.
- [ ] `[DB]` Thêm `agent_permissions` để gắn agent/user/API key với policy/capabilities theo `validFrom`, `validUntil`, `environment`.
- [ ] `[BE]` Implement `ToolRegistryService`: load tools từ core skills + extension tools + DB overrides; cache theo `siteId` và invalidate khi tool/extension đổi.
- [ ] `[BE]` Chuẩn hoá risk policy: `safe`, `review_required`, `dangerous`, `blocked`; support rule theo capability, collection, action, environment.
- [ ] `[BE]` Enforce rate limit theo tool/agent/site để tránh runaway loops.
- [ ] `[SDK]` Thêm types cho `AgentTool`, `AgentCapability`, `AgentRiskPolicy`.
- [ ] `[FE]` Studio page “Agent Tools” để admin bật/tắt tool, xem schema, capability, risk policy và lịch sử gọi.
- [ ] `[TEST]` Agent không thể gọi tool disabled, thiếu capability, vượt rate limit, hoặc risk bị policy `blocked`.

## 3. Phase C — Approval mở rộng: plan/tool/artifact

Mục tiêu: approval không chỉ dành cho `ai_approvals` kiểu skill nguy hiểm, mà thành cổng duyệt tổng quát.

- [ ] `[DB]` Thêm `agent_approvals` với `runId`, `subjectType` (`plan`/`tool_call`/`artifact`/`schema_diff`), `subjectId`, `status`, `requestedByAgent`, `decidedBy`, `decisionReason`, `expiresAt`, `createdAt`, `decidedAt`.
- [ ] `[BE]` Migration bridge: giữ `ai_approvals` backward-compatible nhưng ghi song song sang `agent_approvals` cho action mới.
- [ ] `[BE]` Approval policy engine: `before_execute`, `before_commit`, `two_person_rule`, `owner_only`, `security_admin_only`.
- [ ] `[FE]` Nâng Approvals Dashboard từ card skill đơn giản thành queue theo subject type, diff preview, eval summary, approve/reject/request changes.
- [ ] `[BE]` Audit mọi decision với actor, reason, before/after hash, request id.
- [ ] `[TEST]` Dangerous plan không execute trước approval; rejected artifact không commit; expired approval không còn hiệu lực.

## 4. Phase D — Artifact Store và versioning

Mục tiêu: output của agent trở thành tài sản có thể review, publish, rollback.

- [ ] `[DB]` Thêm `agent_artifacts` với `runId`, `siteId`, `type`, `target`, `title`, `contentRef` hoặc `content jsonb`, `hash`, `version`, `status` (`draft`/`reviewing`/`approved`/`published`/`rejected`/`rolled_back`), `createdAt`.
- [ ] `[BE]` Artifact writers cho các type đầu tiên: `schema_diff`, `page_spec`, `component_spec`, `seed_data`, `api_spec`, `prompt`, `migration`.
- [ ] `[BE]` Commit adapters: artifact `schema_diff` → collections/fields/relations; `seed_data` → items; `page_spec` → pages; tất cả đi qua permission + approval.
- [ ] `[FE]` Artifact review UI: diff view, JSON/raw mode, linked collections/items, approve/publish/rollback.
- [ ] `[SDK]` Client methods: list artifacts by goal/run, get artifact, approve/publish/rollback.
- [ ] `[TEST]` Artifact hash ổn định; publish idempotent; rollback khôi phục version trước; artifact cross-site bị deny.

## 5. Phase E — Evaluation Gate

Mục tiêu: admin duyệt dựa trên bằng chứng, không dựa trên niềm tin vào LLM.

- [ ] `[DB]` Thêm `agent_evaluations` với `runId`, `artifactId`, `kind`, `status`, `score`, `summary`, `details jsonb`, `createdAt`.
- [ ] `[BE]` Eval runner đầu tiên: JSON schema validation, permission diff lint, schema migration dry-run, generated API spec validation, prompt safety check.
- [ ] `[BE]` Policy: artifact loại `schema_diff`/`migration` không được request approval nếu chưa có eval pass hoặc explicit override.
- [ ] `[OPS]` Sandbox smoke test cho generated app/page spec ở Docker runtime trước khi publish.
- [ ] `[FE]` Hiển thị eval summary trong approval/artifact UI với trạng thái pass/warn/fail.
- [ ] `[TEST]` Artifact fail eval không publish được; warning cần reason khi override; eval result gắn đúng artifact hash.

## 6. Phase F — Memory và knowledge base có kiểm soát

Mục tiêu: memory hữu ích nhưng có scope, expiry, provenance và quyền truy cập.

- [ ] `[DB]` Thêm `agent_memory` với `siteId`, `scope` (`site`/`collection`/`item`/`user`/`goal`), `sourceType`, `sourceId`, `content`, `embedding`, `confidence`, `expiresAt`, `createdAt`.
- [ ] `[BE]` Memory write policy: chỉ ghi memory từ artifact/evaluation/approved output hoặc nguồn content rõ provenance.
- [ ] `[BE]` RAG context builder gom schema, permissions, recent runs, approved artifacts, memory phù hợp scope và field mask.
- [ ] `[BE]` PII/secrets redaction trước khi memory được embed hoặc đưa vào context.
- [ ] `[TEST]` User/agent chỉ retrieve memory trong policy scope; expired memory không vào context; field bị mask không xuất hiện trong RAG.

## 7. Phase G — App Generation MVP

Mục tiêu: chứng minh LumiBase không chỉ quản lý content mà giúp tạo business software.

- [ ] `[AI]` Skill `generateAppSpec` đọc collections/fields/relations/policies và sinh `page_spec` + `component_spec` artifacts.
- [ ] `[AI]` Skill `generateApiDocs` sinh `api_spec` artifact từ schema và permission public/role.
- [ ] `[AI]` Skill `generateSeedData` sinh `seed_data` artifact với eval schema validation trước khi insert.
- [ ] `[BE]` App generation run template cho use case e-commerce: products/orders/customers/storefront.
- [ ] `[FE]` Wizard “Generate app from schema”: chọn collections, target app, constraints, budget, approval policy.
- [ ] `[TEST]` End-to-end: tạo goal generate storefront → plan → artifacts → eval → approval → publish page/spec.

## 8. Phase H — Observability, cost và operations

Mục tiêu: agent vận hành được trong production, không chỉ demo.

- [ ] `[BE]` Metrics: run count, success/fail rate, approval latency, tool latency, eval fail rate, token/cost estimate.
- [ ] `[OPS]` Grafana dashboard “Agent Harness”: runs by status, cost by agent/tool/site, approval backlog, failed evals.
- [ ] `[BE]` Budget enforcement: max tool calls, max runtime, max estimated cost, max artifact size.
- [ ] `[BE]` Dead-letter queue cho run/tool call fail nhiều lần.
- [ ] `[FE]` Run detail timeline: plan, tool calls, logs, evals, approvals, artifacts.
- [ ] `[TEST]` Run vượt budget bị stop an toàn và ghi reason; retry không duplicate committed artifacts.

## 9. Thứ tự triển khai khuyến nghị

1. **A1 lifecycle DB + service**: `agent_goals`, `agent_runs`, `agent_tool_calls`, `AgentRunService`.
2. **B1 tool registry**: đưa `CORE_SKILLS` vào registry có risk/capability/rate limit.
3. **C1 approval tổng quát**: `agent_approvals` + Approvals Dashboard mới.
4. **D1 artifact store**: bắt đầu với `schema_diff`, `seed_data`, `api_spec`.
5. **E1 evaluation gate**: schema validation + permission diff + dry-run.
6. **G1 app generation e-commerce demo**: tạo luồng đầu tiên có thể demo end-to-end.

## 10. Definition of Done cho mỗi phase

- Có migration/schema Drizzle và docs cập nhật trong `docs/vi/data-model.md`.
- Có route/API contract trong `apps/cms/openapi.yaml` và SDK type tương ứng.
- Có property tests cho multi-tenant isolation, permission/capability, idempotency hoặc approval invariant.
- Có Studio UI tối thiểu để admin quan sát/duyệt/debug, không chỉ endpoint backend.
- Có audit log và metrics tối thiểu.
- Chạy được cả Cloudflare Workers và Docker runtime; nếu chưa hỗ trợ một runtime phải có feature flag và docs giới hạn.
