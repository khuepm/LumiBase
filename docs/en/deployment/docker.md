# Docker Deployment

Docker mode runs the same CMS API in Node.js and uses self-hosted infrastructure for stateful services.

## Services

The base compose file is `docker/docker-compose.yml`. Add the production override
`docker/docker-compose.prod.yml` for production/self-hosted runs. The production
override is intended to run:

- CMS API as a Node.js container from the published CMS image.
- PostgreSQL for application data.
- Redis for cache and queue adapters.
- MinIO for S3-compatible media storage.
- Optional observability services such as Prometheus and Grafana.

## Configure

Start from the example environment file:

```bash
cp docker/.env.example docker/.env
```

Set production values for database, Redis, object storage, JWT and admin authentication before starting the stack.

## Start production

Pin the CMS image with `LUMIBASE_VERSION` so production runs a predictable
release. If unset, `docker/docker-compose.prod.yml` falls back to `latest`.

```bash
LUMIBASE_VERSION=0.4.3 docker compose -f docker/docker-compose.yml -f docker/docker-compose.prod.yml up -d
```

Verify the API:

```bash
curl -fsS http://localhost:1989/health
```

## Build locally instead of pulling the published image

Keep local builds in a separate override so production uses the published image
by default. Add `docker/docker-compose.build.yml` after the production override:

```bash
docker compose \
  -f docker/docker-compose.yml \
  -f docker/docker-compose.prod.yml \
  -f docker/docker-compose.build.yml \
  up -d --build
```

## Note: `SERVICE_UNAVAILABLE` when the instance is under pressure

If a client receives HTTP `503` with a body similar to:

```json
{
  "errors": [
    {
      "code": "SERVICE_UNAVAILABLE",
      "message": "LumiBase API is temporarily unavailable because this instance is under pressure. Retry later.",
      "details": { "reason": "event_loop_delay" }
    }
  ]
}
```

it does not necessarily mean the CMS service is dead. In Docker mode, `LUMIBASE_PRESSURE_LIMITER_ENABLED=true` lets the CMS protect itself when the Node.js event loop is saturated. The guard returns `503` with `Retry-After` so clients and upstream proxies can retry in a controlled way instead of adding more work to an overloaded process.

Common causes include bursty API traffic, undersized CPU/RAM, heavy export or analytics endpoints, queries that fetch too much data before filtering or JSON processing in JavaScript, slow cache/queue backends, or Docker networking misconfiguration such as using `localhost` instead of the Compose service name for PostgreSQL.

Quick checks:

```bash
docker stats
docker compose logs --since=10m cms
curl -i http://localhost:1989/health
curl -s http://localhost:1989/metrics | grep -E 'nodejs_eventloop|process_cpu|lumibase_http_request_duration'
```

Temporary tuning while investigating:

```env
LUMIBASE_PRESSURE_LIMITER_MAX_EVENT_LOOP_DELAY=1500
LUMIBASE_PRESSURE_LIMITER_MAX_EVENT_LOOP_UTILIZATION=false
LUMIBASE_PRESSURE_LIMITER_RETRY_AFTER=5
```

Disable the guard only briefly when another layer already provides overload protection:

```env
LUMIBASE_PRESSURE_LIMITER_ENABLED=false
```

The long-term fix is to identify the endpoint causing spikes, optimize query/index/pagination/export streaming, or add CMS replicas/CPU.

## Request size & rate limits

The Caddy reverse proxy caps request bodies before they reach the CMS
(`docker/Caddyfile`): 10 MB for the general API and 50 MB for media/asset
upload routes (`/api/v1/media*`, `/api/v1/files*`). Keep the media cap in
sync with `FILE_UPLOAD_MAX_BYTES` if you change either. Tune the general cap
for your workload — most JSON APIs never need more than a few MB.

As defense-in-depth for deployments that don't front the CMS with Caddy
(a bare Node process, or a different proxy), the app also rejects oversized
JSON bodies itself:

```env
# Max JSON request body in bytes for the app-level guard (default 1 MiB).
# Returns 413 { errors: [{ code: "PAYLOAD_TOO_LARGE" }] } when exceeded.
LUMIBASE_MAX_JSON_BODY=1048576
```

## Caching & write-amplification knobs

```env
# Delivery API shared-cache lifetime, seconds (default 60). 0 disables
# public caching (responses become private, no-store).
LUMIBASE_DELIVER_SMAXAGE=60
# Delivery API stale-while-revalidate window, seconds (default 300).
LUMIBASE_DELIVER_SWR=300
# Negative-cache (tombstone) TTL in seconds before ±20% jitter (default 30).
# 0 disables tombstones. See docs/en/features/caching.md.
LUMIBASE_NEGATIVE_CACHE_TTL=30
# Delivery API IP rate limit, requests per minute (default 1200). 0 = off.
LUMIBASE_DELIVER_RATE_LIMIT=1200
# Debounce window (seconds) for API-key lastUsedAt writes (default 60).
# Under read load, an API key's last-used timestamp is refreshed at most
# once per window instead of on every request. 0 = write on every request.
LUMIBASE_APIKEY_TOUCH_INTERVAL=60
```

## Roll back

To roll back the CMS container to a previous release:

1. Change `LUMIBASE_VERSION` back to the previous version.
2. Pull the pinned CMS image.
3. Recreate only the CMS service.

```bash
docker compose pull cms
docker compose up -d cms
```

Docker mode is useful for local production rehearsals and self-hosted installations. Cloudflare Workers remains the default edge deployment path.

## Updating

Before upgrading to any release whose changelog `Migrations` section lists database changes, create and verify a PostgreSQL backup or storage snapshot. Keep the snapshot until the new CMS version is healthy and the migration version matches the expected release notes.

Run a read-only preflight against the new image before replacing the running CMS container:

```bash
docker compose -f docker/docker-compose.prod.yml --env-file docker/.env run --rm -e MIGRATION_MODE=preflight cms
```

The preflight checks `DATABASE_URL` connectivity, prints the current Drizzle schema version, and lists pending migrations without applying DDL. Normal container startup runs this preflight before applying migrations unless `RUN_MIGRATION_PREFLIGHT=false` is set.
