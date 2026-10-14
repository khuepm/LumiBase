---
version: 2
lastUpdated: 2026-10-14T17:01:53.510Z
sourceLang: vi
translatedFrom: vi
sourceHash: df524553325e7930
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-10-14T17:01:53.510Z
codeVerifiedHash: df524553325e7930
codeVerifiedClaims: 12
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

- **`condition`** — compare a path with a value; the output `{ pass, branch: 'true' | 'false' }` drives `branches` (when the node has them) or `next`.
- **`transform`** — transform the payload with JSONata.
- **`http`** — call an external API (axios/fetch).
- **`mail`** — send email via Resend/SMTP.
- **`log`** — append to the activity log.
- **`sleep`** — pause for N seconds.
- **`run-extension`** — call a mounted extension.
- **`item.create`** / **`item.update`** / **`item.delete`** — CRUD against CMS data.
- **`notify`** — push a notification to a user/team.
- **`ai:decision`** — a governed decision about one item that picks the `true`/`false`/`unknown`/`error` branch (see below).
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

## Explicit branches and `ai:decision` (#517)

A node may declare `branches`: a map from the branch key its operation returns to the next node. `null` ends the run on that branch.

```json
{
  "id": "decide",
  "key": "ai:decision",
  "options": { "profileKey": "moderation", "profileVersion": 3, "collection": "posts", "questionKey": "spam", "noulThreshold": 0.8 },
  "branches": { "true": "hold", "false": "publish", "unknown": "queue-review", "error": "notify-admin" }
}
```

Runner rules:

- A node with `branches` follows the `branch` its operation returned and never falls through to `next`. A returned branch missing from `branches` is a run error (`Unmapped branch "<key>" at node <id>`). An operation that returns no `branch` is also an error.
- Legacy `next`-only graphs run as before. `condition` additionally returns `branch: 'true' | 'false'` (and keeps `pass`).
- A cancelled or timed-out run starts no further node.
- `validateGraph` checks branch targets, branch keys and cycles through branches. An `active` flow with an `ai:decision` node that has no `branches` is refused (`GRAPH_BRANCHES_REQUIRED`).

The `ai:decision` operation makes one governed decision about one saved item:

| Option | Meaning |
|--------|---------|
| `profileKey`, `profileVersion` | Review profile and pinned version (required; the active version is never used implicitly) |
| `collection`, `itemId` | The item to decide on; without `itemId` it uses `input.itemId` |
| `questionKey` | The profile question that decides the branch |
| `noulThreshold` | `noul` questions: `true` when ≥ t, `false` when ≤ 1 − t, otherwise `unknown` |
| `minConfidence` | `choice` questions: below it, or when the model abstains (`other`/`unknown`), the branch is `unknown` |

The output stored in the node's step: `{ branch, runId, replayed, decision, errorCode? }`. `runId` is the review run (provenance). `score` questions cannot drive a branch.

Governance, checked when the node executes, not when the run was queued:

- **Switches.** Needs the `aiDecisions` setting to have both `enabled: true` and `flows: true`. `flows` is off by default (Phase C). The site kill switch (`enabled: false`) stops flows too.
- **Principal.** Only manual runs (`POST /api/v1/flows/:id/run`) carry a principal: a reference to the caller, with no capability snapshot. The worker re-resolves that principal, checks `ai:decide` on the live grant, and reads content with that person's own row and field permissions. Event, schedule and webhook runs have no one to decide for, so they are refused (`FORBIDDEN`) rather than run with system rights.
- **A failure is never `true`.** Forbidden, disabled, quota, timeout, cancel, provider errors and a missing profile or item take the `error` branch when it is mapped; otherwise the node fails and the runner follows `onError`.
- **Idempotency.** The review run key is `flow:<flowRunId>:<nodeId>`, per principal. Re-executing the same flow run (a redelivered job) replays the stored decision with no second provider call. If the content changed since then, the replay returns `unknown` (`stale`). A review run that ended in `error` is retried.
- **Downstream nodes.** The runner has no step-level resume: re-executing a run starts it over. The decision node itself is idempotent, but the nodes after it (http, mail, deploy…) must be idempotent themselves.
- **Runtime.** Verified on the Docker/Node worker path (`serve.ts` registers the `flow-runs` consumer). Cloudflare Workers has no `flow-runs` consumer yet, so parity for asynchronous runs on Workers is not claimed.

Studio: the palette has an **AI Decision** block with four branch handles (true/false/unknown/error, plus the option keys listed in `choices`). Run history shows each decision: the branch taken, the value, the threshold, the model, the review run, and an explicit `unknown` or error state.

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
- **Operation Palette**: A quick-pick panel of function blocks in the left column; double-click or press the `+` button to add a block: Condition (If), Transform (JS), HTTP Request, Send Mail, Log, Sleep, Run Extension, Database CRUD, AI Decision.
- **Node Config Panel**: The detailed configuration column on the right automatically shows a form when any node in the graph is selected (e.g. edit the Transform's JS script, choose the Method and URL for HTTP, configure To/Subject for Mail, or set the Sleep delay).
- **Save & Test Run**: A button to save the graph directly to the API and test the flow in place.

## Multi-tenancy

Every `flows`, `flow_runs`, and `operations` query is `WHERE siteId = currentSiteId`. Cascade delete when a site is removed.

## Permissions

Requires the `flows:read` / `flows:write` / `flows:execute` capabilities (configured in policies).
