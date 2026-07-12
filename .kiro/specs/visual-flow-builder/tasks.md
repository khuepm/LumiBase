# Implementation Plan: Visual Flow Builder

## Overview

Gap-focused trên nền flows sẵn có. Thứ tự: luật chung (converter + validateGraph) → đồng bộ editor → event trigger → schedule → webhook → run history → chất lượng. Không phá manual run/editor hiện hành.

## Tasks

- [x] 1. Luật graph dùng chung
  - [x] 1.1 `packages/shared/src/flows/graph.ts`: `feToCanonical`/`canonicalToFe` (edge↔next/onError, entry, giữ position)
    - _Requirements: 4.1, 4.2, 4.4_
  - [x] 1.2 `validateGraph(graph, knownKeys)`: DANGLING_EDGE/CYCLE/NO_ENTRY/UNKNOWN_OPERATION
    - _Requirements: 5.1_
  - [x] 1.3 Unit test: round-trip converter; validateGraph bắt 4 lỗi
    - **Validates: Requirements 4.1, 5.1, 7.2**

- [x] 2. Operations registry endpoint + đồng bộ editor
  - [x] 2.1 `GET /api/v1/flows/operations` trả key + options schema từ registry (nguồn truth cho FE palette + knownKeys)
    - _Requirements: 5.1, 5.3_
  - [x] 2.2 `flow-editor.tsx`: load `canonicalToFe(flow.graph)`, save `feToCanonical` + `validateGraph` trước PATCH; lỗi inline trên node
    - _Requirements: 4.3, 5.3_
  - [x] 2.3 BE: POST/PATCH flow chạy `validateGraph`; `active` + sai → 400
    - _Requirements: 5.2_

- [x] 3. Event trigger
  - [x] 3.1 `flow-dispatch.ts`: `findActiveEventFlows(siteId, collection, action)` (filter siteId/status/triggerType/options); `dispatchItemEvent` enqueue qua `runtime.queue`
    - _Requirements: 1.1, 1.3, 1.5_
  - [x] 3.2 Móc `dispatchItemEvent` vào ItemService sau commit create/update/delete — async, không block response
    - _Requirements: 1.1, 1.2, 7.3_
  - [x] 3.3 Queue worker: load flow, `runFlow`, ghi `flowRuns`
    - _Requirements: 1.4_
  - [x] 3.4 Test: event match (khớp/không/cross-site); mutate không chờ flow; flowRuns ghi
    - **Validates: Requirements 1.1, 1.5, 7.3**

- [x] 4. Schedule runner
  - [x] 4.1 `flow-scheduler.ts`: `runDueScheduledFlows(env, now)` chọn flow due, enqueue, cập nhật `nextRunAt` từ cron; `nextCron` + validate cron
    - _Requirements: 2.1, 2.4_
  - [x] 4.2 Móc vào scheduled handler runtime (CF Cron / Docker) — runtime abstraction, không CF binding trong service
    - _Requirements: 2.2_
  - [x] 4.3 Validate cron khi POST/PATCH (cron sai → không activate)
    - _Requirements: 2.3_
  - [x] 4.4 Test: chọn đúng flow due; nextRunAt cập nhật; cron sai bị từ chối
    - **Validates: Requirements 2.1, 2.3**

- [x] 5. Webhook trigger
  - [x] 5.1 `POST /api/v1/flows/:id/trigger`: assert webhook+active, auth token (compare hằng-thời-gian), input {body,headers,query}, runFlow, ghi flowRuns, trả {runId,status}
    - _Requirements: 3.1, 3.2, 3.3_
  - [x] 5.2 Test: token đúng/sai; ghi run
    - **Validates: Requirements 3.2**

- [x] 6. Run history UI
  - [x] 6.1 `GET /api/v1/flows/:id/runs/:runId` chi tiết steps per-node
    - _Requirements: 6.2_
  - [x] 6.2 `RunHistoryPanel`: list runs (status/startedAt/duration) + chọn run → input/steps/error
    - _Requirements: 6.1, 6.2_
  - [x] 6.3 Highlight node trên canvas theo steps của run đã chọn (success/error/skipped); Test Run hiển thị steps ngay
    - _Requirements: 6.3, 6.4_
  - [x] 6.4 Component test: RunHistoryPanel render steps; highlight theo run
    - **Validates: Requirements 6.2, 6.3**

- [x] 7. Chất lượng & Setup Impact
  - [x] 7.1 `pnpm typecheck` + `pnpm test` pass; không phá manual run/editor; cập nhật `docs/en/api/hono-api-spec.md` (operations, trigger, runs/:runId)
    - _Requirements: 7.1, 7.4_
  - [x] 7.2 **Setup Impact** (DoD): rà soát 6 câu hỏi. Cân nhắc seed flow mẫu (Q1) — dự kiến `n/a`. Lưu ý: scheduled handler đăng ký runtime có thể cần bước cấu hình; ghi rõ khi implement. Thêm dòng registry sau
    - _Requirements: DoD_

---

## Implementation status (2026-07-06)

**Done — toàn bộ.** Task 1 (shared graph + validate + 8 unit tests) đã có từ trước (flow-graph.ts / flow-graph.test.ts). Hoàn tất hôm nay:

- **2**: `GET /flows/operations` (registry + palette docs); graph gate POST/PATCH (`GRAPH_*` 400 khi active, draft được lưu dở); editor load/save qua `canonicalToFe`/`feToCanonical` (đọc được cả graph RF-format cũ), palette load từ registry, validate trước save + inline node ring đỏ.
- **3**: `flow-dispatch.ts` — `findActiveEventFlows` (match collection/action, string|array|wildcard) + `dispatchItemEvent` (queue `flow-events`, không bao giờ throw) móc vào ItemService create/update/delete; consumer `registerFlowEventWorker` (serve.ts) chạy flow + ghi `flow_runs`, re-check active khi consume.
- **4**: `flow-scheduler.ts` — cron 5-field tự viết (không thêm dependency; wildcard/list/range/step, DOM|DOW semantics chuẩn), `runDueScheduledFlows` sweep trong `runSchedulerTick`, advance `next_run_at` TRƯỚC enqueue (idempotent), cron sai → clear `next_run_at`; validate cron khi save (`CRON_INVALID`/`CRON_REQUIRED`).
- **5**: `POST /flows/:id/trigger` — token per-flow (SHA-256 digest constant-time), đăng ký trước `requireFlowAdmin` + bypass `withAuth`; strip credential headers khỏi run input; 404 chung cho non-webhook/inactive (chống probe).
- **6**: `GET /flows/:id/runs/:runId`; `RunHistoryPanel` (list + detail steps/input/error) + highlight node canvas theo run (executed xanh, node lỗi đỏ, chưa chạy mờ); Test Run mở panel ngay.
- **7**: api-spec §7 cập nhật (operations/trigger/gates); Setup Impact #25 cập nhật (queue mới `flow-events`; CF Workers cần wire consumer).

**Verified:** flow-graph 8 + flow-dispatch 7 + flow-scheduler 10 + flows-triggers route 10 + scheduler-worker 5 + run-history-panel component 3 = 43 tests; recursive typecheck pass.
