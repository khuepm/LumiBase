# Agent Harness Layer

LumiBase is moving beyond a human-only headless CMS toward a control plane where AI agents can work with people on business data, schema, workflows, and reusable artifacts.

The Agent Harness Layer wraps every agent action in explicit governance: a goal, a scoped run, a tool contract, permission and risk checks, audit records, evaluation gates, and human approval when the action is risky.

## Product definition

The harness is the operating layer that keeps agents from running as unbounded prompt executors. An agent receives a goal, builds context under tenant and permission boundaries, calls registered tools, emits reviewable artifacts, and records enough audit data to retry or investigate the run later.

In short: LumiBase is an AI-native backend operating system where agents understand business state through schema and content, operate under governance, and return outputs as versioned artifacts instead of opaque chat text.

## User-facing surfaces

### Studio

The Studio Agent Harness page exposes:

- **Runs** — recent goal/run execution status, run metadata, stop reasons, and budget usage.
- **Tools** — enabled tool registry entries, required capabilities, owner, risk policy, and rate-limit metadata.
- **Approvals** — generalized approval queue for plans, tool calls, artifacts, and schema diffs.
- **Artifacts** — reviewable outputs such as schema diffs, page specs, component specs, seed data, API specs, prompts, and migrations.
- **Memory** — scoped context entries with provenance, confidence, expiry, and redaction before use.
- **Generate App** — an MVP template that produces app artifacts from existing schema/content instead of mutating production state directly.

### API and SDK

The CMS exposes the first-class agent control surface under `/api/v1/agent/*`:

- `goals` and `runs` for lifecycle tracking and retry.
- `tools` for registry discovery.
- `approvals` for generalized HITL decisions.
- `artifacts` and `evaluations` for review/publish gates.
- `memory` for scoped context assembly.
- `generate-app` for generation templates that create artifacts.

The JavaScript SDK mirrors these APIs with typed helpers for list/create/read/decide/evaluate/publish operations.

Existing `/api/v1/ai/chat` and `/api/v1/ai/approvals` remain backward-compatible. Dangerous Copilot actions still create legacy `ai_approvals` rows, and the harness writes linked generalized approval records where applicable.

## System collections

The harness adds additive system tables. All records are tenant-scoped with `siteId` and are designed for auditability rather than hidden side effects.

| Collection | Purpose | Governance notes |
|---|---|---|
| `agent_goals` | Business goals created by users, workflows, or agent templates | Owner, priority, deadline, status |
| `agent_runs` | A single execution attempt for a goal | Agent name, model/provider metadata, budget, status, timing, metrics |
| `agent_plans` | Planned steps before tool execution | Can require approval before execute |
| `agent_tools` | Registry of callable skills/tools/extensions | Capability requirements, input/output schema, risk policy, enabled state |
| `agent_permissions` | Agent/role/policy capability grants | Prompt text cannot grant new capabilities |
| `agent_tool_calls` | Audit log for every tool invocation | Input/output/error, latency, status, denial reason, masked secrets |
| `agent_approvals` | Generalized approvals for plans, tool calls, artifacts, and schema diffs | Decision, approver, policy, expiry |
| `agent_artifacts` | Versioned outputs created by agents | Reviewable and publishable, hash tracked |
| `agent_evaluations` | Evaluation results for artifacts | JSON schema validation, permission diff lint, API spec validation, prompt safety |
| `agent_memory` | Long-lived context outside conversation history | Scope, provenance, confidence, expiry, optional embedding |

## Execution contract

Every harnessed action should resolve to an execution envelope:

```json
{
  "goalId": "goal_...",
  "runId": "run_...",
  "agentName": "lumibase-copilot",
  "context": {
    "siteId": "site_...",
    "collections": ["products", "orders"],
    "policySnapshotHash": "sha256:..."
  },
  "budget": {
    "maxToolCalls": 20,
    "maxCostUsd": 2,
    "timeoutMs": 30000,
    "maxArtifactBytes": 524288
  },
  "risk": "safe | review_required | dangerous",
  "approvalPolicy": "none | before_execute | before_commit",
  "artifacts": []
}
```

Rules enforced by the harness:

- A tool must be registered and enabled before it can execute.
- The caller must satisfy required capabilities for the tool.
- Risk policy can deny, execute directly, or require human approval.
- Disabled tools and capability/risk denials are logged with reasons.
- Risky artifacts cannot be published or submitted for approval unless evaluation passes or an explicit override reason is supplied.
- Failed runs keep their audit history. Retries create a new run linked to the original run instead of rewriting history.
- Budget limits stop execution for max tool calls, runtime, estimated cost, or artifact size.

### Run lifecycle and async execution

Run status follows `queued → running → awaiting_approval → succeeded | failed | cancelled`:

- `POST /api/v1/agent/goals` with `execution: 'async'` and a `task: { skillName, arguments }` creates the goal plus a `queued` run, enqueues it on the `agent-runs` queue via the runtime `QueueProvider`, and returns `202` with the `runId` immediately. Runtimes without a queue adapter reject async execution with `ASYNC_UNAVAILABLE`; sync execution is unaffected.
- The queue worker (`registerAgentRunWorker`, wired in the Node entrypoint) drives queued runs through the same harness codepath — capability checks, risk policy, budgets and audit apply identically. Capabilities are captured from the enqueuing session and never widened.
- When a dangerous action creates an approval, the run parks as `awaiting_approval`. An approval decision resumes it and executes only the stored skill — completed tool calls are never re-run.
- `POST /api/v1/agent/runs/:id/cancel` cancels `queued`/`running`/`awaiting_approval` runs. Cancellation takes effect at the next tool-call boundary (the harness re-checks before every tool call), wins over late approvals, and is recorded with `stopReason` in run metrics.

### Trust gradient at the risk decision (L0–L4)

When a dangerous skill reaches Step 3, the harness resolves the effective autonomy level for `(agentRole, capability)` via the trust ledger — `min(grant-or-default, intent cap, hard ceiling)` — and routes accordingly:

- **≤ L2** — classic pre-execute HITL: an approval record is created and the run parks as `awaiting_approval`.
- **L3 (veto window)** — stageable single-item patches (`updateItem` with a `data` patch) execute into a **staged revision** instead of live content, paired with a `kind='veto'` approval whose `autoCommitAt` defaults to 4 hours out. Silence means consent: a delayed queue job on `agent-veto-commits` (plus a 5-minute safety-net sweep) promotes the staging to live at the deadline with full provenance. A human veto (`POST /api/v1/agent/staged/:id/veto`, admin or `veto` role) before the deadline discards the staging — live content was never touched — and records a `veto` incident that automatically demotes the agent role on that capability. Fields pinned by a human **after** staging win at commit time: the pinned part of the patch is dropped (`auto_commit_partial`), never overwritten. Pending stagings are listed at `GET /api/v1/agent/staged` and announced via a `veto.staged` activity entry with a review deep-link. Commit failures leave the staging intact and retry with exponential backoff; exhausting the attempts opens an incident.
- **L4 (autopilot)** — the dangerous action executes directly within capability and budget; the kill switch still applies.
- Irreversible skills (`deleteCollection`, `deleteField`) are hard-capped at L2 by the resolver and can never stage or run on autopilot.

### Load-aware autonomy (Load Guard)

A system that generates load must also sense load. Three guards bound agent-originated work:

- **Write coalescing** — every skill handler runs inside a coalescing window: item writes defer their materialized-view refresh and flush exactly once per collection at the tool-call boundary (N writes to one collection cost one invalidation), on success and failure alike.
- **Write rate budget** — when a run envelope carries `budget.maxWritesPerMinute` (reconciler goals attach it from their intent), write-capable tool calls consume a sliding-window quota scoped to `${siteId}:${intentId}`. An exhausted budget defers the tool call with `write_budget_exceeded` and a retry hint — the run is not failed.
- **Backpressure** — the Node entrypoint feeds event-loop pressure samples into the guard every 5s. Overload pauses **reconciler-origin runs only** (human-triggered work is never auto-paused) with a `load_guard` incident recorded once per activation per site; a hold-down of continuous calm auto-resumes. Activations are counted in `lumibase_agent_backpressure_activations_total`, budget deferrals in `lumibase_agent_write_budget_denials_total`.
- **Maintenance windows** — intents may declare `{ tz, windows: [{ dow, start, end }] }`; outside the window the reconciliation cycle is a no-op and open drifts queue until the window opens. Overnight windows span midnight; an invalid timezone fails open.

## Core Skills Registry

Skills are defined in two synchronized locations:
- **Public registry** (`packages/ai-skills/src/skills.ts`) — LLM tool definitions exposed via `getAISkillsAsTools()`
- **Harness handlers** (`apps/cms/src/services/ai-harness.ts` → `buildCoreSkills()`) — actual execution logic

A skill classified as **DANGEROUS** (requires HITL approval) when:
1. Its `requiredCapabilities` includes any `schema:*` except `schema:read`, OR
2. Its name starts with `delete`

| Skill | Service | Required Capability | Risk | Handler |
|---|---|---|---|---|
| `listCollections` | schema | `schema:read` | SAFE | Real → SchemaService |
| `createCollection` | schema | `schema:create` | **DANGEROUS** | Real → SchemaService |
| `deleteCollection` | schema | `schema:delete` | **DANGEROUS** | Real → SchemaService |
| `createField` | schema | `schema:update` | **DANGEROUS** | Real → SchemaService |
| `deleteField` | schema | `schema:delete` | **DANGEROUS** | Real → SchemaService |
| `listItems` | items | `items:read` | SAFE | Real → ItemService |
| `createItem` | items | `items:write` | SAFE | Real → ItemService |
| `updateItem` | items | `items:update` | SAFE | Real → ItemService.patch() |
| `deleteItem` | items | `items:write` | **DANGEROUS** | Real → ItemService.softDelete() |
| `aiSuggestField` | ai | `schema:read` | SAFE | Real → LLM + existing-field context (offline registry: keyword patterns) |
| `aiContentAssist` | ai | `items:read` | SAFE | Real → LLM + RAG item samples via ItemService |
| `generateAppSpec` | ai | `schema:read`, `items:read` | SAFE | Real → LLM + live schema introspection; sections must declare `source` bindings |
| `generateApiDocs` | ai | `schema:read` | SAFE | Real → deterministic OpenAPI 3.1 from live schema (no LLM needed) |
| `generateSeedData` | ai | `items:write` | SAFE | Real → LLM rows matching real field definitions |

Skills can be overridden per-site via the `agent_tools` database table without redeploying.

Generation skills resolve the LLM through `createConfiguredLLMProvider`. When `LLM_PROVIDER` (plus credentials) is not configured they fail with an explicit `LLM_NOT_CONFIGURED` error — there is no silent stub fallback in production routes. Provider failures surface as `LLM_PROVIDER_ERROR`, malformed model output as `LLM_INVALID_JSON`. Successful LLM-backed runs record `{ llm: { provider, model, estimatedTokens } }` in `agent_runs.metrics`.

## App generation MVP

When a user asks LumiBase to generate an app, the agent reads the existing schema, content, policies, and scoped memory, then produces artifacts:

```text
Goal: generate storefront
Context: products, orders, customers, storefront policy summary
Outputs:
  - page_spec artifact
  - component_spec artifact
  - api_spec artifact
  - seed_data artifact
Evaluations:
  - JSON schema validation
  - API spec validation
  - permission diff lint
  - prompt safety check
Approval:
  - required before publishing risky artifacts
```

The initial e-commerce template targets `products`, `orders`, `customers`, and storefront pages. It is intentionally artifact-first: generated outputs are reviewed, evaluated, approved, and then published.

The current MVP returns four artifacts from `/api/v1/agent/generate-app`: `page_spec`, `component_spec`, `seed_data`, and `api_spec`. Publishing is idempotent, rollback is available for published artifacts, and failed schema/migration evaluations block publish unless an override reason is supplied.

## Runtime compatibility

The harness service layer runs inside the CMS request/runtime boundary and uses existing database and route abstractions. It does not require Cloudflare-only APIs for the current MVP.

- **Cloudflare Workers**: CMS routes and Drizzle-backed harness services run in the Worker runtime.
- **Docker / Node.js**: the same API routes and services run in self-hosted mode.
- **Queues**: repeated run failure uses the runtime `QueueProvider` to enqueue `agent-dead-letter`; if no queue adapter is available, the failed run remains fully audited in `agent_runs` and `agent_tool_calls`.
- **Observability**: Prometheus metrics cover run status, stop reason, tool latency, approval latency, evaluation status, estimated token/cost usage, and dead-letter enqueue rate. Docker mode auto-loads the `Lumibase Agent Harness` Grafana dashboard.
- Long-running generation/evaluation jobs that exceed request runtime limits should be moved behind queue/workflow execution in a later phase. Until then, the MVP keeps evaluation runners short and synchronous.

If future evaluation runners depend on runtime-specific APIs, they must be feature-flagged and documented in [`runtime-abstraction.md`](./runtime-abstraction.md).

## Security model

- All agent tables are scoped by `siteId`.
- Item revisions carry provenance: skill-driven writes are stamped `authorType='agent'` with the executing `createdByRunId`, while Studio/API writes by people record `authorType='human'`. The harness sets this on the ItemService before any skill handler runs.
- **Law Zero (override-is-law):** human edits on collections governed by an active content intent pin the touched fields (`items.pinnedFields`). Agent writes to pinned fields are denied at the ItemService boundary with `PINNED_BY_HUMAN`; pins are listed/released via `GET/DELETE /api/v1/items/:collection/:id/pins[/:field]` and every pin/release is audited in the activity log.
- Tool inputs and memory context are redacted/masked before audit or prompt assembly.
- Prompt text cannot grant permissions; only policy snapshots and capability grants can.
- Approval decisions are recorded with actor, decision, reason, and timestamps.
- Tool calls preserve input/output/error metadata for audit while avoiding plaintext secrets.

## Operational metrics

The harness records the raw fields needed for:

- Run count and success/failure rate.
- Approval latency.
- Tool latency.
- Evaluation failure rate.
- Budget stop reason.
- Estimated cost.
- Artifact size/hash tracking.

These fields can be aggregated by the observability layer described in [`observability.md`](./observability.md).

## Relationship to AI Copilot

The existing AI Copilot remains the human-facing chat entry point. The Agent Harness Layer is the governance and execution substrate underneath it.

Use [`ai-copilot.md`](./ai-copilot.md) for legacy Copilot chat and HITL behavior. Use this document for first-class agent lifecycle, tools, approvals, artifacts, evaluations, memory, and app generation.
