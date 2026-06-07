# LumiBase — GitHub Copilot Instructions

> These instructions apply to all Copilot interactions in this repository.
> For machine-readable setup, see `docs/en/agent-setup/prompt.md`.

## What is LumiBase?

LumiBase is an **Edge-native Headless CMS** — a Directus-inspired, multi-tenant content platform built on:
- **Backend:** Hono.js on Cloudflare Workers (dual: also runs on Node.js/Docker via runtime abstraction)
- **Database:** PostgreSQL + Drizzle ORM (connection via Cloudflare Hyperdrive or direct pg pool)
- **Auth:** Logto (OIDC/OAuth2, multi-tenant)
- **Storage:** Cloudflare R2 (or S3/MinIO in Docker mode)
- **Cache:** Tag-based invalidation via `CacheProvider` (KV on CF Workers, Redis on Docker)

## Monorepo structure

```
apps/cms/        → Hono REST + WebSocket API (primary backend)
apps/studio/     → Admin SPA (React + Vite)
apps/docs/       → Docs site (Cloudflare Pages)
packages/
  database/      → Drizzle schema + migrations (source of truth for DB)
  shared/        → Zod schemas, types, policy DSL, field DSL
  ai-skills/     → AI Copilot skill registry
  runtime/       → Runtime abstraction (Cloudflare ↔ Docker adapters)
  sdk/           → @lumibase/sdk — JS/TS client
  extension-sdk/ → Types for building custom extensions
```

## Critical rules — always follow these

### IDs
- **NEVER** use auto-increment / serial IDs
- Use `nanoid()` for domain records (items, collections, users, files, flows)
- Use `uuidv7()` for system/audit tables (activity, revisions, ai_approvals)

### Multi-tenancy
- **EVERY** domain table must have a `site_id` column
- **EVERY** database query must be scoped with `.where(eq(table.siteId, siteId))`
- Use `scopeSite(siteId)` helper from `@lumibase/database`

### TypeScript
- Always `import type` for type-only imports
- No `any` — use `unknown` + type guards
- Validate all API inputs with Zod schemas from `@lumibase/shared`

### Runtime abstraction
- Business logic must NEVER import Cloudflare bindings (`KVNamespace`, `R2Bucket`) directly
- Always access infrastructure via `c.get('runtime').cache`, `c.get('runtime').storage`, etc.
- Runtime is injected by `withRuntime()` middleware

### AI safety (HITL)
- Skills with `requiredCapabilities.includes('schema:write')` → MUST go through `ai_approvals` table
- Skills whose name starts with `delete` → MUST go through `ai_approvals` table
- The `AISecureHarness` in `apps/cms/src/services/ai-harness.ts` enforces this automatically

### API response format
All responses must follow the envelope:
```typescript
{ data: T, meta?: { total, page, pageSize } }
// Error:
{ errors: [{ code: string, message: string, path?: string[] }] }
```

## Key files for context

| Purpose | File |
|---------|------|
| DB schema | `packages/database/src/schema/` |
| Middleware chain | `apps/cms/src/index.ts` |
| AI skills registry | `packages/ai-skills/src/skills.ts` |
| HITL harness | `apps/cms/src/services/ai-harness.ts` |
| Runtime factory | `packages/runtime/src/factory.ts` |
| Permission DSL | `apps/cms/src/services/permission-dsl.ts` |
| Zod schemas | `packages/shared/src/schemas/` |
| API routes | `apps/cms/src/routes/` |

## Common patterns

### Adding a new API route
```typescript
// apps/cms/src/routes/my-resource.ts
import { zValidator } from '@hono/zod-validator'
import { CreateMyResourceSchema } from '@lumibase/shared'

router.post('/', zValidator('json', CreateMyResourceSchema), async (c) => {
  const siteId = c.get('siteId')          // from tenant middleware
  const db = c.get('db')                  // from db middleware
  const runtime = c.get('runtime')        // from runtime middleware
  const body = c.req.valid('json')

  const id = nanoid()
  await db.insert(myTable).values({ id, siteId, ...body })

  await runtime.cache.invalidateByTag(`myresource:${siteId}`)

  return c.json({ data: { id, ...body } }, 201)
})
```

### Adding a new DB table
```typescript
// packages/database/src/schema/my-domain.ts
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'

export const myTable = pgTable('my_table', {
  id:        text('id').primaryKey(),           // nanoid()
  siteId:    text('site_id').notNull(),         // REQUIRED for multi-tenancy
  name:      text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})
```

## What NOT to do

- ❌ `db.select().from(table)` without `.where(eq(table.siteId, siteId))`
- ❌ `import { KVNamespace } from '@cloudflare/workers-types'` in business logic
- ❌ `id: serial('id')` or `id: integer('id').primaryKey()`
- ❌ `fetch()` directly from an extension (must declare `http:external` capability)
- ❌ Execute dangerous AI skills (schema:write, delete*) without HITL approval
