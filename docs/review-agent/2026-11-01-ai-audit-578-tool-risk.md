# #578 audit: impact-aware tool risk classification and approvals

- **Parent:** #577 (workstream 1, P0 audit priority)
- **Audited commit:** `b12e9385` (`origin/main`, 2026-10-31)
- **Fix branch:** `feature/578-tool-risk-approval-audit`
- **Evidence:** `apps/cms/src/services/__tests__/ai-harness-item-impact.db.integration.test.ts`
  (20 cases, real PostgreSQL 17 + real `ItemService`), negative-checked as described in §5.
- **Related work reused, not duplicated:** #453 (claim → execute → finalize), #472
  (requester re-resolution and requester row/field scope), #507/B119 (`expect`
  precondition for automation proposals).

"P0" is the audit priority. The findings below are rated individually.

## 1. Decision points (code at the audited commit)

| Step | Where | What decides |
|---|---|---|
| Kill switch | `ai-harness.ts` `execute`, before any run is created | `KillSwitchService.frozenScopeFor(agentName)`: site or role freeze denies. |
| Input contract | `validateToolInput` (before `ensureRun`) and again in `runSkill` | Canonical `.strict()` schemas in `packages/contracts/src/agent-tools/schemas.ts`. |
| Capabilities | `checkCapabilities`; role runs narrowed by `AgentRoleService.effectiveCapabilities` | `satisfiesCapability`. |
| Registry policy | `ToolRegistryService.coreTool` / `evaluatePolicy` | `riskPolicy.level` = `dangerous` for `dangerous` flag, mutating `schema:*`, `delete*` name, or `deployments:write`; `blocked`/disabled deny; per-run and per-minute call limits. |
| Risk | `isControlPlaneSkill` (same function backs `evaluateRisk` and the MCP admin backstop) | `dangerous` flag, mutating `schema:*` capability, or name starting with `delete`. |
| Trust gradient | `AutonomyService.resolve` → `resolveAutonomy` | Grant level, else L1 for dangerous / L2 for safe; min with intent `autonomyCap`; irreversible skills capped at L2. |
| Dangerous branch | `execute`, `if (isDangerous)` | L3 + `contentOs.vetoWindow` + stageable `updateItem` data patch → veto staging; L4 → execute; otherwise `parkForApproval`. |
| Write gate | `execute`, "Step 3b" | Non-control-plane writes: L0 → `AUTONOMY_SHADOW`; L1 → `parkForApproval`; L2+ → execute. |
| Law Zero (pins) | `ItemService.patch` | `blockedPinnedFields` refuses agent writes to pinned fields (`PINNED_BY_HUMAN`, 403). Veto commit drops pinned keys. |
| Editorial gate | `ItemService.patch` | On `editorialWorkflow` collections, draft → `published` needs the approved/scheduled state (`EDITORIAL_GATE_REQUIRED`). |
| Approval execution | `executeApproved` → `executeApprovedWithAudit` → `runClaimedApproval` | Expiry, status, requester provenance (#472), requester ∩ decider capabilities, requester row/field scope, conditional claim to `deciding`, cancellation, kill switch, stored arguments re-validated in `runSkill`. |
| Decision routes | `routes/agent.ts` `POST /approvals/:id/decide`, `/agent-decide`, `/reopen`; `routes/ai.ts` `/approvals/:id/decide` | Require `approvals:decide` or control-plane admin; none accept replacement arguments. |

## 2. Policy matrix — before and after

Default installation (no grants, no intent cap). "Park" = pending approval, nothing written.

| Call | Before (`b12e9385`) | After | Evidence (test name) |
|---|---|---|---|
| `createItem` draft | execute | execute | "a draft create still executes at the default level" |
| `createItem` `status: 'published'` | **execute (live, no approval)** | park, `riskReason: publication_change` | "a create with status published parks…" |
| `updateItem` data patch, draft | execute | execute | "a data patch on a draft still executes…" |
| `updateItem` data patch, published item | **execute (live, no approval)** | park, `live_content` | "a data patch on a published item parks…" |
| `updateItem` draft → `published` | **execute** | park, `publication_change` | "publishing a draft parks for approval" |
| `updateItem` published → `draft` | **execute** | park | "unpublishing a live item parks…" |
| `updateItem` on pinned field | denied `PINNED_BY_HUMAN` | unchanged | "a pinned field refuses an agent write…" |
| `deleteItem` | park | park | "a delete at the default level parks…" |
| any write, intent cap L1 | park | park | "an L1 intent cap still parks…" |
| plain write, intent cap L0 | denied `AUTONOMY_SHADOW` | unchanged | — (existing GP2 test) |
| dangerous skill, intent cap L0 | **park (approvable)** | denied `AUTONOMY_SHADOW` | "an L0 intent cap refuses a dangerous skill…", "…refuses a publish outright" |
| published patch, L3 grant + veto flag | execute (not dangerous) | staged in veto window | "an L3 grant with the veto window stages…" |
| publish, L4 grant | execute | execute | "an L4 grant publishes directly…" |
| `ItemService.create` `published` on editorial collection (REST, GraphQL, agent) | **inserted live, review skipped** | `409 EDITORIAL_GATE_REQUIRED` | "creating a published item on an editorial collection is refused" |

Approval controls (all pass at the audited commit; the cases are now covered against a real item row):

| Control | Result | Evidence |
|---|---|---|
| Executes the stored arguments only; decide routes take no payload | pass | "approval executes the stored arguments exactly once" |
| Second approval of the same id (duplicate resume) | denied, item unchanged | same test |
| Stored arguments altered to break the contract | refused by the `runSkill` validation backstop | "a stored payload altered…" |
| Rejected, then approved | denied | "a rejected approval cannot be approved afterwards" |
| Expired (`expires_at` in the past) | denied `Approval expired` | "an expired approval is refused…" |
| Run cancelled before decision | denied | "a cancelled run is not resumed…" |
| Kill switch (site freeze) | new writes and approved execution denied; approval stays `pending` | "the kill switch blocks both…" |
| Revoked/demoted requester, narrowed fields | denied / requester scope | existing `g2-approval-requester*.db.integration.test.ts` (#472) |
| Concurrent decisions | one winner | existing `g1-approval-concurrency.db.integration.test.ts` (#453) |

## 3. Findings

### F1 — Item writes were classified by name only (fixed)

- **Severity: high.** Any principal whose agent session holds `items:write`/`items:update`
  could publish, unpublish or rewrite live content through Copilot, the Agent API or
  governed MCP with no approval at the default level. No privilege escalation is
  involved (the caller already holds the content permission), which is why this is
  not rated critical. It defeats the HITL promise for exactly the changes with public
  impact.
- **Reproduction:** at `b12e9385`, the matrix tests above marked "before: execute"
  fail (measured, see §5).
- **Fix:** `classifyItemWriteImpact` + `AISecureHarness.evaluateItemWriteImpact`
  (one site-scoped status read for `updateItem`; read failure fails closed as
  `unknown_state`). Escalated calls take the dangerous gradient on both the governed
  and legacy paths. `isControlPlaneSkill` is unchanged, so the MCP admin backstop does
  not start requiring admin for content writes. The approval row records
  `approval_policy = 'before_execute'` and the tool call output carries `riskReason`.

### F2 — Editorial gate missing on create (fixed)

- **Severity: medium.** On a collection with `editorialWorkflow: true`, `patch` refuses
  draft → published, but `create` with `status: 'published'` inserted the item live.
  Affects REST/GraphQL callers and agents. Requires create permission on the
  collection.
- **Fix:** the same `EDITORIAL_GATE_REQUIRED` (409) check in `ItemService.create`.

### F3 — L0 did not stop dangerous skills (fixed)

- **Severity: medium.** `AutonomyService` defines L0 as "no side effects", and the
  write gate refused plain writes at L0, but the dangerous branch had no L0 case and
  parked an approval. A human could then release, for example, a `deleteItem` from an
  intent capped at L0.
- **Fix:** the dangerous branch now returns `AUTONOMY_SHADOW` at L0 without creating an
  approval. `g2-mcp-contract-repro.test.ts` GP4 pinned the old behaviour as a control
  and was updated with an explanation.

### F4 — Approvals never expire (open, needs a decision)

- **Severity: medium.** Every expiry check (`executeApproved`, `executeApprovedWithAudit`,
  the decide route) works, but nothing on the governed path sets
  `agent_approvals.expires_at`, so the checks only fire for rows edited by hand. An
  approval for a live patch can be released weeks later against content that has moved
  on. Automation proposals are protected by the `expect` precondition (B119); Copilot and
  MCP proposals are not.
- **Not fixed here:** a default TTL changes what operators see in Mission Control
  (expired rows stay `pending` today; there is no sweeper that settles them). Logged as
  backlog **B171** with the options.

### F5 — Sensitive fields are not a risk input (open, gap by design)

- **Severity: low/medium depending on content model.** A draft-only change to a field
  such as `price` or `paymentUrl` is treated like any other draft field. There is no
  field metadata for agent risk today; once the item is published, F1 covers it.
- Logged as backlog **B172** (needs a field-meta design; additive).

### F6 — Residual, accepted for this audit

- **Approval arguments are not hashed.** Execution uses the stored `ai_approvals.arguments`;
  no route can change them, and the contract backstop catches malformed edits, but a
  valid edit made directly in the database would execute. Database write access is
  outside the threat model of this workstream.
- **`agent_tools` overrides can relax risk.** `ToolRegistryService.getTool` takes
  `riskPolicy` and `requiredCapabilities` from a DB override. No application route
  writes `agent_tools` (`git grep "insert(agentTools)"` is empty), so this is again a
  DB-level capability. Revisit if an override API is added.
- **Bulk changes:** there is no bulk item skill in `CORE_SKILLS`; bulk agent writes are
  N single-item calls and each is classified on its own. N/A for this audit.

## 4. Acceptance criteria of #578

| Criterion | Status |
|---|---|
| Document classifications, decision points and policy matrix with code references | done (§1, §2) |
| Tests prove sensitive changes need approval and low-risk changes still work | done for publication/live changes (F1, F2); field sensitivity is F5 (open) |
| Test denial, expiry, cancellation, payload mutation, duplicate resume, pinned fields, kill switch | done (§2 approval controls) |
| Fix confirmed gaps with regression tests | F1–F3 fixed; F4, F5 logged with rationale |

## 5. How the evidence was produced

```bash
docker run --rm -e POSTGRES_USER=lumibase -e POSTGRES_PASSWORD=lumibase_dev \
  -e POSTGRES_DB=lumibase -p 55432:5432 pgvector/pgvector:pg17
DATABASE_URL=postgresql://lumibase:lumibase_dev@localhost:55432/lumibase pnpm db:migrate
cd apps/cms
DATABASE_URL=postgresql://lumibase:lumibase_dev@localhost:55432/lumibase \
  npx vitest run src/services/__tests__/ai-harness-item-impact.db.integration.test.ts
```

Negative checks on the fix branch:

- `classifyItemWriteImpact` forced to return `null`: 11 of 18 cases fail (every
  escalation case and every approval-lifecycle case, which depend on a parked write).
- L0 branch and the create editorial gate disabled: exactly the 3 cases that cover them
  fail.
