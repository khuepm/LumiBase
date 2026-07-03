# Requirements Document — Visual Flow Builder

## Introduction

Directus **Flows** là automation node-based: trigger (event/schedule/webhook/manual) → chuỗi operation (condition/transform/http/mail/...). LumiBase đã có **phần lớn**: bảng `flows`/`flowRuns`/`operations`, `flow-service.ts` với `runFlow()` + handler registry, routes CRUD + manual run, và Studio editor ReactFlow (`apps/studio/src/modules/automation/`).

Spec này gap-focused: hoàn thiện những mảnh còn thiếu để FE↔BE phối hợp mượt — cụ thể (1) **event trigger** thực sự kích hoạt flow khi item thay đổi, (2) **schedule runner** chạy flow theo cron, (3) **webhook trigger** nhận inbound, (4) **run history UI** với từng-node output, (5) **validation graph** (FE và BE cùng luật), (6) đồng bộ format graph giữa FE (`{nodes, edges}`) và BE (`{entry, nodes:[{next,onError}]}`).

Hiện trạng tận dụng được (xác minh trong codebase):
- Bảng `flows` (`packages/database/src/schema/cms.ts:294-321`): triggerType `webhook|event|schedule|manual`, triggerOptions, graph JSONB, nextRunAt, status.
- Bảng `flowRuns` (`:323-349`): status, input, steps (per-node output), output, error, startedAt/finishedAt.
- Bảng `operations` (`:351-374`): type `condition|transform|http|mail|log|sleep|run-extension|item.create|item.update|item.delete|notify`.
- `flow-service.ts`: `runFlow(graph, input, env)` traverse `entry→next/onError`, cycle detection; `registerHandler(key, handler)`; built-in handlers (log/condition/transform/http SSRF-guarded/sleep/mail/drift-scan/trust-promote-check).
- Routes (`apps/cms/src/routes/flows.ts`): GET/POST/GET:id/PATCH/DELETE, `POST /:id/run`, `GET /:id/runs`. Guard `requireFlowAdmin`.
- Studio (`apps/studio/src/modules/automation/`): `flow-editor.tsx` (ReactFlow + palette + per-node config), `flow-node-types.tsx` (8 node), `flows-page.tsx` (list + manual run).
- `conditions.ts`: `ConditionRule` + `evaluateRule` (Directus `_and/_or`).

## Glossary

- **Flow**: Một automation: trigger + graph operation. Bảng `flows`.
- **Trigger**: Nguồn kích hoạt: `event` (item mutation), `schedule` (cron), `webhook` (inbound HTTP), `manual` (nút Run).
- **Operation / Node**: Một bước trong graph; type quyết định handler chạy. Bảng `operations` + node trong `flows.graph`.
- **Flow_Run**: Một lần chạy flow, lưu input/steps/output/error. Bảng `flowRuns`.
- **Graph_BE**: Format runtime BE: `{ entry?, nodes: [{ id, key, options?, next?, onError? }] }`.
- **Graph_FE**: Format editor FE: `{ nodes: [...], edges: [...] }` (ReactFlow).
- **Run_History**: Danh sách Flow_Run của một flow + chi tiết từng-node output.

## Requirements

### Requirement 1: Event trigger — kích hoạt khi item thay đổi

**User Story:** Là người dựng automation, tôi muốn flow tự chạy khi item được tạo/sửa/xóa, để không phải bấm Run thủ công.

#### Acceptance Criteria

1. WHEN một item được create/update/delete qua `ItemService`, THE system SHALL tìm các flow `status=active`, `triggerType=event`, có `triggerOptions` khớp (collection + action) và chạy chúng với `input = { event, collection, key, payload }`.
2. THE event dispatch SHALL chạy bất đồng bộ (qua queue/runtime, KHÔNG block response mutate item) — fire-and-forget với ghi `flowRuns`.
3. THE `triggerOptions` cho event SHALL hỗ trợ `{ collections: string[], actions: ('create'|'update'|'delete')[] }`; flow chỉ chạy khi collection ∈ collections và action ∈ actions.
4. Mỗi lần chạy SHALL ghi một `flowRuns` row (siteId, flowId, input, steps, output/error, timestamps).
5. THE dispatch SHALL filter `siteId` — flow của site A không kích hoạt bởi item của site B.

### Requirement 2: Schedule trigger — chạy theo cron

**User Story:** Là người vận hành, tôi muốn flow chạy định kỳ (vd quét drift mỗi giờ), để tự động hoá tác vụ lặp.

#### Acceptance Criteria

1. THE system SHALL có scheduled runner quét flow `status=active`, `triggerType=schedule`, `nextRunAt <= now`, chạy chúng và tính `nextRunAt` kế tiếp từ cron trong `triggerOptions.cron`.
2. THE runner SHALL chạy qua cơ chế scheduled hiện có của runtime (CF Cron Triggers / Docker scheduler) — KHÔNG import CF binding trong business logic (runtime abstraction).
3. WHEN `triggerOptions.cron` không hợp lệ, THE flow SHALL không được activate (validate khi PATCH/POST) hoặc bị bỏ qua an toàn với log.
4. Mỗi lần chạy schedule SHALL ghi `flowRuns` và cập nhật `nextRunAt`.

### Requirement 3: Webhook trigger — nhận inbound

**User Story:** Là tích hợp bên ngoài, tôi muốn gọi một URL để kích hoạt flow, để nối LumiBase với hệ thống khác.

#### Acceptance Criteria

1. THE system SHALL có endpoint `POST /api/v1/flows/:id/trigger` (hoặc path token-based) chạy flow `triggerType=webhook` với `input = { body, headers, query }`.
2. THE webhook trigger SHALL xác thực (token trong `triggerOptions` hoặc auth hiện hành) trước khi chạy; request không hợp lệ → 401/403.
3. THE webhook run SHALL ghi `flowRuns` và trả `{ data: { runId, status } }`.

### Requirement 4: Đồng bộ format graph FE↔BE

**User Story:** Là maintainer, tôi muốn editor (Graph_FE `{nodes,edges}`) và runtime (Graph_BE `{entry,nodes[next,onError]}`) không lệch nhau, để flow vẽ trên UI chạy đúng như runtime hiểu.

#### Acceptance Criteria

1. THE system SHALL có một converter dứt khoát giữa Graph_FE và Graph_BE (edge `next`/`onError` ↔ node.next/onError; entry = node không có edge tới).
2. THE converter SHALL là code chung (`@lumibase/shared` hoặc SDK) để FE serialize trước khi lưu và BE/đọc dùng cùng luật — KHÔNG mỗi phía tự suy diễn.
3. WHEN lưu flow từ editor, THE graph được persist SHALL ở một format chuẩn (chọn Graph_BE làm canonical, FE chuyển khi load/save) — `flows.graph` chỉ chứa canonical.
4. THE position node (toạ độ editor) SHALL được giữ (trong `operations.position` hoặc trong node) để load lại editor đúng layout.

### Requirement 5: Validation graph (FE + BE cùng luật)

**User Story:** Là người dựng flow, tôi muốn được cảnh báo khi graph sai (node trỏ tới id không tồn tại, cycle, thiếu entry), để không lưu/chạy flow hỏng.

#### Acceptance Criteria

1. THE system SHALL có `validateGraph(graph): { ok, errors[] }` dùng chung FE/BE: phát hiện node `next/onError` trỏ tới id không tồn tại, cycle, không có entry, key operation không có handler đăng ký.
2. WHEN POST/PATCH flow, THE BE SHALL chạy `validateGraph`; graph sai → 400 `{ errors }` (không lưu graph sai vào DB cho flow `active`).
3. THE editor SHALL chạy cùng `validateGraph` trước khi cho Save/Activate và hiển thị lỗi inline trên node liên quan.

### Requirement 6: Run history UI

**User Story:** Là người vận hành, tôi muốn xem lịch sử chạy của flow và output từng node, để debug khi flow lỗi.

#### Acceptance Criteria

1. THE editor/flows page SHALL có panel Run_History dùng `GET /api/v1/flows/:id/runs` hiển thị danh sách run (status, startedAt, duration) sắp mới nhất trước.
2. WHEN chọn một run, THE panel SHALL hiển thị từng-node output từ `flowRuns.steps` (keyed theo node id), input, và error nếu có.
3. THE editor SHALL highlight node trên canvas theo trạng thái của run đã chọn (success/error/skipped) khi xem một run.
4. THE Test Run trong editor SHALL hiển thị kết quả run ngay (steps) sau khi `POST /:id/run`.

### Requirement 7: Chất lượng & tương thích

#### Acceptance Criteria

1. THE thay đổi SHALL không phá vỡ manual run hiện có (`POST /:id/run`) và editor hiện hành.
2. `validateGraph`, converter Graph_FE↔BE, và event-match SHALL có unit test.
3. Event dispatch SHALL không làm chậm đáng kể path mutate item (async, đo bằng test/metric).
4. `pnpm typecheck` + `pnpm test` pass; runtime abstraction tuân thủ; mọi query filter `siteId`; response `{ data }`/`{ errors }`.
