---
version: 7
lastUpdated: 2026-10-15T22:44:20.342Z
sourceLang: vi
contentHash: fa7cc4b0208971d5
codeVerified: 2026-10-15T22:44:20.342Z
codeVerifiedHash: fa7cc4b0208971d5
codeVerifiedClaims: 16
translatedFrom: en
sourceHash: a3fe5733ba13b42f
mtEngine: manual
syncStatus: human-translated
---

# Flows / Operations Engine

LumiBase Flows cho phép tự động hoá workflow đa bước — tương tự Directus Flows. Một flow là một **graph các operation** chạy theo trigger (webhook, event, schedule, hoặc manual).

## Tables

| Table | Mục đích |
|-------|----------|
| `flows` | Definition: name, status, trigger type/options, graph, nextRunAt |
| `flow_runs` | Execution history: status, input, steps (per-node output), output, error |
| `operations` | Khai báo node trong graph: key, type, options, position |

Status flow: `active` / `inactive` / `draft`. Status run: `pending` / `running` / `success` / `error` / `cancelled`.

## Trigger types

| Type | Khi nào trigger |
|------|-----------------|
| `webhook` | HTTP POST đến URL public của flow |
| `event` | Item lifecycle: `item.create` / `item.update` / `item.delete` (cấu hình collection trong `triggerOptions`) |
| `schedule` | Cron expression — `nextRunAt` được tính sẵn |
| `manual` | Admin click "Run" trong Studio hoặc gọi `POST /api/v1/flows/:id/run` |

## Operation types

Khai báo trong cột `operations.type`:

- **`condition`** — so sánh một path với một giá trị; output `{ pass, branch: 'true' | 'false' }` điều khiển `branches` (nếu node có) hoặc `next`.
- **`transform`** — biến đổi payload bằng JSONata.
- **`http`** — gọi external API (axios/fetch).
- **`mail`** — gửi email qua Resend/SMTP.
- **`log`** — append vào activity log.
- **`sleep`** — pause N giây.
- **`run-extension`** — gọi extension đã mount.
- **`item.create`** / **`item.update`** / **`item.delete`** — CRUD vào CMS data.
- **`notify`** — push notification tới user/team.
- **`ai:decision`** — quyết định có governance trên một item, chọn nhánh `true`/`false`/`unknown`/`error` (xem bên dưới).
- **`ai:apply-tags`** / **`editorial:route`** — đọc một `ai:decision` phía trước và đề xuất một tag hoặc một hàng chờ duyệt cho item; mặc định là shadow (chỉ ghi lại), và một đề xuất live thành approval (xem [Tự động hoá Jev](./jev-automation.md)).
- **`drift-scan`** — một chu kỳ reconciliation của Content OS cho một intent (`options.intentId`): quét drift theo rules của `content_intents` (tôn trọng pinned fields, time-box qua `options.timeBudgetMs`, cursor resume), rồi sinh reconciler goals trong budget `maxGoalsPerCycle`. Lên lịch một flow trigger `schedule` per intent theo cron của intent.

## Graph format

Cột `flows.graph` lưu graph dạng:

```json
{
  "entry": "node-1",
  "nodes": [
    {
      "id": "node-1",
      "key": "fetch-user",
      "options": { "url": "https://api.example.com/users/{{input.id}}" },
      "next": "node-2",
      "onError": "node-error"
    },
    { "id": "node-2", "key": "log-result", "options": {}, "next": null }
  ]
}
```

`key` reference đến `operations.key` (unique per flow). Edge `next` cho luồng thành công, `onError` cho luồng lỗi.

## Nhánh tường minh và `ai:decision` (#517)

Một node có thể khai `branches`: map từ key nhánh mà operation trả về tới node kế tiếp. `null` kết thúc run ở nhánh đó.

```json
{
  "id": "decide",
  "key": "ai:decision",
  "options": { "profileKey": "moderation", "profileVersion": 3, "collection": "posts", "questionKey": "spam", "noulThreshold": 0.8 },
  "branches": { "true": "hold", "false": "publish", "unknown": "queue-review", "error": "notify-admin" }
}
```

Quy tắc của runner:

- Node có `branches` đi theo `branch` mà operation trả về và không bao giờ rơi xuống `next`. Nhánh trả về mà không có trong `branches` là lỗi của run (`Unmapped branch "<key>" at node <id>`). Operation không trả `branch` cũng là lỗi.
- Graph cũ chỉ có `next` chạy như trước. `condition` trả thêm `branch: 'true' | 'false'` (vẫn giữ `pass`).
- Run bị huỷ hoặc quá timeout không bắt đầu node nào nữa.
- `validateGraph` kiểm tra target của nhánh, key nhánh và vòng lặp qua nhánh. Flow `active` có node `ai:decision` mà không có `branches` bị từ chối (`GRAPH_BRANCHES_REQUIRED`).

Operation `ai:decision` đưa ra một quyết định có governance trên một item đã lưu:

| Option | Ý nghĩa |
|--------|---------|
| `profileKey`, `profileVersion` | Review profile và version cố định (bắt buộc; không bao giờ dùng ngầm version đang active) |
| `collection`, `itemId` | Item cần quyết định; thiếu `itemId` thì lấy `input.itemId` |
| `questionKey` | Câu hỏi của profile quyết định nhánh |
| `noulThreshold` | Câu hỏi `noul`: `true` khi ≥ t, `false` khi ≤ 1 − t, còn lại `unknown`. Với t = 0.5, câu trả lời đúng bằng 0.5 thoả cả hai phía và là `unknown` (`between_thresholds`) |
| `minConfidence` | Câu hỏi `choice`: dưới ngưỡng này, hoặc khi model abstain (`other`/`unknown`), nhánh là `unknown` |

Output lưu vào step của node: `{ branch, runId, replayed, decision, errorCode? }`. `runId` là review run (provenance). Câu hỏi `score` không quyết định nhánh được.

Governance, kiểm tra lúc node chạy chứ không phải lúc run vào hàng đợi:

- **Bật/tắt.** Cần setting `aiDecisions` có cả `enabled: true` lẫn `flows: true`. `flows` mặc định tắt (Phase C). Kill switch của site (`enabled: false`) cũng dừng flows. Site admin bật/tắt `flows` trong Studio ở **Settings → AI decisions** (**Allow decisions in Flows**), hoặc qua settings API.
- **Principal.** Chỉ run thủ công (`POST /api/v1/flows/:id/run`) mang principal: một tham chiếu tới người gọi, không có snapshot quyền. Worker resolve lại principal đó, kiểm `ai:decide` trên grant hiện hành và đọc nội dung với quyền row/field của chính người đó. Run từ event, schedule và webhook không có ai để quyết định thay, nên bị từ chối (`FORBIDDEN`) chứ không chạy với quyền system.
- **Lỗi không bao giờ là `true`.** Forbidden, disabled, quota, timeout, cancel, lỗi provider, profile hoặc item không tồn tại đều đi vào nhánh `error` nếu nhánh đó được nối; nếu không thì node thất bại và runner đi theo `onError`.
- **Idempotency.** Key của review run là `flow:<flowRunId>:<nodeId>`, theo từng principal. Chạy lại cùng một flow run (job bị giao lại) sẽ replay quyết định đã lưu mà không gọi provider lần hai. Nếu nội dung đã đổi từ lần đó, replay trả `unknown` (`stale`). Review run kết thúc bằng `error` được thử lại.
- **Node phía sau.** Runner không resume theo từng bước: chạy lại một run là chạy lại từ đầu. Bản thân node quyết định là idempotent, nhưng các node phía sau nó (http, mail, deploy…) phải tự idempotent.
- **Runtime.** Docker/Node và Cloudflare Workers chạy cùng đoạn xử lý. Trên Docker/Node, `serve.ts` đăng ký consumer `flow-runs` và `flow-events`; trên Workers, queue handler `processCloudflareQueue` gọi cùng `registerFlowRunsWorker` / `registerFlowEventWorker` (`apps/cms/src/cloudflare-flow-queue.ts`) với cùng cache, key provider và env của provider. Trước khi backlog B118 được sửa, Workers không có consumer cho `flow-runs`, nên parity cho run bất đồng bộ trên Workers chưa được khẳng định. Nay nó được kiểm bằng unit test trên handler của Workers và một lần chạy `wrangler dev` cục bộ, chưa chạy trên một Worker đã deploy. Các lưu ý về idempotency ở trên áp dụng như nhau trên cả hai runtime. Xem [Cloudflare Workers: queue của Flows](#cloudflare-workers-queue-của-flows).

Studio: palette có khối **AI Decision** với bốn handle nhánh (true/false/unknown/error, cộng các key lựa chọn khai trong `choices`). Run history hiện từng quyết định: nhánh đã đi, giá trị, ngưỡng, model, review run, và trạng thái `unknown` hoặc lỗi được ghi rõ.

## Cloudflare Workers: queue của Flows

Trên Cloudflare Workers, Flows dùng hai queue có producer và consumer riêng trong mọi profile của `apps/cms/wrangler.toml` (B118):

| Profile | `flow-runs` (run thủ công, AI chat bất đồng bộ) | `flow-events` (run theo event và theo lịch) |
|---|---|---|
| Local/default | `lumibase-flow-runs-local` | `lumibase-flow-events-local` |
| staging | `lumibase-flow-runs-staging` | `lumibase-flow-events-staging` |
| production | `lumibase-flow-runs-production` | `lumibase-flow-events-production` |
| dev | `lumibase-flow-runs-dev` | `lumibase-flow-events-dev` |
| demo | `lumibase-flow-runs-demo` | `lumibase-flow-events-demo` |

- Binding là `FLOW_RUNS_QUEUE` và `FLOW_EVENTS_QUEUE`. Mỗi consumer có một dead-letter queue cùng tên kèm hậu tố `-dlq`.
- `max_retries = 2`, tức tối đa 3 lần giao, bằng mặc định `attempts: 3` của BullMQ trên Docker. Message lỗi được thử lại sau 30 giây, hết lượt thì vào DLQ.
- Giao ít nhất một lần (at-least-once): một job theo event hoặc theo lịch được giao lại sẽ ghi một run mới, nên các node phía sau phải idempotent. Run thủ công dùng lại `runId` của nó.
- Worker định tuyến theo tên queue: `lumibase-<logical>-<profile>` → `agent-runs`, `flow-runs` hoặc `flow-events`. Nếu đổi tên queue, giữ nguyên phần logical. Queue không khớp tên nào không có consumer; message của nó được thử lại rồi vào DLQ.
- Cron `* * * * *` của Worker quét các flow theo lịch đã đến hạn và đưa chúng vào `flow-events`, giống cron `flow-schedule` trên Docker. `next_run_at` chỉ được đẩy tới khi flow vẫn còn đến hạn, nên các lần quét chồng nhau đưa mỗi flow vào queue đúng một lần (B128).
- Thiếu binding: nếu runtime không có `FLOW_RUNS_QUEUE`, `POST /api/v1/flows/:id/run` chạy inline với `LUMIBASE_FLOW_SYNC_TIMEOUT` (trước đây nó trả 500 và để lại một run `pending`), còn `Prefer: respond-async` của AI chat rơi về đường đồng bộ. Không có `FLOW_EVENTS_QUEUE` thì flow theo event không được đưa vào queue, và lần quét theo lịch không tiêu thụ slot nào.

Tạo các queue này trước khi deploy phiên bản này lên một profile có tên: consumer trỏ tới một queue chưa tồn tại làm deploy thất bại. Cloudflare tự tạo DLQ còn thiếu ([Data location](https://developers.cloudflare.com/queues/configuration/data-location/)), nhưng tạo sẵn giúp bạn theo dõi nó.

```bash
cd apps/cms
for profile in staging production dev demo; do
  for q in flow-runs flow-events; do
    pnpm exec wrangler queues create "lumibase-$q-$profile"
    pnpm exec wrangler queues create "lumibase-$q-$profile-dlq"
  done
done
```

`wrangler dev` cục bộ mô phỏng queue, nên không cần tạo gì.

## API endpoints

```
GET    /api/v1/flows              List flows (filter status/trigger)
POST   /api/v1/flows              Create flow
GET    /api/v1/flows/:id          Detail
PATCH  /api/v1/flows/:id          Update (graph/status/options)
DELETE /api/v1/flows/:id          Delete
POST   /api/v1/flows/:id/run      Manual trigger với body làm input
GET    /api/v1/flows/:id/runs     Run history
```

Service runner: `apps/cms/src/services/flow-service.ts` — `runFlow(graph, input, ctx)`.

## Studio UI & Visual Flow Editor

LumiBase Studio cung cấp giao diện trực quan hỗ trợ kéo thả và chỉnh sửa workflow bằng đồ thị (`@xyflow/react`):
- **Giao diện danh sách**: Tại `/automation/flows`, hiển thị toàn bộ các flows đang có cùng thông tin trigger, trạng thái hoạt động (draft, active, inactive), và liên kết chỉnh sửa hoặc kích hoạt chạy thử (Test Run).
- **Visual Canvas**: Hỗ trợ vẽ đồ thị bằng các liên kết Next (đường thẳng chỉ hướng màu chàm) và Error (đường đứt nét màu đỏ).
- **Operation Palette**: Bảng chọn nhanh các khối chức năng ở cột trái, nhấp đúp hoặc nhấn nút `+` để thêm khối: Condition (If), Transform (JS), HTTP Request, Send Mail, Log, Sleep, Run Extension, Database CRUD, AI Decision.
- **Node Config Panel**: Cột cấu hình chi tiết bên phải tự động hiển thị biểu mẫu khi nhấp chọn bất kỳ Node nào trong đồ thị (ví dụ chỉnh sửa script JS của Transform, chọn Method và URL cho HTTP, cấu hình To/Subject cho Mail, hay điền thời gian trễ của Sleep).
- **Save & Test Run**: Nút lưu đồ thị trực tiếp lên API và chạy thử luồng ngay tại chỗ.

## Multi-tenancy

Mọi truy vấn `flows`, `flow_runs`, `operations` đều `WHERE siteId = currentSiteId`. Cascade delete khi xoá site.

## Permissions

Cần capability `flows:read` / `flows:write` / `flows:execute` (configure trong policies).
