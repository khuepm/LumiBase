# #583 audit: model routing, provider fallbacks and cache isolation

- **Parent:** #577 (P1)
- **Audited commit:** `5a92d6ea` (`origin/main`, 2026-11-01)
- **Fix branch:** `feature/583-model-routing-cache-isolation`
- **Model:** none. Every result below is deterministic. No live model was called, so this
  report claims **no model-sensitive results**, no token counts and no provider costs.
- **Coordination:** authorization parity across transports is #580 (PR #595); token
  budgets and Copilot provider errors are #582 (PR #597, B182/B184); retrieval and
  embeddings are #581 (PR #596, B180). Cache/load evidence reused from
  `high-load-cache-readiness` (#342 lineage): `permission-cache-versioning.test.ts`,
  `permission-cache-revocation.integration.test.ts`,
  `permission-revocation.db.integration.test.ts`.

## 1. Routing and fallback matrix (audited commit)

There is no multi-provider routing. Each path resolves **one** provider from the
environment, and no path fails over to a second provider.

| Path | Resolver | Provider when unconfigured | Timeout | Retries | Output contract |
|---|---|---|---|---|---|
| Copilot `POST /ai/chat` (sync) and `ai-chat-runs` worker | `createLLMProvider` (`services/llm-provider.ts:747`) | **`EchoProvider` keyword matcher**, `console.warn` only (B186) | none in the app; no `signal` passed (B185) | 0 | tool calls → `AISecureHarness` |
| Generation skills (`completeJson`, `ai-harness.ts:385`), intent and constitution compilers | `createConfiguredLLMProvider` (`llm-provider.ts:856`) | `null` → `LLM_NOT_CONFIGURED` | none in the app (B185) | 0 | JSON parsed by caller; tools off since #579 |
| Decisions `/ai/decisions`, Jev reviews, Flows `ai:decision`, drift scan | `createDecisionProvider` (`decision-provider.ts:987`) | `null` → `DECISION_NOT_CONFIGURED` (no stub) | `DECISION_TIMEOUT_MS` 1–120 s deadline + `DECISION_ATTEMPT_TIMEOUT_MS` | `DECISION_MAX_RETRIES` 0–5 (Jev/OpenRouter); `llm` sends exactly 1 (`maxAttempts: 1`) | validated at the provider boundary (#508) |
| Embeddings | `createEmbeddingProvider` | no caller (B180) | — | — | — |

Supported providers: `openai`, `anthropic`/`claude`, `gemini`, `nvidia`, `vertex`,
`workers-ai`, `echo` (LLM); `typesafe`, `openrouter`, `llm` (decisions).

**Policy under fallback.** The only fallback is Copilot → echo. Echo returns tool calls such
as `deleteCollection`; they reach the same `AISecureHarness.execute` with the same
capability list, risk classification, HITL and kill switch as a real model's calls (tested
by the #578/#579 suites, which use a scripted model and therefore cover any provider). A
fallback cannot relax policy because no policy decision reads the provider. What the
fallback loses is correctness: a typo in `LLM_PROVIDER` silently turns Copilot into a
keyword bot (B186, owner decision).

**Retries are bounded** everywhere: 0 on the LLM paths, at most 5 on decisions, validated by
`readBound` (out-of-range values fall back to the default with a warning). The decision
tests (`decision-provider.test.ts`, `decision-budgets.test.ts`,
`decision-governance.test.ts`) passed on this branch (see §6). **Timeouts are not bounded**
on the non-decision paths (B185); choosing a default is an owner decision.

## 2. Cache inventory relevant to AI paths

| Cache | Key | Tenant | Principal | Invalidation | Verdict |
|---|---|---|---|---|---|
| Permission bundle (shared SWR + 5 s process layer) | `perm:{site}:v{n}:{principal}` | yes | **F1: role only when user + role** | `perm-ver:{site}` bump after every permission mutation | **fixed (F1, F2)** |
| Decision quota counters | `dq:{siteId}:…` | yes | per site | TTL windows | correct (existing tests) |
| Refusal-audit dedup | `dra:{siteId}:…` | yes | principal/IP hash | window TTL | correct (#564 tests) |
| Collection tombstones | `neg:{site}:collection:{name}` | yes | n/a (existence only) | `forgetNegative` on create | correct |
| Tenant existence | `site-exists:{site}` | yes | n/a | **`invalidateSiteExists` has no caller (B187)** | gap outside AI; AI paths verified safe |
| Review runs (idempotent replay) | DB unique `(site, principalType, principalId, idempotencyKey)` | yes | yes | stale view by content hash on read | correct (J05 tests) |
| LLM response / semantic cache | — | — | — | — | **N/A: none exists** |
| Embedding cache | — | — | — | — | **N/A: no retrieval runs (B180)** |

## 3. Findings

### F1: permission bundles shared across members of one role (fixed)

- **Severity: high.** `PermissionService.principalKey` returned `role:{roleId}` whenever
  the context carried a role, even when it also carried a user
  (`services/permission-service.ts`, audited lines 205–210). `compile()` reads
  user-specific inputs: `user_roles`, `user_policies` and the user's IP-guarded policies.
  `EffectiveCapabilityService.resolveUser` builds the context with **both** the user and the
  membership role (`effective-capability-service.ts:280–285`). That service resolves the
  grant for every governed AI path: Copilot tool calls (`routes/ai.ts`), MCP
  (`routes/mcp.ts`), the Agent API (`routes/agent.ts`), the `agent-runs` worker, approvals,
  automation, Jev reviews and Flows `ai:decision`. So within the 60 s entry TTL:
  - a member of role R inherited a policy granted directly to another member of R. With an
    admin policy that meant `controlPlaneAdmin: true` and admin bypass of row/field rules on
    the AI item path;
  - a share link for role R (`ShareService` builds `{ roleId: R }`) and the public role read
    the same entry, so an unauthenticated share visitor could get a member's bundle;
  - the reverse order narrowed the privileged member (denial).
  The window needs two members of one role, a user-level grant on one of them, and a second
  resolution within 60 s. That is ordinary on any site with per-user policies, so the
  rating is high. It does not cross tenants: the key always carries `siteId`.
- **Reproduction** (before the fix): Alice and Bob are both members of role `editor`; a
  policy with `admin_access` is attached to Alice in `user_policies`. Resolve Alice through
  `EffectiveCapabilityService` with a shared cache, then resolve Bob. Bob's grant has
  `controlPlaneAdmin: true` and his AI item service lists a collection outside his grant.
- **Fix:** the key names every identity input: `api_key:{id}`, `user:{id}`, `role:{id}`,
  joined with `|`; `anon` when none. Single-identity keys keep their old form, except that a
  bare user id becomes `user:{id}`. Old entries are no longer addressed and expire.

### F2: IP- and time-guarded policies served across requests (fixed)

- **Severity: medium.** `compile()` filters policies through `isPolicyActive(policy, ctx)`,
  which reads `ctx.ip` and `ctx.now`, but the result was cached under a key without either.
  A bundle compiled from an allowed address was served to the same principal from a denied
  address for up to 60 s, and a validity window ended up to 60 s late. Exploitation needs the
  principal's credential used from another address inside the window (stolen token, shared
  key), so the rating is medium. The reverse order wrongly denied the allowed address.
- **Reproduction:** attach a policy with `ip_allow: ['10.58.3.1']` that reads `secret` to
  Bob. Resolve Bob from `10.58.3.1` (granted), then from `10.58.3.2`: before the fix the
  second resolution still reads `secret`.
- **Fix:** `compile()` marks a bundle `contextBound` when any **candidate** policy (active or
  not) has an IP list or a validity window. A cached marked entry only records that fact;
  `bundle()` compiles for the current request instead of serving it, and reuses the
  compilation it just made on a miss. The marker is stripped before the bundle leaves the
  service, so `GET /permissions/me` is unchanged. Unguarded principals keep the cache.
  Version bumps still invalidate the marker.

### Evidence (F1, F2)

`apps/cms/src/services/__tests__/permission-cache-principal-scope.db.integration.test.ts`:
real Postgres, a real shared `MemoryCacheProvider` (the production SWR + process cache
path), real `ItemService` via `itemServiceForPrincipal`. 13 cases, all within the TTLs.

| Run | Result |
|---|---|
| with the fix | 13/13 pass |
| `principalKey` restored to the audited code | **5/13 fail**: 4 F1 cases + the key-format case |
| `contextBound` check removed | **3/13 fail**: the 3 F2 cases (two IP orders, validity window) |

The other cases pass on both reverts by design: concurrent resolution of two members (8
parallel calls), a deleted tenant denied while its bundle is cached, two-site isolation, the
marker never reaching a caller, and a removed grant taking effect after a version bump.

## 4. Controls verified correct (no change)

- **Revocation under cache** (Property P9): existing
  `permission-revocation.db.integration.test.ts` and
  `permission-cache-revocation.integration.test.ts` pass with the new key format; the new
  suite adds the user-policy case on the AI resolution path.
- **Tenant disablement:** sites are deleted, not disabled. After deletion,
  `EffectiveCapabilityService` re-reads the user and membership (or API key) from the DB, so
  a deleted tenant is refused (`PRINCIPAL_NOT_MEMBER`) even while its bundle is cached (new
  test case). The tenant-existence cache is not invalidated (B187); this does not reach the
  AI grant.
- **Content edits:** AI tool calls read and write through `ItemService` on live rows; no AI
  path caches content. Review runs compare the stored content hash with the current content
  on every read (J05 tests).
- **Configuration updates:** decision settings and the kill switch are read from the DB at
  call time (`decision-governance.ts`, `semantic-drift-scan.ts`), not cached.
- **Negative caching:** collection tombstones are site-scoped and principal-independent
  (existence only); create forgets them. No item tombstone exists (comment in
  `negative-cache.ts`).
- **Quota and refusal counters** are prefixed with `siteId` (`decision-governance.test.ts`,
  `decision-refusal-audit.test.ts`).

## 5. Workload

`apps/cms/eval/permission-cache/bench.ts` measures `EffectiveCapabilityService.resolve`, the
entry point of every governed AI call, against a real Postgres. Run:
`DATABASE_URL=… pnpm -F @lumibase/cms exec tsx eval/permission-cache/bench.ts 500`.
Local pg17 (Docker, ARM64 Mac, load average 23–37 during the runs), in-process cache, 500
resolutions after 20 warm-up, 3 runs:

| Scenario | p50 (ms) | p95 (ms) | p99 (ms) |
|---|---|---|---|
| no cache (compile every call) | 6.05–6.42 | 22.8–31.9 | 47.1–82.6 |
| cached, unguarded principal | 0.91–1.08 | 2.0–2.8 | 2.7–4.2 |
| cached, IP-guarded principal (compiled per request after F2) | 5.28–5.33 | 8.1–10.0 | 10.1–17.0 |

Threshold used for this report: a cached resolution's p95 must stay below an uncached
resolution's p50. It held in all 3 runs (2.8 ms < 6.05 ms). The guarded case pays the
compile on every request, as intended; only principals with IP or time guards pay it. The
cached figures exclude a Redis/KV round trip.

**Token use, cost and model latency: N/A.** No live model was called. The per-turn
Copilot tool-schema cost (~6 053 estimated tokens) is measured in #582 (B184); model
latency and cost need credentials and a cost decision (same as B173). No cache hit/miss
figure exists for model calls because there is no model-response cache.

## 6. Verification

- New suite: 13/13 pass; revert counts in §3.
- Existing focused suites (permission*, share-service, cache-purge-scope,
  effective-capability, llm-provider, decision-provider, decision-budgets,
  decision-governance, decision-governance.wiring, site-membership, api-key-security):
  18 files, 311/311 pass.
- Typecheck, `pnpm check:all`, DB integration suites and the full `apps/cms` run: recorded in
  the PR body.

## 7. Not covered / residual

- **Timeouts on non-decision LLM calls** (B185, owner decision on a default).
- **Copilot silent echo fallback** (B186, owner decision).
- **Tenant-existence cache never invalidated** (B187, outside the AI scope).
- **Workers KV:** the version pointer is eventually consistent across colos; the 60 s entry
  TTL remains the documented bound there (unchanged).
- **Redis-backed latency** and model latency/cost were not measured.

## 8. Acceptance criteria of #583

| Criterion | Status |
|---|---|
| Routing/fallback matrix identifies supported behavior and deterministic failure handling | done (§1). Unconfigured decisions and generation fail loud; Copilot falls back to echo (B186). |
| Automated tests prove no cross-tenant/principal cache leakage or stale authorization/content results | done for the permission cache (F1, F2 fixed; §3, §4). Content is not cached on AI paths. |
| Failure injection proves retries are bounded and fallback never relaxes required policy | retries bounded (existing decision tests, 0 on LLM paths); fallback goes through the harness (§1). Timeouts unbounded on non-decision paths: **partial**, B185. |
| Reproducible workload reports latency percentiles, token/cost estimates and thresholds; confirmed gaps fixed | latency percentiles and threshold for capability resolution (§5). Token/cost: **N/A without a live model** (B184/B173). |


## Completion verification (2026-11-08)

On base `a59d11c9`, six network adapters receive one bounded 20-second deadline through body consumption. Earlier caller cancellation survives. Ordinary chat performs no repair retry or provider switch on an outage. The permission-cache tests prove positive and negative cache isolation and grant invalidation. Content samples are queried per request; there is no model-output cache to invalidate on content or provider configuration changes. Tenant, role and approval controls remain on the execution path.

`apps/cms/eval/model-routing/baseline.v1.json` records the actual local workload of 120 requests per scenario. Success p50/p95/p99 were 0.084/0.498/0.895 ms, outage 0.163/0.466/2.192 ms, echo 0.001/0.005/0.012 ms. Threshold p95 <100 ms catches a large local overhead regression. Input/output token counts were synthetic (11,520 / 1,440 cumulative on successes). At explicit illustrative $2/$8 per million, estimated total was $0.03456. Errors and echo record unknown usage/cost. See §5 for the independent real-DB authorization/cache measurements. This does not measure live provider speed or invoices.
