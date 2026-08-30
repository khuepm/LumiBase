# LumiBase — Project Structure

Turborepo monorepo, pnpm workspaces (`pnpm-workspace.yaml`). Root version in `package.json` is the single source of truth for the release number (`pnpm version:sync` propagates it).

## Top level

| Path | Purpose |
|------|---------|
| `apps/` | Deployable applications |
| `packages/` | Shared libraries (`@lumibase/*`, `workspace:*` deps) |
| `docs/en/`, `docs/vi/` | Bilingual documentation — always edit both (CLAUDE.md rule #7) |
| `docker/` | Compose files for local infra + Docker deployment |
| `extensions/` | Git submodule for first-party extensions |
| `examples/` | Sample integrations |
| `scripts/` | Repo tooling (version sync, release env check, docs i18n, registry numbering) |
| `patches/` | pnpm `patchedDependencies` |
| `.kiro/specs/` | Feature specs (`requirements.md` / `design.md` / `tasks.md`) |
| `.kiro/steering/` | Always-on agent rules (this file, DoD, release criteria, backlog) |

## apps/

| App | Package | Stack / target |
|-----|---------|----------------|
| `cms` | `@lumibase/cms` | Hono API — the backend. CF Worker + Node.js |
| `studio` | `@lumibase/studio` | Admin SPA — React + Vite + Tailwind + Shadcn |
| `consumer` | — | Next.js reference frontend (page hydration pattern) |
| `docs` | `@lumibase/docs` | Docs site (CF Pages) |
| `landing` | `@lumibase/landing` | Marketing site, Next.js `output: 'export'` (static) |
| `marketplace` | `@lumibase/marketplace` | Extension marketplace site |
| `shell` | `@lumibase/shell` | Tauri 2 desktop/mobile wrapper around Studio |

### apps/cms/src

```
index.ts        ← Hono app entry, Cloudflare Workers export
serve.ts        ← Node.js entry (@hono/node-server), Docker path; registers queue consumers + cron
env.ts          ← env parsing/validation
config/         ← cors, limits, runtime config
middleware/     ← logger → metrics → runtime → cors → tenant → auth → db → rls
routes/         ← thin HTTP handlers, delegate to services
services/       ← business logic (ItemService, PermissionService, AISecureHarness, FlowService…)
modules/        ← self-contained features (setup, audit, cdc, mfa, notifications, git-integration…)
graphql/        ← graphql-yoga schema + resolvers
realtime/       ← WebSocket / Durable Object channels
observability/  ← metrics, tracing
extensions/     ← dynamic extension loading (admin-only, control plane)
__tests__/      ← cross-cutting + wiring tripwire tests
test-utils/     ← shared test harness
```

Route/service split matters: handlers stay thin; anything touching data goes through a service that carries the caller's permission context (`itemServiceForRequest(c)`), never `itemServiceForSystem` on a request path.

### apps/studio/src

```
main.tsx, App.tsx, router.tsx   ← entry + TanStack route tree
modules/     ← feature areas (content, data-model, access, users, files, settings,
               setup, insights, mission-control, editorial, automation, cdc,
               presets, translations, recovery)
components/  ← shared UI
hooks/, lib/ ← api client (getApiBaseUrl), token-store, utils
locales/     ← i18n bundles
test/        ← setup for Vitest + Testing Library
```

Router caveat: most settings pages need **two** routes — plain `/settings/...` and the custom admin-path `/$adminPath/settings/...`. Adding one nav item means adding both.

## packages/

| Package | Contents |
|---------|----------|
| `database` | Drizzle schema (`src/schema/` is schema source of truth), migrations in `drizzle/`, `backfill/`, `seeds/`, migration guard |
| `shared` | Zod schemas, shared types, policy DSL — consumed by CMS, Studio, SDK |
| `runtime` | Runtime abstraction adapters (`src/adapters/`) for CF ↔ Docker: cache, storage, db, queue, search, media |
| `ai-skills` | AI Copilot skill registry + definitions (risk/capability metadata drives HITL) |
| `sdk` | `@lumibase/sdk` public JS/TS client — part of the semver-frozen surface |
| `ui` | Shared React components |
| `cli`, `create-lumibase` | Scaffolding + operator CLI |
| `extension-sdk`, `extension-cli`, `extensions` | Extension authoring + signing |
| `mcp-server` | MCP server exposing CMS operations to agents |

## Conventions

- **File naming:** kebab-case for modules/files (`item-service.ts`, `file-upload-policy.ts`); PascalCase only for React components. Tests live in `__tests__/` next to the code, named `*.test.ts(x)`, integration ones `*.integration.test.ts`.
- **Tests:** Vitest everywhere; fast-check for property tests; Hono `testClient` for route integration.
- **Migrations:** numbered SQL in `packages/database/drizzle/`. Rebase on `main` before picking the next number; must be idempotent.
- **Docs pairing:** a user-facing change touches `docs/en/**` and `docs/vi/**` in the same commit.
- **Commits:** `type(scope): summary` — e.g. `feat(cms): add X`, `fix(studio): fix Y`.
- **Where to change what:** schema → `packages/database/src/schema/`; endpoint → `apps/cms/src/routes/` + `services/`; permissions → `apps/cms/src/services/permission-dsl.ts`; AI skill → `packages/ai-skills/src/skills.ts`; runtime behavior → `packages/runtime/src/adapters/`; validation → `packages/shared/src/schemas/`.
