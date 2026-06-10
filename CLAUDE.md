# LumiBase — Claude Code Instructions

> **Quick setup:** Read `docs/en/agent-setup/prompt.md` for full machine-readable instructions.
> **API reference:** `docs/en/api/hono-api-spec.md`
> **DB schema:** `packages/database/src/schema/`

## Project overview

LumiBase is an Edge-native Headless CMS with dual deployment (Cloudflare Workers + Docker). It is a Turborepo monorepo.

**Philosophy:** Multi-tenant by default · Edge-first caching · Config-as-Code · HITL for dangerous AI ops

## Quick architecture map

```
apps/cms/src/
  index.ts              ← Hono app entry (CF Workers export)
  serve.ts              ← Node.js server entry (Docker)
  middleware/           ← logger → runtime → cors → tenant → auth → db → rls
  routes/               ← Route handlers (thin, delegate to services)
  services/             ← Business logic (ItemService, AISecureHarness, FlowService…)
  modules/              ← Self-contained features (setup, audit, cdc, anomaly…)

packages/
  database/src/schema/  ← Drizzle table definitions (source of truth)
  shared/src/schemas/   ← Zod validation schemas (shared by CMS + Studio + SDK)
  ai-skills/src/        ← AI Copilot skill registry + definitions
  runtime/src/          ← Runtime abstraction (CF ↔ Docker adapters)
```

## Non-negotiable rules

1. **IDs:** `nanoid()` for domain tables, `uuidv7()` for audit tables. Never `serial`/auto-increment.
2. **Multi-tenancy:** Every domain table needs `site_id`. Every query needs `.where(eq(table.siteId, siteId))`.
3. **Runtime abstraction:** Never import CF bindings in business logic. Use `c.get('runtime').cache` etc.
4. **HITL:** Skills with `schema:write` capability or starting with `delete` → `ai_approvals` table first.
5. **Response format:** `{ data: T, meta?: PaginationMeta }` or `{ errors: [...] }`.
6. **TypeScript:** Strict mode, `import type`, no `any`.

## Common tasks

### Run tests
```bash
pnpm -F @lumibase/cms test
pnpm test           # all packages
```

### Add a migration
```bash
pnpm -F @lumibase/database db:generate
pnpm -F @lumibase/database db:migrate
```

### Run local dev
```bash
docker compose -f docker/docker-compose.yml up -d
pnpm dev
# CMS: http://localhost:8787 | Studio: http://localhost:5173
```

### Type check
```bash
pnpm typecheck
```

## Key docs

- Architecture decisions: `docs/en/architecture/decisions/`
- Full API spec: `docs/en/api/hono-api-spec.md`
- Data model: `docs/en/data-model.md`
- AI skills: `docs/en/ai-skills.md`
- Contributing: `docs/en/contributing/`
