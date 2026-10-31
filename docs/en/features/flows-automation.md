---
version: 8
lastUpdated: 2026-10-16T17:38:35.512Z
sourceLang: vi
translatedFrom: vi
sourceHash: 5565293f8aac9d97
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-10-16T17:38:35.512Z
codeVerifiedHash: 5565293f8aac9d97
codeVerifiedClaims: 16
contentHash: a3fe5733ba13b42f
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
- **`ai:apply-tags`** / **`editorial:route`** — read an upstream `ai:decision` and propose a tag or a review queue for the item; shadow by default (recorded only), and a live proposal becomes an approval (see [Jev automation](./jev-automation.md)).
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
| `noulThreshold` | `noul` questions: `true` when ≥ t, `false` when ≤ 1 − t, otherwise `unknown`. With t = 0.5 an answer of exactly 0.5 meets both and is `unknown` (`between_thresholds`) |
| `minConfidence` | `choice` questions: below it, or when the model abstains (`other`/`unknown`), the branch is `unknown` |

The output stored in the node's step: `{ branch, runId, replayed, decision, errorCode? }`. `runId` is the review run (provenance). `score` questions cannot drive a branch.

Governance, checked when the node executes, not when the run was queued:

- **Switches.** Needs the `aiDecisions` setting to have both `enabled: true` and `flows: true`. `flows` is off by default (Phase C). The site kill switch (`enabled: false`) stops flows too. A site admin switches `flows` in Studio under **Settings → AI decisions** (**Allow decisions in Flows**), or through the settings API.
- **Principal.** Only manual runs (`POST /api/v1/flows/:id/run`) carry a principal: a reference to the caller, with no capability snapshot. The worker re-resolves that principal, checks `ai:decide` on the live grant, and reads content with that person's own row and field permissions. Event, schedule and webhook runs have no one to decide for, so they are refused (`FORBIDDEN`) rather than run with system rights.
- **A failure is never `true`.** Forbidden, disabled, quota, timeout, cancel, provider errors and a missing profile or item take the `error` branch when it is mapped; otherwise the node fails and the runner follows `onError`.
- **Idempotency.** The review run key is `flow:<flowRunId>:<nodeId>`, per principal. Re-executing the same flow run (a redelivered job) replays the stored decision with no second provider call. If the content changed since then, the replay returns `unknown` (`stale`). A review run that ended in `error` is retried.
- **Downstream nodes.** The runner has no step-level resume: re-executing a run starts it over. The decision node itself is idempotent, but the nodes after it (http, mail, deploy…) must be idempotent themselves.
- **Runtime.** Docker/Node and Cloudflare Workers run the same processing code. On Docker/Node, `serve.ts` registers the `flow-runs` and `flow-events` consumers; on Workers, the queue handler `processCloudflareQueue` calls the same `registerFlowRunsWorker` / `registerFlowEventWorker` (`apps/cms/src/cloudflare-flow-queue.ts`) with the same cache, key provider and provider env. Until backlog B118 was fixed, Workers had no `flow-runs` consumer, so parity for asynchronous runs on Workers was not claimed. It is now verified by unit tests against the Workers handler and a local `wrangler dev` run, not on a deployed Worker. The idempotency notes above apply the same way on both runtimes. See [Cloudflare Workers: Flows queues](#cloudflare-workers-flows-queues).

Studio: the palette has an **AI Decision** block with four branch handles (true/false/unknown/error, plus the option keys listed in `choices`). Run history shows each decision: the branch taken, the value, the threshold, the model, the review run, and an explicit `unknown` or error state.

## Cloudflare Workers: Flows queues

On Cloudflare Workers, Flows uses two queues with their own producer and consumer in every profile of `apps/cms/wrangler.toml` (B118):

| Profile | `flow-runs` (manual runs, async AI chat) | `flow-events` (event and schedule runs) |
|---|---|---|
| Local/default | `lumibase-flow-runs-local` | `lumibase-flow-events-local` |
| staging | `lumibase-flow-runs-staging` | `lumibase-flow-events-staging` |
| production | `lumibase-flow-runs-production` | `lumibase-flow-events-production` |
| dev | `lumibase-flow-runs-dev` | `lumibase-flow-events-dev` |
| demo | `lumibase-flow-runs-demo` | `lumibase-flow-events-demo` |

- The bindings are `FLOW_RUNS_QUEUE` and `FLOW_EVENTS_QUEUE`. Each consumer has a dead-letter queue with the same name plus `-dlq`.
- `max_retries = 2`, so at most 3 deliveries, equal to the BullMQ default `attempts: 3` on Docker. A failed message is retried after 30 seconds and goes to the DLQ when its retries run out.
- Delivery is at-least-once: a redelivered event or schedule job records a new run, so downstream nodes must be idempotent. A manual run reuses its `runId`.
- The Worker routes by queue name: `lumibase-<logical>-<profile>` → `agent-runs`, `flow-runs` or `flow-events`. If you rename a queue, keep the logical segment. A queue that matches no name has no consumer; its messages are retried and then go to the DLQ.
- The Worker's `* * * * *` cron sweeps due schedule flows onto `flow-events`, like the `flow-schedule` cron on Docker. `next_run_at` only advances while the flow is still due, so overlapping sweeps enqueue each flow exactly once (B132).
- Missing binding: if the runtime has no `FLOW_RUNS_QUEUE`, `POST /api/v1/flows/:id/run` runs inline with `LUMIBASE_FLOW_SYNC_TIMEOUT` (it used to return 500 and leave a `pending` run behind), and AI chat `Prefer: respond-async` falls back to the sync path. Without `FLOW_EVENTS_QUEUE`, event flows are not enqueued and the schedule sweep consumes no slots.

Create these queues before you deploy this version to a named profile: a consumer bound to a queue that does not exist makes the deploy fail. Cloudflare creates a missing DLQ automatically ([Data location](https://developers.cloudflare.com/queues/configuration/data-location/)), but creating it first lets you monitor it.

```bash
cd apps/cms
for profile in staging production dev demo; do
  for q in flow-runs flow-events; do
    pnpm exec wrangler queues create "lumibase-$q-$profile"
    pnpm exec wrangler queues create "lumibase-$q-$profile-dlq"
  done
done
```

Local `wrangler dev` simulates queues, so there is nothing to create.

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
