# Implementation Plan

## Overview

This plan implements the Docker dual-deployment feature for LumiBase, including the runtime abstraction layer, Docker infrastructure, integrated tooling (MeiliSearch, BullMQ, Imgproxy, Prometheus/Grafana), and comprehensive documentation. Tasks are ordered by dependency — abstraction layer first, then adapters, then infrastructure, then tooling integration, then docs.

## Tasks

- [x] 1. Create runtime package foundation
  - [x] 1.1 Create `packages/runtime/package.json` with dependencies (ioredis, @aws-sdk/client-s3, postgres, meilisearch, bullmq, prom-client) and `tsconfig.json` extending monorepo base config
  - [x] 1.2 Create runtime interfaces: `packages/runtime/src/interfaces/cache.ts` (CacheProvider), `storage.ts` (StorageProvider, StorageObject), `database.ts` (DatabaseProvider), `search.ts` (SearchProvider, SearchResult, SearchOptions), `queue.ts` (QueueProvider, Job, JobOptions), `media.ts` (MediaProcessor, TransformOptions), `runtime.ts` (RuntimeContext aggregate), and barrel `index.ts`
  - [x] 1.3 Create `packages/runtime/src/index.ts` public API exports and register `@lumibase/runtime` in `pnpm-workspace.yaml`

- [x] 2. Implement Cloudflare adapters
  - [x] 2.1 Implement Cloudflare cache adapter (`packages/runtime/src/adapters/cloudflare/cache.ts`) — KV-backed CacheProvider
  - [x] 2.2 Implement Cloudflare storage adapter (`packages/runtime/src/adapters/cloudflare/storage.ts`) — R2-backed StorageProvider
  - [x] 2.3 Implement Cloudflare database adapter (`packages/runtime/src/adapters/cloudflare/database.ts`) — Hyperdrive-backed DatabaseProvider
  - [x] 2.4 Implement Cloudflare search adapter (`packages/runtime/src/adapters/cloudflare/search.ts`) — MeiliSearch Cloud via HTTP
  - [x] 2.5 Implement Cloudflare queue adapter (`packages/runtime/src/adapters/cloudflare/queue.ts`) — Cloudflare Queues-backed QueueProvider
  - [x] 2.6 Implement Cloudflare media adapter (`packages/runtime/src/adapters/cloudflare/media.ts`) — CF Image Resizing MediaProcessor
  - [x] 2.7 Create `packages/runtime/src/adapters/cloudflare/index.ts` — `createCloudflareRuntime()` factory

- [x] 3. Implement Docker adapters
  - [x] 3.1 Implement Docker cache adapter (`packages/runtime/src/adapters/docker/cache.ts`) — Redis-backed CacheProvider using ioredis
  - [x] 3.2 Implement Docker storage adapter (`packages/runtime/src/adapters/docker/storage.ts`) — S3/MinIO-backed StorageProvider using @aws-sdk/client-s3
  - [x] 3.3 Implement Docker database adapter (`packages/runtime/src/adapters/docker/database.ts`) — pg-pool-backed DatabaseProvider
  - [x] 3.4 Implement Docker search adapter (`packages/runtime/src/adapters/docker/search.ts`) — MeiliSearch-backed SearchProvider
  - [x] 3.5 Implement Docker queue adapter (`packages/runtime/src/adapters/docker/queue.ts`) — BullMQ-backed QueueProvider
  - [x] 3.6 Implement Docker media adapter (`packages/runtime/src/adapters/docker/media.ts`) — Imgproxy-backed MediaProcessor with signed URLs
  - [x] 3.7 Create `packages/runtime/src/adapters/docker/index.ts` — `createDockerRuntime()` factory

- [x] 4. Create runtime factory and tests
  - [x] 4.1 Create `packages/runtime/src/factory.ts` — `createRuntime(env)` dispatcher based on `LUMIBASE_RUNTIME` env var
  - [x] 4.2 Write unit tests for Cloudflare adapters (cache, storage) using mocks
  - [x] 4.3 Write unit tests for Docker adapters (Redis cache with ioredis-mock, S3 storage with mock client, MeiliSearch with mock)

- [x] 5. Integrate runtime into CMS API
  - [x] 5.1 Add `@lumibase/runtime` and `@hono/node-server` as dependencies to `apps/cms/package.json`
  - [x] 5.2 Update `apps/cms/src/env.ts` to include `RuntimeContext` in Variables interface
  - [x] 5.3 Create `apps/cms/src/middleware/runtime.ts` — middleware that creates and injects RuntimeContext based on environment
  - [x] 5.4 Refactor `apps/cms/src/middleware/db.ts` to use `DatabaseProvider` from RuntimeContext instead of direct Hyperdrive
  - [x] 5.5 Update routes using `c.env.CONFIG_CACHE` (KV) to use `CacheProvider` from RuntimeContext
  - [x] 5.6 Update routes using `c.env.MEDIA` (R2) to use `StorageProvider` from RuntimeContext

- [x] 6. Add CMS API endpoints and hooks
  - [x] 6.1 Create `apps/cms/src/serve.ts` — Node.js HTTP server entrypoint using @hono/node-server with graceful shutdown (SIGTERM, 10s timeout)
  - [x] 6.2 Add `/health` endpoint to CMS API that checks DB, Redis, and MeiliSearch connectivity
  - [x] 6.3 Add `/metrics` endpoint to CMS API exposing Prometheus metrics (request count, duration histogram, error rate, cache hit/miss)
  - [x] 6.4 Create `/search` endpoint in CMS API that accepts query params and returns ranked results via SearchProvider
  - [x] 6.5 Add content indexing hooks: auto-index on item create/update, auto-remove on delete via QueueProvider
  - [x] 6.6 Add media processing hooks: enqueue thumbnail generation on media upload via QueueProvider + MediaProcessor

- [x] 7. Create Docker infrastructure
  - [x] 7.1 Create `docker/Dockerfile` — multi-stage production build (Node.js 20 slim, pnpm, non-root user, HEALTHCHECK)
  - [x] 7.2 Create `docker/Dockerfile.dev` — development image with volume mounting for hot-reload
  - [x] 7.3 Create `docker/scripts/entrypoint.sh` — run migrations with retry logic (5 attempts, exponential backoff) then start server
  - [x] 7.4 Create `.dockerignore` to exclude node_modules, .git, dist, .wrangler
  - [x] 7.5 Create `docker/docker-compose.yml` with services: PostgreSQL 16, Redis 7, MinIO, MeiliSearch, Imgproxy, CMS, Bull Board — all with health checks and named volumes
  - [x] 7.6 Create `docker/docker-compose.monitoring.yml` overlay with Prometheus, Grafana, Loki, and pg-backup services
  - [x] 7.7 Create `docker/prometheus/prometheus.yml` — scrape config targeting CMS /metrics endpoint
  - [x] 7.8 Create `docker/grafana/provisioning/datasources.yml` and `dashboards.yml` for auto-provisioning
  - [x] 7.9 Create `docker/grafana/dashboards/lumibase.json` — pre-configured dashboard (request rate, latency p50/p95/p99, error rate, queue depth, cache hit ratio)
  - [x] 7.10 Create `docker/scripts/backup.sh` and `docker/scripts/restore.sh` for PostgreSQL backup/restore to S3
  - [x] 7.11 Create `docker/.env.example` with all required variables and sensible defaults for local development
  - [x] 7.12 Create `docker/docker-compose.prod.yml` for production-like local testing (no volume mounts, production image)

- [x] 8. Verify Docker stack and add CI/CD
  - [x] 8.1 Verify `docker compose up` brings up all services and CMS responds on localhost:3000
  - [x] 8.2 Create `.github/workflows/docker.yml` — build and push on main (ghcr.io), build-only on PR, layer caching, health check verification

- [x] 9. Create documentation
  - [x] 9.1 Create `apps/docs/content/deployment/overview.md` — comparison of deployment options with architecture diagrams
  - [x] 9.2 Create `apps/docs/content/deployment/cloudflare.md` — Wrangler setup, Hyperdrive, KV, R2, env vars, step-by-step guide
  - [x] 9.3 Create `apps/docs/content/deployment/docker.md` — building image, configuring env, running with compose, deploying to ECS/Cloud Run/Railway/Fly.io
  - [x] 9.4 Create `apps/docs/content/deployment/local-development.md` — prerequisites, docker-compose quickstart, connecting to DB, running migrations
  - [x] 9.5 Create `apps/docs/content/deployment/environment-variables.md` — complete env var reference for both runtimes
  - [x] 9.6 Create `apps/docs/content/guides/tooling-recommendations.md` — integrated tools docs + alternative recommendations with comparison tables, categorized as Integrated/Alternative/Optional
  - [x] 9.7 Create `apps/docs/content/guides/backup-recovery.md` — backup strategy, restore procedures, PITR setup, disaster recovery playbook

- [x] 10. Final verification
  - [x] 10.1 Verify typecheck passes for entire monorepo (`pnpm -r typecheck`)

## Notes

- Tasks 1 establishes the runtime package foundation
- Tasks 2 implements Cloudflare adapters (wrapping existing bindings)
- Tasks 3 implements Docker adapters (new infrastructure)
- Task 4 covers the runtime factory and unit testing for adapters
- Tasks 5 refactors the CMS API to use the abstraction layer
- Tasks 6 adds new CMS API endpoints and hooks
- Tasks 7 creates Docker infrastructure files
- Task 8 verifies the Docker stack and adds CI/CD
- Tasks 9 creates documentation
- Task 10 is final verification
- The monitoring stack (docker-compose.monitoring.yml) is an optional overlay — users run it with `docker compose -f docker-compose.yml -f docker-compose.monitoring.yml up`

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["1.3"] },
    { "id": 3, "tasks": ["2.1", "2.2", "2.3", "2.4", "2.5", "2.6", "3.1", "3.2", "3.3", "3.4", "3.5", "3.6"] },
    { "id": 4, "tasks": ["2.7", "3.7", "4.1"] },
    { "id": 5, "tasks": ["4.2", "4.3", "5.1"] },
    { "id": 6, "tasks": ["5.2"] },
    { "id": 7, "tasks": ["5.3"] },
    { "id": 8, "tasks": ["5.4", "5.5", "5.6", "6.1", "6.3", "6.4"] },
    { "id": 9, "tasks": ["6.2", "6.5", "6.6", "7.1", "7.2"] },
    { "id": 10, "tasks": ["7.3", "7.4"] },
    { "id": 11, "tasks": ["7.5", "7.6", "7.7", "7.8", "7.9", "7.10"] },
    { "id": 12, "tasks": ["7.11"] },
    { "id": 13, "tasks": ["7.12"] },
    { "id": 14, "tasks": ["8.1"] },
    { "id": 15, "tasks": ["8.2", "9.1", "9.2", "9.3", "9.4", "9.5", "9.6", "9.7"] },
    { "id": 16, "tasks": ["10.1"] }
  ]
}
```
