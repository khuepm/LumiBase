# Environment Variables Reference

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
| `LUMIBASE_REALTIME_ENABLED` | ✗ | `true` | Set to `false` to disable WebSocket at deployment level |
| `LUMIBASE_ADMIN_PATH` | ✗ | (random) | Custom path for Studio admin panel (security through obscurity) |

The admin path is private operational state. Do not expose it through `VITE_*`
environment variables or client build metadata, and do not automatically
redirect public/setup routes to it in production. See
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
| `MEILISEARCH_URL` | If search enabled | MeiliSearch instance URL |
| `MEILISEARCH_API_KEY` | If search enabled | MeiliSearch master or search API key |

---

## AI Copilot

| Variable | Required | Description |
|----------|----------|-------------|
| `LLM_PROVIDER` | ✗ | LLM provider: `openai`, `anthropic`, `claude`, `gemini`, `workers-ai`, `echo` (default: `echo`) |
| `OPENAI_API_KEY` | If `openai` provider | OpenAI API key |
| `ANTHROPIC_API_KEY` | If `anthropic` / `claude` provider | Anthropic API key |
| `GEMINI_API_KEY` | If `gemini` provider | Google Gemini API key |
| `LLM_MODEL` | ✗ | Model name override (e.g., `gpt-4.1-nano`, `claude-3-5-haiku-latest`, `gemini-3.5-flash`) |
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
