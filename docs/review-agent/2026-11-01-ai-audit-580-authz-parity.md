# #580 audit: authorization parity across Copilot, Agent API and MCP

- **Parent:** #577 (workstream 3, P0 audit priority)
- **Audited commit:** `b12e9385` (`origin/main`, 2026-10-31)
- **Fix branch:** `feature/580-authz-parity`
- **Evidence:** `apps/cms/src/services/__tests__/authz-parity-agent-run.db.integration.test.ts`
  (6 cases, real PostgreSQL 17 + real worker entry point + real `ItemService`, two sites,
  a least-privilege API-key principal), negative-checked as described in §6.
- **Model:** none. Every case feeds a fixed tool call to the harness or the worker. No live
  model was called, so there are no model-sensitive results.
- **Related work reused, not duplicated:** #472 (capability resolution from RBAC, requester
  re-resolution and requester row/field scope on approval), #453 (claim → execute → finalize),
  #454 (governed standalone-MCP routing, `S16` coverage table), #364/#361 (governed tool
  contract), B72 (principal-bound ItemService in the async Copilot worker), #578/#579 (risk
  classification and compromised-model dataset, PRs #586/#587).

"P0" is the audit priority. The finding below is rated on its own.

## 1. Inventory of execution paths (audited commit)

| Transport | Entry point | Who can reach it | Coarse capabilities | Row/field enforcement (`ItemService`) | Provenance for parked work |
|---|---|---|---|---|---|
| Copilot sync | `POST /api/v1/ai/chat` (`routes/ai.ts`) | site member (Studio plane) | `resolveRequestCapabilities(c)` | `itemServiceForRequest(c)` | `approvalRequesterFromAuth` |
| Copilot async | `ai:chat` job → `services/ai-chat-run-worker.ts` | same request, `Prefer: respond-async` | re-resolved from `job.principal` at pickup | `itemServiceForPrincipal` (B72) | `job.principal` |
| Agent API sync | `POST /api/v1/agent/goals` (`execution: 'sync'`) | control-plane admin (`CONTROL_PLANE_PATHS`) | — (creates a goal; executes nothing) | — | — |
| Agent API async | `POST /agent/goals` (`execution: 'async'`) → `agent-runs` → `services/agent-run-worker.ts` | control-plane admin | re-resolved from `payload.principal` at pickup (#472) | **system ItemService (F1)** → now `itemServiceForPrincipal` | `payload.principal` |
| Agent API retry | `POST /agent/runs/:id/retry` → same worker | control-plane admin | re-resolved for the retrying principal | **system (F1)** → now principal-bound | retrying principal |
| Reconciler | goal dispatch → same worker, `agentRole`, no principal | system (intent + agent role) | `AgentRoleService.effectiveCapabilities`, re-read at pickup | system (`background-worker`), declared | `kind: 'agentRole'` |
| Governed MCP | `POST /api/v1/mcp` (`routes/mcp.ts`) | site member with `contentOs.mcp` on | `resolveRequestCapabilities(c)` + admin backstop for control-plane skills | `itemServiceForRequest(c)` | `approvalRequesterFromAuth` |
| Standalone MCP (stdio) | `packages/mcp-server` | the holder of the configured token | governed tools → `POST /api/v1/mcp`; other tools → REST with the same token | the server-side route of each call | as the route |
| Approval decide | `POST /agent/approvals/:id/decide`, `/agent-decide`, `POST /ai/approvals/:id/decide` | `approvals:decide` or control-plane admin | requester re-resolved ∩ decider (#472) | requester's context (`scopeToRequester`, #472 F1) | stored |
| J11 automation | `ai:automation` flow op (`services/ai-automation-ops.ts`) | flow owner principal | re-resolved | `itemServiceForPrincipal` | principal |

The standalone MCP server has no authorization code of its own. Backup/restore
(`export_backup`, `restore_backup` → `/api/v1/admin/*`, control plane), marketplace
(`install_marketplace_extension` → `POST /api/v1/marketplace/extensions/:slug/install`,
`extensions:install`) and media (`list_media`, read only) are REST passthroughs, so they are
authorized exactly as REST (`no-skill` in `packages/mcp-server/src/governed.ts`). No agent
skill writes binary media, backups or marketplace rows, so those rows of the matrix are N/A for
the harness.

## 2. Enforcement points

| Check | Where | Applies to |
|---|---|---|
| Authentication, tenant resolution, membership | `withAuth`, `withTenant`, `withTenantExists`, `withSiteMembership` | every HTTP transport |
| Control-plane backstop | `withControlPlaneAccessGuard` (`/api/v1/agent`, `/api/v1/ai/automation`, …) | Agent API |
| Control-plane skill backstop | `controlPlaneSkillFromCall` in `routes/mcp.ts` | governed MCP |
| Capability resolution | `governed-capabilities.ts` → `EffectiveCapabilityService` (one resolver) | all transports; workers at pickup |
| Kill switch, schema contract, capability, registry policy, autonomy, HITL | `AISecureHarness.execute` | all transports |
| Row rules and field masks | `ItemService` with a `permissionCtx` | only when the ItemService is principal-bound |
| Approval execution | `executeApproved` (requester provenance, requester ∩ decider, requester scope, claim) | all decide routes |

## 3. Matrix (principal × tenant × action × field × transport)

Principal: an API key on site A whose policy allows `read/create/update` on `posts`, fields
`title, body` only. Site B is another tenant. "Sync" is the request-equivalent harness that
Copilot sync and governed MCP build; "queued" is a job processed by `processAgentRunJob`.

| Action | Sync (Copilot/MCP) | Queued Agent API, before | Queued Agent API, after | Evidence (test name) |
|---|---|---|---|---|
| create `posts` `{title}` | executed | executed | executed | "an authorized create executes on both paths" |
| create in `secrets` (no permission) | denied, no row | **executed, row written** | denied, no row | "a create in a collection outside the grant…" |
| update `posts.internalNote` (field not granted) | denied, unchanged | **executed, overwritten** | denied, unchanged | "an update to a field outside the grant…" |
| list `posts` | executed, `internalNote` masked | **executed, `internalNote` in tool output** | executed, masked | "a read returns neither the masked field…" |
| update site B's item id | not found | not found (site scope) | not found | "a cross-tenant item id is not reachable…" |
| grant revoked between enqueue and pickup | — | run `failed`, no row | unchanged | "a grant revoked between enqueue and pickup…" |

Missing and revoked credentials, cross-tenant ids, locked tenants and insufficient
capabilities on the other transports are already covered and were re-run (§5).

## 4. Findings

### F1: Queued Agent API runs bypassed row and field rules (fixed)

- **Severity: medium.** `processAgentRunJob` built `itemServiceForSystem(…, 'background-worker')`
  for every job, including jobs that carry a principal. Since #472 the worker re-resolves that
  principal's capabilities at pickup, so the coarse gate was correct, but the ItemService then
  wrote with no `permissionCtx`. A principal allowed to create `posts` alone resolves to
  `items:write` and could therefore write any collection, write fields outside its grant, and
  read masked fields back in the tool output. The same request through Copilot or governed MCP
  is refused. This is the class B72 closed for the async Copilot worker.
- **Why not higher:** `POST /agent/goals` and `/agent/runs/:id/retry` are behind the
  control-plane backstop, so the enqueuing principal is a site admin, and a current admin
  bundle has no row or field restrictions. The bypass matters when the principal's grant is
  narrower at pickup than at enqueue (an admin demoted to a scoped role while the job waits;
  #472 re-resolves the coarse grant but the row/field scope was lost), and for any future
  producer of `agent-runs` jobs that is not admin-gated. No cross-tenant access was possible:
  the system ItemService is still site-scoped.
- **Reproduction:** at `b12e9385`, 3 of the 6 cases in the new suite fail (measured, §6): the
  `secrets` row is written, `internalNote` is overwritten, and the list output contains the
  canary.
- **Fix:** the worker binds the ItemService to `capabilities.permissionContext` with
  `itemServiceForPrincipal` when the job carries a user or API-key principal. Reconciler
  (`agentRole`) jobs and legacy capability-snapshot jobs have no principal to bind and keep the
  declared system posture. The ExtensionsService in the same worker already received the
  principal context.
- **Development principals (review R1).** The first version of the fix also bound `dev`
  principals. `EffectiveCapabilityService.resolveDev` admits them only in the development
  runtime with the `admin` role and grants a full admin bundle, but their permission context
  has no user, role or API key, so `PermissionService` resolves no grants and every write was
  denied. That broke queued dev-admin runs (`agent-run-retry.db.integration.test.ts` › "queues
  the retry…", red in CI run 41510960129). The worker now keeps the system posture for `dev`
  principals only; a tripwire pins that exemption to exactly `principal?.type !== 'dev'`.

## 5. Controls verified correct (no change)

| Control | Evidence (existing suites; all `*.integration*` suites re-run on this branch, §6) |
|---|---|
| One capability resolver for every transport; `auth.roles` never used as capabilities | `__tests__/governed-capabilities.wiring.test.ts`, `services/__tests__/g2-governed-capabilities.test.ts` |
| Queued work re-resolves the principal at pickup; revoked key / deactivated user denied | `effective-capability-service.db.integration.test.ts`, new revocation case |
| Approval re-resolves the requester, intersects with the decider, executes in the requester's row/field scope | `g2-approval-requester.db.integration.test.ts`, `g2-approval-requester-scope.db.integration.test.ts` |
| Concurrent / duplicate approval execution | `g1-approval-concurrency.db.integration.test.ts` |
| MCP admin backstop for control-plane skills; API key never `controlPlaneAdmin` | `routes/__tests__/mcp-control-plane-backstop.test.ts`, `g2-reviewer-admin-contract.db.integration.test.ts` |
| MCP and the direct harness return the same decision | `services/__tests__/mcp-parity.property.test.ts` (Property 14) |
| Copilot async worker principal-bound | `item-service-rbac-context.test.ts` (B72 pattern) |
| Unknown tenant id refused before auth writes audit rows | `withTenantExists` (B64) |
| Kill switch blocks new runs and approved execution | `#578` suite (PR #586) |
| Compromised-model tool calls cannot exceed the principal | `#579` dataset suite (PR #587) |

## 6. How the evidence was produced

```bash
cd apps/cms
DATABASE_URL=postgresql://lumibase:lumibase_dev@localhost:55432/lumibase \
  npx vitest run src/services/__tests__/authz-parity-agent-run.db.integration.test.ts
```

Measured on this branch (`--maxWorkers=1 --no-file-parallelism`, Postgres 17 + pgvector):

- **With the fix:** 6 of 6 cases pass (221 s, host under heavy load).
- **Negative check** (`agent-run-worker.ts` restored to `origin/main` `b12e9385`, test
  unchanged): 3 of 6 fail. They are the `secrets` create (run `succeeded`), the
  `internalNote` update (run `succeeded`) and the list (the tool output contains
  `CANARY-580-A`). The authorized create, the cross-tenant id and the revocation cases pass on
  both versions, as expected: site scope and pickup re-resolution were already correct.
- **Tripwire** `governed-capabilities.wiring.test.ts` › "workers that re-resolve a principal
  bind ItemService to it (#580)": passes with the fix and fails on the audited worker (see
  the PR body for the count).

After review R1 (dev exemption), measured on the new head with the same local Postgres, one
suite at a time:

- `agent-run-retry.db.integration.test.ts`: 13 of 13 pass. With the exemption removed
  (`bindPrincipal = true`): 1 of 13 fails, "queues the retry…" with `expected 'failed' to be
  'succeeded'`, the same failure as CI run 41510960129.
- `authz-parity-agent-run.db.integration.test.ts`: 6 of 6 pass.
- Tripwire "the agent-run worker exempts only development principals from binding": 6 of 6
  wiring cases pass. Each of three mutations of the worker makes exactly that case fail
  (1 failed / 5 passed): a second exemption (`&& type !== 'api_key'`), a widened condition
  (`|| Boolean(payload.userId)`) and no exemption at all.
- All DB integration suites (`vitest --run integration` with the env of CI job
  `db-integration`): 642 of 643 pass in 63 files. The one failure is
  `g3-dispatch-reliability` › "R3: two concurrent dispatch passes…" (`expected +0 to be 1`),
  the known flake B126; that file then passed 19 of 19 in three separate runs.
- Full `apps/cms` run (no `DATABASE_URL`, so DB suites self-skip; `user-enum.timing.test.ts`
  excluded for local load): 382 files passed, 46 skipped; 3918 tests passed, 289 skipped,
  0 failed.
- `pnpm typecheck` 18 of 18 tasks; `pnpm check:all` exit 0; docs pair re-stamped
  `--verified` (36 claims), parity 0 problems, `docs:i18n:detect` 158 of 158 up to date.

All values are synthetic canaries. No model is involved, so no repeat counts apply.

## 7. Residual / not covered

- **Reconciler runs execute with a system ItemService (B178).** Their authority is the intent and the
  agent role, which the harness enforces; there is no principal whose row/field rules could
  apply. This is a declared posture, not a defect. Narrowing it would need a per-role
  permission context (design decision) and is not proposed here.
- **Legacy capability-snapshot jobs** (enqueued before `principal` existed) keep the system
  posture until the queue drains, as in the Copilot worker.
- **Tool discovery** (`tools/list`, `GET /agent/tools`) lists every enabled tool regardless of
  the caller's capabilities. It grants nothing; execution is checked per call.
- **Standalone MCP REST passthroughs** inherit REST authorization and were not re-tested here;
  their coverage gaps are tracked in B70 (#454).
- **Live models:** not used (see header).

## 8. Acceptance criteria of #580

| Criterion | Status |
|---|---|
| Inventory and matrix identify enforcement points and justified transport differences at an exact commit | done (§1–§3, `b12e9385`) |
| Positive/negative integration tests cover every supported route and prove no unauthorized reads/writes | done for the queued Agent API path (new suite); other transports covered by the existing suites in §5 |
| Revocation between planning, approval and execution is enforced; failed authorization leaves no partial side effects | done: pickup re-resolution (new revocation case), approval re-resolution (#472 suites); F1 closes the row/field half at execution |
| Reuse existing evidence; fix only confirmed remaining gaps with regression coverage | F1 fixed with a negative-checked DB suite; no other gap confirmed |
