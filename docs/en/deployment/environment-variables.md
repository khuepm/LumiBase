---
version: 2
lastUpdated: 2026-07-28T10:30:25.628Z
sourceLang: en
contentHash: 9d27520c67af75a0
codeVerified: 2026-07-28T10:30:25.628Z
codeVerifiedHash: 9d27520c67af75a0
codeVerifiedClaims: 60
---

# Environment Variables Reference

<!-- verify-code-refs: planned LUMIBASE_REALTIME_ENABLED -->

> **For AI agents:** All required variables must be set before starting the CMS API. Missing required variables will cause startup to fail with an explicit error message.

This page documents every environment variable and Cloudflare binding used by LumiBase.

---

## Core runtime

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LUMIBASE_ENV` | ✓ | — | Environment label: `development`, `staging`, `production` |
| `LUMIBASE_RUNTIME` | Docker only | `cloudflare` | `docker` for Node.js/Docker; Cloudflare Workers infers from bindings |
| `JWT_SECRET` | ✓ | — | Secret for signing/verifying application JWTs. Min 32 chars. **For Cloudflare production, set with `wrangler secret put JWT_SECRET --env production`; never commit or place in `[env.production.vars]`.** |
| `LUMIBASE_DEV_AUTH` | Local dev only | `false` | Set to `true` to bypass Logto auth in local dev. **Never enable in production; `pnpm release:check` fails if production resolves to `true`.** |
| `LUMIBASE_REALTIME_ENABLED` | ✗ | — | **Not implemented.** Nothing reads this yet; setting it has no effect. Tracked as the "explicit enablement" goal in [realtime implementation](../architecture/realtime-websocket-implementation.md). |
| `VITE_LUMIBASE_ALLOW_ADMIN_PATH_REDIRECT` | Setup/debug only | `false` | Client-side opt-in that allows convenience redirects to the private admin path. Keep unset in production except for a temporary controlled setup/debug window. |

The admin path is **not** configured by an environment variable. It is chosen during
the Setup Wizard and stored in the database, so it can be rotated without a
redeploy — and so it never sits in a build artifact.

It is private operational state. Do not expose it through `VITE_*` environment
variables or client build metadata, and do not automatically redirect
public/setup routes to it in production. See
[Private admin path](./private-admin-path.md).

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
| `MEILISEARCH_HOST` | If search enabled | MeiliSearch instance URL, e.g. `http://meilisearch:7700` |
| `MEILISEARCH_API_KEY` | If search enabled | MeiliSearch master or search API key |

---

## AI Copilot

| Variable | Required | Description |
|----------|----------|-------------|
| `LLM_PROVIDER` | ✗ | LLM provider: `openai`, `anthropic`, `claude`, `gemini`, `nvidia`, `vertex`, `workers-ai`, `echo` (default: `echo`) |
| `OPENAI_API_KEY` | If `openai` provider | OpenAI API key |
| `ANTHROPIC_API_KEY` | If `anthropic` / `claude` provider | Anthropic API key |
| `GEMINI_API_KEY` | If `gemini` provider | Google Gemini API key |
| `NVIDIA_API_KEY` | If `nvidia` provider | NVIDIA hosted-inference key (build.nvidia.com / NIM). Billed by NVIDIA. |
| `NVIDIA_BASE_URL` | ✗ | Override the NVIDIA endpoint — e.g. a self-hosted NIM container (`http://nim:8000/v1`). Defaults to `https://integrate.api.nvidia.com/v1`. |
| `VERTEX_ACCESS_TOKEN` | If `vertex` provider | Google Cloud OAuth 2.0 bearer (`gcloud auth print-access-token`). Tokens expire (~1h). **Billed to Google Cloud, not AWS.** |
| `VERTEX_PROJECT_ID` | If `vertex` provider | Google Cloud project id that owns the Vertex AI models. |
| `VERTEX_LOCATION` | ✗ | Vertex AI region (default: `us-central1`). |
| `LLM_MODEL` | ✗ | Model name override (e.g., `gpt-4.1-nano`, `claude-3-5-haiku-latest`, `gemini-3.5-flash`, `meta/llama-3.1-8b-instruct`) |
| `WORKERS_AI_GATEWAY` | Workers AI only | CF Workers AI gateway URL |

> **Provider ↔ billing:** `nvidia` and `vertex` call *external* clouds — NVIDIA
> and Google Cloud respectively — so their usage is **not** covered by AWS
> credit. `nvidia` (or a self-hosted NIM via `NVIDIA_BASE_URL`) and MeiliSearch
> are the pieces that pair naturally with AWS-hosted infrastructure.

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

## Pressure limiter (Docker / Node.js)

The Docker CMS process includes an overload guard for the Node.js event loop. When enabled and the process is saturated, API requests fail fast with HTTP `503`, a `SERVICE_UNAVAILABLE` JSON envelope, `Retry-After`, and `X-Lumi-Overload` instead of queueing until the container becomes unresponsive. The guard bypasses `/health` and `/metrics` by default so operators can still inspect the instance.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LUMIBASE_PRESSURE_LIMITER_ENABLED` | Docker only | `true` | Enables the Node.js overload guard. Set `false` only as a temporary mitigation while you scale or optimize the overloaded path. |
| `LUMIBASE_PRESSURE_LIMITER_SAMPLE_INTERVAL` | ✗ | `250` | Sampling interval in milliseconds for event-loop pressure checks. |
| `LUMIBASE_PRESSURE_LIMITER_MAX_EVENT_LOOP_DELAY` | ✗ | `1000` | Maximum observed event-loop delay in milliseconds before API traffic receives `503`. Set `false` to disable this threshold. |
| `LUMIBASE_PRESSURE_LIMITER_MAX_EVENT_LOOP_UTILIZATION` | ✗ | `false` | Optional utilization threshold such as `0.99`. Disabled by default because sustained useful CPU work can otherwise produce noisy rejections. |
| `LUMIBASE_PRESSURE_LIMITER_RETRY_AFTER` | ✗ | `5` | Seconds advertised in the `Retry-After` response header. |
| `LUMIBASE_PRESSURE_LIMITER_EXCLUDED_PATHS` | ✗ | `/health,/metrics` | Comma-separated path prefixes that should keep serving during overload checks. |

---

## Rate limiting

A fixed-window throttle guards the authenticated API. It keys per principal (user → API key → IP) and is scoped per site. When exceeded it returns HTTP `429` with a `RATE_LIMITED` envelope plus `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, and `Retry-After`. It fails open if the cache is unavailable, so it is defence-in-depth rather than a hard quota.

Large imports can trip the default budget. Raise `LUMIBASE_RATE_LIMIT_MAX` and prefer the bulk endpoint — see [Data import](../features/data-import.md).

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LUMIBASE_RATE_LIMIT_MAX` | ✗ | `300` | Max requests per window per principal, per site. |
| `LUMIBASE_RATE_LIMIT_WINDOW_S` | ✗ | `60` | Window length in seconds. |
| `LUMIBASE_RATE_LIMIT_DISABLED` | ✗ | (unset) | Set to `true` to disable the throttle entirely. |
| `LUMIBASE_DELIVER_RATE_LIMIT` | ✗ | `1200` | Max requests per minute per client IP on the public Delivery API (`/api/v1/deliver/*`). `0` disables. See [Caching — penetration](../features/caching.md). |
| `LUMIBASE_NEGATIVE_CACHE_TTL` | ✗ | `30` | Tombstone TTL (seconds) for confirmed absences on public read paths, before ±20% jitter. `0` disables. |

---

## GraphQL

Every GraphQL operation is validated before it runs against a depth limit and a static cost limit, rejecting abusively deep or wide queries at parse time (CWE-770). Depth is a compile-time constant (12); cost is tunable. Raise `LUMIBASE_GQL_MAX_COST` if a legitimate query is rejected. See [`graphql-api-spec.md`](../api/graphql-api-spec.md#abuse-guards).

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LUMIBASE_GQL_MAX_COST` | ✗ | `1000` | Max static cost accepted per operation. |
| `LUMIBASE_GQL_DEFAULT_LIST_SIZE` | ✗ | `20` | Cost multiplier for a list field with no literal pagination argument (or a variable one). |
| `LUMIBASE_GQL_MAX_LIST_MULTIPLIER` | ✗ | `100` | Upper clamp on any single list field's cost multiplier. |

---

## Observability

| Variable | Required | Description |
|----------|----------|-------------|
| `PROMETHEUS_ENABLED` | Docker only | `true` to expose `/metrics` endpoint |
| `LOG_LEVEL` | ✗ | Log level: `debug`, `info`, `warn`, `error` (default: `info`) |
| `LOG_FORMAT` | ✗ | `json` (default) or `pretty` (local dev) |

---

## Cloudflare Bindings

Configure these in `apps/cms/wrangler.toml` (not environment variables):

| Binding | Type | Purpose |
|---------|------|---------|
| `HYPERDRIVE` | Hyperdrive | Pooled PostgreSQL connections |
| `CONFIG_CACHE` | KV Namespace | Schema, permission, and settings cache |
| `MEDIA` | R2 Bucket | Media/file object storage |
| `SITE_ROOM` | Durable Object | Per-site WebSocket coordination (realtime) |
| `AI` | Workers AI | Workers AI binding for `workers-ai` LLM provider |

```toml
# wrangler.toml excerpt
[[hyperdrive]]
binding = "HYPERDRIVE"
id = "<your-hyperdrive-id>"

[[kv_namespaces]]
binding = "CONFIG_CACHE"
id = "<your-kv-namespace-id>"

[[r2_buckets]]
binding = "MEDIA"
bucket_name = "lumibase-media"

[durable_objects]
bindings = [{ name = "SITE_ROOM", class_name = "SiteRoom" }]
```

---

## Security checklist

Before deploying to production, verify:

- [ ] `JWT_SECRET` is at least 32 characters and stored as a Wrangler Secret or Docker secret
- [ ] `LUMIBASE_DEV_AUTH` is NOT set to `true`
- [ ] Database credentials are stored as secrets, not in `.env` files committed to git
- [ ] `S3_SECRET_ACCESS_KEY` is stored as a secret
- [ ] `RESEND_API_KEY` is stored as a secret
- [ ] CORS is configured to allow only your Studio and consumer domains
