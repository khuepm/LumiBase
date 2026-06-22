# Design Document — Visual Flow Builder

## Overview

Flows đã có nền vững (schema + `runFlow()` + editor ReactFlow). Spec này lấp 6 gap để FE↔BE mượt: event trigger, schedule runner, webhook trigger, converter Graph_FE↔BE chung, validateGraph chung, run-history UI. Trục thiết kế: **luật dùng chung** (converter + validateGraph ở `@lumibase/shared`) và **dispatch async** (không block mutate item).

## Architecture

### Canonical graph & converter (`packages/shared/src/flows/`)

Chọn **Graph_BE làm canonical** (đã là format runtime). Editor chuyển khi load/save.

```ts
// graph.ts (shared)
export interface FlowNode { id: string; key: string; options?: Record<string, unknown>; next?: string|null; onError?: string|null; position?: {x:number;y:number} }
export interface FlowGraph { entry?: string; nodes: FlowNode[] }
export interface FeGraph { nodes: FeNode[]; edges: FeEdge[] }   // ReactFlow

export function feToCanonical(fe: FeGraph): FlowGraph   // edge type 'next'|'onError' → node.next/onError; entry = node không là target của edge nào
export function canonicalToFe(g: FlowGraph): FeGraph     // ngược lại, giữ position
export function validateGraph(g: FlowGraph, knownKeys: string[]): { ok: boolean; errors: GraphError[] }
//   errors: DANGLING_EDGE (next/onError trỏ id lạ), CYCLE, NO_ENTRY, UNKNOWN_OPERATION (key không có handler)
```
`knownKeys` = danh sách operation key có handler (BE lấy từ registry; FE lấy từ const đồng bộ hoặc endpoint `GET /flows/operations`).

### Event trigger dispatch

Móc vào `ItemService` (nơi create/update/delete xảy ra). Sau khi mutate thành công + commit:

```ts
// apps/cms/src/services/flow-dispatch.ts
export async function dispatchItemEvent(env, siteId, ev: { event:'create'|'update'|'delete', collection, key, payload }) {
  const flows = await findActiveEventFlows(db, siteId, ev.collection, ev.event);  // filter siteId, status active, triggerType event, options khớp
  for (const f of flows) enqueueFlowRun(env.runtime.queue, { flowId: f.id, siteId, input: ev });   // async qua runtime queue
}
```
- Gọi từ ItemService sau commit, **không await** (hoặc await enqueue nhanh) → không block response.
- Worker tiêu thụ queue: load flow, `runFlow(graph, input, { db, siteId })`, ghi `flowRuns`.
- Runtime abstraction: dùng `env.runtime.queue` (CF Queue / Docker in-proc), KHÔNG import CF binding trong service.

### Schedule runner

```ts
// apps/cms/src/services/flow-scheduler.ts
export async function runDueScheduledFlows(env, now) {
  const due = await db.select().from(flows).where(and(eq(status,'active'), eq(triggerType,'schedule'), lte(nextRunAt, now)));
  for (const f of due) {
    await enqueueFlowRun(env.runtime.queue, { flowId: f.id, siteId: f.siteId, input: { scheduled: true } });
    await db.update(flows).set({ nextRunAt: nextCron(f.triggerOptions.cron, now) }).where(eq(flows.id, f.id));
  }
}
```
Gọi từ scheduled handler của runtime (CF Cron Trigger `scheduled()` / Docker cron) — đặt cùng nơi audit `scheduled.ts` đã móc. `nextCron` dùng cron parser (validate khi save).

### Webhook trigger

```
POST /api/v1/flows/:id/trigger
  - load flow (siteId scope), assert triggerType=webhook & active
  - auth: token trong triggerOptions.token (compare hằng-thời-gian) hoặc auth middleware hiện hành
  - input = { body, headers, query }; runFlow (đồng bộ hoặc enqueue); ghi flowRuns
  - 200 { data: { runId, status } } | 401/403
```

### Routes bổ sung (`apps/cms/src/routes/flows.ts`)

```
(giữ) GET/POST/GET:id/PATCH/DELETE, POST /:id/run, GET /:id/runs
+ GET    /api/v1/flows/operations         danh sách operation key + schema options (cho FE palette + validate)
+ GET    /api/v1/flows/:id/runs/:runId    chi tiết 1 run (steps per-node)
+ POST   /api/v1/flows/:id/trigger        webhook trigger
```
- POST/PATCH: chạy `validateGraph` (canonical) trước khi lưu; `active` + graph sai → 400.
- Guard `requireFlowAdmin` giữ nguyên cho admin ops; `/trigger` dùng token riêng.

## Component tree (Studio `modules/automation/`)

```
flow-editor.tsx (sửa)
├─ load: canonicalToFe(flow.graph) → ReactFlow; save: feToCanonical → PATCH (validate trước)
├─ inline validation: validateGraph → badge lỗi trên node (DANGLING/CYCLE/NO_ENTRY/UNKNOWN_OP)
├─ <RunHistoryPanel flowId/> (mới) — GET /:id/runs; chọn run → GET /:id/runs/:runId
│     └─ highlight node theo steps[run] (success/error/skipped) lên canvas
└─ Test Run → POST /:id/run → hiển thị steps ngay + highlight

flow-node-types.tsx (giữ 8 node) — thêm trigger config form cho event(collections,actions)/schedule(cron)/webhook(token)
flows-page.tsx (giữ) — list + manual run; thêm cột "last run status"
```

## Sequence — event trigger

```
PATCH /items/posts/123 → ItemService.update (commit) 
   └─ dispatchItemEvent({event:'update',collection:'posts',key:'123',payload})  [async, không block]
        findActiveEventFlows(siteId,'posts','update') → [flowA]
        enqueue {flowId:A, input}
   ← response item (ngay, không chờ flow)
Queue worker: runFlow(A.graph, input, {db,siteId}) → ghi flowRuns(steps,output)
```

## Sequence — save từ editor

```
Editor Save → feToCanonical(feGraph) → validateGraph(canonical, knownKeys)
   ok=false → hiển thị lỗi inline, không gọi API
   ok=true  → PATCH /flows/:id { graph: canonical }
        BE: validateGraph lại (defense) → lưu | 400
```

## Quyết định mở

1. **Queue vs in-proc:** dùng `env.runtime.queue` abstraction; CF = Queues, Docker = in-process worker (như `agent-run-worker.ts` đã làm). Theo pattern hiện có.
2. **Cron parser lib:** chọn lib nhẹ (vd `cron-parser`) cho `nextCron` + validate; nêu khi implement.
3. **knownKeys cho FE:** đề xuất endpoint `GET /flows/operations` (BE là nguồn truth registry) để FE không hard-code lệch.

## Error handling

- Flow lỗi khi chạy → `flowRuns.status='error'`, `error` lưu stack; không ảnh hưởng mutate item gốc (đã commit).
- Graph sai khi save → 400, editor highlight node.
- Webhook token sai → 401/403, không ghi run (hoặc ghi run `rejected` tuỳ chọn).
- Cron sai → không activate được (validate) ; flow đang active mà cron hỏng → skip + log.

## Testing strategy

- `feToCanonical`/`canonicalToFe` round-trip giữ nguyên graph (property test).
- `validateGraph`: bắt DANGLING/CYCLE/NO_ENTRY/UNKNOWN_OP.
- Event match: collection/action khớp/không khớp; cross-site không kích hoạt.
- Dispatch async: mutate item không chờ flow (đo); flowRuns được ghi.
- Schedule: `runDueScheduledFlows` chọn đúng flow due, cập nhật nextRunAt.
- Webhook: token đúng/sai; ghi run.
- FE: editor load/save round-trip; RunHistoryPanel render steps; highlight node theo run.
