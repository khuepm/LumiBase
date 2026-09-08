---
version: 2
lastUpdated: 2026-09-01T16:48:56.430Z
sourceLang: vi
translatedFrom: vi
sourceHash: be568838e320c7e9
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-09-01T16:48:56.430Z
codeVerifiedHash: be568838e320c7e9
codeVerifiedClaims: 10
---

# Runtime Abstraction Layer (`@lumibase/runtime`)

LumiBase can run on two completely different runtimes:

- **Cloudflare Workers** — KV, R2, Hyperdrive, Durable Objects, Queues, CF Image Resizing.
- **Docker / Node.js** — Redis, MinIO/S3, a PostgreSQL pool, self-hosted MeiliSearch, BullMQ, Imgproxy.

All business logic (routes, services, middleware) **never calls** the Cloudflare or Node APIs directly — it goes through the interfaces in `@lumibase/runtime`.

## Code location

```
packages/runtime/
├── src/
│   ├── interfaces/           # Interface definitions (cache/storage/database/search/queue/media)
│   ├── adapters/
│   │   ├── cloudflare/       # Implementation for Cloudflare Workers
│   │   └── docker/           # Implementation for Docker/Node
│   ├── factory.ts            # createRuntime(env) selects by LUMIBASE_RUNTIME
│   ├── index.ts              # "." entry — Cloudflare-safe surface only
│   ├── docker.ts             # "./docker" entry — Docker adapters
│   └── node.ts               # "./node" entry — createRuntime + leader lock
└── package.json              # deps: ioredis, @aws-sdk/client-s3, postgres, meilisearch, bullmq, prom-client
```

## Three entry points, and why it matters

| Import | Contains | Safe in a Worker? |
|---|---|---|
| `@lumibase/runtime` | Interfaces, cache helpers, memory providers, shared key handling, **Cloudflare** adapters | Yes |
| `@lumibase/runtime/docker` | Docker adapters — Redis, BullMQ, S3, MeiliSearch, Imgproxy | **No** |
| `@lumibase/runtime/node` | `createRuntime` (branches on `LUMIBASE_RUNTIME`) and the Redis leader lock | **No** |

The split is not stylistic. The package root used to re-export everything, so the
Cloudflare Worker bundle contained `bullmq`, `ioredis` and `@aws-sdk/client-s3`
even though a Worker never uses them. BullMQ 6 then added a Postgres backend
whose `sql-loader` resolves its own directory at **module top level** and throws
where there is no `__dirname` and no `file:///` stack frame — precisely a bundled
Worker. The Worker stopped starting, and Cloudflare rejected every deploy with
validation error 10021.

Rules that follow from it:

- **Business logic imports the root only.** If you need `RuntimeContext` or a
  provider interface, import it from `@lumibase/runtime` — those are types and
  erase at build time.
- **Node entry points** (`apps/cms/src/serve.ts`, CLI scripts under
  `apps/cms/scripts/`) may import `/node` and `/docker`.
- **Never import `/docker` from anything reachable by `apps/cms/src/index.ts`.**
  That module is the Worker's app. A dynamic `await import()` is not an escape
  hatch either: the bundler still inlines the target, so `wrangler.toml` aliases
  the subpath to a stub for Worker builds.
- **Adding an export to the root?** If its module needs a Node built-in or a
  Node-only package as a *value* import, it belongs in a subpath. `import type`
  is always fine.

Two CI gates enforce this, and they are not interchangeable:

```bash
# asserts the built Worker contains no Docker-only code
pnpm verify:worker-bundle
# boots the Worker under workerd
pnpm verify:worker-startup
```

`verify:worker-bundle` is the real fence. `verify:worker-startup` does **not**
catch this class — with the Docker adapters deliberately restored, `wrangler dev`
still booted successfully, because BullMQ's stack-scanning fallback finds a
`file:///` frame locally and none in a deployed Worker. Treat a green startup
probe as "no eager top-level throw", never as "this will deploy".

## The 6 Provider interfaces

```typescript
// packages/runtime/src/interfaces/runtime.ts
export interface RuntimeContext {
  cache: CacheProvider;
  storage: StorageProvider;
  database: DatabaseProvider;
  search: SearchProvider;
  queue: QueueProvider;
  media: MediaProcessor;
  runtime: 'cloudflare' | 'docker';
}
```

### CacheProvider

```typescript
get(key: string): Promise<string | null>
set(key: string, value: string, ttl?: number): Promise<void>
delete(key: string): Promise<void>
```

| Cloudflare | Docker |
|------------|--------|
| Cloudflare KV (`env.CONFIG_CACHE`) | Redis via `ioredis` |

### StorageProvider

```typescript
put(key: string, data: ArrayBuffer | Uint8Array, metadata?: Record<string, string>): Promise<void>
get(key: string): Promise<StorageObject | null>
delete(key: string): Promise<void>
list(prefix: string): Promise<StorageObject[]>
```

| Cloudflare | Docker |
|------------|--------|
| R2 (`env.MEDIA`) | S3-compatible MinIO via `@aws-sdk/client-s3` |

### DatabaseProvider

```typescript
getConnection(): DrizzleDatabase
```

| Cloudflare | Docker |
|------------|--------|
| Hyperdrive connection string | `pg-pool` (the `postgres` driver) |

### SearchProvider

```typescript
index(collection: string, documents: Doc[]): Promise<void>
search(collection: string, query: string, options?: SearchOptions): Promise<SearchResult>
delete(collection: string, ids: string[]): Promise<void>
getIndex(collection: string): Promise<IndexInfo>
```

| Cloudflare | Docker |
|------------|--------|
| MeiliSearch Cloud via HTTP | Self-hosted MeiliSearch |

### QueueProvider

```typescript
enqueue(queueName: string, job: Job): Promise<string>
process(queueName: string, handler: (job: Job) => Promise<void>): void
getStatus(jobId: string): Promise<JobStatus>
```

| Cloudflare | Docker |
|------------|--------|
| Cloudflare Queues | BullMQ (running on the existing Redis) |

Supports `high` / `normal` / `low` priority, with 3 retries using exponential backoff.

### MediaProcessor

```typescript
transform(key: string, options: TransformOptions): Promise<string>  // returns URL
getUrl(key: string, transformations: TransformOptions): string
```

| Cloudflare | Docker |
|------------|--------|
| CF Image Resizing | Imgproxy with signed URLs |

Operations: resize, crop, format conversion (WebP/AVIF), quality.

## Factory & middleware

```typescript
// packages/runtime/src/factory.ts
export function createRuntime(env: Record<string, unknown>): RuntimeContext {
  const mode = (env.LUMIBASE_RUNTIME as string) || 'docker';
  if (mode === 'cloudflare') return createCloudflareRuntime(env);
  return createDockerRuntime(env);
}
```

The `withRuntime()` middleware (`apps/cms/src/middleware/runtime.ts`) calls this factory and injects it into `c.set('runtime', ...)` on every request — running right after logger/metrics.

```typescript
// Usage in a route:
app.get('/example', (c) => {
  const cache = c.get('runtime').cache;
  const storage = c.get('runtime').storage;
  // ...
});
```

## Environment parity

The adapter sets must guarantee:

1. **The same API responses** for all content CRUD regardless of runtime.
2. **Consistent TTL behavior** between KV and Redis.
3. **Identical storage operations** (list/get/put/delete) between R2 and MinIO.
4. **The same Drizzle schema and migrations** for both.
5. When a feature is unavailable on a runtime (e.g. Durable Objects are CF-only), log a warning and degrade — do not fail.

## Selecting the runtime

```bash
# On Cloudflare (the default when deploying with Wrangler):
LUMIBASE_RUNTIME=cloudflare

# On Docker / self-hosted:
LUMIBASE_RUNTIME=docker
```

See `apps/docs/content/deployment/environment-variables.md` for the full list of env vars.

## CDC runtime split

ClickHouse CDC uses the same runtime abstraction for the API/control-plane
surface, but the stateful replication workers are intentionally not executed
inside Cloudflare Workers:

- **Cloudflare Workers** may host the authenticated CDC API routes and Redis/KV
  cache invalidation edge components.
- **Docker / managed services** host Debezium/Kafka, ClickHouse materialized
  replication, Airbyte, health polling, and long-running deployment steps.

The CDC deployment target is explicit in API payloads via
`target: "docker_compose" | "cloudflare_workers"`. Runtime-specific services
must keep this target explicit instead of silently starting a stateful connector
inside the Workers isolate.

## Test strategy

- Unit tests for each adapter in `packages/runtime/src/__tests__/`:
  - `cloudflare-adapters.test.ts` (mock KV/R2).
  - `docker-adapters.test.ts` (mock ioredis, S3 client, MeiliSearch).
- Integration tests run the real stack via `docker compose up` in the CI workflow `.github/workflows/docker.yml`.
