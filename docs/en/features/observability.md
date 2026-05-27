# Observability — Metrics, Logs, Dashboards

## Endpoints

| Endpoint | Mục đích | Auth |
|----------|----------|------|
| `/health` | Liveness + readiness probe (test DB, cache, search, storage, queue) | None |
| `/metrics` | Prometheus exposition format | None |

Cả hai mount ngoài `/api/v1` — không cần JWT, dùng cho infra probes.

## Metrics exposed

Implementation: `apps/cms/src/routes/metrics.ts` + middleware `withMetrics()`.

| Metric | Type | Labels |
|--------|------|--------|
| `lumibase_http_requests_total` | counter | `method`, `path`, `status` |
| `lumibase_http_request_duration_seconds` | histogram | `method`, `path` |
| `lumibase_http_errors_total` | counter | `method`, `path`, `code` |
| `lumibase_active_connections` | gauge | — |
| `lumibase_cache_hits_total` | counter | `provider` |
| `lumibase_cache_misses_total` | counter | `provider` |
| `lumibase_queue_depth` | gauge | `queue` |
| `lumibase_db_pool_active` | gauge | — |
| `lumibase_db_pool_idle` | gauge | — |

Backend: `prom-client` (works trên Node + emulated trong Workers).

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
- **Docker**: log stdout, được Promtail pick lên Loki.

## Stack monitoring

### Cloudflare mode

Dùng built-in services:

- **Workers Analytics Engine** — emit custom metrics, query qua dashboard.
- **Workers Logpush** — log shipping.
- **Cloudflare Trace** cho APM.

Documentation only — không tự host gì cả.

### Docker mode

Toàn bộ stack chạy qua `docker compose -f docker-compose.yml -f docker-compose.monitoring.yml up`:

| Service | Port | Mục đích |
|---------|------|----------|
| Prometheus | 9090 | Metrics scrape |
| Grafana | 3002 | Dashboards |
| Loki | 3100 | Log aggregation |
| Promtail | — | Log shipping (per-host) |
| pg-backup | — | Scheduled `pg_dump` |

Config: `docker/prometheus/prometheus.yml`, `docker/grafana/provisioning/`, `docker/grafana/dashboards/lumibase.json`.

## Pre-provisioned Grafana dashboard

Dashboard `Lumibase` (auto-loaded) bao gồm:

- **Request rate** (req/s) over time, broken by status class.
- **Latency percentiles** p50, p95, p99.
- **Error rate** (%) and top error codes.
- **Queue depth** for each queue (search-index, media-thumbnails, webhook).
- **Cache hit ratio** (%).
- **DB pool utilization** (active vs idle).
- **CPU / Memory** of CMS container.

## Backup monitoring

`pg-backup` service runs `pg_dump` daily at 02:00 UTC, uploads to MinIO/S3 với retention 7 daily + 4 weekly. Failures send notification qua webhook (configurable).

Restore: `docker/scripts/restore.sh <backup-key>`.

Xem `apps/docs/content/guides/backup-recovery.md` cho disaster recovery playbook.

## Health check details

`GET /health` response:

```json
{
  "status": "ok",
  "checks": {
    "database": { "status": "ok", "latency": 5 },
    "cache":    { "status": "ok", "latency": 1 },
    "search":   { "status": "ok", "latency": 12 },
    "storage":  { "status": "ok", "latency": 8 },
    "queue":    { "status": "ok", "latency": 2 }
  }
}
```

Trả 200 nếu tất cả `ok`, 503 nếu bất kỳ check nào fail. Probe interval khuyến nghị: 30s.

## Alerting

Khuyến nghị alert rules trong Prometheus:

- Error rate > 5% trong 5 phút.
- p95 latency > 500ms trong 10 phút.
- Queue depth > 1000 items trong 5 phút.
- DB pool active = max trong 2 phút (saturation).
- Health check fail.

Xem `apps/docs/content/guides/tooling-recommendations.md` cho managed alternatives (Datadog, Sentry, New Relic).
