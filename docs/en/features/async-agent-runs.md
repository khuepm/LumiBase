---
version: 2
lastUpdated: 2026-10-08T14:15:38.469Z
sourceLang: en
contentHash: f7df31416aa1c0f0
codeVerified: 2026-10-08T14:15:38.469Z
codeVerifiedHash: f7df31416aa1c0f0
codeVerifiedClaims: 6
---

# Asynchronous agent runs

`POST /api/v1/agent/goals` accepts `execution: "async"`, a `task` containing
`skillName` and `arguments`, and a `budget`. It returns `202` with a queued run.
The queue payload carries the budget and the principal reference; the worker
resolves current capabilities when it receives the job. A missing queue binding
returns `400 ASYNC_UNAVAILABLE` before a goal or run is created.

## Cloudflare setup

`apps/cms/wrangler.toml` pairs an `AGENT_RUNS_QUEUE` producer with a consumer in
all five profiles. The runtime maps that binding to the logical queue
`agent-runs`; it does not fall back to the realtime queue.

| Profile | Queue |
| --- | --- |
| Local/default | `lumibase-agent-runs-local` |
| staging | `lumibase-agent-runs-staging` |
| production | `lumibase-agent-runs-production` |
| dev | `lumibase-agent-runs-dev` |
| demo | `lumibase-agent-runs-demo` |

Before deploying a named profile, provision its queue if it does not exist.
For production, run from `apps/cms`:

```bash
pnpm exec wrangler queues create lumibase-agent-runs-production
pnpm run deploy:production
```

Each consumer uses a batch size of 1, a batch timeout of 1 second, three retries,
and a dead-letter queue with the `-dlq` suffix. Monitor the dead-letter queue;
failed delivery does not prove that an interrupted skill had no side effects.
The queue handler needs `HYPERDRIVE`; local development may use `DATABASE_URL`
when `LUMIBASE_ENV=development`. Configure the same LLM and encryption secrets
used by synchronous execution. The worker receives cache, search, queue and key
providers from the Cloudflare runtime.

## Execution and recovery

`apps/cms/src/cloudflare.ts` exports the queue handler. It awaits each message
before acknowledging it and retries only messages whose processing throws.
Malformed messages also follow the bounded retry/dead-letter path. Logs identify
the queue and message, without copying tool arguments or credentials.

The shared worker atomically claims only a `queued` run. Repeated delivery of an
already claimed, cancelled or completed run does not repeat the skill. The
five-minute scheduled sweep quarantines stale `running` runs; operators must
inspect their tool calls before deciding whether to retry. Expected harness
outcomes such as denied execution or pending approval are persisted and the
message is acknowledged.

New jobs forward the saved budget. Older jobs missing a budget in their payload
fall back to the stored run budget. `maxToolCalls: 0` therefore blocks the first
tool call. Queue transport does not bypass capability or human-approval checks.

The shared `health_check` probe is acknowledged without running an agent or opening a database connection.

## Multi-tenancy

Queues and provider credentials are shared by the deployment. Each job retains
its `siteId`, run/goal identifiers, principal and governance limits. Database
operations in the shared worker remain tenant-scoped; principals are resolved
against the payload tenant. Queue bindings and names differ between deployment
profiles so staging cannot consume production jobs.

## Verification

Regression tests cover PATCH omission semantics, budget propagation and
execution, two-tenant isolation, per-message acknowledgement/retry, missing
bindings and provider parity. The PostgreSQL suite uses `DATABASE_URL` and must
run against a disposable test database:

```bash
pnpm -F @lumibase/cms exec vitest run src/services/__tests__/p1-governance.db.integration.test.ts
pnpm -F @lumibase/cms exec vitest run src/__tests__/cloudflare-agent-queue.test.ts
pnpm -F @lumibase/runtime exec vitest run src/__tests__/cloudflare-agent-queue.test.ts
```

A dry-run build verifies bundling and configuration. It does not verify that
production queues, secrets and Hyperdrive connectivity are provisioned.
