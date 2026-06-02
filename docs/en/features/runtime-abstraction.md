# Runtime Abstraction Layer (`@lumibase/runtime`)

LumiBase có thể chạy trên hai runtime hoàn toàn khác nhau:

- **Cloudflare Workers** — KV, R2, Hyperdrive, Durable Objects, Queues, CF Image Resizing.
- **Docker / Node.js** — Redis, MinIO/S3, PostgreSQL pool, MeiliSearch self-host, BullMQ, Imgproxy.

Toàn bộ business logic (routes, services, middleware) **không gọi trực tiếp** vào API của Cloudflare hay Node — mà đi qua các interface trong `@lumibase/runtime`.

## Vị trí code

```
packages/runtime/
├── src/
│   ├── interfaces/           # Định nghĩa interface (cache/storage/database/search/queue/media)
│   ├── adapters/
│   │   ├── cloudflare/       # Implementation cho Cloudflare Workers
│   │   └── docker/           # Implementation cho Docker/Node
│   ├── factory.ts            # createRuntime(env) chọn theo LUMIBASE_RUNTIME
│   └── index.ts              # Public API
└── package.json              # deps: ioredis, @aws-sdk/client-s3, postgres, meilisearch, bullmq, prom-client
```

## 6 Provider interfaces

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
| Cloudflare KV (`env.CONFIG_CACHE`) | Redis qua `ioredis` |

### StorageProvider

```typescript
put(key: string, data: ArrayBuffer | Uint8Array, metadata?: Record<string, string>): Promise<void>
get(key: string): Promise<StorageObject | null>
delete(key: string): Promise<void>
list(prefix: string): Promise<StorageObject[]>
```

| Cloudflare | Docker |
|------------|--------|
| R2 (`env.MEDIA`) | S3-compatible MinIO qua `@aws-sdk/client-s3` |

### DatabaseProvider

```typescript
getConnection(): DrizzleDatabase
```

| Cloudflare | Docker |
|------------|--------|
| Hyperdrive connection string | `pg-pool` (driver `postgres`) |

### SearchProvider

```typescript
index(collection: string, documents: Doc[]): Promise<void>
search(collection: string, query: string, options?: SearchOptions): Promise<SearchResult>
delete(collection: string, ids: string[]): Promise<void>
getIndex(collection: string): Promise<IndexInfo>
```

| Cloudflare | Docker |
|------------|--------|
| MeiliSearch Cloud qua HTTP | MeiliSearch self-host |

### QueueProvider

```typescript
enqueue(queueName: string, job: Job): Promise<string>
process(queueName: string, handler: (job: Job) => Promise<void>): void
getStatus(jobId: string): Promise<JobStatus>
```

| Cloudflare | Docker |
|------------|--------|
| Cloudflare Queues | BullMQ (chạy trên Redis có sẵn) |

Hỗ trợ priority `high` / `normal` / `low`, retry 3 lần với exponential backoff.

### MediaProcessor

```typescript
transform(key: string, options: TransformOptions): Promise<string>  // returns URL
getUrl(key: string, transformations: TransformOptions): string
```

| Cloudflare | Docker |
|------------|--------|
| CF Image Resizing | Imgproxy với signed URLs |

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

Middleware `withRuntime()` (`apps/cms/src/middleware/runtime.ts`) gọi factory này và inject vào `c.set('runtime', ...)` ở mọi request — chạy ngay sau logger/metrics.

```typescript
// Sử dụng trong route:
app.get('/example', (c) => {
  const cache = c.get('runtime').cache;
  const storage = c.get('runtime').storage;
  // ...
});
```

## Environment parity

Bộ adapter phải đảm bảo:

1. **Cùng API responses** cho mọi content CRUD bất kể runtime.
2. **TTL behavior nhất quán** giữa KV và Redis.
3. **Storage operations identical** (list/get/put/delete) giữa R2 và MinIO.
4. **Cùng Drizzle schema và migrations** cho cả hai.
5. Khi feature unavailable trên một runtime (ví dụ Durable Objects chỉ có CF), log warning và degrade — không fail.

## Selecting runtime

```bash
# Trên Cloudflare (mặc định khi deploy bằng Wrangler):
LUMIBASE_RUNTIME=cloudflare

# Trên Docker / self-hosted:
LUMIBASE_RUNTIME=docker
```

Xem `apps/docs/content/deployment/environment-variables.md` để biết danh sách env vars đầy đủ.

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

- Unit tests cho từng adapter trong `packages/runtime/src/__tests__/`:
  - `cloudflare-adapters.test.ts` (mock KV/R2).
  - `docker-adapters.test.ts` (mock ioredis, S3 client, MeiliSearch).
- Integration tests chạy thật stack qua `docker compose up` trong CI workflow `.github/workflows/docker.yml`.
