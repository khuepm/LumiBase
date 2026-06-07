# ADR-002: Runtime Abstraction Layer for Dual Deployment

**Date:** 2024-02-10
**Status:** Accepted

## Context

LumiBase has two target deployment environments with fundamentally different APIs for infrastructure services:

| Service | Cloudflare Workers | Docker / Node.js |
|---------|--------------------|------------------|
| Cache | KV (HTTP, global CDN-backed) | Redis (ioredis) |
| Object storage | R2 (S3-compatible API) | MinIO / S3 |
| Database | Hyperdrive (connection pooler via Cloudflare) | pg pool (node-postgres) |
| Queue | Cloudflare Queues (push-based, at-least-once) | BullMQ on Redis |
| Search | MeiliSearch Cloud | MeiliSearch self-hosted |
| Image transform | Cloudflare Images Resize (built into Workers) | Imgproxy (signed URLs) |

If business logic calls `KV.get()` directly, it cannot run in Docker. If it calls `Redis.get()` directly, it cannot run on Workers. Every service would need two branches everywhere.

Additionally:
- The engineering team wants to be able to test business logic in a Node.js environment without needing live Cloudflare bindings
- Future deployment targets (e.g., Bun, Deno Deploy) should be addable without rewriting business logic
- Local development should work without a real Cloudflare account

## Decision

Create a **runtime abstraction package** at `packages/runtime` that defines 6 provider interfaces:

```typescript
interface CacheProvider { get, set, delete, invalidateByTag, addTag }
interface StorageProvider { upload, download, delete, getUrl, getSignedUrl }
interface DatabaseProvider { query, transaction, pool }
interface SearchProvider { index, search, delete, reindex }
interface QueueProvider { publish, subscribe }
interface MediaProcessor { transform, getTransformUrl }
```

Each interface has two adapter implementations: `cloudflare/` and `docker/`.

A `createRuntime(env)` factory in `packages/runtime/src/factory.ts` selects adapters based on `env.LUMIBASE_RUNTIME` (`'cloudflare'` | `'docker'`).

The `withRuntime()` Hono middleware injects the `RuntimeContext` into `c.set('runtime', ctx)`. All routes and services access providers through `c.get('runtime').cache`, `c.get('runtime').storage`, etc.

Business logic in `apps/cms/src/` never imports Cloudflare bindings or Redis directly.

## Consequences

**Positive:**
- Business logic is 100% portable — same `ItemService.ts` runs on Workers and Docker
- Local tests can use in-memory mock adapters without real infrastructure
- Adding a new deployment target (e.g., Deno Deploy) requires only new adapters
- Clear separation of concerns: business logic vs infrastructure wiring

**Negative:**
- Extra abstraction layer adds ~1 function call overhead per cache/storage operation (negligible in practice)
- Developers must understand the adapter pattern before debugging infrastructure issues
- Interface must be kept in sync across both adapters — a missing method in one adapter causes a runtime error (caught by TypeScript `implements` check)

**Neutral:**
- Some Cloudflare-specific features (Durable Objects for Realtime, Worker-to-Worker service bindings) cannot be abstracted — these are in `apps/cms/src/realtime/` and only activate in `cloudflare` mode
