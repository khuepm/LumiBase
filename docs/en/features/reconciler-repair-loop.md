---
version: 3
sourceLang: en
lastUpdated: 2026-09-23T12:16:23.556Z
contentHash: 028b26a85a1c849b
codeVerified: 2026-09-23T12:16:23.556Z
codeVerifiedHash: 028b26a85a1c849b
codeVerifiedClaims: 2
---

# Reconciler repair loop

A content intent declares rules; `DriftService` records violations of those rules as drift; `ReconcilerService` turns open drift into agent goals. This page documents the step that carries a goal through to repaired, published content: dispatch → draft → human approval → publish → verified re-evaluation.

One scenario is wired end to end: a translatable field missing a locale.

## Why this exists

Creating a goal used to be the end of the chain. The goal row was inserted, the drift flipped to `assigned` with `goalId` set, and nothing executed it — there was no cron task, queue consumer or route that turned a reconciler goal into a run.

That was worse than doing nothing. Goal assignment deliberately skips drift that already carries a `goalId`, so an unexecutable goal *locked* its drift out of every later cycle. A site accumulated assigned drift that no longer looked actionable and was never repaired.

## The loop

Each dispatch pass advances a goal by at most one step. The next step is derived from observable state — the goal's phase, its latest run, whether the draft branch still exists, and the drift's status — so the pass is safe to repeat, safe to resume after a crash, and unaffected by duplicate queue delivery.

| Phase | Skill | Effect | Gate |
|---|---|---|---|
| draft | `repairTranslation` | Writes the proposed translation into a named version branch | Write/autonomy gate: L0 shadow-denies, L1 parks for approval, L2+ executes |
| promote | `promoteVersion` | Applies that branch to main through the item API | Classified dangerous — always parks for human approval |
| verify | — | Re-scans the intent | Completes only if the violation is gone |

Published content changes exactly once in this sequence, at the promote step, after a human approves.

Drafts use the item snapshot taken after translation generation, preserving edits made while the provider was running, including a target translation entered by a human. If the source text changed during generation, the draft is discarded and the run fails with `SOURCE_CHANGED`; recovery requires operator review rather than an automatic retry.

The draft branch key is deterministic (`drift-repair:<drift fingerprint>`), which is what makes the loop idempotent: a duplicate draft job finds the existing branch and returns without calling the model again, and a duplicate branch can never be created.

## Failure and stop states

The loop never retries on its own. A failed or cancelled run blocks the goal with a reason, because the most common cause is a human rejecting the approval, and re-dispatching would re-ask someone who already said no.

`status` becomes `blocked` and `metadata.blockedReason` records which of these happened:

| Reason | Meaning |
|---|---|
| `RUN_FAILED` / `RUN_CANCELLED` | The phase's run did not succeed — rejected approval, provider error, shadow-level denial |
| `NO_REPAIR_SKILL` | The drift's rule type has no wired repair path (only `translations` does today) |
| `DRAFT_MISSING` | A draft run reported success but left no branch |
| `PROMOTE_INCOMPLETE` | A promote reported success but the branch is still there |
| `VERIFY_FAILED` | Content was published and the violation is still present |
| `ENQUEUE_FAILED` | The queue refused the job; the run row is settled rather than left waiting forever |
| `DRIFT_MISSING` | The drift row disappeared, so there is nothing to verify a repair against |

Two situations are deliberately *not* blocks, because the goal is fine and something around it is temporarily not:

- **A frozen site** (kill switch) advances nothing and leaves goals untouched.
- **A paused or errored intent** — including one the circuit breaker tripped — stops dispatch for its goals.
- **A runtime with no queue adapter** reports `queueUnavailable` and leaves goals dispatchable, so adding a queue later needs no manual unblocking.

`blocked` goals appear in Studio → Mission Control with their reason, and clearing one is a human decision.

## Governance carried through the queue

A reconciler run has no human principal: the intent that declared the rule is the authority. The job payload therefore carries the governance envelope, and the worker enforces it at pickup rather than trusting anything captured at enqueue time:

| Field | Purpose |
|---|---|
| `siteId` | Tenant scope; a dispatcher only ever sees its own site's goals |
| `intentId` | Write-budget scope, and the intent whose status gates dispatch |
| `goalId` / `driftFingerprint` | Ties the run to the exact violation it repairs |
| `autonomyCap` | The intent's ceiling; the resolver takes `min(cap, grant)` |
| `agentRole` | The capability boundary, re-read from the role library at pickup |
| `origin: 'reconciler'` | Lets backpressure pause reconciler work only |

Capabilities are **not** snapshotted into the payload. They are resolved when the job is picked up, from the agent role recorded on the goal (`translations` drift routes to `translator`). Disabling that role stops work that is already queued; the run fails `capabilities_denied` and nothing is written.

Role freezes and autonomy grants use the persisted run's agent identity. Approval execution checks that identity again: freezing `translator` after a promotion is parked prevents publication and leaves the run awaiting approval. After lifting the freeze, the same approval can be decided again. This also covers existing approvals whose legacy row still has the default agent name.

## Multi-tenancy

| Resource | Scope |
|---|---|
| Goals, runs, drift, content versions, items | Isolated per `site_id` on every read and write |
| Draft branch key | Derived from the drift fingerprint, which begins with the intent id |
| Dispatch pass | Constructed per site; the cron tick discovers sites from goals and runs one pass each |
| Agent role library | Per site (`agent_roles` rows are seeded per tenant) |

Verified with two sites in `g3-repair-loop.db.integration.test.ts`: dispatching site A creates no run, no draft and no content change for site B.

## Runtime support

Dispatch runs on the **Node/Docker** runtime, driven by a leader-locked cron tick every minute. The lock matters: two processes dispatching one goal would create two runs for one drift.

On **Cloudflare Workers** the `agent-runs` queue has no consumer export, so asynchronous runs — including this loop — do not execute there. That is a pre-existing limitation of async agent execution, not of this loop. Use the manual endpoint below, or run the Docker deployment, until a Workers queue consumer exists.

## Triggering a cycle

`POST /api/v1/intents/:id/scan` runs the whole cycle for one intent and returns all three stages:

```json
{
  "data": {
    "scan": { "scanned": 1, "opened": 1, "reopened": 0, "resolved": 0, "completed": true, "cursor": null },
    "reconcile": { "goalsCreated": 1, "deferred": 0, "breakerTripped": false },
    "dispatch": {
      "dispatched": 1,
      "completed": 0,
      "skipped": 0,
      "blocked": 0,
      "outcomes": [{ "goalId": "gol_…", "action": "dispatch_draft", "runId": "run_…" }]
    }
  }
}
```

Because each pass advances one step, driving a repair to completion takes several passes: one to draft, one to request the promote, and one to verify after the approval is granted. The cron tick does this on its own; calling the endpoint repeatedly does the same thing on demand.

## Extending it to another rule type

`translations` is the only rule type with a repair path. Adding another means supplying repair arguments for its drift and a skill that writes a draft rather than live content. Until then, goals for other rule types block with `NO_REPAIR_SKILL` — stated rather than silently skipped, so the drift does not sit assigned to a goal nothing will advance.

## Related

- [Agent Harness Layer](./agent-harness-layer.md) — run lifecycle, autonomy levels, approvals, kill switch
- [API reference](../api/hono-api-spec.md) — intent and agent endpoints
