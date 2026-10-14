---
version: 3
lastUpdated: 2026-10-14T18:09:29.331Z
sourceLang: vi
contentHash: 09cdb8faf1f6769f
codeVerified: 2026-10-14T18:09:29.331Z
codeVerifiedHash: 09cdb8faf1f6769f
codeVerifiedClaims: 12
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
| `noulThreshold` | Câu hỏi `noul`: `true` khi ≥ t, `false` khi ≤ 1 − t, còn lại `unknown` |
| `minConfidence` | Câu hỏi `choice`: dưới ngưỡng này, hoặc khi model abstain (`other`/`unknown`), nhánh là `unknown` |

Output lưu vào step của node: `{ branch, runId, replayed, decision, errorCode? }`. `runId` là review run (provenance). Câu hỏi `score` không quyết định nhánh được.

Governance, kiểm tra lúc node chạy chứ không phải lúc run vào hàng đợi:

- **Bật/tắt.** Cần setting `aiDecisions` có cả `enabled: true` lẫn `flows: true`. `flows` mặc định tắt (Phase C). Kill switch của site (`enabled: false`) cũng dừng flows.
- **Principal.** Chỉ run thủ công (`POST /api/v1/flows/:id/run`) mang principal: một tham chiếu tới người gọi, không có snapshot quyền. Worker resolve lại principal đó, kiểm `ai:decide` trên grant hiện hành và đọc nội dung với quyền row/field của chính người đó. Run từ event, schedule và webhook không có ai để quyết định thay, nên bị từ chối (`FORBIDDEN`) chứ không chạy với quyền system.
- **Lỗi không bao giờ là `true`.** Forbidden, disabled, quota, timeout, cancel, lỗi provider, profile hoặc item không tồn tại đều đi vào nhánh `error` nếu nhánh đó được nối; nếu không thì node thất bại và runner đi theo `onError`.
- **Idempotency.** Key của review run là `flow:<flowRunId>:<nodeId>`, theo từng principal. Chạy lại cùng một flow run (job bị giao lại) sẽ replay quyết định đã lưu mà không gọi provider lần hai. Nếu nội dung đã đổi từ lần đó, replay trả `unknown` (`stale`). Review run kết thúc bằng `error` được thử lại.
- **Node phía sau.** Runner không resume theo từng bước: chạy lại một run là chạy lại từ đầu. Bản thân node quyết định là idempotent, nhưng các node phía sau nó (http, mail, deploy…) phải tự idempotent.
- **Runtime.** Đã kiểm tra trên đường worker Docker/Node (`serve.ts` đăng ký consumer `flow-runs`). Cloudflare Workers chưa có consumer cho `flow-runs`, nên chưa khẳng định parity cho run bất đồng bộ trên Workers.

Studio: palette có khối **AI Decision** với bốn handle nhánh (true/false/unknown/error, cộng các key lựa chọn khai trong `choices`). Run history hiện từng quyết định: nhánh đã đi, giá trị, ngưỡng, model, review run, và trạng thái `unknown` hoặc lỗi được ghi rõ.

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
