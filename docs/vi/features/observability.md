---
version: 1
lastUpdated: 2026-06-23T13:05:48.000Z
sourceLang: vi
contentHash: d668bbc29e7fdaba
---

# Observability — Metrics, Logs, Dashboards, Tracing

## Endpoints

| Endpoint | Mục đích | Auth | HTTP status |
|----------|----------|------|-------------|
| `/health` | Liveness + dependency summary for operators | None | Always `200`; body is `healthy` or `degraded` |
| `/health/ready` | Readiness probe for orchestrators | None | `200` when all probes healthy, `503` when degraded |
| `/metrics` | Prometheus exposition format | None | `200` |

Các endpoint này mount ngoài `/api/v1` để infra probes có thể gọi không cần JWT.

## Metrics exposed

Implementation: `apps/cms/src/routes/metrics.ts` + middleware `withMetrics()`.

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

Docker/Node runtime supports an optional tracing bootstrap. It is disabled by default and controlled by environment variables:

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
- OpenTelemetry SDK bootstrap must run before the Hono app import so auto-instrumentations can patch supported Node modules early.
- Changing tracing provider/endpoint should be treated as a process restart operation; hot reload is intentionally out of scope for this POC.
- Request spans use normalized paths and never copy `Authorization`, cookies, raw query strings, or request bodies into attributes.

## Structured logging

Mọi request log JSON với fields:

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

- **Cloudflare**: log đẩy qua Workers Logpush ra R2/S3/external.
- **Docker**: log stdout, được Promtail/Loki hoặc runtime log driver thu thập.

## Stack monitoring

### Cloudflare mode

Dùng built-in services:

- **Workers Analytics Engine** — emit custom metrics, query qua dashboard.
- **Workers Logpush** — log shipping.
- **Cloudflare Trace** cho APM.

Documentation only — không tự host gì cả.

### Docker mode

Metrics/log dashboard stack chạy qua:

```bash
docker compose -f docker/docker-compose.yml -f docker/docker-compose.monitoring.yml up
```

| Service | Port | Mục đích |
|---------|------|----------|
| Prometheus | 9090 | Metrics scrape |
| Grafana | 3002 | Dashboards |
| Loki | 3100 | Log aggregation |
| pg-backup | — | Scheduled `pg_dump` |

Tracing POC stack chạy thêm file `docker/docker-compose.skywalking.yml`:
Config: `docker/prometheus/prometheus.yml`, `docker/grafana/provisioning/`, `docker/grafana/dashboards/lumibase.json`, `docker/grafana/dashboards/agent-harness.json`.

## Pre-provisioned Grafana dashboard

Dashboard `Lumibase` (auto-loaded) bao gồm:

- **Request rate** (req/s) over time, broken by status class.
- **Latency percentiles** p50, p95, p99.
- **Error rate** (%) and top error codes.
- **Queue depth** for each queue (search-index, media-thumbnails, webhook).
- **Cache hit ratio** (%).
- **DB pool utilization** (active vs idle).
- **CPU / Memory** of CMS container.

Dashboard `Lumibase Agent Harness` bao gồm run success/fail rate, budget stop reason, tool latency, approval latency, evaluation outcome, token/cost estimate và dead-letter enqueue rate. Run fail lặp lại được đẩy vào queue `agent-dead-letter` khi runtime queue adapter khả dụng.

## Backup monitoring

`pg-backup` service runs `pg_dump` daily at 02:00 UTC, uploads to MinIO/S3 với retention 7 daily + 4 weekly. Failures send notification qua webhook (configurable).

| Service | Port | Mục đích |
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

Khuyến nghị alert rules trong Prometheus:

- Error rate > 5% trong 5 phút.
- p95 latency > 500ms trong 10 phút.
- Health readiness fail.
- Queue job failures rising continuously.
- DB query duration p95 above service SLO.

Xem `apps/docs/content/guides/tooling-recommendations.md` cho managed alternatives (Datadog, Sentry, New Relic).
