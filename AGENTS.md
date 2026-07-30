# LumiBase — Agent Instructions (AGENTS.md)

> This file provides context for AI coding agents (OpenAI Codex, Devin, SWE-agent, etc.).
> For the full machine-readable setup guide, fetch: `docs/en/agent-setup/prompt.md`

## Identity

**LumiBase** — Content Operating System (Content OS): an Edge-native, AI-native headless CMS where agents operate content under governed autonomy and humans set intent/taste/accountability.  
Stack: Hono.js · PostgreSQL · Drizzle ORM · Logto · Cloudflare Workers / Docker · Turborepo · pnpm

## Codebase layout

| Path | Description |
|------|-------------|
| `apps/cms/` | Hono API — primary backend |
| `apps/studio/` | Admin SPA (React + Vite) |
| `packages/database/` | Drizzle schema + migrations |
| `packages/shared/` | Zod schemas, types, policy DSL |
| `packages/runtime/` | CF Workers ↔ Docker runtime adapters |
| `packages/ai-skills/` | AI Copilot skill definitions |
| `packages/sdk/` | @lumibase/sdk JS/TS client |
| `docs/en/` | Full docs (API spec, ADRs, SDK, deployment) |

## Architecture constraints

### Identifiers
```
nanoid()   → domain records (items, collections, users, files, flows…)
uuidv7()   → audit/system records (activity, revisions, ai_approvals…)
NEVER      → serial / auto-increment
```

### Multi-tenancy
```typescript
// ✅ Always
db.select().from(t).where(and(eq(t.siteId, siteId), ...))

// ❌ Never
db.select().from(t)  // missing site_id
```

### Runtime abstraction
```typescript
// ✅ Correct — via middleware context
const cache = c.get('runtime').cache
await cache.set(key, value, { tags: [`schema:${siteId}`] })

// ❌ Wrong — direct CF binding import in business logic
import type { KVNamespace } from '@cloudflare/workers-types'
```

### AI safety
```typescript
// Dangerous skills require HITL (human approval)
// AISecureHarness.evaluateRisk() returns isDangerous=true if:
// - skill.requiredCapabilities.includes('schema:write')
// - skill.name.startsWith('delete')
```

### Endpoint deprecation (opt-in — do not pre-wire)
`withDeprecation` in `apps/cms/src/middleware/deprecation.ts` is a reusable RFC 8594 helper (OWASP API9). **Do not** attach it unless an explicit task says to deprecate / retire / sunset a specific endpoint. Having the middleware unwired while no APIs are retiring is correct — wiring healthy routes would falsely mark them deprecated.

```typescript
import { withDeprecation } from '../middleware/deprecation'

// Attach ONLY to the retiring route/router
legacyRouter.use('*', withDeprecation({
  since: '2026-08-01',
  sunset: '2026-11-01',
  link: 'https://docs.lumibase.dev/changelog#items-legacy',
}))
```

## Testing

```bash
pnpm test                          # all packages
pnpm -F @lumibase/cms test         # CMS only
pnpm -F @lumibase/cms test --watch # watch mode
pnpm typecheck                     # TypeScript check
pnpm lint                          # ESLint
```

All tests use **Vitest**. Property-based tests use **fast-check**. Integration tests use Hono's `testClient`.

## Environment setup

```bash
cp .env.example .env
docker compose -f docker/docker-compose.yml up -d
pnpm install
pnpm -F @lumibase/database db:migrate
pnpm dev
```

Required env vars: `DATABASE_URL`, `LOGTO_ENDPOINT`, `LOGTO_APP_ID`, `JWT_SECRET`

See `docs/en/deployment/environment-variables.md` for the full reference.

## Commit convention

```
feat(cms): add X
fix(studio): fix Y
docs(api): update Z
test(ai-harness): add property test for W
chore(deps): update drizzle-orm
```

## Where to look for things

| I need to... | Look here |
|--------------|-----------|
| Change DB schema | `packages/database/src/schema/` |
| Add an API endpoint | `apps/cms/src/routes/` + `apps/cms/src/services/` |
| Modify permissions | `apps/cms/src/services/permission-dsl.ts` |
| Add an AI skill | `packages/ai-skills/src/skills.ts` |
| Change runtime behavior | `packages/runtime/src/adapters/` |
| Deprecate / sunset an endpoint | `apps/cms/src/middleware/deprecation.ts` (`withDeprecation` — opt-in only) |
| Update Zod validation | `packages/shared/src/schemas/` |
| Read architecture decisions | `docs/en/architecture/decisions/` |
