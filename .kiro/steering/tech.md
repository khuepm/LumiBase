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
