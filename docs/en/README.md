---
version: 1
lastUpdated: 2026-06-23T13:03:22.000Z
sourceLang: vi
translatedFrom: vi
sourceHash: eefbd2c6ae81722e
mtEngine: claude
syncStatus: machine-translated
---

# LumiBase Documentation

Technical documentation for LumiBase — an Edge-native **Content Operating System (Content OS)**: where AI agents *operate* content while humans set intent, define taste, and hold ultimate accountability. **Runs on both Cloudflare Workers and self-hosted Docker** through a shared runtime abstraction layer.

> As of **v0.5.0**, LumiBase is redefined from a *Content Management System* → a *Content Operating System*: the unit of work is **intent (intent/SLO)**, content is **continuously reconciled** toward the desired state, agents earn **autonomy by level (L0–L4)**, and every byte of content has **provenance**. See [ai-native-vision.md](./ai-native-vision.md).

> Goal: surpass Directus in **No-code Collection Builder**, **field-level / JSON-policy Permissions**, a **Raw editor for every field**, a **safe Extension SDK (with a signed Marketplace)**, **Display Templates**, **Realtime WebSocket**, and an **AI-First Copilot (HITL)** — while keeping LumiBase's Edge-native, Multi-tenant DNA but allowing self-hosting on Docker when needed.

## Quick start

- [getting-started.md](./getting-started.md) — Bootstrap a new LumiBase project with `npm create lumibase@latest` (the `create-lumibase` CLI), from an empty folder to a running server (Docker or Cloudflare Workers).

## Tutorials

- [tutorials/index.md](./tutorials/index.md) — Catalog of end-to-end tutorials for newcomers.
- [tutorials/nextjs-quickstart.md](./tutorials/nextjs-quickstart.md) — **Render LumiBase content in a Next.js app**: run the CMS locally, create a `posts` collection, then fetch & render with plain `fetch` or `@lumibase/sdk`.

## Agent Setup (for AI agents)

- [agent-setup/index.md](./agent-setup/index.md) — The hub page for setting up AI agents for LumiBase.
- [agent-setup/prompt.md](./agent-setup/prompt.md) — Machine-readable instructions for agents to fetch and execute directly.
- [agent-setup/claude-code.md](./agent-setup/claude-code.md) · [cursor.md](./agent-setup/cursor.md) · [github-copilot.md](./agent-setup/github-copilot.md) · [codex.md](./agent-setup/codex.md) · [windsurf.md](./agent-setup/windsurf.md) — Per-agent guides.
- [llms.txt](../llms.txt) — Index of all docs for LLMs. [en/llms.txt](./llms.txt) — Index of the English docs.

## Documentation structure

- **Vision & Positioning**
  - [vision-and-positioning.md](./vision-and-positioning.md) — Comparison with Directus, LumiBase's USP positioning.
  - [ai-native-vision.md](./ai-native-vision.md) — The Content OS vision: redefining the CMS for the AI era (intent-driven, reconciliation, trust gradient, multi-agent, mission control).
- **Architecture**
  - [architecture/overview.md](./architecture/overview.md) — Overall tech stack, layers, modules, runtime abstraction.
  - [architecture/page-hydration.md](./architecture/page-hydration.md) — The page-hydration API contract.
  - [architecture/decisions/index.md](./architecture/decisions/index.md) — Architecture Decision Records (ADR-001 through ADR-008).
- **Data model**
  - [data-model.md](./data-model.md) — Core schema (sites, collections, fields, relations, permissions, presets, translations, files, revisions, activity, webhooks, extensions, **flows, ai_approvals, materialized_collections, translation_memory, glossary**).
- **Core features** (`features/`)
  - [collections-builder.md](./features/collections-builder.md) — No-code Collection Builder.
  - [field-types-and-config.md](./features/field-types-and-config.md) — The field-types system & interface/display config.
  - [permissions-rbac.md](./features/permissions-rbac.md) — Roles, Policies, Permissions down to the field (a JSON rule engine).
  - [access-manifest-v1.md](./features/access-manifest-v1.md) — JSON schema contract `lumibase.access@v1` for access import/export.
  - [system-collections-access.md](./features/system-collections-access.md) — System/sensitive collection grouping for seeding and Permission Builder.
  - [raw-data-editing.md](./features/raw-data-editing.md) — A Raw editor for every field.
  - [user-management.md](./features/user-management.md) — User management, invitations, SSO/Logto.
  - [extensions-system.md](./features/extensions-system.md) — The extension SDK + sandbox permissions.
  - [system-config.md](./features/system-config.md) — The config system (settings, env, theming, modules).
  - [bookmarks-presets.md](./features/bookmarks-presets.md) — Bookmarks/Presets for the list view.
  - [translations-i18n.md](./features/translations-i18n.md) — Field/UI/content multilingual support.
  - [display-templates.md](./features/display-templates.md) — Display templates (listing + detail).
  - [websockets-realtime.md](./features/websockets-realtime.md) — Realtime subscribe/publish + presence + collaborative cursors.
  - [typegen.md](./features/typegen.md) — Generate `lumibase-types.ts` (schema → TypeScript), like Directus.
  - [cloudflare-auth.md](./features/cloudflare-auth.md) — Logto/Cloudflare auth integration.
- **Content OS (v0.5 — AI-native)** (`ai-native-vision.md` + `.kiro/specs/content-os/`)
  - [ai-native-vision.md](./ai-native-vision.md) — The vision & 7 principles: intent-driven, reconciliation loop, trust gradient (L0–L4), tenant constitution, provenance-first, multi-agent newsroom, Studio as Mission Control.
  - [.kiro/specs/content-os/requirements.md](../../.kiro/specs/content-os/requirements.md) — 17 EARS requirements (provenance, real skills, queued runs, MCP server, content intents/SLO, trust ledger, veto window, kill switch, constitution, agent org).
  - [.kiro/specs/content-os/design.md](../../.kiro/specs/content-os/design.md) — Architecture, new tables/columns (migrations `0019`–`0027`), the control loop, evaluator pinning.
  - [.kiro/specs/content-os/tasks.md](../../.kiro/specs/content-os/tasks.md) — 20 task groups across modules A–E.
- **Advanced features (POST-GA / Dual-runtime)** (`features/`)
  - [ai-copilot.md](./features/ai-copilot.md) — AI Chat + Human-in-the-Loop approvals (Studio Copilot).
  - [agent-harness-layer.md](./features/agent-harness-layer.md) — Agent goals, runs, tools, memory, approvals, artifacts, evaluations, and app generation governance.
  - [runtime-abstraction.md](./features/runtime-abstraction.md) — The `@lumibase/runtime` layer that allows running on Cloudflare and Docker.
  - [flows-automation.md](./features/flows-automation.md) — The Flows / Operations engine (workflow automation).
  - [marketplace.md](./features/marketplace.md) — Marketplace extensions with digital signatures (signed bundles).
  - [scim-provisioning.md](./features/scim-provisioning.md) — SCIM 2.0 user/group provisioning.
  - [search.md](./features/search.md) — Full-text search (self-hosted MeiliSearch or CF managed).
  - [translation-memory.md](./features/translation-memory.md) — Translation Memory + glossary + MT providers.
  - [materialized-collections.md](./features/materialized-collections.md) — Materialized read tables for the hot path.
  - [firebase-sync.md](./features/firebase-sync.md) — Sync content (`items`) to Firebase Firestore/RTDB in real time.
  - [deployment-integrations.md](./features/deployment-integrations.md) — Trigger, monitor, and debug Vercel/Netlify/HTTP deployments from Studio.
  - [observability.md](./features/observability.md) — Metrics, logs, dashboards (Prometheus/Grafana/Loki).
  - [ai-first-specification.md](./features/ai-first-specification.md) — The original specification for AI agents to implement (historical).
- **ClickHouse CDC** (`cdc/`)
  - [cdc/README.md](./cdc/README.md) — CDC overview + a table of criteria for choosing an approach (Debezium+Kafka / Materialized Engine / Airbyte).
  - [cdc/architecture.md](./cdc/architecture.md) — Architecture, system diagram, deployment topology.
  - [cdc/environment-variables.md](./cdc/environment-variables.md) — Environment-variable reference per approach.
  - [cdc/troubleshooting.md](./cdc/troubleshooting.md) — Handling replication-slot, connection, sync, and schema-drift errors.
  - Setup: [Debezium+Kafka](./cdc/setup-debezium-kafka.md) · [Materialized Engine](./cdc/setup-materialized-engine.md) · [Airbyte](./cdc/setup-airbyte.md).
  - Deployment: [Docker Compose / managed services](./cdc/deployment-docker-compose.md) · [Cloudflare Workers (edge only)](./cdc/deployment-cloudflare-workers.md).
- **SDK** (`sdk/`)
  - [sdk/index.md](./sdk/index.md) — SDK overview.
  - [sdk/javascript.md](./sdk/javascript.md) — The full JS/TS SDK (auth, items, files, realtime, AI Copilot, Flows).
  - [sdk/typegen.md](./sdk/typegen.md) — Generate TypeScript types from the live schema.
- **API**
  - [api/hono-api-spec.md](./api/hono-api-spec.md) — Standardized REST/WS endpoints with full request/response examples.
- **UI Studio**
  - [ui/README.md](../ui/README.md) — Spec for the redesigned Lumibase Studio and detailed screen specifications.
  - [en/ui/studio-ui-spec.md](./ui/studio-ui-spec.md) — Original page structure, modules, layouts, components, and state.
- **Deployment** (`deployment/`)
  - [deployment/overview.md](./deployment/overview.md) — Overview of the Cloudflare Workers, Cloudflare Pages, and Docker targets.
  - [deployment/cloudflare.md](./deployment/cloudflare.md) — Build/deploy commands for the CMS Worker and the docs Pages.
  - [deployment/docker.md](./deployment/docker.md) — Run the CMS API in Docker/self-hosted mode.
  - [deployment/private-admin-path.md](./deployment/private-admin-path.md) — Security rules for the private admin path and production no-redirect.
  - [deployment/environment-variables.md](./deployment/environment-variables.md) — Environment variables and bindings.
  - [deployment/local-development.md](./deployment/local-development.md) — Local dev workflow and pre-deploy checks.
- **Operations** (`operations/`)
  - [operations/upgrades.md](./operations/upgrades.md) — Fixed-version upgrade policy, Cloudflare/Docker flows, backup, migrations, and rollback limits.
- **Compliance & User Rights** (`compliance/`)
  - [compliance/README.md](./compliance/README.md) — Overview + rights × market matrix (EU/US/VN, Google/Apple) mapped to LumiBase. **Not legal advice.**
  - [compliance/user-rights-catalog.md](./compliance/user-rights-catalog.md) — Plain-language catalog of each right (right to be forgotten, access, portability, consent, unsubscribe, account deletion…).
  - Per-market: [EU GDPR/ePrivacy](./compliance/market-eu-gdpr.md) · [US CCPA/CPRA & CAN-SPAM](./compliance/market-us.md) · [Vietnam PDPD & content licensing](./compliance/market-vietnam.md) · [Google & Apple store policy](./compliance/provider-google-apple.md).
  - [compliance/gap-analysis.md](./compliance/gap-analysis.md) — Right ↔ LumiBase feature mapping (✅/⚠️/❌) + [implementation-checklist.md](./compliance/implementation-checklist.md).
- **Contributing** (`contributing/`)
  - [contributing/index.md](./contributing/index.md) — Setup, branching, commit conventions, PR checklist.
  - [contributing/code-style.md](./contributing/code-style.md) — TypeScript, naming, service patterns.
  - [contributing/testing.md](./contributing/testing.md) — Vitest unit, property-based, and integration tests.
  - [contributing/extension-dev.md](./contributing/extension-dev.md) — Build custom extensions (interface, display, operation, hook, endpoint).
- **Roadmap**
  - [roadmap/tasks.md](./roadmap/tasks.md) — Detailed task list by phase (Phase 0 → POST-GA + Dual-deployment + AI Copilot).
  - [roadmap/consumer-sdk.md](./roadmap/consumer-sdk.md), [roadmap/phase-d1-users.md](./roadmap/phase-d1-users.md), [roadmap/studio-content-slices.md](./roadmap/studio-content-slices.md).

## Monorepo apps & packages

- **`apps/cms`** — The Hono API, built for both Cloudflare Workers (Wrangler) and Node.js (Docker container).
- **`apps/studio`** — The admin SPA (React + Vite + TanStack Router). AI Copilot panel + Access Control + Content + Files + Settings + Translations + Users modules.
- **`apps/docs`** — A Vite docs viewer that serves this `docs/` on the web (port 5174 in dev).
- **`apps/landing`** — The Next.js landing page (`lumibase.dev`).
- **`apps/consumer`** — A Next.js demo consumer (delivery API + SDK usage example), replacing the old `apps/web`.
- **`packages/database`** — Drizzle ORM schema + migrations (Postgres).
- **`packages/runtime`** — The abstraction layer (CacheProvider, StorageProvider, DatabaseProvider, SearchProvider, QueueProvider, MediaProcessor) with two adapter sets (Cloudflare and Docker).
- **`packages/ai-skills`** — The skill registry for the AI Copilot (CORE_SKILLS) + OpenAI-compatible tool definitions.
- **`packages/shared`** — Types, zod schemas, the policy DSL, the field DSL.
- **`packages/sdk`** — The JS SDK (REST + WS + typegen).
- **`packages/ui`** — shadcn components + CVA tokens.
- **`packages/extension-sdk`** — Types and helpers for developers writing extensions.
- **`packages/create-lumibase`** — The bootstrap CLI (`npm create lumibase@latest`) that generates a new LumiBase project from a Docker or Cloudflare Workers template. See [getting-started.md](./getting-started.md).
- **`packages/mcp-server`** — The MCP stdio server (`@lumibase/mcp-server`) exposing tools for AI assistants to create/manage collections, fields, and items.

## Principles for reading the documentation

1. **Config-as-Code first**: every collection/field/permission can be exported/imported as JSON/YAML (see `apps/cms/scripts/config-cli.ts`).
2. **Multi-tenant**: every domain entity has a `site_id`, and every query/cache key includes `site_id`.
3. **Edge-friendly but not Cloudflare-locked**: business-logic code does not depend directly on KV/R2/Hyperdrive — it goes through `@lumibase/runtime` so it also runs on Docker.
4. **1-roundtrip**: the Studio and Delivery APIs prefer returning aggregated payloads.
5. **Backward-compat**: every schema change must go through the revision/migration system.
6. **HITL for AI**: dangerous AI actions (`schema:write`, `delete*`) must always go through the approval workflow in the `ai_approvals` table.
