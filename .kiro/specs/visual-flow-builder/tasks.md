# Implementation Plan: Visual Flow Builder

## Overview

Gap-focused trên nền flows sẵn có. Thứ tự: luật chung (converter + validateGraph) → đồng bộ editor → event trigger → schedule → webhook → run history → chất lượng. Không phá manual run/editor hiện hành.

## Tasks

- [x] 1. Luật graph dùng chung
  - [x] 1.1 `packages/shared/src/flows/graph.ts`: `feToCanonical`/`canonicalToFe` (edge↔next/onError, entry, giữ position) — done: `packages/shared/src/schemas/flow-graph.ts`
    - _Requirements: 4.1, 4.2, 4.4_
  - [x] 1.2 `validateGraph(graph, knownKeys)`: DANGLING_EDGE/CYCLE/NO_ENTRY/UNKNOWN_OPERATION
    - _Requirements: 5.1_
  - [x] 1.3 Unit test: round-trip converter; validateGraph bắt 4 lỗi — done: `apps/cms/src/services/__tests__/flow-graph.test.ts`
    - **Validates: Requirements 4.1, 5.1, 7.2**

- [ ] 2. Operations registry endpoint + đồng bộ editor
  - [ ] 2.1 `GET /api/v1/flows/operations` trả key + options schema từ registry (nguồn truth cho FE palette + knownKeys) — **chưa làm**: không có `GET /flows/operations`
    - _Requirements: 5.1, 5.3_
  - [ ] 2.2 `flow-editor.tsx`: load `canonicalToFe(flow.graph)`, save `feToCanonical` + `validateGraph` trước PATCH; lỗi inline trên node — **làm một phần**: `flow-editor.tsx` (drag-drop @xyflow/react, save PATCH) TỒN TẠI nhưng KHÔNG dùng `feToCanonical`/`canonicalToFe`/`validateGraph` shared — converter viết tay trong editor
    - _Requirements: 4.3, 5.3_
  - [ ] 2.3 BE: POST/PATCH flow chạy `validateGraph`; `active` + sai → 400 — **chưa làm**: POST/PATCH flow không chạy `validateGraph`
    - _Requirements: 5.2_

- [ ] 3. Event trigger
  - [ ] 3.1 `flow-dispatch.ts`: `findActiveEventFlows(siteId, collection, action)` (filter siteId/status/triggerType/options); `dispatchItemEvent` enqueue qua `runtime.queue` — **chưa làm**
    - _Requirements: 1.1, 1.3, 1.5_
  - [ ] 3.2 Móc `dispatchItemEvent` vào ItemService sau commit create/update/delete — async, không block response — **chưa làm**: ItemService không dispatch event flow
    - _Requirements: 1.1, 1.2, 7.3_
  - [ ] 3.3 Queue worker: load flow, `runFlow`, ghi `flowRuns` — **chưa làm**
    - _Requirements: 1.4_
  - [ ] 3.4 Test: event match (khớp/không/cross-site); mutate không chờ flow; flowRuns ghi — **chưa làm**
    - **Validates: Requirements 1.1, 1.5, 7.3**

- [ ] 4. Schedule runner
  - [ ] 4.1 `flow-scheduler.ts`: `runDueScheduledFlows(env, now)` chọn flow due, enqueue, cập nhật `nextRunAt` từ cron; `nextCron` + validate cron — **chưa làm** (flow-service có wiring cron cho intents — `triggerOptions.cron` — nhưng không có `runDueScheduledFlows` tổng quát)
    - _Requirements: 2.1, 2.4_
  - [ ] 4.2 Móc vào scheduled handler runtime (CF Cron / Docker) — runtime abstraction, không CF binding trong service — **chưa làm**
    - _Requirements: 2.2_
  - [ ] 4.3 Validate cron khi POST/PATCH (cron sai → không activate) — **chưa làm**
    - _Requirements: 2.3_
  - [ ] 4.4 Test: chọn đúng flow due; nextRunAt cập nhật; cron sai bị từ chối — **chưa làm**
    - **Validates: Requirements 2.1, 2.3**

- [ ] 5. Webhook trigger
  - [ ] 5.1 `POST /api/v1/flows/:id/trigger`: assert webhook+active, auth token (compare hằng-thời-gian), input {body,headers,query}, runFlow, ghi flowRuns, trả {runId,status} — **chưa làm**: không có endpoint `POST /flows/:id/trigger`
    - _Requirements: 3.1, 3.2, 3.3_
  - [ ] 5.2 Test: token đúng/sai; ghi run — **chưa làm**
    - **Validates: Requirements 3.2**

- [ ] 6. Run history UI
  - [ ] 6.1 `GET /api/v1/flows/:id/runs/:runId` chi tiết steps per-node — **chưa làm**: chỉ có `GET /:id/runs` (list), không có `/runs/:runId` chi tiết
    - _Requirements: 6.2_
  - [ ] 6.2 `RunHistoryPanel`: list runs (status/startedAt/duration) + chọn run → input/steps/error — **chưa làm**
    - _Requirements: 6.1, 6.2_
  - [ ] 6.3 Highlight node trên canvas theo steps của run đã chọn (success/error/skipped); Test Run hiển thị steps ngay — **chưa làm**
    - _Requirements: 6.3, 6.4_
  - [ ] 6.4 Component test: RunHistoryPanel render steps; highlight theo run — **chưa làm**
    - **Validates: Requirements 6.2, 6.3**

- [ ] 7. Chất lượng & Setup Impact
  - [ ] 7.1 `pnpm typecheck` + `pnpm test` pass; không phá manual run/editor; cập nhật `docs/en/api/hono-api-spec.md` (operations, trigger, runs/:runId) — **làm một phần**: typecheck pass; docs cho operations/trigger/runs chưa có vì endpoint chưa tồn tại
    - _Requirements: 7.1, 7.4_
  - [x] 7.2 **Setup Impact** (DoD): rà soát 6 câu hỏi. Cân nhắc seed flow mẫu (Q1) — dự kiến `n/a`. Lưu ý: scheduled handler đăng ký runtime có thể cần bước cấu hình; ghi rõ khi implement. Thêm dòng registry sau — done một phần: registry #25 (n/a, 2026-06-18) cho phần converter; ghi chú rà lại khi làm scheduled runner
    - _Requirements: DoD_
