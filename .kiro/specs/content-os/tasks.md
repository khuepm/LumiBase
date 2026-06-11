# Implementation Plan: Content OS

## Overview

Triển khai 5 module A–E theo thứ tự phụ thuộc. Mỗi task nhóm theo module, có thể giao cho agent/người độc lập. Quy ước: TypeScript strict, Drizzle, Hono, Zod, fast-check property tests, mọi bảng mới scope `siteId`, feature flag mặc định off.

## Tasks

### Module A — Foundation

- [ ] 1. Provenance và Pin schema
  - [ ] 1.1 Thêm cột provenance vào `revisions`: `authorType`, `createdByRunId`, `model`, `constitutionHash`, `sources`, `confidence`, `staged`, `autoCommitAt`; thêm `pinnedFields` vào `items`; sinh + áp migration
    - _Requirements: 1.1, 1.5_
  - [ ] 1.2 Ghi `authorType`/`createdByRunId` tại ItemService (human path) và Harness write path (agent path)
    - _Requirements: 1.2, 1.3_
  - [ ] 1.3 Delivery API hỗ trợ `?provenance=true`, mask thông tin nhạy cảm
    - _Requirements: 1.4_
  - [ ] 1.4 Property test: Provenance round-trip (Property 13)
    - **Validates: Requirements 1.1, 1.2, 1.3**

- [ ] 2. Thật hoá 5 stub skills
  - [ ] 2.1 Nối `aiSuggestField`, `aiContentAssist` vào llm-provider + embedding RAG context; lỗi provider trả lỗi tường minh, không fallback stub
    - _Requirements: 2.1, 2.2_
  - [ ] 2.2 Nối `generateAppSpec`, `generateApiDocs`, `generateSeedData` → output là `agent_artifacts` qua evaluation gate
    - _Requirements: 2.1, 2.4_
  - [ ] 2.3 Ghi model/token/cost vào run metrics cho mọi LLM call
    - _Requirements: 2.3_

- [ ] 3. Run qua queue
  - [ ] 3.1 Mở rộng run state machine (`queued`, `cancelled`; stopReason `frozen/backpressure/write_budget`); enqueue qua `QueueProvider` khi `execution='async'`
    - _Requirements: 3.1, 3.2, 3.3_
  - [ ] 3.2 Resume run từ `awaiting_approval` không chạy lại tool call đã xong; cancel tại tool-call boundary
    - _Requirements: 3.4, 3.5_

- [ ] 4. MCP server + llms.txt
  - [ ] 4.1 `mcp-service.ts` + route `/api/v1/mcp` (Streamable HTTP): tool list từ `agent_tools` enabled, mọi call qua Harness, auth token capability
    - _Requirements: 4.1, 4.2, 4.3_
  - [ ] 4.2 Dangerous → trả `pending_approval` + approvalId trong tool result (không block)
    - _Requirements: 4.4_
  - [ ] 4.3 `llms.txt` public per site
    - _Requirements: 4.5_
  - [ ] 4.4 Property test: MCP parity (Property 14)
    - **Validates: Requirements 4.2**

### Module B — Reconciliation

- [ ] 5. Content Intents
  - [ ] 5.1 Bảng `content_intents` + JSON Schema `intent-rule.v1` + migration
    - _Requirements: 5.1, 5.4, 17.1, 17.3_
  - [ ] 5.2 `intent-service.ts`: CRUD, pause/resume, NL compile (trả bản compile chờ xác nhận, không tự kích hoạt)
    - _Requirements: 5.2, 5.3, 5.5_
  - [ ] 5.3 Routes `/api/v1/agent/intents` (capability `intents:write`)
    - _Requirements: 5.2_

- [ ] 6. Drift detection
  - [ ] 6.1 Bảng `content_drifts` (unique fingerprint per site) + migration
    - _Requirements: 6.3, 17.1_
  - [ ] 6.2 `drift-service.ts`: rule runners 6 loại v1; skip pinnedFields; partial-scan trong budget thời gian
    - _Requirements: 6.2, 6.4, 6.5_
  - [ ] 6.3 Flows operation type `drift-scan` chạy theo schedule của intent
    - _Requirements: 6.1_
  - [ ] 6.4 Property tests: Pinned field không sinh drift (Property 5); fingerprint dedupe (Property 4)
    - **Validates: Requirements 6.3, 6.4, 7.1**

- [ ] 7. Reconciler
  - [ ] 7.1 `reconciler-service.ts`: drift → goals (`origin='reconciler'`, intentId, driftFingerprint), dedupe, route theo role, autonomy = min(autonomyCap, grant)
    - _Requirements: 7.1, 7.2, 7.4_
  - [ ] 7.2 Budget `maxGoalsPerCycle` + circuit breaker (3 fails → intent error + incident + notify)
    - _Requirements: 7.3, 7.5_
  - [ ] 7.3 Property test: budget per cycle (Property 11)
    - **Validates: Requirements 7.5**

- [ ] 8. Override-is-law (Pin)
  - [ ] 8.1 `pin-service.ts`: auto-pin khi human sửa field thuộc intent active; prompt "ngoại lệ hay luật mới" (không chặn save, default giữ pin); release + audit
    - _Requirements: 8.1, 8.2, 8.4_
  - [ ] 8.2 PinGuard hook trong Harness: chặn agent write vào pinned field, denial `pinned_by_human`
    - _Requirements: 8.3_
  - [ ] 8.3 Routes pins (GET/DELETE) + badge Pin per field trong Studio item editor
    - _Requirements: 8.4, 8.5_
  - [ ] 8.4 Property test: Pin supremacy (Property 2)
    - **Validates: Requirements 8.1, 8.3**

- [ ] 9. Load-aware autonomy
  - [ ] 9.1 `load-guard-service.ts`: write coalescing per (run, collection) → 1 tag-invalidation; enforce `maxWritesPerMinute` (pause/resume tại tool-call boundary)
    - _Requirements: 9.1, 9.3_
  - [ ] 9.2 Maintenance window scheduling cho goal `origin='reconciler'`
    - _Requirements: 9.2_
  - [ ] 9.3 Backpressure: subscribe anomaly signal → pause reconciler runs của site + incident; hold-down resume; metrics `backpressure_activations`
    - _Requirements: 9.4, 9.5_
  - [ ] 9.4 Property test: write coalescing (Property 9)
    - **Validates: Requirements 9.1**

### Module C — Multi-agent org

- [ ] 10. Delegation + Agent Roles
  - [ ] 10.1 Cột `parentGoalId/origin/intentId/driftFingerprint/agentRole` trên `agent_goals`; bảng `agent_roles`; migration
    - _Requirements: 10.1, 10.2, 17.1_
  - [ ] 10.2 Seed role library: Planner, Writer, Translator, Taxonomist, SEO, FactChecker, Librarian — capability tối thiểu, Writer không có `schema:*`
    - _Requirements: 10.3_
  - [ ] 10.3 Planner: phân rã goal → sub-goals (kế thừa budget còn lại); Harness enforce capability = role ∩ grant; goal cha fail nếu acceptance không đạt
    - _Requirements: 10.1, 10.4, 10.5_

- [ ] 11. Agent-as-reviewer
  - [ ] 11.1 Cột `approverType/approverRunId` trên `agent_approvals`; ngưỡng agent-review per site + công tắc tắt toàn bộ
    - _Requirements: 11.1, 11.2, 11.5_
  - [ ] 11.2 Reviewer flow: quyết trong ngưỡng + capability `review:<domain>`; cấm self-review (cùng goal-tree); escalate người khi reject/low-confidence kèm deep-link
    - _Requirements: 11.2, 11.3, 11.4_
  - [ ] 11.3 Property test: self-review cấm (Property 8)
    - **Validates: Requirements 11.3**

### Module D — Trust ledger

- [ ] 12. Autonomy grants L0–L4
  - [ ] 12.1 Bảng `agent_autonomy_grants` + `agent_incidents`; migration
    - _Requirements: 12.1, 12.4, 17.1_
  - [ ] 12.2 `autonomy-service.ts`: resolveAutonomy (min của grant/intentCap/hardCeiling; defaults L2 safe / L1 dangerous; không-revert-được ≤ L2); tích hợp vào điểm quyết định risk của Harness
    - _Requirements: 12.2, 12.3, 12.7_
  - [ ] 12.3 Property test: autonomy resolver (Property 3)
    - **Validates: Requirements 12.2, 12.3, 12.7**

- [ ] 13. Promotion/demotion engine
  - [ ] 13.1 `trust-ledger-service.ts`: promote-check định kỳ (streak/approve-rate/zero-incident, ngưỡng per site) → tạo approval; chỉ effective khi human approve
    - _Requirements: 12.5_
  - [ ] 13.2 Demotion event-driven từ incident insert: −1 level (severity high → L1) tức thì + notify + evidence
    - _Requirements: 12.6_
  - [ ] 13.3 Property test: demotion bất biến (Property 7)
    - **Validates: Requirements 12.5, 12.6**

- [ ] 14. Veto Window
  - [ ] 14.1 `veto-service.ts`: dangerous @L3 → staged revision + approval `kind=veto, autoCommitAt`; notify users có quyền veto
    - _Requirements: 13.1, 13.2_
  - [ ] 14.2 Commit job qua queue: re-check pinnedFields (pin sau staging thắng), promote → live + provenance; retry backoff → incident
    - _Requirements: 13.3, 13.5, 8.6_
  - [ ] 14.3 Veto path: huỷ staging + rollback + incident(source=veto) + demotion signal
    - _Requirements: 13.4_
  - [ ] 14.4 Property test: veto window (Property 6)
    - **Validates: Requirements 13.1, 13.3, 13.4, 8.6**

- [ ] 15. Kill Switch
  - [ ] 15.1 `kill-switch-service.ts` + route: 4 mức (cancel run / pause intent / freeze role / freeze site); enforce tại tool-call boundary; capability `agents:freeze`; audit đầy đủ
    - _Requirements: 14.1, 14.2, 14.3, 14.5_
  - [ ] 15.2 Site frozen → từ chối goal/run mới, đọc vẫn hoạt động
    - _Requirements: 14.4_
  - [ ] 15.3 Property test: kill switch (Property 10)
    - **Validates: Requirements 14.2**

- [ ] 16. Constitution
  - [ ] 16.1 Bảng `constitutions` (versioned, hash, một active per site) + migration
    - _Requirements: 15.1, 17.1_
  - [ ] 16.2 `constitution-service.ts`: evaluator types (`rule` DSL + `llm_judge`), pin hash vào run, publish gate (blocking evaluator fail → chặn publish, override cần lý do), dry-run, activate + diff audit
    - _Requirements: 15.2, 15.3, 15.4, 15.5, 15.6_
  - [ ] 16.3 Property test: constitution pinning (Property 12)
    - **Validates: Requirements 15.3**

### Module E — Mission Control

- [ ] 17. Exception Inbox
  - [ ] 17.1 `mission-control/` module: inbox hợp nhất (approvals, veto countdown, escalations, incidents, intents lỗi) sắp theo độ khẩn; diff view + hành động inline
    - _Requirements: 16.1, 16.2, 13.6_
  - [ ] 17.2 SLO health per collection + trust ledger UI (role × capability, lịch sử promote/demote)
    - _Requirements: 16.3_

- [ ] 18. Constitution editor + Intent composer
  - [ ] 18.1 Constitution editor: NL → compile → dry-run trên content thật → activate; version diff
    - _Requirements: 16.4_
  - [ ] 18.2 Intent composer làm primary CTA; form editing giữ làm secondary path
    - _Requirements: 16.5_
  - [ ] 18.3 Kill switch UI 4 mức, confirm 2 bước cho freeze
    - _Requirements: 16.6_

### Xuyên suốt

- [ ] 19. Bất biến an ninh & tenancy
  - [ ] 19.1 Property test tenant isolation cho mọi service/route mới (Property 1)
    - **Validates: Requirements 17.1**
  - [ ] 19.2 Property test: prompt/tool input không đổi được capability/level (mở rộng test hiện có của Harness)
    - **Validates: Requirements 17.2**
  - [ ] 19.3 Mask secrets trong audit cho mọi guard/denial mới
    - _Requirements: 17.6_

- [ ] 20. Feature flags, metrics, docs
  - [ ] 20.1 Flags per site: `contentOs.reconciler / vetoWindow / agentReview / mcp` (default off); mọi flag off ⇒ hành vi như hiện tại
    - _Requirements: (rollout — design)_
  - [ ] 20.2 Prometheus metrics mới: autonomous operation rate, veto rate, coalescing ratio, backpressure activations, intent health; Grafana dashboard cập nhật
    - _Requirements: 9.5_
  - [ ] 20.3 Integration tests end-to-end: reconciliation cycle, veto flow, backpressure pause/resume
    - _Requirements: 6.x, 7.x, 9.4, 13.x_
  - [ ] 20.4 Cập nhật docs: data-model.md, hono-api-spec.md, agent-harness-layer.md, ai-native-vision.md (link spec), llms.txt index
    - _Requirements: (docs)_
