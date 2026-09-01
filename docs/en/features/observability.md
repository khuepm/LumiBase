---
version: 2
lastUpdated: 2026-08-02T19:22:34.503Z
sourceLang: vi
translatedFrom: vi
sourceHash: 3a4ed673b2da93ce
mtEngine: manual
syncStatus: human-translated
---

# Observability — Metrics, Logs, Dashboards, Tracing

## Endpoints

| Endpoint | Purpose | Auth | HTTP status |
|----------|----------|------|-------------|
| `/health` | Liveness + dependency summary for operators | None | Always `200`; body is `healthy` or `degraded` |
| `/health/ready` | Readiness probe for orchestrators | None | `200` when all probes healthy, `503` when degraded |
| `/metrics` | Prometheus exposition format | None | `200` |

These endpoints are mounted outside `/api/v1` so infra probes can call them without a JWT.

## Metrics exposed

Implementation: `apps/cms/src/routes/metrics.ts` + the `withMetrics()` middleware.

| Metric | Type | Labels |
|--------|------|--------|
| `lumibase_http_requests_total` | counter | `method`, `path`, `status` |
| `lumibase_http_request_duration_seconds` | histogram | `method`, `path` |
| `lumibase_cache_operations_total` | counter | `operation`, `hit` |
| `lumibase_queue_jobs_total` | counter | `queue`, `status` |
| `lumibase_search_queries_total` | counter | `collection` |
| `lumibase_search_duration_seconds` | histogram | `collection` |
| `lumibase_item_mutations_total` | counter | `collection`, `action`, `status` |
| `lumibase_permission_denials_total` | counter | `collection`, `action` |
| `lumibase_realtime_connections_total` | counter | `site` |
| `lumibase_webhook_dispatch_total` | counter | `target`, `status` |
| `lumibase_db_query_duration_seconds` | histogram | `operation` |
| `lumibase_http_errors_total` | counter | `method`, `path`, `code` |
| `lumibase_active_connections` | gauge | — |
| `lumibase_cache_hits_total` | counter | `provider` |
| `lumibase_cache_misses_total` | counter | `provider` |
| `lumibase_queue_depth` | gauge | `queue` |
| `lumibase_db_pool_active` | gauge | — |
| `lumibase_db_pool_idle` | gauge | — |
| `lumibase_agent_runs_total` | counter | `agent`, `status`, `stop_reason` |
| `lumibase_agent_tool_latency_seconds` | histogram | `tool`, `status` |
| `lumibase_agent_approvals_total` | counter | `subject_type`, `status` |
| `lumibase_agent_approval_latency_seconds` | histogram | `subject_type`, `status` |
| `lumibase_agent_evaluations_total` | counter | `kind`, `status` |
| `lumibase_agent_estimated_tokens_total` | counter | `tool` |
| `lumibase_agent_estimated_cost_usd_total` | counter | `tool` |
| `lumibase_agent_dead_letters_total` | counter | `agent`, `reason` |

Backend: `prom-client`. Process default metrics are collected only when the runtime exposes a working Node `process.cpuUsage()` implementation; Workers/Wrangler stubs are skipped safely.

Request path labels are normalized before recording to avoid high-cardinality labels from UUIDs and numeric IDs.

## Tracing / Apache SkyWalking POC

The Docker/Node runtime supports an optional tracing bootstrap. It is disabled by default and controlled by environment variables:

```env
LUMIBASE_TRACING_ENABLED=false
LUMIBASE_TRACING_PROVIDER=skywalking
LUMIBASE_SERVICE_NAME=lumibase-cms
OTEL_EXPORTER_OTLP_ENDPOINT=http://skywalking-oap:11800
LUMIBASE_TRACING_SAMPLING_RATIO=1
```

Enable the SkyWalking stack in Docker by including the optional compose override:

```bash
docker compose \
  -f docker/docker-compose.yml \
  -f docker/docker-compose.skywalking.yml \
  up --build
```

Disable tracing by omitting `docker/docker-compose.skywalking.yml` or setting `LUMIBASE_TRACING_ENABLED=false`.

Notes:

- Tracing is Node/Docker-only for this POC. Cloudflare Workers should use Cloudflare-native observability until a separate Workers tracing design exists.
- The OpenTelemetry SDK bootstrap must run before the Hono app import so auto-instrumentations can patch supported Node modules early.
- Changing the tracing provider/endpoint should be treated as a process-restart operation; hot reload is intentionally out of scope for this POC.
- Request spans use normalized paths and never copy `Authorization`, cookies, raw query strings, or request bodies into attributes.

## Structured logging

Every request logs JSON with fields:

```json
{
  "timestamp": "2025-...",
  "level": "info",
  "requestId": "req_xyz",
  "method": "GET",
  "path": "/api/v1/items/posts",
  "status": 200,
  "duration": 45,
  "siteId": "s_abc",
  "userId": "u_123"
}
```

- **Cloudflare**: logs are shipped via Workers Logpush to R2/S3/external.
- **Docker**: logs go to stdout, collected by Promtail/Loki or the runtime log driver.

## Stack monitoring

### Cloudflare mode

Use the built-in services:

- **Workers Analytics Engine** — emit custom metrics, query via the dashboard.
- **Workers Logpush** — log shipping.
- **Cloudflare Trace** for APM.

Documentation only — nothing is self-hosted.

### Docker mode

The metrics/log dashboard stack runs via:

```bash
docker compose -f docker/docker-compose.yml -f docker/docker-compose.monitoring.yml up
```

| Service | Port | Purpose |
|---------|------|----------|
| Prometheus | 9090 | Metrics scrape |
| Grafana | 3002 | Dashboards |
| Loki | 3100 | Log aggregation |
| pg-backup | — | Scheduled `pg_dump` |

The Tracing POC stack additionally runs the file `docker/docker-compose.skywalking.yml`:
Config: `docker/prometheus/prometheus.yml`, `docker/grafana/provisioning/`, `docker/grafana/dashboards/lumibase.json`, `docker/grafana/dashboards/agent-harness.json`.

## Pre-provisioned Grafana dashboard

The `LumiBase` dashboard (auto-loaded) includes:

- **Request rate** (req/s) over time, broken down by status class.
- **Latency percentiles** p50, p95, p99.
- **Error rate** (%) and top error codes.
- **Queue depth** for each queue (search-index, media-thumbnails, webhook).
- **Cache hit ratio** (%).
- **DB pool utilization** (active vs idle).
- **CPU / Memory** of the CMS container.

The `LumiBase Agent Harness` dashboard includes run success/fail rate, budget stop reason, tool latency, approval latency, evaluation outcome, token/cost estimate, and dead-letter enqueue rate. Repeatedly failing runs are pushed to the `agent-dead-letter` queue when the runtime queue adapter is available.

## Backup monitoring

The `pg-backup` service runs `pg_dump` daily at 02:00 UTC, uploads to MinIO/S3 with a retention of 7 daily + 4 weekly. Failures send a notification via webhook (configurable).

| Service | Port | Purpose |
|---------|------|----------|
| SkyWalking OAP | 11800 / 12800 | OTLP receiver + API |
| SkyWalking UI | 8080 | Trace explorer |

Config: `docker/prometheus/prometheus.yml`, `docker/grafana/provisioning/`, `docker/grafana/dashboards/lumibase.json`.

## Health check details

`GET /health` response:

```json
{
  "status": "healthy",
  "services": {
    "database": "healthy",
    "cache": "healthy",
    "search": "healthy",
    "storage": "healthy",
    "queue": "healthy"
  }
}
```

`GET /health` always returns `200` so it is safe as a liveness/diagnostic endpoint. `GET /health/ready` returns `503` when any dependency probe is unhealthy, so orchestrators can use it for readiness.

Probe timeout: 750ms per dependency.

## Alerting

Recommended alert rules in Prometheus:

- Error rate > 5% over 5 minutes.
- p95 latency > 500ms over 10 minutes.
- Health readiness failing.
- Queue job failures rising continuously.
- DB query duration p95 above the service SLO.

See `apps/docs/content/guides/tooling-recommendations.md` for managed alternatives (Datadog, Sentry, New Relic).
