---
version: 1
lastUpdated: 2026-06-23T12:59:56.000Z
sourceLang: vi
translatedFrom: vi
sourceHash: a7d2f855ee399c09
mtEngine: claude
syncStatus: machine-translated
---

# Flows / Operations Engine

LumiBase Flows enables multi-step workflow automation — similar to Directus Flows. A flow is a **graph of operations** that runs on a trigger (webhook, event, schedule, or manual).

## Tables

| Table | Purpose |
|-------|----------|
| `flows` | Definition: name, status, trigger type/options, graph, nextRunAt |
| `flow_runs` | Execution history: status, input, steps (per-node output), output, error |
| `operations` | Declares the nodes in the graph: key, type, options, position |

Flow status: `active` / `inactive` / `draft`. Run status: `pending` / `running` / `success` / `error` / `cancelled`.

## Trigger types

| Type | When it triggers |
|------|-----------------|
| `webhook` | HTTP POST to the flow's public URL |
| `event` | Item lifecycle: `item.create` / `item.update` / `item.delete` (collection configured in `triggerOptions`) |
| `schedule` | Cron expression — `nextRunAt` is precomputed |
| `manual` | Admin clicks "Run" in Studio or calls `POST /api/v1/flows/:id/run` |

## Operation types

Declared in the `operations.type` column:

- **`condition`** — branch based on an expression; the output controls `next` or `onError`.
- **`transform`** — transform the payload with JSONata.
- **`http`** — call an external API (axios/fetch).
- **`mail`** — send email via Resend/SMTP.
- **`log`** — append to the activity log.
- **`sleep`** — pause for N seconds.
- **`run-extension`** — call a mounted extension.
- **`item.create`** / **`item.update`** / **`item.delete`** — CRUD against CMS data.
- **`notify`** — push a notification to a user/team.
- **`drift-scan`** — one Content OS reconciliation cycle for an intent (`options.intentId`): scans for drift per the `content_intents` rules (respecting pinned fields, time-boxed via `options.timeBudgetMs`, with cursor resume), then generates reconciler goals within the `maxGoalsPerCycle` budget. Schedule one `schedule`-triggered flow per intent following the intent's cron.

## Graph format

The `flows.graph` column stores the graph as:

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

`key` references `operations.key` (unique per flow). The `next` edge is for the success path, `onError` for the failure path.

## API endpoints

```
GET    /api/v1/flows              List flows (filter by status/trigger)
POST   /api/v1/flows              Create a flow
GET    /api/v1/flows/:id          Detail
PATCH  /api/v1/flows/:id          Update (graph/status/options)
DELETE /api/v1/flows/:id          Delete
POST   /api/v1/flows/:id/run      Manual trigger with the body as input
GET    /api/v1/flows/:id/runs     Run history
```

Service runner: `apps/cms/src/services/flow-service.ts` — `runFlow(graph, input, ctx)`.

## Studio UI & Visual Flow Editor

LumiBase Studio provides a visual interface for drag-and-drop editing of workflows as a graph (`@xyflow/react`):
- **List view**: At `/automation/flows`, shows all existing flows with their trigger info, activity status (draft, active, inactive), and links to edit or trigger a Test Run.
- **Visual Canvas**: Supports drawing the graph with Next edges (a solid indigo directional line) and Error edges (a dashed red line).
- **Operation Palette**: A quick-pick panel of function blocks in the left column; double-click or press the `+` button to add a block: Condition (If), Transform (JS), HTTP Request, Send Mail, Log, Sleep, Run Extension, Database CRUD.
- **Node Config Panel**: The detailed configuration column on the right automatically shows a form when any node in the graph is selected (e.g. edit the Transform's JS script, choose the Method and URL for HTTP, configure To/Subject for Mail, or set the Sleep delay).
- **Save & Test Run**: A button to save the graph directly to the API and test the flow in place.

## Multi-tenancy

Every `flows`, `flow_runs`, and `operations` query is `WHERE siteId = currentSiteId`. Cascade delete when a site is removed.

## Permissions

Requires the `flows:read` / `flows:write` / `flows:execute` capabilities (configured in policies).
