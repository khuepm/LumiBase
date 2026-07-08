---
version: 1
lastUpdated: 2026-06-23T13:05:48.000Z
sourceLang: vi
translatedFrom: vi
sourceHash: b070858cd46928df
mtEngine: claude
syncStatus: machine-translated
---

# Architecture Overview

## 1. Layer diagram

```
┌──────────────────────────────────────────────────────────────────┐
│ Clients (client applications)                                    │
│  - apps/studio    (React + Vite + TanStack Router) — admin UI    │
│  - apps/consumer  (Next.js)  — delivery demo                     │
│  - apps/docs      (Vite SPA) — documentation site                │
│  - apps/landing   (Next.js)  — public home page                  │
│  - third-party SDK / SCIM / webhooks                             │
└───────────────▲──────────────────────────────▲───────────────────┘
                │ REST + Hydration             │ WSS realtime
┌───────────────┴──────────────────────────────┴───────────────────┐
│ apps/cms — Hono.js                                               │
│   Two entrypoints:                                               │
│     • src/index.ts  → Cloudflare Workers (wrangler dev/deploy)   │
│     • src/serve.ts  → Node.js / Docker (@hono/node-server)       │
│                                                                  │
│ Routers:                                                         │
│   /auth            (Logto OIDC)                                  │
│   /collections /fields /relations  (schema admin)                │
│   /items/:collection                (CRUD content)               │
│   /typegen                          (TS types from schema)       │
│   /permissions /roles /policies                                  │
│   /users /teams                                                  │
│   /files /media /assets             (R2 / S3-MinIO storage)      │
│   /presets /bookmarks /translations                              │
│   /settings /extensions /webhooks /activity                      │
│   /flows /marketplace /materialize  (POST-GA)                    │
│   /search                           (MeiliSearch)                │
│   /tm                               (Translation Memory)         │
│   /ai                               (AI Copilot + Agent Harness)  │
│   /admin/backup /admin/restore      (config GitOps)              │
│   /deliver/page/:slug               (1-roundtrip)                │
│   /realtime                         (WS upgrade)                 │
│   /metrics                          (Prometheus)                 │
│   /health                           (liveness probe)             │
│   /scim/v2/*                        (SCIM 2.0 provisioning)      │
│                                                                  │
│ Middleware order:                                               │
│   logger → metrics → runtime → cors → tenant → auth → db → rls   │
│                                                                  │
│ Services:                                                        │
│   SchemaService, PermissionService, ItemService, RevisionService,│
│   ActivityService, ExtensionRuntime, FlowService, AISecureHarness│
│   TranslationMemory, CursorProtocol, Validation, Conditions,     │
│   CryptoService (per-field encryption), Template, Typegen        │
└───────────────▲──────────────────────────────▲───────────────────┘
                │ DatabaseProvider             │ Cache/Storage/Queue/Search/Media
                │                              │
┌───────────────┴──────────┐      ┌────────────┴────────────────────┐
│ Postgres                 │      │ @lumibase/runtime adapters       │
│  - Hyperdrive (CF mode)  │      │  Cloudflare      | Docker        │
│  - pg pool   (Docker)    │      │  ─────────────── | ────────────  │
│ packages/database        │      │  KV              | Redis         │
└──────────────────────────┘      │  R2              | MinIO/S3      │
                                  │  CF Queues       | BullMQ        │
                                  │  MeiliSearch     | MeiliSearch   │
                                  │  CF Image Resize | Imgproxy      │
                                  │  Durable Objects | (host process)│
                                  └──────────────────────────────────┘
```

## 2. Monorepo structure

```
lumibase/
├── apps/
│   ├── cms/                  # Hono API — runs on Workers AND Node/Docker
│   │   └── src/
│   │       ├── routes/       # /collections, /items, /ai, /flows, /search, ...
│   │       ├── services/     # SchemaService, AISecureHarness, FlowService, ...
│   │       ├── middleware/   # auth, db, logger, rls, runtime, tenant
│   │       ├── realtime/     # SiteRoom (Durable Object) — CF only
│   │       ├── extensions/   # runtime loader + sandbox
│   │       ├── index.ts      # Cloudflare Workers entrypoint
│   │       └── serve.ts      # Node/Docker entrypoint
│   ├── studio/               # React + Vite admin SPA
│   │   └── src/
│   │       ├── modules/      # content, data-model, access, automation, files,
│   │       │                 # users, settings, translations
│   │       ├── components/   # AppShell, AI Assistant, presence, ...
│   │       ├── interfaces/   # field interfaces registry
│   │       ├── displays/     # field displays registry
│   │       ├── layouts/      # tabular/cards/kanban/calendar/map
│   │       └── lib/          # api client, ws client, policy eval, use-permissions
│   ├── consumer/             # Next.js delivery demo
│   ├── docs/                 # Vite docs viewer (this site)
│   └── landing/              # Next.js landing page
├── packages/
│   ├── database/             # Drizzle schemas + migrations
│   │   └── src/schema/       # core, access, cms, platform, ai
│   ├── runtime/              # Abstraction layer (CacheProvider/Storage/...)
│   │   └── src/adapters/     # cloudflare/, docker/
│   ├── ai-skills/            # CORE_SKILLS registry for AI Copilot
│   ├── shared/               # types, zod schemas, policy DSL, field DSL
│   ├── ui/                   # shadcn + cva tokens
│   ├── sdk/                  # JS SDK (REST+WS) for clients/extensions
│   └── extension-sdk/        # types + helpers for extension developers
├── docker/                   # Dockerfile, docker-compose.{yml,monitoring,prod}
│   ├── prometheus/  grafana/ scripts/
└── docs/
```

## 3. Main logic layers (apps/cms)

1. **Schema layer** — manages `collections`, `fields`, `relations`, producing a "virtual schema" in the cache.
2. **Item layer** — generic CRUD based on the virtual schema; builds Drizzle queries dynamically. Supports `materialized_collections` for the hot path.
3. **Permission layer** — evaluates the Policy DSL before each action; returns a **field mask** (read/write).
4. **Delivery layer** — public endpoints, applying the "public" role's permissions + cache-tag.
5. **Realtime layer** — a Cloudflare Durable Object per `site_id` (in `cloudflare` mode); broadcasts normalized events. It has a protocol for **collaborative cursors** (CRDT-lite, last-write-wins + a Y-style update vector).
6. **Extension layer** — loads the manifest, mounts routes/hooks/UI into the registry; gated by capability. Integrates a signed Marketplace.
7. **AI layer** — `AISecureHarness` evaluates risk, checks capability, and gates HITL for dangerous skills. Skills are declared in `@lumibase/ai-skills`. This is the current seed of the Agent Harness Layer.
8. **Flows layer** — a graph of operations (condition, transform, http, mail, log, sleep, run-extension, item.*, notify) run on triggers (webhook, event, schedule, manual).
9. **Search layer** — pushes/syncs the index to MeiliSearch when an item changes; auto re-indexes via the queue.
10. **Translation Memory layer** — TM + glossary + an MT provider chain (DeepL, OpenAI, Workers AI, echo fallback).


## 3.1. Agent Harness Layer

LumiBase extends the traditional CMS model into a control plane for AI Agents. Agents do not call the API directly from a free-form prompt; every run goes through the harness to normalize input/context/permissions, observe output, log, block risks, and enable replay/retry.

```text
User / Admin
   ↓
LumiBase Studio + API
   ↓
CMS Layer: Schemas, Roles, Policies, Content, Files, Flows
   ↓
Agent Harness Layer: Goals, Runs, Plans, Tools, Memory, Approvals, Evaluations
   ↓
AI Agents + Tool Registry + Extensions + External APIs
   ↓
App Generation Layer: Pages, Components, Datasets, Configs, Prompts, Migrations, API Specs
```

The standard execution lifecycle:

```text
Goal → Context package → Plan → Tool calls → Validation/Evaluation
→ Human approval if needed → Commit artifact/result → Audit trail + Memory update
```

The current implementation already has `AISecureHarness`, backward-compatible `ai_approvals`, first-class `agent_goals`, `agent_runs`, `agent_tool_calls`, `agent_artifacts`, `agent_evaluations`, `agent_approvals`, memory, a tool registry, and an app-generation MVP. Repeatedly failing runs are pushed to `agent-dead-letter` when the runtime queue adapter is available; Prometheus/Grafana track run status, approval latency, tool latency, eval fail rate, and token/cost estimate. The detailed blueprint is in [Agent Harness Layer](../features/agent-harness-layer.md).

## 4. Caching & cache invalidation

- Cache keys: `schema:{site}:{collection}`, `perm:{site}:{role}:{collection}`, `settings:{site}` — via `CacheProvider` (KV on Cloudflare, Redis on Docker).
- Tag-based: each item writes a `item:{site}:{collection}:{id}` tag; a mutation emits an event → invalidate the cache + revalidate the Next.js tag (via a webhook to `apps/consumer`).
- WebSocket emits the same event ⇒ the realtime client and the cache stay in sync.

## 5. Runtime abstraction layer (Cloudflare ↔ Docker)

`@lumibase/runtime` defines 6 interfaces:

| Interface | Cloudflare adapter | Docker adapter |
|-----------|--------------------|----------------|
| `CacheProvider` | Cloudflare KV | Redis (ioredis) |
| `StorageProvider` | R2 | S3-compatible MinIO (`@aws-sdk/client-s3`) |
| `DatabaseProvider` | Hyperdrive connection | pg pool (`postgres`) |
| `SearchProvider` | MeiliSearch Cloud (HTTP) | MeiliSearch (self-host) |
| `QueueProvider` | Cloudflare Queues | BullMQ on Redis |
| `MediaProcessor` | CF Image Resizing | Imgproxy (signed URLs) |

The `createRuntime(env)` factory in `packages/runtime/src/factory.ts` chooses the adapter by `env.LUMIBASE_RUNTIME` (`cloudflare` | `docker`). The `withRuntime()` middleware injects a `RuntimeContext` into `c.set('runtime', ...)`. Every route + service reads through `c.get('runtime').<provider>`.

See [features/runtime-abstraction.md](../features/runtime-abstraction.md) for details.

## 6. Multi-tenancy

- `site_id` is passed via subdomain or the `X-Lumi-Site` header.
- The `withTenant()` middleware sets `c.set('siteId', …)` and injects it into every service.
- The Drizzle helper `scopeSite(siteId)` wraps the query builder to force the filter.
- The `withRls()` middleware sets a Postgres session var to apply additional RLS policies.

## 7. Security

- Logto JWT validated at the edge (JWKS cached via `CacheProvider`).
- CSRF for Studio (same-origin + token).
- Per-field encryption (AES-GCM, key in a Workers Secret or env var) for fields flagged `sensitive: true`.
- Extensions run in an **isolated module** (dynamic import from R2/S3), constrained by the capability manifest. Marketplace bundles must have a valid ed25519/RSA-PSS signature.
- A separate SCIM token (`SCIM_TOKEN` env), not using the Logto JWT pipeline.
- AI HITL: dangerous skills (capability `schema:write` or a name starting with `delete`) must go through `ai_approvals`; the Agent Harness extends this same principle to plan/tool/artifact approval.

## 8. Observability

- **Cloudflare**: Workers Logpush (JSON logs) + Workers Analytics Engine (metrics).
- **Docker**: the `/metrics` Prometheus endpoint + Loki/Promtail for logs + a pre-provisioned Grafana dashboard (request rate, latency p50/p95/p99, error rate, queue depth, cache hit ratio).
- The Activity table for business audit.
- The `/health` health check tests connectivity to the DB, cache, search, storage, and queue.

See [features/observability.md](../features/observability.md) for details on the monitoring stack.
