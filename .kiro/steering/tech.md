# LumiBase — Technical Architecture

## Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| API framework | Hono.js | Web Standards API — runs on CF Workers + Node.js |
| Database | PostgreSQL + Drizzle ORM | Schema-first, no binary engine, works in Workers |
| DB Connection | Hyperdrive (CF) / pg pool (Docker) | Via runtime abstraction |
| Cache | Cloudflare KV (CF) / Redis (Docker) | Tag-based invalidation |
| Storage | Cloudflare R2 (CF) / S3/MinIO (Docker) | Via runtime abstraction |
| Queue | CF Queues (CF) / BullMQ+Redis (Docker) | Via runtime abstraction |
| Auth | Logto (OIDC) | Multi-tenant organizations, self-hostable |
| Search | MeiliSearch | Self-hosted or cloud |
| AI | Gemini/OpenAI/Anthropic/Workers AI | Via AISecureHarness + HITL |
| Frontend (admin) | React + Vite + TailwindCSS + Shadcn | Studio SPA |
| Frontend (consumer) | Next.js 15 App Router | Page hydration pattern |
| Monorepo | Turborepo + pnpm | Incremental builds |

## Common commands

Package manager is pinned: **pnpm 9.12.0** (`packageManager` field), Node **>= 22** (`.nvmrc`). Turborepo fans commands out across the workspace; `-F` targets one package.

```bash
# setup
pnpm install
docker compose -f docker/docker-compose.yml up -d   # postgres, redis, minio, meilisearch, imgproxy
pnpm db:migrate                                     # export DATABASE_URL first — not auto-loaded

# dev (CMS :1989, Studio :2026)
pnpm lumibase              # cms + studio (needs interactive TUI)
pnpm cms:dev               # wrangler dev, CMS only
pnpm studio:dev            # vite, Studio only
pnpm docs:dev / landing:dev / marketplace:dev

# verify — all three must pass before a feature is done
pnpm typecheck             # tsc --noEmit, recursive
pnpm test                  # vitest --run, all packages
pnpm lint                  # several packages stub this and exit 0
pnpm -F @lumibase/cms test src/services/__tests__/item-service-encryption.test.ts   # focused run

# build
pnpm build                 # all except @lumibase/shell
pnpm -F @lumibase/cms build          # wrangler dry-run → dist (Workers)
pnpm -F @lumibase/cms build:node     # esbuild → dist/serve.cjs (Docker)

# database
pnpm db:generate           # drizzle-kit generate after editing src/schema/
pnpm db:migrate:preflight  # inspect pending migrations
pnpm db:migrate:dry-run
pnpm db:studio
pnpm db:seed-dev
pnpm -F @lumibase/database backfill:role-policies   # apply | verify | rollback

# repo hygiene gates (also enforced in CI)
pnpm version:check         # root version vs package versions
pnpm registry:check        # duplicate Setup Impact Registry numbers
pnpm docs:i18n:detect      # en ↔ vi drift
pnpm docs:i18n:parity <rel>
pnpm docs:i18n:verify <rel>

# release / deploy
pnpm release:check         # required CF env/secrets present
pnpm cms:deploy            # production Worker
```

Notes: `.husky/pre-commit` runs the full `pnpm test`. Never start dev servers or watch mode in a blocking tool call — use `--run`. Full `@lumibase/cms` test runs include DB integration tests that reset setup state, so don't point them at a local DB you care about.

## Deployment modes

**Cloudflare mode** (`LUMIBASE_RUNTIME=cloudflare`):
- `apps/cms` → Cloudflare Worker (Wrangler)
- KV, R2, Durable Objects, Hyperdrive from CF bindings
- `apps/studio`, `apps/docs`, `apps/landing` → Cloudflare Pages

**Docker mode** (`LUMIBASE_RUNTIME=docker`):
- `apps/cms` → Node.js via `@hono/node-server`
- Redis, MinIO, pg pool, BullMQ from env vars
- All apps → Docker Compose

## Middleware chain (apps/cms)

```
Request
  └→ logger
  └→ metrics
  └→ withRuntime()       ← injects c.get('runtime') = { cache, storage, db, queue, search, media }
  └→ cors
  └→ withTenant()        ← resolves siteId from subdomain or X-Lumi-Site header
  └→ withAuth()          ← validates JWT (JWKS from Logto), loads LumiBase user row
  └→ withDb()            ← creates scoped Drizzle db instance
  └→ withRLS()           ← enforces site_id scoping at query level
  └→ route handler
```

## Data flow

### Read flow
```
Client → CF Worker → withRuntime → withAuth → withRLS
→ CacheProvider.get(key)          ← HIT: return cached
→ ItemService.listItems(db, siteId, query)
→ Drizzle SELECT WHERE site_id = siteId AND [conditions]
→ Permission filter (field masking)
→ CacheProvider.set(key, result, { tags })
→ JSON response
```

### Write flow
```
Client → withAuth → withRLS → ItemService.createItem
→ validate input (Zod)
→ db.insert().values({ id: nanoid(), siteId, ...body })
→ ActivityService.log(...)
→ CacheProvider.invalidateByTag(`list:${siteId}:${collection}`)
→ WebSocket broadcast (if realtime enabled)
→ JSON response
```

## Key architectural decisions

See `docs/en/architecture/decisions/` for full ADRs:

- **ADR-001**: NanoID over auto-increment (security, edge distribution)
- **ADR-002**: Runtime abstraction (CF ↔ Docker portability)
- **ADR-003**: HITL for dangerous AI skills (schema:write, delete*)
- **ADR-004**: Tag-based cache invalidation
- **ADR-005**: Hono.js (Web Standards, Workers compatible)
- **ADR-006**: Drizzle ORM (no binary engine)
- **ADR-007**: Logto (OIDC, multi-tenant, self-hostable)
- **ADR-008**: JSON Policy DSL (field-level, config-as-code)
