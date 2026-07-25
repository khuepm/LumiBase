# Design Document

## Overview

This design introduces a runtime abstraction layer and Docker-based deployment infrastructure for LumiBase, enabling the CMS to run on both Cloudflare Workers (edge) and standard Node.js/Docker environments (self-hosted). The architecture follows an adapter pattern where infrastructure concerns (caching, storage, database pooling) are abstracted behind interfaces, with concrete implementations selected at startup based on the target runtime.

## Architecture

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    CMS API (Hono.js)                     │
│              Business Logic & Routes                     │
├─────────────────────────────────────────────────────────┤
│              @lumibase/runtime (Abstraction)             │
│  ┌──────────────┐  ┌───────────────┐  ┌─────────────┐  │
│  │CacheProvider │  │StorageProvider│  │  DBProvider  │  │
│  └──────┬───────┘  └──────┬────────┘  └──────┬──────┘  │
├─────────┼──────────────────┼──────────────────┼─────────┤
│         │                  │                  │         │
│  ┌──────▼───────┐  ┌──────▼────────┐  ┌──────▼──────┐  │
│  │ CF KV / Redis│  │ R2 / MinIO    │  │Hyperdrive/PG│  │
│  └──────────────┘  └───────────────┘  └─────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### Package Structure

```
packages/
  runtime/                    # NEW: @lumibase/runtime
    src/
      index.ts               # Public exports
      interfaces/
        cache.ts             # CacheProvider interface
        storage.ts           # StorageProvider interface
        database.ts          # DatabaseProvider interface
        search.ts            # SearchProvider interface
        queue.ts             # QueueProvider interface
        media.ts             # MediaProcessor interface
        runtime.ts           # RuntimeContext aggregate
      adapters/
        cloudflare/
          index.ts           # CloudflareRuntime factory
          cache.ts           # KV-backed CacheProvider
          storage.ts         # R2-backed StorageProvider
          database.ts        # Hyperdrive-backed DatabaseProvider
          search.ts          # MeiliSearch Cloud-backed SearchProvider
          queue.ts           # Cloudflare Queues-backed QueueProvider
          media.ts           # CF Image Resizing MediaProcessor
        docker/
          index.ts           # DockerRuntime factory
          cache.ts           # Redis-backed CacheProvider
          storage.ts         # MinIO/S3-backed StorageProvider
          database.ts        # pg-pool-backed DatabaseProvider
          search.ts          # MeiliSearch-backed SearchProvider
          queue.ts           # BullMQ-backed QueueProvider
          media.ts           # Imgproxy-backed MediaProcessor
      factory.ts             # createRuntime(env) dispatcher
    package.json
    tsconfig.json
```

### Docker Infrastructure

```
docker/
  Dockerfile                 # Multi-stage production image
  Dockerfile.dev             # Development image with hot-reload
  docker-compose.yml         # Full local dev stack (core + tooling)
  docker-compose.prod.yml    # Production-like stack
  docker-compose.monitoring.yml  # Prometheus + Grafana + Loki overlay
  .env.example               # Environment variable template
  grafana/
    dashboards/
      lumibase.json          # Pre-configured CMS dashboard
    provisioning/
      datasources.yml        # Prometheus + Loki datasources
      dashboards.yml         # Dashboard provisioning config
  prometheus/
    prometheus.yml           # Scrape config for CMS metrics
  scripts/
    entrypoint.sh            # Container entrypoint (migrate + start)
    backup.sh                # PostgreSQL backup script
    restore.sh               # PostgreSQL restore script
    wait-for-it.sh           # Service readiness checker
```

### Documentation Structure

```
apps/docs/content/
  deployment/
    overview.md              # Deployment options comparison
    cloudflare.md            # Cloudflare deployment guide
    docker.md                # Docker deployment guide
    local-development.md     # Local dev quickstart
    environment-variables.md # Complete env var reference
  guides/
    tooling-recommendations.md  # Complementary tools guide
```

## Components and Interfaces

### 1. Runtime Interfaces (`@lumibase/runtime`)

```typescript
// interfaces/cache.ts
export interface CacheProvider {
  get<T = string>(key: string): Promise<T | null>;
  set(key: string, value: string, options?: { ttl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

// interfaces/storage.ts
export interface StorageObject {
  key: string;
  body: ReadableStream | Buffer;
  contentType?: string;
  size?: number;
  metadata?: Record<string, string>;
}

export interface StorageProvider {
  put(key: string, data: ReadableStream | Buffer, metadata?: Record<string, string>): Promise<void>;
  get(key: string): Promise<StorageObject | null>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<{ keys: string[] }>;
}

// interfaces/database.ts
export interface DatabaseProvider {
  getConnection(): Database; // Drizzle instance from @lumibase/database
  close(): Promise<void>;
}

// interfaces/runtime.ts
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

### 1b. Search, Queue, and Media Interfaces

```typescript
// interfaces/search.ts
export interface SearchResult<T = Record<string, unknown>> {
  hits: T[];
  totalHits: number;
  processingTimeMs: number;
}

export interface SearchOptions {
  filter?: string;
  sort?: string[];
  limit?: number;
  offset?: number;
  attributesToRetrieve?: string[];
}

export interface SearchProvider {
  index(collection: string, documents: Record<string, unknown>[]): Promise<void>;
  search<T = Record<string, unknown>>(collection: string, query: string, options?: SearchOptions): Promise<SearchResult<T>>;
  delete(collection: string, documentIds: string[]): Promise<void>;
  getIndex(collection: string): Promise<{ numberOfDocuments: number }>;
}

// interfaces/queue.ts
export interface JobOptions {
  priority?: 'high' | 'normal' | 'low';
  delay?: number;
  attempts?: number;
  backoff?: { type: 'exponential' | 'fixed'; delay: number };
}

export interface Job<T = unknown> {
  id: string;
  name: string;
  data: T;
  status: 'waiting' | 'active' | 'completed' | 'failed';
}

export interface QueueProvider {
  enqueue<T>(queueName: string, jobName: string, data: T, options?: JobOptions): Promise<string>;
  process<T>(queueName: string, handler: (job: Job<T>) => Promise<void>): void;
  getStatus(queueName: string, jobId: string): Promise<Job | null>;
}

// interfaces/media.ts
export interface TransformOptions {
  width?: number;
  height?: number;
  format?: 'webp' | 'avif' | 'jpeg' | 'png';
  quality?: number;
  fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside';
}

export interface MediaProcessor {
  getUrl(key: string, options?: TransformOptions): string;
  generateThumbnails(key: string, sizes: Array<{ width: number; height: number }>): Promise<string[]>;
}
```

### 2. Cloudflare Adapter

Wraps existing Cloudflare bindings (KV, R2, Hyperdrive) into the provider interfaces. This adapter is instantiated per-request in the Worker context.

```typescript
// adapters/cloudflare/cache.ts
export class CloudflareCacheProvider implements CacheProvider {
  constructor(private kv: KVNamespace) {}
  
  async get<T = string>(key: string): Promise<T | null> {
    return this.kv.get(key, 'json') as Promise<T | null>;
  }
  
  async set(key: string, value: string, options?: { ttl?: number }): Promise<void> {
    await this.kv.put(key, value, options?.ttl ? { expirationTtl: options.ttl } : undefined);
  }
  
  async delete(key: string): Promise<void> {
    await this.kv.delete(key);
  }
}
```

### 3. Docker Adapter

Uses Redis (ioredis), MinIO (@aws-sdk/client-s3), and direct PostgreSQL (postgres-js with pooling).

```typescript
// adapters/docker/cache.ts
import Redis from 'ioredis';

export class RedisCacheProvider implements CacheProvider {
  private client: Redis;
  
  constructor(redisUrl: string) {
    this.client = new Redis(redisUrl);
  }
  
  async get<T = string>(key: string): Promise<T | null> {
    const val = await this.client.get(key);
    return val ? JSON.parse(val) as T : null;
  }
  
  async set(key: string, value: string, options?: { ttl?: number }): Promise<void> {
    if (options?.ttl) {
      await this.client.setex(key, options.ttl, value);
    } else {
      await this.client.set(key, value);
    }
  }
  
  async delete(key: string): Promise<void> {
    await this.client.del(key);
  }
  
  async close(): Promise<void> {
    await this.client.quit();
  }
}
```

### 4. Runtime Factory

```typescript
// factory.ts
export function createRuntime(env: Record<string, unknown>): RuntimeContext {
  const mode = (env.LUMIBASE_RUNTIME as string) || 'docker';
  
  if (mode === 'cloudflare') {
    return createCloudflareRuntime(env);
  }
  return createDockerRuntime(env);
}
```

### 4b. MeiliSearch Adapter (Docker)

```typescript
// adapters/docker/search.ts
import { MeiliSearch } from 'meilisearch';

export class MeiliSearchProvider implements SearchProvider {
  private client: MeiliSearch;

  constructor(host: string, apiKey?: string) {
    this.client = new MeiliSearch({ host, apiKey });
  }

  async index(collection: string, documents: Record<string, unknown>[]): Promise<void> {
    const index = this.client.index(collection);
    await index.addDocuments(documents);
  }

  async search<T>(collection: string, query: string, options?: SearchOptions): Promise<SearchResult<T>> {
    const index = this.client.index(collection);
    const result = await index.search(query, {
      filter: options?.filter,
      sort: options?.sort,
      limit: options?.limit ?? 20,
      offset: options?.offset ?? 0,
      attributesToRetrieve: options?.attributesToRetrieve,
    });
    return {
      hits: result.hits as T[],
      totalHits: result.estimatedTotalHits ?? 0,
      processingTimeMs: result.processingTimeMs,
    };
  }

  async delete(collection: string, documentIds: string[]): Promise<void> {
    const index = this.client.index(collection);
    await index.deleteDocuments(documentIds);
  }

  async getIndex(collection: string): Promise<{ numberOfDocuments: number }> {
    const stats = await this.client.index(collection).getStats();
    return { numberOfDocuments: stats.numberOfDocuments };
  }
}
```

### 4c. BullMQ Adapter (Docker)

```typescript
// adapters/docker/queue.ts
import { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';

export class BullMQProvider implements QueueProvider {
  private queues = new Map<string, Queue>();

  constructor(private connection: Redis) {}

  private getQueue(name: string): Queue {
    if (!this.queues.has(name)) {
      this.queues.set(name, new Queue(name, { connection: this.connection }));
    }
    return this.queues.get(name)!;
  }

  async enqueue<T>(queueName: string, jobName: string, data: T, options?: JobOptions): Promise<string> {
    const queue = this.getQueue(queueName);
    const job = await queue.add(jobName, data, {
      priority: options?.priority === 'high' ? 1 : options?.priority === 'low' ? 3 : 2,
      delay: options?.delay,
      attempts: options?.attempts ?? 3,
      backoff: options?.backoff ?? { type: 'exponential', delay: 1000 },
    });
    return job.id!;
  }

  process<T>(queueName: string, handler: (job: Job<T>) => Promise<void>): void {
    new Worker(queueName, async (bullJob) => {
      await handler({
        id: bullJob.id!,
        name: bullJob.name,
        data: bullJob.data as T,
        status: 'active',
      });
    }, { connection: this.connection });
  }

  async getStatus(queueName: string, jobId: string): Promise<Job | null> {
    const queue = this.getQueue(queueName);
    const job = await queue.getJob(jobId);
    if (!job) return null;
    const state = await job.getState();
    return { id: job.id!, name: job.name, data: job.data, status: state as Job['status'] };
  }
}
```

### 4d. Imgproxy Adapter (Docker)

```typescript
// adapters/docker/media.ts
import crypto from 'node:crypto';

export class ImgproxyMediaProcessor implements MediaProcessor {
  constructor(
    private baseUrl: string,
    private key: string,
    private salt: string,
    private storageUrl: string,
  ) {}

  getUrl(key: string, options?: TransformOptions): string {
    const processing = this.buildProcessingString(options);
    const sourceUrl = `${this.storageUrl}/${key}`;
    const encoded = Buffer.from(sourceUrl).toString('base64url');
    const path = `/${processing}/${encoded}`;
    const signature = this.sign(path);
    return `${this.baseUrl}/${signature}${path}`;
  }

  async generateThumbnails(key: string, sizes: Array<{ width: number; height: number }>): Promise<string[]> {
    return sizes.map(size => this.getUrl(key, { ...size, format: 'webp', quality: 80 }));
  }

  private buildProcessingString(options?: TransformOptions): string {
    if (!options) return 'preset:default';
    const parts: string[] = [];
    if (options.width || options.height) parts.push(`rs:${options.fit ?? 'fill'}:${options.width ?? 0}:${options.height ?? 0}`);
    if (options.format) parts.push(`f:${options.format}`);
    if (options.quality) parts.push(`q:${options.quality}`);
    return parts.join('/') || 'preset:default';
  }

  private sign(path: string): string {
    const hmac = crypto.createHmac('sha256', Buffer.from(this.key, 'hex'));
    hmac.update(Buffer.from(this.salt, 'hex'));
    hmac.update(path);
    return hmac.digest('base64url').substring(0, 32);
  }
}
```

### 5. Node.js Server Entrypoint

```typescript
// apps/cms/src/serve.ts
import { serve } from '@hono/node-server';
import { createRuntime } from '@lumibase/runtime';
import app from './index';

const port = parseInt(process.env.PORT || '3000', 10);
const runtime = createRuntime(process.env);

// Inject runtime into Hono context
app.use('*', async (c, next) => {
  c.set('runtime', runtime);
  await next();
});

const server = serve({ fetch: app.fetch, port });
console.log(`[lumibase-cms] Started in ${runtime.runtime} mode on port ${port}`);

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[lumibase-cms] SIGTERM received, shutting down...');
  server.close();
  await runtime.database.close();
  process.exit(0);
});
```

### 6. Dockerfile (Production)

```dockerfile
# Stage 1: Build
FROM node:20-slim AS builder
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/ ./packages/
COPY apps/cms/ ./apps/cms/
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @lumibase/cms build

# Stage 2: Runtime
FROM node:20-slim AS runtime
RUN addgroup --system lumibase && adduser --system --ingroup lumibase lumibase
WORKDIR /app
COPY --from=builder /app/apps/cms/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY docker/scripts/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
USER lumibase
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://localhost:3000/health || exit 1
ENTRYPOINT ["/entrypoint.sh"]
```

### 7. Docker Compose (Local Development)

```yaml
version: '3.8'
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: lumibase
      POSTGRES_USER: lumibase
      POSTGRES_PASSWORD: lumibase_dev
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U lumibase"]
      interval: 5s
      timeout: 3s
      retries: 5

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5

  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    ports:
      - "9000:9000"
      - "9001:9001"
    volumes:
      - miniodata:/data
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 5s
      timeout: 3s
      retries: 5

  meilisearch:
    image: getmeili/meilisearch:v1.7
    environment:
      MEILI_MASTER_KEY: lumibase_dev_key
      MEILI_ENV: development
    ports:
      - "7700:7700"
    volumes:
      - meilidata:/meili_data
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--spider", "http://localhost:7700/health"]
      interval: 5s
      timeout: 3s
      retries: 5

  imgproxy:
    image: darthsim/imgproxy:latest
    environment:
      IMGPROXY_KEY: ${IMGPROXY_KEY:-736563726574}
      IMGPROXY_SALT: ${IMGPROXY_SALT:-736563726574}
      IMGPROXY_USE_S3: "true"
      AWS_ACCESS_KEY_ID: minioadmin
      AWS_SECRET_ACCESS_KEY: minioadmin
      IMGPROXY_S3_ENDPOINT: http://minio:9000
    ports:
      - "8080:8080"
    depends_on:
      minio:
        condition: service_healthy

  cms:
    build:
      context: .
      dockerfile: docker/Dockerfile.dev
    environment:
      LUMIBASE_RUNTIME: docker
      DATABASE_URL: postgresql://lumibase:lumibase_dev@postgres:5432/lumibase
      REDIS_URL: redis://redis:6379
      S3_ENDPOINT: http://minio:9000
      S3_ACCESS_KEY: minioadmin
      S3_SECRET_KEY: minioadmin
      S3_BUCKET: lumibase-media
      MEILISEARCH_HOST: http://meilisearch:7700
      MEILISEARCH_API_KEY: lumibase_dev_key
      IMGPROXY_URL: http://imgproxy:8080
      IMGPROXY_KEY: 736563726574
      IMGPROXY_SALT: 736563726574
      PORT: "3000"
    ports:
      - "3000:3000"
    volumes:
      - ./apps/cms/src:/app/apps/cms/src
      - ./packages:/app/packages
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      minio:
        condition: service_healthy
      meilisearch:
        condition: service_healthy

  # BullMQ Dashboard (Bull Board)
  bull-board:
    image: deadly0/bull-board:latest
    environment:
      REDIS_HOST: redis
      REDIS_PORT: 6379
    ports:
      - "3001:3000"
    depends_on:
      redis:
        condition: service_healthy

volumes:
  pgdata:
  miniodata:
  meilidata:
```

### 8. Docker Compose Monitoring Overlay (`docker-compose.monitoring.yml`)

```yaml
version: '3.8'
services:
  prometheus:
    image: prom/prometheus:v2.51.0
    volumes:
      - ./docker/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml
      - prometheusdata:/prometheus
    ports:
      - "9090:9090"
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.retention.time=7d'

  grafana:
    image: grafana/grafana:10.4.0
    environment:
      GF_SECURITY_ADMIN_PASSWORD: admin
      GF_USERS_ALLOW_SIGN_UP: "false"
    volumes:
      - ./docker/grafana/provisioning:/etc/grafana/provisioning
      - ./docker/grafana/dashboards:/var/lib/grafana/dashboards
      - grafanadata:/var/lib/grafana
    ports:
      - "3002:3000"
    depends_on:
      - prometheus
      - loki

  loki:
    image: grafana/loki:2.9.0
    ports:
      - "3100:3100"
    volumes:
      - lokidata:/loki

  # PostgreSQL backup service
  pg-backup:
    image: prodrigestivill/postgres-backup-local:16
    environment:
      POSTGRES_HOST: postgres
      POSTGRES_DB: lumibase
      POSTGRES_USER: lumibase
      POSTGRES_PASSWORD: lumibase_dev
      SCHEDULE: "@daily"
      BACKUP_KEEP_DAYS: 7
      BACKUP_KEEP_WEEKS: 4
      BACKUP_KEEP_MONTHS: 0
      S3_ENDPOINT: http://minio:9000
      S3_BUCKET: lumibase-backups
      S3_ACCESS_KEY_ID: minioadmin
      S3_SECRET_ACCESS_KEY: minioadmin
    volumes:
      - backupdata:/backups
    depends_on:
      postgres:
        condition: service_healthy

volumes:
  prometheusdata:
  grafanadata:
  lokidata:
  backupdata:
```

## Correctness Properties

### Property 1: Cache Round-Trip Consistency

For any key-value pair, setting a value in the cache and then getting it returns the original value, regardless of which adapter (KV or Redis) is used.

```
For all key: string, value: string, adapter: CacheProvider
  adapter.set(key, value) → adapter.get(key) == value
```

**Validates: Requirement 1.1, Requirement 13.2**

### Property 2: Storage Round-Trip Consistency

For any key and binary data, putting an object in storage and then getting it returns identical data, regardless of which adapter (R2 or MinIO) is used.

```
For all key: string, data: Buffer, adapter: StorageProvider
  adapter.put(key, data) → adapter.get(key).body == data
```

**Validates: Requirement 1.2, Requirement 13.3**

### Property 3: Storage List Completeness

After putting N objects with a common prefix, listing that prefix returns all N keys.

```
For all prefix: string, keys: string[], adapter: StorageProvider
  for each k in keys: adapter.put(prefix + k, data)
  adapter.list(prefix).keys ⊇ { prefix + k | k ∈ keys }
```

**Validates: Requirement 1.2, Requirement 13.3**

### Property 4: Cache TTL Expiration

For any key-value pair set with a TTL, the value is retrievable before expiration and absent after expiration.

```
For all key: string, value: string, ttl: number > 0, adapter: CacheProvider
  adapter.set(key, value, { ttl }) → 
    immediately: adapter.get(key) == value
    after ttl seconds: adapter.get(key) == null
```

**Validates: Requirement 13.2**

### Property 5: API Response Equivalence Across Runtimes

For any valid API request, the response body structure and status code are identical when processed by the Cloudflare adapter vs the Docker adapter (given the same database state).

```
For all request: ValidAPIRequest, dbState: DatabaseState
  response_cf = process(request, cloudflareAdapter, dbState)
  response_docker = process(request, dockerAdapter, dbState)
  response_cf.status == response_docker.status
  response_cf.body == response_docker.body
```

**Validates: Requirement 13.1**

### Property 6: Runtime Factory Determinism

The runtime factory always returns the correct adapter type based on the LUMIBASE_RUNTIME environment variable.

```
For all env where env.LUMIBASE_RUNTIME == 'cloudflare'
  createRuntime(env).runtime == 'cloudflare'

For all env where env.LUMIBASE_RUNTIME == 'docker' OR undefined
  createRuntime(env).runtime == 'docker'
```

**Validates: Requirement 1.6**

## Data Models

### Environment Variables (Docker Mode)

| Variable | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `LUMIBASE_RUNTIME` | string | No | `docker` | Runtime mode: `cloudflare` or `docker` |
| `DATABASE_URL` | string | Yes | — | PostgreSQL connection string |
| `REDIS_URL` | string | Yes | — | Redis connection URL |
| `S3_ENDPOINT` | string | Yes | — | S3-compatible endpoint (MinIO) |
| `S3_ACCESS_KEY` | string | Yes | — | S3 access key |
| `S3_SECRET_KEY` | string | Yes | — | S3 secret key |
| `S3_BUCKET` | string | Yes | — | S3 bucket name |
| `MEILISEARCH_HOST` | string | Yes | — | MeiliSearch host URL |
| `MEILISEARCH_API_KEY` | string | Yes | — | MeiliSearch API key |
| `IMGPROXY_URL` | string | Yes | — | Imgproxy base URL |
| `IMGPROXY_KEY` | string | Yes | — | Imgproxy signing key (hex) |
| `IMGPROXY_SALT` | string | Yes | — | Imgproxy signing salt (hex) |
| `PORT` | number | No | `3000` | HTTP server port |
| `LOGTO_ISSUER` | string | No | — | OIDC issuer URL |
| `LOGTO_AUDIENCE` | string | No | — | OIDC audience |
| `ENCRYPTION_KEY` | string | No | — | AES-GCM encryption key (base64) |

### Prometheus Metrics Schema

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `lumibase_http_requests_total` | Counter | method, path, status | Total HTTP requests |
| `lumibase_http_request_duration_seconds` | Histogram | method, path | Request duration |
| `lumibase_cache_operations_total` | Counter | operation, hit | Cache operations (hit/miss) |
| `lumibase_queue_jobs_total` | Counter | queue, status | Queue job counts |
| `lumibase_search_queries_total` | Counter | collection | Search query counts |
| `lumibase_search_duration_seconds` | Histogram | collection | Search query duration |

## Error Handling

### Runtime Initialization Errors

- **Database unreachable**: Retry up to 5 times with exponential backoff (1s, 2s, 4s, 8s, 16s). If all retries fail, exit with code 1 and log the error.
- **Redis unreachable**: Log warning and start with degraded caching (pass-through, no cache). Queue operations will fail gracefully.
- **MeiliSearch unreachable**: Log warning and disable search indexing. Search endpoint returns 503 with retry-after header.
- **MinIO/S3 unreachable**: Log warning. Media upload/download operations return 503.

### Runtime Operation Errors

- **Cache set/get failure**: Log error, return null for get, swallow for set. Never block the request pipeline.
- **Queue enqueue failure**: Log error, attempt synchronous fallback for critical operations (webhook delivery). Non-critical operations are dropped with a warning.
- **Search index failure**: Log error, enqueue retry job. If retry queue is also down, log to dead-letter and continue.
- **Media transform failure**: Return original image URL as fallback. Log error for investigation.

### Graceful Degradation Strategy

When a non-essential service is unavailable, the CMS continues to serve content CRUD operations. The `/health` endpoint reports partial health with details:

```json
{
  "status": "degraded",
  "services": {
    "database": "healthy",
    "cache": "unhealthy",
    "search": "unhealthy",
    "storage": "healthy",
    "queue": "unhealthy"
  }
}
```

## Dependencies

### New Package Dependencies

**@lumibase/runtime (new package)**:
- `ioredis` ^5.4.0 — Redis client for Docker cache adapter and BullMQ connection
- `@aws-sdk/client-s3` ^3.600.0 — S3 client for MinIO/S3 storage adapter
- `postgres` ^3.4.5 — Already used, for direct PG connections in Docker mode
- `meilisearch` ^0.41.0 — MeiliSearch client for search adapter
- `bullmq` ^5.12.0 — BullMQ for task queue adapter
- `prom-client` ^15.1.0 — Prometheus metrics client

**@lumibase/cms (additions)**:
- `@hono/node-server` ^1.12.0 — Node.js HTTP server for Hono
- `@lumibase/runtime` workspace:* — Runtime abstraction

### Infrastructure Dependencies

- Docker Engine 24+
- Docker Compose v2
- PostgreSQL 16
- Redis 7
- MinIO (latest)
- MeiliSearch v1.7+
- Imgproxy (latest)
- Prometheus v2.51+
- Grafana 10.4+
- Loki 2.9+

### CI Dependencies

- GitHub Actions `docker/build-push-action`
- GitHub Actions `docker/setup-buildx-action` (layer caching)
- Container registry (GitHub Container Registry / Docker Hub)

## Migration Strategy

### Phase 1: Abstraction Layer (Non-Breaking)
1. Create `@lumibase/runtime` package with interfaces and both adapters
2. Existing Cloudflare code continues to work unchanged
3. Add `LUMIBASE_RUNTIME=cloudflare` as default

### Phase 2: Refactor CMS to Use Abstraction
1. Replace direct `c.env.HYPERDRIVE`, `c.env.CONFIG_CACHE`, `c.env.MEDIA` usage with `RuntimeContext`
2. Update middleware to inject runtime context
3. Verify all existing tests pass

### Phase 3: Docker Infrastructure
1. Add Node.js entrypoint (`serve.ts`)
2. Create Dockerfiles and docker-compose
3. Add CI pipeline for Docker builds

### Phase 4: Documentation
1. Write deployment guides
2. Write tooling recommendations
3. Add architecture diagrams

## Testing Strategy

### Unit Tests
- Each adapter (Cloudflare and Docker) has isolated unit tests using mocks (ioredis-mock, mock KVNamespace, mock S3 client, mock MeiliSearch)
- Runtime factory tested with various env configurations

### Integration Tests
- Docker Compose stack used for integration testing: real Redis, real MeiliSearch, real PostgreSQL, real MinIO
- CI pipeline starts the full stack and runs integration test suite against localhost:3000

### Property-Based Tests
- Cache round-trip consistency (arbitrary key-value pairs)
- Storage round-trip consistency (arbitrary binary data)
- Runtime factory determinism (arbitrary env configurations)

### Smoke Tests
- Docker image health check in CI (build → start → curl /health)
- All services reachable from CMS container after `docker compose up`

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Cloudflare-specific APIs (KV metadata, R2 multipart) not fully replicable | Medium | Define interface as lowest common denominator; document limitations |
| Performance difference between edge (Cloudflare) and centralized (Docker) | Low | Document expected latency differences; not a correctness issue |
| Redis TTL precision differs from KV expiration | Low | Use second-level granularity for both; document sub-second limitations |
| MinIO S3 compatibility gaps with R2 | Low | Use only standard S3 operations; test both in CI |
