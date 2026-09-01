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
| `packages/contracts/` | Zod schemas, types, policy DSL |
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

## Docs

- Edits under `docs/en/` or `docs/vi/` must update the other locale in the same PR when a counterpart exists (or create one); prefer over-syncing, then re-stamp the pair with `scripts/docs-i18n/stamp-pair.mjs`. Full checklist: `.kiro/steering/definition-of-done.md` §4a.

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
| Update Zod validation | `packages/contracts/src/schemas/` |
| Read architecture decisions | `docs/en/architecture/decisions/` |

## Cursor Cloud specific instructions

Standard commands: see **Environment setup** / **Testing** above and `docs/en/deployment/local-development.md`. Cloud gotchas:

### Infra + env
- Start **infra only** (avoid the compose `cms` service stealing `:1989`):  
  `docker compose -f docker/docker-compose.yml up -d postgres redis minio minio-init meilisearch imgproxy`
- Postgres URL from compose is `postgresql://lumibase:lumibase_dev@localhost:5432/lumibase` (password `lumibase_dev`, not `lumibase`).
- `pnpm db:migrate` does **not** auto-load `packages/database/.env` — export `DATABASE_URL` (or pass it inline) before migrating.
- There is **no root `.env.example`**. Use `docs/en/deployment/local-development.md` + `docker/.env.example`. For Wrangler, put secrets in `apps/cms/.dev.vars` (gitignored). Logto is **not** in compose; local auth uses JWT + setup wizard (`LUMIBASE_DEV_AUTH=true` in wrangler `[vars]`).

### Running CMS + Studio
- `pnpm lumibase` / `turbo run dev` needs an interactive TUI (`interactive: true` in `turbo.json`). In non-TUI agents, run separately:
  - **Preferred for Docker infra (full `/health`):**  
    `cd apps/cms && LUMIBASE_RUNTIME=docker LUMIBASE_ENV=development DATABASE_URL=... JWT_SECRET=... REDIS_URL=redis://localhost:6379 S3_ENDPOINT=http://localhost:9000 S3_ACCESS_KEY=minioadmin S3_SECRET_KEY=minioadmin S3_BUCKET=lumibase-media MEILISEARCH_HOST=http://localhost:7700 MEILISEARCH_API_KEY=lumibase_dev_key pnpm exec tsx src/serve.ts`
  - **Wrangler** (`pnpm -F @lumibase/cms dev`): works for API + setup, but `/health` often reports **storage/cache/queue unhealthy** (no R2/MEDIA binding).
  - Studio: `cd apps/studio && pnpm exec vite --host 0.0.0.0 --port 2026` (default Vite may bind IPv6-only `::1`, which breaks `127.0.0.1` clients).
- Ports: CMS `:1989`, Studio `:2026`. First-run: `POST /api/v1/setup/complete` then login; Studio UI at `http://localhost:2026/<adminPath>/login`.

### Lint / test notes
- Many packages’ `lint` scripts are stubs (`echo … && exit 0`); `pnpm lint` still exits 0.
- Full `pnpm -F @lumibase/cms test` is long and **DB integration tests reset setup state** — do not run them against a shared local DB you care about. Prefer focused Vitest paths for smoke.
- Husky `.husky/pre-commit` runs `pnpm test` (full suite).
