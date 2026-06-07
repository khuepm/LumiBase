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
  - prompt artifact
Evaluations:
  - JSON schema validation
  - API spec validation
  - permission diff lint
  - prompt safety check
Approval:
  - required before publishing risky artifacts
```

The initial e-commerce template targets `products`, `orders`, `customers`, and storefront pages. It is intentionally artifact-first: generated outputs are reviewed, evaluated, approved, and then published.

## Runtime compatibility

The harness service layer runs inside the CMS request/runtime boundary and uses existing database and route abstractions. It does not require Cloudflare-only APIs for the current MVP.

- **Cloudflare Workers**: CMS routes and Drizzle-backed harness services run in the Worker runtime.
- **Docker / Node.js**: the same API routes and services run in self-hosted mode.
- Long-running generation/evaluation jobs that exceed request runtime limits should be moved behind queue/workflow execution in a later phase. Until then, the MVP keeps evaluation runners short and synchronous.

If future evaluation runners depend on runtime-specific APIs, they must be feature-flagged and documented in [`runtime-abstraction.md`](./runtime-abstraction.md).

## Security model

- All agent tables are scoped by `siteId`.
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
