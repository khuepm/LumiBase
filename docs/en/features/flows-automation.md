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

## Studio UI

`apps/studio/src/modules/automation/flows-page.tsx` cung cấp list view các flows với status, trigger type, last run. Visual editor (drag-drop graph) còn nằm trong roadmap POST-GA.

## Multi-tenancy

Mọi truy vấn `flows`, `flow_runs`, `operations` đều `WHERE siteId = currentSiteId`. Cascade delete khi xoá site.

## Permissions

Cần capability `flows:read` / `flows:write` / `flows:execute` (configure trong policies).
