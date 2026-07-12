---
description: LumiBase CDC & performance runbook — implement the Change Feed spec, operate CDC pipelines/subscriptions, and diagnose/tune caching, indexing, materialization. Activate when working on CDC, change events, webhooks/outbox, cache invalidation, search indexing, materialization, or edge/performance tuning.
argument-hint: [phase|topic] e.g. "feed A", "dispatcher", "cache", "operate", "perf" (optional)
allowed-tools: Bash, Read, Edit, Write, Grep, Glob
---

# /cdc — LumiBase CDC & performance runbook

You are working on **Change Data Capture and performance** in LumiBase. The focus is: **$ARGUMENTS**

If `$ARGUMENTS` is empty, ask the user which track they want — **implement** (build the Change Feed spec), **operate** (register/monitor CDC pipelines & subscriptions), or **perf** (diagnose/tune caching, indexing, materialization) — then proceed. Do not guess a large scope.

> This repo has **two distinct CDC surfaces** — do not conflate them:
> 1. **ClickHouse CDC control plane** (shipped) — `.kiro/specs/clickhouse-cdc/`, `apps/cms/src/modules/cdc/{routes.ts,connectors/,registry/,health-monitor.ts}`. Provisions **external** Postgres→ClickHouse replication (Debezium/Kafka, MaterializedPostgreSQL, Airbyte). Not a first-party content-event feed.
> 2. **CDC Extension Integration / Change Feed** (spec, not yet implemented) — `.kiro/specs/cdc-extension-integration/`. A first-party **transactional outbox + relay** over LumiBase content mutations (pull cursor API, HMAC webhooks, sandboxed extension subscribers).

## Step 0 — Orient (ALWAYS run first)

Read the sources of truth before touching code:
```bash
# Spec (the plan + invariants)
ls .kiro/specs/cdc-extension-integration/                     # requirements.md, design.md, tasks.md
sed -n '1,40p' .kiro/specs/cdc-extension-integration/tasks.md # phases, dependency graph, done/pending
grep -cE '^\s*- \[[ x]\]' .kiro/specs/cdc-extension-integration/tasks.md

# Existing CDC code map
ls apps/cms/src/modules/cdc apps/cms/src/modules/cdc/connectors
sed -n '1,30p' packages/database/src/schema/cdc.ts            # table names (lumibase_ prefixed, ADR-010)

# Non-negotiables + release gates
sed -n '1,60p' CLAUDE.md
cat .kiro/steering/definition-of-done.md
```

State to the user: which surface you're on (control plane vs Change Feed), the tasks.md done/pending count, and the track (implement/operate/perf).

## Guardrails (apply to every change — from CLAUDE.md + ADRs)

1. **IDs**: `nanoid()` for domain tables, `uuidv7()` for audit/append-only (the outbox `lumibase_cdc_change_events` and `lumibase_cdc_deliveries` use uuidv7 — the id doubles as the cursor).
2. **Multi-tenancy**: every table has `site_id`; every query `.where(eq(table.siteId, siteId))`; new tables added to `packages/database/migrations/rls-policies.sql` (site_isolation). Two-site smoke test is mandatory (DoD §2b).
3. **Table naming (ADR-010)**: physical names are `lumibase_`-prefixed (`lumibase_cdc_*`); Drizzle exports stay camelCase; index literals are NOT prefixed.
4. **Runtime abstraction**: never import CF bindings in business logic — queue/cache/schedule go through `c.get('runtime')` (`packages/runtime`: `QueueProvider`, `CacheProvider`). Everything must run on both Cloudflare Workers and Docker/Node.
5. **HITL**: any AI skill with mutating `schema:*` capability, `dangerous: true`, or a name starting with `delete` is auto-classified control-plane by `isControlPlaneSkill` (`apps/cms/src/services/ai-harness.ts`) → routes through `ai_approvals`. Keep `deleteCdcSubscription` in that class.
6. **Response format**: `{ data, meta? }` / `{ errors: [...] }`. TypeScript strict, `import type`, no `any`.
7. **Secrets**: `webhooks.secret` write-only (never returned via API); mask secret/PII in logs, audit, and delivery `errorMessage`; mask `fields.classification` `pii`/`phi` BEFORE writing the outbox payload.

## Track A — Implement the Change Feed spec

Drive `.kiro/specs/cdc-extension-integration/tasks.md` in dependency-graph order (the `## Task Dependency Graph` waves at the bottom). Do NOT jump ahead of a wave.

1. **Pick the next wave** from the graph; read the referenced requirements (`Req n`) and design sections (`§n`, correctness Properties §12) for each task before coding.
2. **Phase A (schema + Zod)**: add `cdcChangeEvents`/`cdcSubscriptions`/`cdcDeliveries` to `packages/database/src/schema/cdc.ts` (prefixed names, uuidv7/nanoid PKs), export from schema barrel, then:
   ```bash
   pnpm -F @lumibase/database db:generate   # produces the next incremental migration on top of 0000_lumibase_init
   ```
   Add the 3 prefixed table names to `rls-policies.sql`. Add Zod schemas to `packages/shared/src/schemas/cdc-feed.ts` + barrel.
3. **Phase B (capture)**: `outbox-writer.ts` writes one Change_Event in the mutation transaction (fallback: write-after-mutation + audit warning on HTTP driver). Site-flag cache to skip sites with no subscriber. Never block or fail the mutation.
4. **Phases C–H**: pull API + subscriptions → dispatcher + webhook (HMAC-SHA256 via WebCrypto, `validateOutboundUrl`, cursor advances only on 2xx) → extension subscriber (sandbox, capability-filtered) → retention/replay → tenancy/AI-skills/MCP → Studio + docs.
5. **Each property task** = one `fast-check` test (≥100 iterations), tag `Feature: cdc-extension-integration, Property {N}: {title}`.
6. **At every checkpoint task**, run and require green:
   ```bash
   pnpm typecheck
   pnpm -F @lumibase/cms test
   ```
7. **Before marking any task done**, run the DoD checklist (`.kiro/steering/definition-of-done.md`) — especially update the Setup Impact Registry row (`.kiro/specs/admin-setup-wizard/setup-impact.md`, row #45) and flip `pending`→`done` when shipped. Tick the `[ ]`→`[x]` box in tasks.md.

## Track B — Operate CDC (control plane + feed)

- **ClickHouse CDC pipelines** (`/api/v1/cdc/*`, admin-gated): register a pipeline (connector type + encrypted source/sink/intermediary), start/stop, health, metrics. Deletion drops the Postgres replication slot before removing the registry row — never orphan a slot (`registry/pipeline-registry.ts`). Use the recommender (`recommender.ts`) to pick Debezium/Materialized/Airbyte by volume+latency.
- **Change Feed subscriptions** (once implemented): create `pull`/`webhook`/`extension` subscriptions, watch lag, `POST .../replay` within the retention window, `POST .../dispatch` on-demand when no queue adapter. `dead`/`stale` subscriptions emit notifications; resume only via explicit replay/reset.
- Prefer editing via the injected-services pattern and the `InMemory*` deps used in tests — never hit live infra in unit tests (see `apps/cms/src/__tests__/cdc-*.test.ts`).

## Track C — Performance playbook (my-judgment scope)

CDC's cache-invalidator is itself a performance feature; the same reasoning applies to the broader perf surface. When diagnosing/tuning, work through these in order:

1. **Tag-based cache invalidation (ADR-004)** — `docs/en/architecture/decisions/adr-004-tag-based-cache-invalidation.md`, `apps/cms/src/services/delivery-cache.ts`. Confirm reads are cached with correct tags and writes invalidate the right tags; a CDC change event should map to a tag/key invalidation, not a full flush.
2. **Cache layers** — `delivery-cache.ts` (content delivery), `process-cache.ts` (per-process), `domains/host-cache.ts` (host→site resolution). All keys MUST be tenant-prefixed with `siteId` (multi-tenant isolation). Verify TTLs and that CF (KV) and Docker (Redis) adapters behave identically via `packages/runtime`.
3. **Search indexing** — `content-indexing-worker.ts` rides `QueueProvider`; index names are `{siteId}__{collection}`. A CDC subscriber is a natural driver for incremental reindex. Check the worker is registered in `serve.ts` (jobs enqueued with no consumer = silent staleness).
4. **Materialization** — `materialize-service.ts` creates physical `mat_*` tables (Phase-2). Heavy; verify it is `siteId`-scoped and does not collide with `lumibase_`/user tables.
5. **Runtime queue** — `QueueProvider` (BullMQ on Docker, CF Queues on Workers). For dispatch/backfill work, dedup keys must be tenant-prefixed; a sweep (scheduler pattern) is the correctness backstop, the queue is only latency optimization.
6. **Report**: for any perf change, state the before/after signal you measured (cache hit rate, replication lag, events/sec, reindex latency) — don't claim a speedup you didn't observe.

## MCP & Harness integration (when adding agent-facing surface)

- **MCP**: expose new REST endpoints as MCP tools in `packages/mcp-server/src/tools/cdc.ts` (`registerCrud` for `/cdc/subscriptions`, `registerTool` for `/cdc/events` + `/replay`), wired into `registerAllTools`. Tools are REST passthrough via `LumiBaseClient` — they inherit the route's capability guard + HITL, so agents cannot bypass.
- **AI skills**: declare in `packages/ai-skills/src/skills.ts` with `requiredCapabilities` (`cdc:subscribe` / `cdc:manage`) and rely on the `delete`-prefix rule for `deleteCdcSubscription` → HITL. After editing `ai-harness.ts` or `packages/ai-skills/`, update `docs/en/ai-skills.md` and `docs/en/features/agent-harness-layer.md` (a PostToolUse hook reminds you).

## Finish

Report: which tasks moved `[ ]`→`[x]`, checkpoint/test results (with output, not just "passed"), DoD + Setup Impact status, and anything still pending. Do not open a PR unless asked; commit to the working branch with a clear `feat(cdc:…)` / `docs(cdc:…)` message.
