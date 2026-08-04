---
version: 1
lastUpdated: 2026-07-08T20:22:25.695Z
sourceLang: en
contentHash: de67be004c86190c
---

These are official instructions from LumiBase to configure an AI coding agent to work effectively with the LumiBase headless CMS codebase.

Complete all steps yourself. Do not ask the user to run these commands.

---

## About LumiBase

LumiBase is an Edge-native Headless CMS (inspired by Directus) built on:

- **Runtime**: Hono.js (Cloudflare Workers + Node.js Docker, via `@lumibase/runtime` abstraction)
- **Database**: PostgreSQL with Drizzle ORM + JSONB hybrid schema
- **Auth**: Logto (OIDC, multi-tenant)
- **Storage**: Cloudflare R2 (or local Docker volume)
- **Cache**: Cloudflare KV / Redis (tag-based invalidation)
- **Frontend**: React + Vite (Studio), Next.js (Landing + Consumer demo)
- **AI**: OpenAI / Anthropic / Cloudflare Workers AI — switchable via `LLM_PROVIDER` env

### Monorepo layout

```
apps/
  cms/          # Hono API — builds to CF Workers or Docker container
  studio/       # Admin SPA (React + Vite + TanStack Router)
  docs/         # Vite docs viewer (serves docs/ at port 5174)
  landing/      # Next.js landing page
  consumer/     # Next.js delivery demo + SDK usage

packages/
  database/     # Drizzle schema + migrations (PostgreSQL)
  runtime/      # Abstraction: CacheProvider, StorageProvider, etc.
  ai-skills/    # AI skill registry (CORE_SKILLS) + tool definitions
  shared/       # Types, zod schemas, field/policy DSL
  sdk/          # JS SDK (REST + WebSocket + typegen)
  ui/           # shadcn components + CVA tokens
  extension-sdk # Types + helpers for extension developers
```

---

## Strict conventions — follow these at all times

1. **IDs**: Never use serial/auto-increment. Always use NanoID (short URLs) or UUIDv7.
2. **Multi-tenancy**: Every domain table has `site_id`. Every query scopes to `WHERE site_id = :siteId`.
3. **Edge-friendliness**: Business logic must go through `@lumibase/runtime` abstractions — no direct Cloudflare KV/R2 bindings in app code.
4. **1-roundtrip API**: Studio and delivery endpoints return aggregated payloads — avoid N+1 patterns.
5. **HITL for dangerous AI actions**: Skills requiring `schema:write` or `delete*` must create an `ai_approvals` row and wait for human approval before executing.
6. **Config-as-code**: Collections, fields, and permissions can be exported/imported as JSON/YAML (`apps/cms/scripts/config-cli.ts`).
7. **Cache tagging**: When data changes, invalidate all cache keys tagged with that entity.
8. **Endpoint deprecation (opt-in only)**: `withDeprecation` in `apps/cms/src/middleware/deprecation.ts` is a reusable RFC 8594 helper. **Do not** mount it on live endpoints. Attach it **only** when an explicit instruction says to retire / deprecate / sunset a specific route (or router). Leaving it unwired is correct when nothing is being retired.

### When an instruction says to deprecate an endpoint

1. Import `withDeprecation` from `apps/cms/src/middleware/deprecation.ts`.
2. Attach it to **only** the retiring route or sub-router (never the global app middleware chain).
3. Prefer full dates + a changelog `link` so clients get a migration window:

```typescript
import { withDeprecation } from '../middleware/deprecation'

// Attach ONLY to the route/router being retired — not globally
legacyRouter.use('*', withDeprecation({
  since: '2026-08-01',
  sunset: '2026-11-01',
  link: 'https://docs.lumibase.dev/changelog#items-legacy',
}))
```

Headers emitted: `Deprecation` (HTTP-date or `true`), optional `Sunset`, optional `Link rel="deprecation"`. All options are optional — omit dates to emit only `Deprecation: true`. Document the change in the changelog and, if consumers exist, mention FE handling in `docs/en/tutorials/nextjs-quickstart.md` § Production & security notes.

---

## Key API endpoints

Base URL: `https://<your-site>.lumibase.dev` (or `http://localhost:1989` locally)

All requests require:
- `Authorization: Bearer <access_token>`
- `X-Site-Id: <siteId>` header (or resolved via subdomain)

### Items (CRUD)
```
GET    /api/v1/items/:collection          # List items
POST   /api/v1/items/:collection          # Create item
GET    /api/v1/items/:collection/:id      # Get item
PATCH  /api/v1/items/:collection/:id      # Update item
DELETE /api/v1/items/:collection/:id      # Delete item
```

### Schema
```
GET    /api/v1/collections                # List collections
POST   /api/v1/collections                # Create collection
GET    /api/v1/fields/:collection         # List fields
POST   /api/v1/fields/:collection         # Create field
```

### Flows / Automation
```
GET    /api/v1/flows                      # List flows
POST   /api/v1/flows/:id/run              # Manually trigger a flow
GET    /api/v1/flows/:id/runs             # Execution history
```

### AI Copilot
```
POST   /api/v1/ai/chat                    # Natural language → skill execution
GET    /api/v1/ai/approvals               # List pending HITL approvals
POST   /api/v1/ai/approvals/:id/decide    # Approve or reject
```

### Files
```
POST   /api/v1/files                      # Upload asset (multipart/form-data)
GET    /api/v1/files/:id                  # File metadata
```

### Auth / Users
```
POST   /api/v1/auth/login                 # Username/password login
POST   /api/v1/auth/refresh               # Refresh access token
GET    /api/v1/users                      # List users
POST   /api/v1/users                      # Create user
```

Full spec: `docs/en/api/hono-api-spec.md`

---

## Docs index

Key documentation files:

- `docs/en/README.md` — full docs map
- `docs/en/data-model.md` — database schema reference
- `docs/en/features/ai-copilot.md` — AI Copilot internals (HITL, skills, LLM providers)
- `docs/en/ai-skills.md` — AI skill definitions and system prompts
- `docs/en/features/flows-automation.md` — Flows / Operations engine
- `docs/en/features/permissions-rbac.md` — Roles, policies, field-level permissions
- `docs/en/features/websockets-realtime.md` — Realtime WebSocket subscribe/publish
- `docs/en/architecture/overview.md` — Tech stack, layers, runtime abstraction
- `docs/en/deployment/overview.md` — Cloudflare Workers, Cloudflare Pages, Docker
- `docs/en/deployment/environment-variables.md` — All env vars and bindings

---

## Local development

```bash
# Install dependencies
pnpm install

# Start all services (CMS API + Studio + Docs)
pnpm dev

# CMS API runs at:   http://localhost:1989
# Studio runs at:    http://localhost:2026
# Docs run at:       http://localhost:5174
```

Copy `.env.example` to `.env` and fill in required values (see `docs/en/deployment/environment-variables.md`).

---

## AI Copilot skill system

The AI Copilot uses a skill registry in `packages/ai-skills/src/skills.ts`. Each skill has:

- `name` + `description` — used for LLM tool calling
- `parameters` — JSON Schema (OpenAI-compatible)
- `requiredCapabilities` — e.g. `['schema:write']`, `['items:read']`

**Safe skills** (execute directly): `listCollections`, `listItems`, `createItem`, `updateItem`

**Dangerous skills** (require HITL approval): `createCollection`, `deleteCollection`, `createField`, `deleteField`, `deleteItem`

Call `getAISkillsAsTools()` from `packages/ai-skills` to get the OpenAI function-calling tool list.

---

## Permissions system

LumiBase uses a JSON policy rule engine:

- **Roles** → assigned to users
- **Policies** → attached to roles, contain permission rules
- **Permissions** → `{ collection, action, fields?, conditions? }`
- **Capabilities** — string tokens (`schema:write`, `items:read`, `flows:execute`, etc.)

Wildcard `'*'` in capabilities satisfies any requirement.

---

These instructions are published at `docs/en/agent-setup/prompt.md`.
