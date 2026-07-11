---
version: 1
lastUpdated: 2026-06-23T12:59:56.000Z
sourceLang: vi
contentHash: a7d2f855ee399c09
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

- **`condition`** — branch dựa trên expression, output điều khiển `next` hoặc `onError`.
- **`transform`** — biến đổi payload bằng JSONata.
- **`http`** — gọi external API (axios/fetch).
- **`mail`** — gửi email qua Resend/SMTP.
- **`log`** — append vào activity log.
- **`sleep`** — pause N giây.
- **`run-extension`** — gọi extension đã mount.
- **`item.create`** / **`item.update`** / **`item.delete`** — CRUD vào CMS data.
- **`notify`** — push notification tới user/team.
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
- **Operation Palette**: Bảng chọn nhanh các khối chức năng ở cột trái, nhấp đúp hoặc nhấn nút `+` để thêm khối: Condition (If), Transform (JS), HTTP Request, Send Mail, Log, Sleep, Run Extension, Database CRUD.
- **Node Config Panel**: Cột cấu hình chi tiết bên phải tự động hiển thị biểu mẫu khi nhấp chọn bất kỳ Node nào trong đồ thị (ví dụ chỉnh sửa script JS của Transform, chọn Method và URL cho HTTP, cấu hình To/Subject cho Mail, hay điền thời gian trễ của Sleep).
- **Save & Test Run**: Nút lưu đồ thị trực tiếp lên API và chạy thử luồng ngay tại chỗ.

## Multi-tenancy

Mọi truy vấn `flows`, `flow_runs`, `operations` đều `WHERE siteId = currentSiteId`. Cascade delete khi xoá site.

## Permissions

Cần capability `flows:read` / `flows:write` / `flows:execute` (configure trong policies).
