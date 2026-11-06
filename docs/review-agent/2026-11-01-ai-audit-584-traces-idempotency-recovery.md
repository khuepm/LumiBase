# #584 audit: end-to-end traces, idempotency and partial-failure recovery

- **Parent:** #577 (P1)
- **Audited commit:** `5a92d6ea` (`origin/main`, 2026-11-01). The fix branch was rebased
  onto `ce4a9acb` (#579 and dependency bump #589 merged); neither touches the run lifecycle.
- **Fix branch:** `feature/584-traces-idempotency-recovery`
- **Model:** none. Every result below is deterministic. No live model was called, so this
  report claims **no model-sensitive results**, no token counts and no provider costs.
- **Coordination:** approval claim/resume and the failed-outcome gate are #453
  (`g1-approval-concurrency`, `g1-failed-outcome`, `g1-claim-sweeper`); the queue claim,
  stale quarantine and dispatch are #455/#481 (`g3-run-claim`, `g3-dispatch-reliability`);
  the retry endpoint is B73/B82 (`agent-run-retry`); queue recovery parity is P2
  (`p2-recovery-parity`); principal re-resolution is #472. Workflow validation (#548) and the
  evaluation workstream are not changed here. Token accounting is #582 (B184).

## 1. Trace model (audited commit)

There is no tracing system (no OpenTelemetry span, no trace id). The trace of an agent
action is the set of rows below, joined on stored ids.

| Record | Table | Correlates by | Written by |
|---|---|---|---|
| Goal | `lumibase_agent_goals` | `id`, `intentId`, `driftFingerprint` | `POST /agent/goals`, dispatch, `ensureRun` (transient) |
| Run | `lumibase_agent_runs` | `goalId`, `retryOfRunId`; `status`, `error`, `metrics.stopReason` | `AgentRunService` |
| Tool call | `lumibase_agent_tool_calls` | `runId`, `approvalId`; `status`, `error`, masked `input`/`output`, `latencyMs` | harness `appendToolCall` / `finishToolCall` |
| Approval | `lumibase_agent_approvals` (+ legacy `lumibase_ai_approvals`) | `runId`, `subjectId` = tool call id, `legacyApprovalId`, `requestedByPrincipal`, `decidedBy` | `parkForApproval`, decision paths |
| Content change | `lumibase_revisions` | `createdByRunId`, `authorType = agent` | `ItemService` via `setProvenance` |
| Retry decision | `lumibase_activity` `agent_run.retried` | `payload.runId`, `retryOfRunId`, `goalId`, `requestedBy` | `retryRun` (same transaction as the row) |
| Metrics | Prometheus | `agent`, `status`, `stop_reason`, `tool` labels | `agent-metrics.ts` |

What is **not** correlated: the HTTP request id. Goals and runs carry none, and audit-log rows
carry `requestId` but no `runId` (B189). Model calls inside a skill are not recorded apart
from `extractLLMMeta` in run metrics (B184).

## 2. Decision points (failure handling)

| Point | Code (audited) | Behaviour |
|---|---|---|
| Queue claim | `agent-run-service.ts` `claimQueuedRun` | CAS `queued → running`; redelivery is a no-op (#455 F3). |
| Stale sweep | `quarantineStaleRuns` | `running` past 15 min → `failed` `stale_unverified`, never replayed (#481 R3.1); `queued` → `queue_timeout`. |
| Cancel | `cancelRun` (line 607) | **read, then unconditional UPDATE** (F1). |
| Park for approval | `ai-harness.ts` `parkForApproval` → `awaitApproval` (line 594) | **approval rows created, then unconditional UPDATE to `awaiting_approval`** (F2). |
| Approval claim | `executeApprovedWithAudit` | CAS `pending → deciding`; touched-then-failed → `failed`, reopen is a human decision (#453). |
| Skill execution | `runSkill` | 30 s `Promise.race`; the handler is not stopped (B188). Error text = `err.message` (F4). |
| Worker catch | `agent-run-worker.ts` | any throw → `failRun(err.message, worker_error)` (F3, F4). |
| Retry | `retryRun` | checks run status only, not tool call status (F3). |

## 3. Matrix

| Failure | Expected | Observed at `5a92d6ea` | After fix | Evidence |
|---|---|---|---|---|
| Duplicate delivery of a queued job | one execution | one execution | unchanged | `g3-run-claim`, `agent-run-retry`, recovery case "recovered failure" |
| Concurrent approve/approve, approve/reject | one execution, consistent rows | one | unchanged | `g1-approval-concurrency` |
| Crash after write, before terminal status | quarantined, not replayed | quarantined | unchanged | `g3-dispatch-reliability`, `p2-recovery-parity` |
| Write succeeds, saving the outcome fails | effect visible, not replayed | **run `failed`, retry re-executes (2 items)** | retry refused `409 RUN_EFFECT_RECORDED` | F3 |
| Cancel races completion | outcome kept | **`succeeded` rewritten to `cancelled`, then retryable** | cancel returns null / `409 NOT_CANCELLABLE` | F1 |
| Cancel during classification of an approval-gated call | stays cancelled | **revived as `awaiting_approval` with a pending approval** | stays cancelled, no approval | F2 |
| Failed DB statement inside a run | reason recorded, no values | **full `params:` list in run/tool call `error`** | `Database query failed (SQLSTATE …): …` | F4 |
| Skill timeout | not reported as clean failure | reported `failed`, handler continues | unchanged | B188 (open) |
| Approval while run cancelled (parked) | refused | refused | unchanged | `ai-harness-item-impact` cancel case |
| Enqueue fails | run settled, retryable | settled `enqueue_failed` | unchanged | `agent-run-retry`, `p2-recovery-parity` |

## 4. Findings

### F1: a cancel that loses the race to completion rewrote the outcome (fixed)

- **Severity: medium.** `cancelRun` read the run, checked that it was in flight, then ran
  `UPDATE … SET status = 'cancelled' WHERE id = ?` without the status. If the worker settled
  the run between the two statements, `succeeded` became `cancelled`. The trace then said the
  action was cancelled although it ran, and `cancelled` is retryable, so a retry repeated an
  executed write. Callers: `POST /agent/runs/:id/cancel`, the kill switch (`killed_by_user`),
  dispatch (`dispatch_lost`) and the worker's deferral settlement. The window is two
  statements wide and needs a human (or the kill switch) to act at the moment of completion,
  so medium rather than high.
- **Reproduction:** a run executes `createItem` and is rewound to `running`; the canceller's
  `getRun` returns that snapshot while another service `closeRun`s it; `cancelRun` then writes.
  Before the fix: status `cancelled`, `cancelRun` returns the row, retry accepted.
- **Fix:** the UPDATE carries `status IN ('queued','running','awaiting_approval')`; no row →
  `null` (route `409 NOT_CANCELLABLE`), and the metric is counted only on a real cancel.

### F2: a cancelled run came back as `awaiting_approval` (fixed)

- **Severity: medium.** The harness checks `isCancelled` once, right after `ensureRun`, and then
  does several queries (tool registry, capabilities, policy, item impact, autonomy) before
  `parkForApproval`. That function inserted the approval rows and then wrote
  `awaiting_approval` unconditionally. A cancel in that window was overwritten: the run
  was parked again and its approval was pending in the inbox. The decision path checks
  `isCancelled`, which now returned false, so approving executed the action the user had
  cancelled. Medium: the action still needs a human approval, but the cancellation the
  approver would rely on is gone from the record.
- **Reproduction:** queued `deleteItem` (dangerous → parks at the default level); the
  cancel is injected right after the tool call is appended. Before the fix: run
  `awaiting_approval`, one pending `agent_approvals` row and one legacy row.
- **Fix:** `awaitApproval` is a CAS on the in-flight states and returns whether it parked.
  `parkForApproval` parks **first**; if the run is no longer in flight it records the tool
  call `denied` ("Run was cancelled") and creates no approval. A cancel after parking is the
  existing cancel-while-parked case, which the decision path already refuses.

### F3: a retry re-executed a write whose effect was recorded (fixed)

- **Severity: medium.** When the skill succeeded and a later statement threw (the run's
  `closeRun`, or anything after `finishToolCall`), the worker's catch settled the run
  `failed` with `stopReason: worker_error` while the tool call said `executed`. `retryRun`
  only checks the run status, so it accepted the retry and the worker ran the skill again.
  The service's own rule is that a success is not retryable ("retrying a success is 'do it
  again'"); this state is a success recorded under a failed run. Needs a database error at
  the right moment plus a human retry, hence medium.
- **Reproduction:** `closeRun` rejects once (`connection reset`) during a queued `createItem`.
  Before the fix: run `failed`/`worker_error`, tool call `executed`, 1 item; `retryRun` →
  `ok: true`; delivering the job → **2 items**.
- **Fix:** `retryRun` refuses with `RUN_EFFECT_RECORDED` (`409`) when any tool call of the run
  is `executed`. The refusal names the tool call. Runs whose tool call is `failed`, `denied`
  or still `running` (stale quarantine) keep today's behaviour: a human may retry them.

### F4: query parameters copied into run and tool call errors (fixed)

- **Severity: medium.** Drizzle's `DrizzleQueryError` message is
  `Failed query: <sql>\nparams: <values>`. `runSkill`, the approval execution path, the veto
  staging path and the worker recorded `err.message`, so the values of a failed statement
  went into `agent_runs.error` and `agent_tool_calls.error`. `GET /api/v1/agent/runs` returns
  that field and run notifications carry its first 240 characters. Two consequences: item
  content (PII) reached the run listing, and secret-keyed values that `maskSecrets` removes
  from the recorded tool call input were stored and returned in clear. The route is
  control-plane (admins), so exposure is to operators and notification channels, not to the
  public: medium.
- **Reproduction:** (a) `createItem` with a NUL character in `title` and canaries in `email`
  and `apiToken`: recording the tool call fails (`22P05`), and the run error contained the
  query and the canary content. (b) A site-scoped test trigger rejects the item insert
  (`P0584`): before the fix the run and tool call error contained the `apiToken` canary that
  the tool call input shows as `[masked]`.
- **Fix:** `runErrorMessage(err)` (`agent-run-service.ts`) records
  `Database query failed (SQLSTATE <code>): <driver message>` for a query error and strips a
  `params:` tail from any other message. Used by `runSkill`, the approval paths, veto staging
  and the worker catch. The driver message is kept because it says why the write failed;
  Postgres messages can quote a value in a few type-cast errors (residual, §6).

### Evidence (F1–F4)

`apps/cms/src/services/__tests__/agent-run-recovery.db.integration.test.ts`: real Postgres,
real worker entry point (`processAgentRunJob`) and harness with the echo provider, real
`agentRouter` on Hono, two sites. Faults are injected by wrapping one `AgentRunService`
method for one call, or by a real trigger scoped to the test site. 10 cases.

| Run | Result |
|---|---|
| with the fixes | 10/10 pass |
| the four source files restored to the audited commit | **6/10 fail**: F1, F2, F3 ×2, F4 ×2 |
| only the `cancelRun` status guard removed | 1/10 fail (F1) |
| only the `awaitApproval` status guard removed | 1/10 fail (F2) |
| only the retry `executed` check disabled | 2/10 fail (F3, F3 route) |
| `runErrorMessage` returning `err.message` | 2/10 fail (F4 ×2) |

The 4 cases that pass on every revert are the reconstruction and masking controls (§5).

## 5. Controls verified correct (no change)

- **Reconstruction (acceptance 1).** The new suite rebuilds three outcomes from rows only:
  a success (run `succeeded` → tool call `executed` → revision with `createdByRunId` = the
  run and `authorType = agent`), a denial (tool call `denied` "Insufficient capabilities",
  run `failed`, no revision, no item) and a recovered failure (failed attempt → retry run
  with `retryOfRunId` → `agent_run.retried` naming both runs and the skill → one success, one
  item, redelivery of the retry job a no-op).
- **Duplicate delivery and concurrent resume.** Queue CAS claim (`g3-run-claim`), approval
  claim under concurrent approve/approve and approve/reject (`g1-approval-concurrency`),
  touched-then-failed approvals parked as `failed` with a human reopen
  (`g1-failed-outcome`), stuck `deciding` claims swept (`g1-claim-sweeper`), concurrent
  retries producing one row and one job (`agent-run-retry`). All passed on this branch.
- **Partial failure never reports full success.** Every `executed` tool call is followed by
  `closeRun`; a throw anywhere after the skill leaves the run `failed` or `running`, never
  `succeeded` (F3 case asserts the run is not `succeeded`). The approval path reports
  "the action ran but the decision was not committed" when the legacy row moved under it.
- **Masking.** Secret-keyed values (`secret|token|password|api_key|authorization|credential`)
  are masked in recorded tool call input and output; a masked input refuses replay
  (`RETRY_UNRECOVERABLE`). The new control case confirms the `apiToken` canary is absent from
  tool calls and from `GET /agent/runs` on success, that non-secret content stays as audit
  evidence (`email` is kept in the input, which is what a retry replays), and that another
  site's listing is empty. Queue logs do not copy tool arguments (`async-agent-runs.md`).
- **Error classification.** Runs carry `metrics.stopReason` from a fixed set (`frozen`,
  `invalid_input`, `capabilities_denied`, `max_tool_calls`, `autonomy_shadow`,
  `staged_veto_window`, `deferred`, `worker_error`, `stale_unverified`, `queue_timeout`,
  `enqueue_failed`, `dispatch_lost`, `cancelled_by_user`, `killed_by_user`).

## 6. Residual / not covered

- **Skill timeout does not stop the handler** (B188, owner decision on the mechanism).
- **No request id on goals/runs** (B189).
- **Metrics:** unbounded `agent` / `tool` labels, token/cost counters never fed, approval
  latency observed on one decision route only (B190; tokens also B184).
- **Driver messages kept in errors:** a Postgres type-cast message can quote the offending
  value (for example `invalid input syntax for type integer: "…"`). Item data is `jsonb`, so
  the item write paths do not produce those; not changed.
- **Existing rows:** run errors written before this fix keep their `params:` text (no
  backfill).
- **Eval correlation:** `agent_evaluations` link to artifacts, not checked here beyond the
  existing suites.
- **Latency, tokens, cost:** run metrics record `lastToolLatencyMs` and tool call
  `latencyMs`; no live model, so no token or cost figures (B184).

## 7. Verification

- New suite: 10/10; revert counts in §4.
- Focused run of every agent, harness, approval, MCP, G1–G3, P1–P2 and AI suite (71 files,
  761 tests) on the fix: 760 passed and 1 failed, the fake-DB state-machine case for
  `cancelRun` metrics; the cancel kept the JS-merged metrics shape, after which that file
  passes (30/30 with the recovery and retry suites).
- All DB integration + e2e suites on the rebased head (docker env): 51 files, 342/342.
- Full `apps/cms` (`user-enum.timing` excluded): 4287 passed, 2 skipped, 1 failed
  (`golden-path.e2e`, env-only; passes in the DB run above).
- `pnpm typecheck` 18/18; `pnpm check:all` exit 0.

## 8. Acceptance criteria of #584

| Criterion | Status |
|---|---|
| A representative success, denial and recovered failure can each be reconstructed from correlated events | **done** (§5, three DB cases). Request-id correlation missing (B189). |
| Automated tests prove retries/duplicate resume do not duplicate side effects and partial failures do not report full success | **done**: existing claim/approval/retry suites plus F1–F3 cases. Skill timeout remains (B188). |
| Synthetic secret/PII canaries do not appear in exported traces/logs; necessary audit evidence remains useful | **done** for run/tool call rows and `GET /agent/runs` (F4 + control case); errors keep the SQLSTATE and driver reason. |
| Recovery semantics and operator guidance are documented; scoped fixes cover confirmed gaps | **done**: `docs/{en,vi}/features/async-agent-runs.md` "Reconstructing a run and recovery decisions"; retry code in the API spec and harness docs. |
