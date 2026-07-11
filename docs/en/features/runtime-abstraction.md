---
version: 1
lastUpdated: 2026-06-23T13:03:22.000Z
sourceLang: vi
translatedFrom: vi
sourceHash: 9ec3924addf5c76e
mtEngine: claude
syncStatus: machine-translated
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
│   └── index.ts              # Public API
└── package.json              # deps: ioredis, @aws-sdk/client-s3, postgres, meilisearch, bullmq, prom-client
```

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
