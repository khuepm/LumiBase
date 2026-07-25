# Requirements Document

## Introduction

LumiBase is an edge-native headless CMS currently tightly coupled to Cloudflare Workers (Hyperdrive, KV, R2). This feature introduces a Docker-based deployment option and a runtime abstraction layer so that LumiBase can run both on Cloudflare's edge infrastructure and on self-hosted Docker environments (local development, staging, production). Additionally, comprehensive documentation will guide users through both deployment paths and recommend complementary tools/services for a production-grade headless CMS.

## Glossary

- **CMS_API**: The LumiBase Hono.js API application that serves content management endpoints.
- **Abstraction_Layer**: A set of TypeScript interfaces and adapter implementations that decouple the CMS_API from specific infrastructure providers (Cloudflare vs Docker/self-hosted).
- **Docker_Compose_Stack**: A docker-compose configuration that orchestrates all services needed for local development (PostgreSQL, Redis, MinIO, CMS_API).
- **Production_Image**: An optimized, multi-stage Docker image of the CMS_API suitable for production deployment.
- **Runtime_Adapter**: A concrete implementation of the Abstraction_Layer interfaces for a specific runtime (Cloudflare adapter or Node.js/Docker adapter).
- **Cache_Provider**: An interface abstracting key-value caching operations (backed by Cloudflare KV or Redis).
- **Storage_Provider**: An interface abstracting object/blob storage operations (backed by Cloudflare R2 or S3-compatible storage like MinIO).
- **Connection_Pool**: A database connection pooling mechanism (Hyperdrive on Cloudflare, or pg-pool/pgBouncer on Docker).
- **Deployment_Docs**: Documentation pages explaining how to deploy and operate LumiBase on each supported platform.
- **Tooling_Guide**: Documentation recommending additional services (search, queues, media processing, monitoring) for a production headless CMS.
- **Search_Provider**: An interface abstracting full-text search operations (backed by MeiliSearch in both runtimes).
- **Queue_Provider**: An interface abstracting async job queue operations (backed by BullMQ/Redis in Docker, Cloudflare Queues on edge).
- **Media_Processor**: An interface abstracting image transformation and optimization (backed by Imgproxy in Docker, Cloudflare Image Resizing on edge).
- **Observability_Stack**: Prometheus + Grafana + Loki for metrics, dashboards, and log aggregation in self-hosted deployments.
- **Backup_Service**: Automated PostgreSQL backup with scheduled pg_dump and WAL archiving for point-in-time recovery.

## Requirements

### Requirement 1: Runtime Abstraction Layer

**User Story:** As a developer, I want the CMS to use abstract interfaces for infrastructure services, so that I can swap between Cloudflare and Docker runtimes without changing business logic.

#### Acceptance Criteria

1. THE Abstraction_Layer SHALL define a `CacheProvider` interface with methods `get(key)`, `set(key, value, ttl?)`, and `delete(key)`.
2. THE Abstraction_Layer SHALL define a `StorageProvider` interface with methods `put(key, data, metadata?)`, `get(key)`, `delete(key)`, and `list(prefix)`.
3. THE Abstraction_Layer SHALL define a `DatabaseProvider` interface with a method `getConnection()` that returns a Drizzle ORM database instance.
4. WHEN the CMS_API starts in Cloudflare mode, THE Runtime_Adapter SHALL bind `CacheProvider` to Cloudflare KV, `StorageProvider` to Cloudflare R2, and `DatabaseProvider` to Hyperdrive.
5. WHEN the CMS_API starts in Docker mode, THE Runtime_Adapter SHALL bind `CacheProvider` to Redis, `StorageProvider` to S3-compatible storage (MinIO), and `DatabaseProvider` to a direct PostgreSQL connection string with pooling.
6. THE CMS_API SHALL select the active Runtime_Adapter based on a `LUMIBASE_RUNTIME` environment variable with values `cloudflare` or `docker`.
7. THE Abstraction_Layer SHALL reside in a shared package (`@lumibase/runtime`) consumable by all apps in the monorepo.

### Requirement 2: Docker Image for CMS API

**User Story:** As a DevOps engineer, I want a production-ready Docker image for the CMS API, so that I can deploy LumiBase on any container orchestration platform.

#### Acceptance Criteria

1. THE Production_Image SHALL use a multi-stage build with a build stage (Node.js 20+, pnpm) and a runtime stage (Node.js 20 slim).
2. THE Production_Image SHALL include only production dependencies and compiled output in the final stage.
3. THE Production_Image SHALL expose port 3000 for the CMS_API HTTP server.
4. THE Production_Image SHALL accept configuration via environment variables: `DATABASE_URL`, `REDIS_URL`, `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `LOGTO_ISSUER`, `LOGTO_AUDIENCE`, `ENCRYPTION_KEY`.
5. THE Production_Image SHALL run the CMS_API process as a non-root user.
6. WHEN the container starts, THE Production_Image SHALL run database migrations automatically before starting the HTTP server.
7. THE Production_Image SHALL include a `/health` endpoint that returns HTTP 200 when the service is ready.
8. IF the database is unreachable at startup, THEN THE Production_Image SHALL retry the connection up to 5 times with exponential backoff before exiting with a non-zero code.

### Requirement 3: Docker Compose for Local Development

**User Story:** As a developer, I want a single `docker-compose up` command to spin up the entire LumiBase stack locally, so that I can develop and test without a Cloudflare account.

#### Acceptance Criteria

1. THE Docker_Compose_Stack SHALL include services for: PostgreSQL 16, Redis 7, MinIO (S3-compatible storage), and the CMS_API.
2. THE Docker_Compose_Stack SHALL use named volumes for PostgreSQL data and MinIO data to persist state across restarts.
3. THE Docker_Compose_Stack SHALL expose the CMS_API on `localhost:3000`, PostgreSQL on `localhost:5432`, Redis on `localhost:6379`, and MinIO console on `localhost:9001`.
4. THE Docker_Compose_Stack SHALL include a health check for each service so that dependent services wait for readiness.
5. THE Docker_Compose_Stack SHALL provide a `.env.example` file documenting all required environment variables with sensible defaults for local development.
6. WHEN `docker-compose up` completes, THE Docker_Compose_Stack SHALL have a fully functional CMS_API connected to all backing services.
7. THE Docker_Compose_Stack SHALL support hot-reload of the CMS_API source code via volume mounting for development workflows.

### Requirement 4: Node.js Server Entrypoint

**User Story:** As a developer, I want the CMS API to run as a standard Node.js HTTP server when not on Cloudflare Workers, so that it can be containerized and deployed anywhere.

#### Acceptance Criteria

1. THE CMS_API SHALL provide a Node.js entrypoint (`serve.ts`) that starts the Hono app on a standard Node.js HTTP server using `@hono/node-server`.
2. THE CMS_API SHALL read the listen port from the `PORT` environment variable, defaulting to 3000.
3. WHEN running in Docker mode, THE CMS_API SHALL initialize the Docker Runtime_Adapter before registering routes.
4. THE CMS_API SHALL log a startup message indicating the runtime mode and listening port.
5. WHEN a SIGTERM signal is received, THE CMS_API SHALL gracefully shut down by closing the HTTP server and database connections within 10 seconds.

### Requirement 5: Deployment Documentation

**User Story:** As a user evaluating LumiBase, I want clear documentation explaining both deployment options, so that I can choose the approach that fits my infrastructure.

#### Acceptance Criteria

1. THE Deployment_Docs SHALL include a "Cloudflare Deployment" guide covering: Wrangler setup, Hyperdrive configuration, KV namespace creation, R2 bucket setup, and environment variable configuration.
2. THE Deployment_Docs SHALL include a "Docker Deployment" guide covering: building the Production_Image, configuring environment variables, running with docker-compose, and deploying to container platforms (AWS ECS, Google Cloud Run, Railway, Fly.io).
3. THE Deployment_Docs SHALL include a "Local Development" guide covering: prerequisites, `docker-compose up` quickstart, connecting to the local database, and running migrations.
4. THE Deployment_Docs SHALL include architecture diagrams showing the service topology for each deployment mode.
5. THE Deployment_Docs SHALL be written in Markdown and placed in the `apps/docs` content directory for rendering in the documentation site.
6. WHEN a new environment variable is added to the CMS_API, THE Deployment_Docs SHALL document the variable's purpose, type, and default value.

### Requirement 6: Full-Text Search Integration (MeiliSearch)

**User Story:** As a content editor, I want fast full-text search across all CMS content, so that I can find and manage content efficiently.

#### Acceptance Criteria

1. THE CMS_API SHALL define a `SearchProvider` interface in `@lumibase/runtime` with methods `index(collection, documents)`, `search(collection, query, options?)`, `delete(collection, documentIds)`, and `getIndex(collection)`.
2. WHEN running in Docker mode, THE SearchProvider SHALL be backed by MeiliSearch.
3. WHEN running in Cloudflare mode, THE SearchProvider SHALL be backed by a MeiliSearch Cloud instance (via HTTP API).
4. WHEN a content item is created or updated, THE CMS_API SHALL automatically index the item in the search engine.
5. WHEN a content item is deleted, THE CMS_API SHALL remove the item from the search index.
6. THE Docker_Compose_Stack SHALL include a MeiliSearch service on port `7700` with persistent volume.
7. THE SearchProvider SHALL support filtering, sorting, and pagination of search results.
8. THE CMS_API SHALL expose a `/search` endpoint that accepts query parameters and returns ranked results.

### Requirement 7: Task Queue System (BullMQ)

**User Story:** As a developer, I want an async task queue for background operations (webhooks, content publishing, media processing), so that API responses remain fast.

#### Acceptance Criteria

1. THE CMS_API SHALL define a `QueueProvider` interface in `@lumibase/runtime` with methods `enqueue(queueName, job)`, `process(queueName, handler)`, and `getStatus(jobId)`.
2. WHEN running in Docker mode, THE QueueProvider SHALL be backed by BullMQ (using the existing Redis instance).
3. WHEN running in Cloudflare mode, THE QueueProvider SHALL be backed by Cloudflare Queues.
4. THE CMS_API SHALL use the queue for: webhook delivery, content publish/unpublish events, search index sync, and media processing tasks.
5. THE Docker_Compose_Stack SHALL include a BullMQ dashboard (Bull Board) on port `3001` for monitoring queue status.
6. IF a queued job fails, THEN THE QueueProvider SHALL retry the job up to 3 times with exponential backoff.
7. THE QueueProvider SHALL support job priority levels (high, normal, low).

### Requirement 8: Media Processing Service (Imgproxy)

**User Story:** As a content editor, I want uploaded images to be automatically optimized and available in multiple sizes/formats, so that the CMS delivers performant media.

#### Acceptance Criteria

1. THE CMS_API SHALL define a `MediaProcessor` interface in `@lumibase/runtime` with methods `transform(key, options)` and `getUrl(key, transformations)`.
2. THE Docker_Compose_Stack SHALL include an Imgproxy service on port `8080` connected to the MinIO storage.
3. THE MediaProcessor SHALL support operations: resize, crop, format conversion (WebP, AVIF), and quality adjustment.
4. WHEN a media asset is uploaded, THE CMS_API SHALL enqueue a job to generate predefined thumbnail sizes (150x150, 300x300, 600x600).
5. THE CMS_API SHALL expose media URLs with on-the-fly transformation parameters (e.g., `/media/:key?w=300&h=300&format=webp`).
6. WHEN running in Cloudflare mode, THE MediaProcessor SHALL use Cloudflare Image Resizing or a remote Imgproxy instance.
7. THE Imgproxy service SHALL be configured with signed URLs to prevent abuse.

### Requirement 9: Monitoring and Observability (Prometheus + Grafana)

**User Story:** As a DevOps engineer, I want metrics, logs, and dashboards for the CMS, so that I can monitor health and performance in production.

#### Acceptance Criteria

1. THE CMS_API SHALL expose a `/metrics` endpoint in Prometheus exposition format with metrics: request count, request duration histogram, error rate, active connections, cache hit/miss ratio.
2. THE Docker_Compose_Stack SHALL include Prometheus (port `9090`) configured to scrape the CMS_API metrics endpoint.
3. THE Docker_Compose_Stack SHALL include Grafana (port `3002`) with a pre-configured LumiBase dashboard showing: request rate, latency percentiles (p50, p95, p99), error rate, queue depth, and cache hit ratio.
4. THE CMS_API SHALL use structured JSON logging with fields: timestamp, level, requestId, method, path, status, duration.
5. THE Docker_Compose_Stack SHALL include Loki for log aggregation, connected to Grafana as a data source.
6. WHEN running in Cloudflare mode, THE CMS_API SHALL emit metrics via Workers Analytics Engine (documentation only, no self-hosted Prometheus needed).

### Requirement 10: Database Backup and Recovery

**User Story:** As a DevOps engineer, I want automated database backups and a tested recovery procedure, so that I can restore data in case of failure.

#### Acceptance Criteria

1. THE Docker_Compose_Stack SHALL include a backup service that runs `pg_dump` on a configurable schedule (default: daily at 02:00 UTC).
2. THE backup service SHALL store backups in the MinIO/S3 storage bucket with a configurable retention policy (default: 7 daily, 4 weekly).
3. THE backup service SHALL support point-in-time recovery (PITR) via WAL archiving for production deployments.
4. THE Deployment_Docs SHALL include a "Backup & Recovery" guide with step-by-step restore procedures.
5. THE Docker_Compose_Stack SHALL include a `restore` script that can restore from a specific backup file.
6. WHEN a backup fails, THE backup service SHALL send a notification (configurable: webhook, email).

### Requirement 11: Tooling Recommendations Documentation

**User Story:** As a user building a production headless CMS, I want a guide recommending complementary tools and services, so that I can build a complete content platform.

#### Acceptance Criteria

1. THE Tooling_Guide SHALL document the integrated tools (MeiliSearch, BullMQ, Imgproxy, Prometheus/Grafana) with configuration guides.
2. THE Tooling_Guide SHALL recommend additional search solutions (Typesense, Elasticsearch) as alternatives with comparison of trade-offs.
3. THE Tooling_Guide SHALL recommend additional caching strategies (CDN for delivery, edge caching patterns, Varnish).
4. THE Tooling_Guide SHALL recommend additional queue solutions (RabbitMQ, AWS SQS, Kafka) for high-throughput scenarios.
5. THE Tooling_Guide SHALL recommend additional media solutions (Cloudinary, Bunny CDN, Thumbor) as managed alternatives.
6. THE Tooling_Guide SHALL recommend additional monitoring tools (Datadog, Sentry, New Relic) as managed alternatives.
7. THE Tooling_Guide SHALL categorize each recommendation as "Integrated", "Alternative", or "Optional" based on typical headless CMS needs.
8. THE Tooling_Guide SHALL include docker-compose override snippets for alternative tools.

### Requirement 12: CI/CD Pipeline for Docker Builds

**User Story:** As a DevOps engineer, I want automated Docker image builds in CI, so that every merge to main produces a deployable container image.

#### Acceptance Criteria

1. WHEN a commit is pushed to the `main` branch, THE CI pipeline SHALL build the Production_Image and push it to a container registry.
2. WHEN a pull request is opened, THE CI pipeline SHALL build the Production_Image without pushing to verify the build succeeds.
3. THE CI pipeline SHALL tag images with both the git SHA and `latest` for main branch builds.
4. THE CI pipeline SHALL use Docker layer caching to reduce build times.
5. THE CI pipeline SHALL run a container health check after building to verify the image starts correctly.

### Requirement 13: Environment Parity

**User Story:** As a developer, I want the Docker environment to behave identically to the Cloudflare environment for all CMS operations, so that I can develop locally with confidence.

#### Acceptance Criteria

1. FOR ALL content CRUD operations, THE CMS_API SHALL produce identical API responses regardless of whether the active Runtime_Adapter is Cloudflare or Docker.
2. THE Abstraction_Layer SHALL ensure that cache TTL behavior is consistent between Cloudflare KV and Redis implementations.
3. THE Abstraction_Layer SHALL ensure that storage operations (upload, download, list, delete) produce identical results between R2 and MinIO implementations.
4. IF a feature is unavailable in one runtime (e.g., edge-specific optimizations), THEN THE CMS_API SHALL log a warning and gracefully degrade rather than fail.
5. THE CMS_API SHALL use the same Drizzle ORM schema and migrations across both runtimes.
