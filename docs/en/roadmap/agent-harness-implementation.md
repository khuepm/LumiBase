---
version: 1
lastUpdated: 2026-07-25T08:14:17.856Z
sourceLang: vi
translatedFrom: vi
sourceHash: 8e804b343329c625
mtEngine: claude
syncStatus: machine-translated
codeVerified: 2026-07-25T08:14:17.856Z
codeVerifiedHash: 8e804b343329c625
codeVerifiedClaims: 2
---

# Agent Harness Layer implementation roadmap

This document answers one question: now that LumiBase is positioned as a "structured operating layer where humans, agents, data, workflows, and applications co-evolve", what concretely needs building?

The goal is no longer "add an AI chat". The goal is to turn every agent action into a structured lifecycle: **Goal → Run → Plan → Tool calls → Evaluation → Approval → Artifact commit → Audit/Memory**.

## 0. Guiding principles

1. **No agent writes straight to schema/content without harness state.** Every risky action must be tied to a `goalId`, `runId`, policy snapshot, and approval/evaluation.
2. **Keep the tool registry out of the prompt.** Which tool may be called, its input schema, capability, risk policy and rate limit must come from the database/config — never from what the agent claims about itself.
3. **The artifact is the real output; chat is only an interface.** Anything that matters is stored as a versioned artifact: page, component, dataset, config, prompt, migration, API spec, workflow.
4. **Evaluation before approval, approval before commit.** An admin should not be approving "text"; an admin approves a diff/artifact together with its test/eval result.
5. **Audit/replay is first-class.** A failed run must be reviewable: plan, tool calls, secret-masked input/output, errors, cost, and retry policy.

## 1. Phase A — Standardise the DB foundation and lifecycle

Goal: turn today's AI Copilot from disconnected chat/HITL into a lifecycle with explicit goals and runs.

- [x] `[DB]` Add `agent_goals` with `siteId`, `title`, `description`, `source` (`user`/`flow`/`api`/`schedule`), `createdBy`, `assigneeAgent`, `priority`, `deadline`, `status`, `successCriteria jsonb`, `createdAt`, `updatedAt`.
- [x] `[DB]` Add `agent_runs` with `goalId`, `siteId`, `agentName`, `provider`, `model`, `status`, `budget jsonb`, `policySnapshotHash`, `risk`, `startedAt`, `finishedAt`, `error`.
- [x] `[DB]` Add `agent_plans` with `runId`, `steps jsonb`, `status`, `risk`, `approvalPolicy`, `createdAt`, `approvedAt`, `approvedBy`.
- [x] `[DB]` Add `agent_tool_calls` with `runId`, `toolName`, `input jsonb`, `output jsonb`, `error`, `status`, `latencyMs`, `cost jsonb`, `createdAt`; input/output must support secret masking.
- [x] `[DB]` Add indexes `(siteId, status)`, `(goalId, createdAt)`, `(runId, createdAt)` and sensible cascades on `siteId`/`goalId`.
- [x] `[BE]` Build `AgentRunService` to open a run, append plan/tool calls, close, fail, and retry a run.
- [x] `[BE]` Refactor `AISecureHarness.execute()` so a request without `goalId/runId` creates a transient goal/run instead of only a disconnected approval.
- [ ] `[TEST]` Property tests guaranteeing every tool call belongs to the right `siteId/runId`, that a failed run still keeps its audit trail, and that runs/goals are unreadable cross-site.

## 2. Phase B — Tool registry and capability policy

Goal: promote `CORE_SKILLS` from a constant in a package to an operable registry.

- [ ] `[DB]` Add `agent_tools` with `name`, `description`, `inputSchema`, `outputSchema`, `requiredCapabilities`, `riskPolicy`, `rateLimit`, `enabled`, `owner`, `extensionId?`.
- [ ] `[DB]` Add `agent_permissions` binding an agent/user/API key to policies/capabilities with `validFrom`, `validUntil`, `environment`.
- [ ] `[BE]` Implement `ToolRegistryService`: load tools from core skills + extension tools + DB overrides; cache per `siteId` and invalidate when a tool/extension changes.
- [ ] `[BE]` Standardise risk policy: `safe`, `review_required`, `dangerous`, `blocked`; support rules by capability, collection, action, and environment.
- [ ] `[BE]` Enforce rate limits per tool/agent/site to prevent runaway loops.
- [ ] `[SDK]` Add types for `AgentTool`, `AgentCapability`, `AgentRiskPolicy`.
- [ ] `[FE]` Studio "Agent Tools" page for admins to enable/disable a tool and inspect its schema, capabilities, risk policy and call history.
- [ ] `[TEST]` An agent cannot call a disabled tool, one it lacks the capability for, one over its rate limit, or one whose risk is policy-`blocked`.

## 3. Phase C — Extended approvals: plan/tool/artifact

Goal: approval stops being only for `ai_approvals`-style dangerous skills and becomes a general gate.

- [ ] `[DB]` Add `agent_approvals` with `runId`, `subjectType` (`plan`/`tool_call`/`artifact`/`schema_diff`), `subjectId`, `status`, `requestedByAgent`, `decidedBy`, `decisionReason`, `expiresAt`, `createdAt`, `decidedAt`.
- [ ] `[BE]` Migration bridge: keep `ai_approvals` backward-compatible while dual-writing new actions to `agent_approvals`.
- [ ] `[BE]` Approval policy engine: `before_execute`, `before_commit`, `two_person_rule`, `owner_only`, `security_admin_only`.
- [ ] `[FE]` Grow the Approvals Dashboard from simple skill cards into a queue by subject type, with diff preview, eval summary, and approve/reject/request-changes.
- [ ] `[BE]` Audit every decision with actor, reason, before/after hash, and request id.
- [ ] `[TEST]` A dangerous plan does not execute before approval; a rejected artifact does not commit; an expired approval no longer counts.

## 4. Phase D — Artifact store and versioning

Goal: agent output becomes an asset that can be reviewed, published, and rolled back.

- [ ] `[DB]` Add `agent_artifacts` with `runId`, `siteId`, `type`, `target`, `title`, `contentRef` or `content jsonb`, `hash`, `version`, `status` (`draft`/`reviewing`/`approved`/`published`/`rejected`/`rolled_back`), `createdAt`.
- [ ] `[BE]` Artifact writers for the first types: `schema_diff`, `page_spec`, `component_spec`, `seed_data`, `api_spec`, `prompt`, `migration`.
- [ ] `[BE]` Commit adapters: a `schema_diff` artifact → collections/fields/relations; `seed_data` → items; `page_spec` → pages — all going through permissions + approval.
- [ ] `[FE]` Artifact review UI: diff view, JSON/raw mode, linked collections/items, approve/publish/rollback.
- [ ] `[SDK]` Client methods: list artifacts by goal/run, get an artifact, approve/publish/rollback.
- [ ] `[TEST]` Artifact hashes are stable; publish is idempotent; rollback restores the previous version; cross-site artifacts are denied.

## 5. Phase E — Evaluation gate

Goal: admins approve on evidence, not on trust in the LLM.

- [ ] `[DB]` Add `agent_evaluations` with `runId`, `artifactId`, `kind`, `status`, `score`, `summary`, `details jsonb`, `createdAt`.
- [ ] `[BE]` First eval runners: JSON schema validation, permission diff lint, schema migration dry-run, generated API spec validation, prompt safety check.
- [ ] `[BE]` Policy: a `schema_diff`/`migration` artifact cannot request approval without a passing eval or an explicit override.
- [ ] `[OPS]` Sandbox smoke test for a generated app/page spec on the Docker runtime before publishing.
- [ ] `[FE]` Show the eval summary in the approval/artifact UI with pass/warn/fail status.
- [ ] `[TEST]` An artifact failing eval cannot publish; a warning requires a reason to override; eval results attach to the correct artifact hash.

## 6. Phase F — Controlled memory and knowledge base

Goal: memory that is useful but scoped, expiring, provenanced, and access-controlled.

- [ ] `[DB]` Add `agent_memory` with `siteId`, `scope` (`site`/`collection`/`item`/`user`/`goal`), `sourceType`, `sourceId`, `content`, `embedding`, `confidence`, `expiresAt`, `createdAt`.
- [ ] `[BE]` Memory write policy: only write memory from an artifact/evaluation/approved output, or from content with clear provenance.
- [ ] `[BE]` RAG context builder assembling schema, permissions, recent runs, approved artifacts, and memory that matches scope and field mask.
- [ ] `[BE]` PII/secret redaction before memory is embedded or placed in context.
- [ ] `[TEST]` A user/agent only retrieves memory within its policy scope; expired memory never enters context; masked fields never appear in RAG.

## 7. Phase G — App generation MVP

Goal: demonstrate that LumiBase does not just manage content but helps build business software.

- [ ] `[AI]` A `generateAppSpec` skill reading collections/fields/relations/policies and producing `page_spec` + `component_spec` artifacts.
- [ ] `[AI]` A `generateApiDocs` skill producing an `api_spec` artifact from the schema and public/role permissions.
- [ ] `[AI]` A `generateSeedData` skill producing a `seed_data` artifact, with schema validation as an eval before insert.
- [ ] `[BE]` An app-generation run template for the e-commerce use case: products/orders/customers/storefront.
- [ ] `[FE]` A "Generate app from schema" wizard: pick collections, target app, constraints, budget, approval policy.
- [ ] `[TEST]` End-to-end: create a goal to generate a storefront → plan → artifacts → eval → approval → publish page/spec.

## 8. Phase H — Observability, cost and operations

Goal: the agent is operable in production, not just in a demo.

- [ ] `[BE]` Metrics: run count, success/fail rate, approval latency, tool latency, eval fail rate, token/cost estimate.
- [ ] `[OPS]` An "Agent Harness" Grafana dashboard: runs by status, cost by agent/tool/site, approval backlog, failed evals.
- [ ] `[BE]` Budget enforcement: max tool calls, max runtime, max estimated cost, max artifact size.
- [ ] `[BE]` Dead-letter queue for runs/tool calls that fail repeatedly.
- [ ] `[FE]` Run detail timeline: plan, tool calls, logs, evals, approvals, artifacts.
- [ ] `[TEST]` A run over budget stops safely and records the reason; a retry does not duplicate already-committed artifacts.

## 9. Recommended implementation order

1. **A1 lifecycle DB + service**: `agent_goals`, `agent_runs`, `agent_tool_calls`, `AgentRunService`.
2. **B1 tool registry**: move `CORE_SKILLS` into a registry carrying risk/capability/rate limit.
3. **C1 general approvals**: `agent_approvals` + the new Approvals Dashboard.
4. **D1 artifact store**: start with `schema_diff`, `seed_data`, `api_spec`.
5. **E1 evaluation gate**: schema validation + permission diff + dry-run.
6. **G1 e-commerce app-generation demo**: the first flow that can be demoed end-to-end.

## 10. Definition of Done for each phase

- A Drizzle migration/schema exists and `docs/en/data-model.md` is updated.
- The route/API contract is in `apps/cms/openapi.yaml` with matching SDK types.
- Property tests cover multi-tenant isolation, permission/capability, idempotency, or an approval invariant.
- A minimal Studio UI exists so an admin can observe/approve/debug — not just a backend endpoint.
- Minimal audit log and metrics are in place.
- It runs on both the Cloudflare Workers and Docker runtimes; if one runtime is not supported yet, there is a feature flag and the limitation is documented.
