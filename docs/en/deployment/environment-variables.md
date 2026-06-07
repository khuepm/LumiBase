# Environment Variables

This page lists the deployment variables most operators need when running LumiBase.

## CMS Runtime

---

## Core runtime

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LUMIBASE_ENV` | ✓ | — | Environment label: `development`, `staging`, `production` |
| `LUMIBASE_RUNTIME` | Docker only | `cloudflare` | `docker` for Node.js/Docker; Cloudflare Workers infers from bindings |
| `JWT_SECRET` | ✓ | — | Secret for signing/verifying application JWTs. Min 32 chars. **For Cloudflare production, set with `wrangler secret put JWT_SECRET --env production`; never commit or place in `[env.production.vars]`.** |
| `LUMIBASE_DEV_AUTH` | Local dev only | `false` | Set to `true` to bypass Logto auth in local dev. **Never enable in production; `pnpm release:check` fails if production resolves to `true`.** |
| `LUMIBASE_REALTIME_ENABLED` | ✗ | `true` | Set to `false` to disable WebSocket at deployment level |
| `LUMIBASE_ADMIN_PATH` | ✗ | (random) | Custom path for Studio admin panel (security through obscurity) |

---

## Authentication (Logto)

| Variable | Required | Description |
|----------|----------|-------------|
| `LOGTO_ENDPOINT` | ✓ | Logto instance URL (e.g., `https://your-tenant.logto.app`) |
| `LOGTO_APP_ID` | ✓ | Logto application ID |
| `LOGTO_APP_SECRET` | ✓ | Logto application secret |
| `LOGTO_JWKS_URI` | ✗ | Override JWKS URL (auto-derived from `LOGTO_ENDPOINT` if not set) |
| `CF_ACCESS_CERTS_URL` | CF Access only | Cloudflare Access JWKS URL for admin tunnel auth |
| `CF_ACCESS_AUDIENCE` | CF Access only | Cloudflare Access application audience tag |

---

## Database

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Docker only | PostgreSQL connection string (e.g., `postgres://user:pass@host:5432/lumibase`) |
| `DATABASE_POOL_MIN` | ✗ | Minimum DB pool connections (default: `2`) |
| `DATABASE_POOL_MAX` | ✗ | Maximum DB pool connections (default: `10`) |
| `DATABASE_SSL` | ✗ | `true` to require SSL for DB connection |

For Cloudflare Workers, use the `HYPERDRIVE` binding (see [Cloudflare Bindings](#cloudflare-bindings)).

---

## Cache

| Variable | Required | Description |
|----------|----------|-------------|
| `REDIS_URL` | Docker only | Redis connection string (e.g., `redis://localhost:6379`) |
| `CACHE_TTL_SCHEMA` | ✗ | Schema cache TTL in seconds (default: `60`) |
| `CACHE_TTL_PERMISSIONS` | ✗ | Permission cache TTL in seconds (default: `300`) |
| `CACHE_TTL_SETTINGS` | ✗ | Settings cache TTL in seconds (default: `60`) |

---

## Object storage

| Variable | Required | Description |
|----------|----------|-------------|
| `S3_ENDPOINT` | Docker/S3 only | S3-compatible endpoint URL (e.g., MinIO: `http://localhost:9000`) |
| `S3_ACCESS_KEY_ID` | Docker/S3 only | S3 access key |
| `S3_SECRET_ACCESS_KEY` | Docker/S3 only | S3 secret key |
| `S3_BUCKET` | Docker/S3 only | Storage bucket name (default: `lumibase-media`) |
| `S3_REGION` | ✗ | S3 region (default: `us-east-1`) |
| `S3_PUBLIC_URL` | ✗ | Public base URL for assets (e.g., CDN URL pointing to the bucket) |

---

## Search (MeiliSearch)

| Variable | Required | Description |
|----------|----------|-------------|
| `MEILISEARCH_URL` | If search enabled | MeiliSearch instance URL |
| `MEILISEARCH_API_KEY` | If search enabled | MeiliSearch master or search API key |

---

## AI Copilot

| Variable | Required | Description |
|----------|----------|-------------|
| `LLM_PROVIDER` | ✗ | LLM provider: `openai`, `anthropic`, `workers-ai`, `echo` (default: `echo`) |
| `OPENAI_API_KEY` | If `openai` provider | OpenAI API key |
| `ANTHROPIC_API_KEY` | If `anthropic` provider | Anthropic API key |
| `LLM_MODEL` | ✗ | Model name override (e.g., `gpt-4o`, `claude-3-5-sonnet-20241022`) |
| `WORKERS_AI_GATEWAY` | Workers AI only | CF Workers AI gateway URL |

---

## Email (Resend)

| Variable | Required | Description |
|----------|----------|-------------|
| `RESEND_API_KEY` | If email enabled | Resend API key for transactional email |
| `EMAIL_FROM` | If email enabled | Sender address (e.g., `noreply@yourdomain.com`) |

---

## SCIM provisioning

| Variable | Required | Description |
|----------|----------|-------------|
| `SCIM_TOKEN` | If SCIM enabled | Bearer token for `/scim/v2/` endpoint authentication |

---

## Observability

| Variable | Required | Description |
|----------|----------|-------------|
| `PROMETHEUS_ENABLED` | Docker only | `true` to expose `/metrics` endpoint |
| `LOG_LEVEL` | ✗ | Log level: `debug`, `info`, `warn`, `error` (default: `info`) |
| `LOG_FORMAT` | ✗ | `json` (default) or `pretty` (local dev) |

---

## Cloudflare Bindings

| Binding | Type | Purpose |
| --- | --- | --- |
| `HYPERDRIVE` | Hyperdrive | Pooled PostgreSQL connections for the Worker runtime. |
| `CONFIG_CACHE` | KV | Schema, permission and settings cache. |
| `MEDIA` | R2 | Media object storage. |
| `SITE_ROOM` | Durable Object | Per-site realtime coordination. |

## Docker Services

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | Yes | PostgreSQL connection string. |
| `REDIS_URL` | Yes | Redis connection string for cache/queue adapters. |
| `S3_ENDPOINT` | If media enabled | MinIO or S3-compatible endpoint. |
| `S3_ACCESS_KEY_ID` | If media enabled | Object storage access key. |
| `S3_SECRET_ACCESS_KEY` | If media enabled | Object storage secret key. |
| `S3_BUCKET` | If media enabled | Media bucket name. |

Do not commit production secrets. Use Wrangler secrets for Workers and environment-specific secret storage for Docker.
