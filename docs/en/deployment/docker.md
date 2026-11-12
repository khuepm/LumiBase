---
version: 4
lastUpdated: 2026-11-12T18:25:51.362Z
sourceLang: en
contentHash: a8e0d457c7d0b3f8
codeVerified: 2026-11-12T18:25:51.362Z
codeVerifiedHash: a8e0d457c7d0b3f8
codeVerifiedClaims: 20
---

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

> **If you are only trying this stack locally, set `DATABASE_SSL_MODE=disable`.**
> The production override defaults it to `require`
> (`DATABASE_SSL_MODE: ${DATABASE_SSL_MODE:-require}` in
> `docker/docker-compose.prod.yml`), which is correct for a managed database but
> cannot connect to the PostgreSQL container in the base compose file — that one
> serves no TLS, so the CMS fails at startup with a connection error rather than
> a configuration one. Leave the default as `require` for real deployments.

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

## Hardened image

The published image (`docker/Dockerfile`) is built to run with as little as
possible:

| Property | What it means for you |
|----------|-----------------------|
| Distroless runtime (`gcr.io/distroless/nodejs22-debian13:nonroot`) | Node.js and its runtime libraries only — no shell, no package manager, no `curl`. `docker exec -it <container> sh` does not work; use `docker debug` or an ephemeral debug container instead. |
| Non-root, fixed UID | Runs as UID/GID `65532`. The previous image also ran unprivileged, as a `lumibase` system user whose UID `adduser --system` picked at build time; the user is now a fixed, numeric UID that `runAsNonRoot` checks can verify. The application files belong to root and are not writable by that user. |
| Read-only root filesystem | The server writes nothing to disk, so the container runs with `read_only: true`. `docker/docker-compose.prod.yml` and `docker/docker-compose.gcp.yml` set it, together with `cap_drop: [ALL]`, `no-new-privileges` and `init: true`. |
| Healthcheck | `HEALTHCHECK` runs `docker/scripts/healthcheck.mjs` with the image's own Node. It probes `PORT`, or the worker health port when `LUMIBASE_PROCESS_ROLE=worker`. |
| Entrypoint | `docker/scripts/entrypoint.mjs` (Node) replaces `entrypoint.sh`. `SKIP_MIGRATIONS`, `RUN_MIGRATION_PREFLIGHT`, `MIGRATION_MODE` and the `*_FILE` secrets behave as before; `MIGRATION_MODE=preflight` (or `dry-run`) still needs only `DATABASE_URL`. Secret values, `ENCRYPTION_KEY` included, reach the server exactly as supplied. |

### Where the server writes

Nothing it needs is on the container filesystem:

| Data | Where it goes |
|------|---------------|
| Content, users, audit log, setup state | PostgreSQL (`DATABASE_URL`) |
| Cache, rate limits, queues, leader locks | Redis (`REDIS_URL`) |
| Uploaded media | S3-compatible storage (`S3_ENDPOINT`) |
| Search index | Meilisearch (`MEILISEARCH_HOST`) |
| Logs | stdout/stderr |
| `/tmp` | A 64 MiB `tmpfs` in the production compose files, only for third-party code that asks `os.tmpdir()`. LumiBase itself does not use it; a read-only `/tmp` also starts. |

Read-only inputs: `/app/dist`, `/app/drizzle`, `/app/studio`, `*_FILE` secrets,
`ENCRYPTION_KEY_<id>` files, and the optional GeoIP database at
`/var/lib/lumibase/geoip/GeoLite2-Country.mmdb`.

To run the published image the same way without Compose:

```bash
docker run --read-only --tmpfs /tmp:size=64m --cap-drop ALL \
  --security-opt no-new-privileges:true --init \
  --env-file docker/.env -p 1989:1989 ghcr.io/khuepm/lumibase-cms:<version>
```

### Verify what you pull

Every release image is scanned before anything in the release is published —
the GitHub Release, the image, the Worker and npm all wait for the gate. The
release workflow fails on any **CRITICAL** finding, in the image or in the npm lockfile (the server is
a bundle, so its npm dependencies are only visible through the lockfile).
Accepted exceptions live in `.trivyignore`, each with its reason. The image is
then signed with keyless cosign and carries an SPDX SBOM attestation; both SBOMs
(`lumibase-cms-image.spdx.json`, `lumibase-dependencies.spdx.json`) are attached
to the GitHub Release.

```bash
IMAGE=ghcr.io/khuepm/lumibase-cms:<version>
cosign verify "$IMAGE" \
  --certificate-identity-regexp '^https://github\.com/khuepm/LumiBase/\.github/workflows/release\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
cosign verify-attestation "$IMAGE" --type spdxjson \
  --certificate-identity-regexp '^https://github\.com/khuepm/LumiBase/\.github/workflows/release\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

`edge` builds from `main` are not cosign-signed; pin a release tag in production.

### Upgrading from the previous image (`lumibase` user, writable filesystem)

- **Secret files** mounted for `*_FILE` must be readable by UID `65532`
  (for example mode `0444`, or owned by `65532`). A file readable only by the
  old `lumibase` UID is not. Docker Compose `file:` secrets are bind-mounted
  with the host file's owner and mode, so a `0600` secret file owned by your
  own user is unreadable inside the container until you change its mode or
  owner on the host.
- **Bind mounts or volumes** you added under `/app` for scratch space are no
  longer writable. Nothing in LumiBase needs one; remove it, or mount a `tmpfs`.
- **Custom entrypoints or commands** that called `/entrypoint.sh`, `bash` or `sh`
  fail: there is no shell. The image entrypoint is
  `["/nodejs/bin/node", "/app/bin/entrypoint.mjs"]`; to run one migration
  command, override it with `--entrypoint /nodejs/bin/node` and pass
  `dist/migrate.cjs preflight` (or `apply`).
- **Orchestrator health probes** that used `curl` inside the container must
  switch to an HTTP probe on `/health` or to
  `/nodejs/bin/node /app/bin/healthcheck.mjs`.

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
