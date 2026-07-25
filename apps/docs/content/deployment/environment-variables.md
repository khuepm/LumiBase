# Environment Variables Reference

Complete reference for all LumiBase CMS environment variables across both runtimes.

## Runtime Selection

| Variable | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `LUMIBASE_RUNTIME` | `string` | No | `docker` | Runtime mode. Values: `cloudflare` or `docker`. Determines which adapter set is loaded. |
| `PORT` | `number` | No | `1989` | HTTP server listen port (Docker mode only). |
| `LUMIBASE_ENV` | `string` | No | `development` | Environment name. Values: `development`, `preview`, `production`. Affects logging verbosity and dev features. |
| `NODE_ENV` | `string` | No | — | Set to `production` in production Docker images. Enables production config validation. |

## Database

| Variable | Type | Required | Default | Runtime | Description |
|----------|------|----------|---------|---------|-------------|
| `DATABASE_URL` | `string` | Yes | — | Docker | PostgreSQL connection string. Format: `postgresql://user:password@host:port/database` |
| `DATABASE_URL_FILE` | `string` | No | — | Docker | File path containing `DATABASE_URL`. Used for Docker secrets when `DATABASE_URL` is unset. |
| `DATABASE_SSL_MODE` | `string` | No | `require` in production | Docker | Set to `disable` only for private non-TLS test stacks. Otherwise `DATABASE_URL` must include `sslmode=require`, `sslmode=verify-ca`, or `sslmode=verify-full`. |
| `HYPERDRIVE` | binding | Yes | — | Cloudflare | Hyperdrive binding (configured in `wrangler.toml`, not set as env var). Provides connection pooling to PostgreSQL. |

### Database URL Examples

```bash
# Local development
DATABASE_URL=postgresql://lumibase:lumibase_dev@localhost:5432/lumibase

# Production with SSL
DATABASE_URL=postgresql://user:password@db.example.com:5432/lumibase?sslmode=require

# AWS RDS
DATABASE_URL=postgresql://admin:secret@mydb.cluster-abc123.us-east-1.rds.amazonaws.com:5432/lumibase

# Neon (serverless)
DATABASE_URL=postgresql://user:pass@ep-cool-name-123456.us-east-2.aws.neon.tech/lumibase?sslmode=require
```

## Cache (Redis / KV)

| Variable | Type | Required | Default | Runtime | Description |
|----------|------|----------|---------|---------|-------------|
| `REDIS_URL` | `string` | Yes | — | Docker | Redis connection URL. Used for caching and BullMQ queues. |
| `REDIS_URL_FILE` | `string` | No | — | Docker | File path containing `REDIS_URL`. Used for Docker secrets when `REDIS_URL` is unset. |
| `CONFIG_CACHE` | binding | Yes | — | Cloudflare | KV namespace binding (configured in `wrangler.toml`). |

### Redis URL Examples

```bash
# Local development
REDIS_URL=redis://localhost:6379

# With password
REDIS_URL=redis://:mypassword@redis-host:6379

# Redis Cluster (AWS ElastiCache)
REDIS_URL=rediss://user:pass@clustercfg.my-cluster.abc123.use1.cache.amazonaws.com:6379

# Upstash (serverless Redis)
REDIS_URL=rediss://default:token@us1-abc-12345.upstash.io:6379
```

## Object Storage (S3 / R2)

| Variable | Type | Required | Default | Runtime | Description |
|----------|------|----------|---------|---------|-------------|
| `S3_ENDPOINT` | `string` | Yes | — | Docker | S3-compatible endpoint URL. |
| `S3_ACCESS_KEY` | `string` | Yes | — | Docker | S3 access key ID. |
| `S3_SECRET_KEY` | `string` | Yes | — | Docker | S3 secret access key. |
| `S3_BUCKET` | `string` | Yes | — | Docker | S3 bucket name for media storage. |
| `S3_REGION` | `string` | No | `us-east-1` | Docker | S3 region (required for AWS S3, optional for MinIO). |
| `MEDIA` | binding | Yes | — | Cloudflare | R2 bucket binding (configured in `wrangler.toml`). |

### S3 Endpoint Examples

```bash
# MinIO (local development)
S3_ENDPOINT=http://localhost:9000

# AWS S3
S3_ENDPOINT=https://s3.us-east-1.amazonaws.com

# DigitalOcean Spaces
S3_ENDPOINT=https://nyc3.digitaloceanspaces.com

# Backblaze B2
S3_ENDPOINT=https://s3.us-west-004.backblazeb2.com
```

## Search (MeiliSearch)

| Variable | Type | Required | Default | Runtime | Description |
|----------|------|----------|---------|---------|-------------|
| `MEILISEARCH_HOST` | `string` | Yes | — | Both | MeiliSearch instance URL. |
| `MEILISEARCH_API_KEY` | `string` | Yes | — | Both | MeiliSearch API key (master key or search key). |

### MeiliSearch Examples

```bash
# Local development (Docker Compose)
MEILISEARCH_HOST=http://meilisearch:7700
MEILISEARCH_API_KEY=lumibase_dev_key

# MeiliSearch Cloud
MEILISEARCH_HOST=https://ms-abc123.sfo.meilisearch.io
MEILISEARCH_API_KEY=your-cloud-api-key

# Self-hosted production
MEILISEARCH_HOST=https://search.yourdomain.com
MEILISEARCH_API_KEY=your-master-key
```

## Media Processing (Imgproxy)

| Variable | Type | Required | Default | Runtime | Description |
|----------|------|----------|---------|---------|-------------|
| `IMGPROXY_URL` | `string` | Yes | — | Docker | Imgproxy base URL for image transformations. |
| `IMGPROXY_KEY` | `string` | Yes | — | Docker | Imgproxy HMAC key (hex-encoded) for URL signing. |
| `IMGPROXY_SALT` | `string` | Yes | — | Docker | Imgproxy HMAC salt (hex-encoded) for URL signing. |

### Generating Imgproxy Keys

```bash
# Generate random hex key and salt
echo $(head -c 32 /dev/urandom | xxd -p -c 64)
echo $(head -c 32 /dev/urandom | xxd -p -c 64)
```

## Authentication (OIDC)

| Variable | Type | Required | Default | Runtime | Description |
|----------|------|----------|---------|---------|-------------|
| `LOGTO_ISSUER` | `string` | No | — | Both | OIDC issuer URL (e.g., Logto instance). Required for production. |
| `LOGTO_AUDIENCE` | `string` | No | — | Both | OIDC audience identifier. Typically your API URL. |
| `JWT_SECRET` | `string` | Yes in production | — | Both | Secret used for application JWT verification/signing. In Cloudflare production, set with `wrangler secret put JWT_SECRET --env production`; never hardcode in `[env.production.vars]`. |
| `JWT_SECRET_FILE` | `string` | No | — | Docker | File path containing `JWT_SECRET`. Used for Docker secrets when `JWT_SECRET` is unset. |
| `LUMIBASE_DEV_AUTH` | `string` | No | `false` | Both | Enable dev auth mode. Accepts `Bearer dev:<logtoId>` tokens. **Never enable in production; `pnpm release:check` blocks production deploys when it is `true`.** |

### Authentication Examples

```bash
# Logto Cloud
LOGTO_ISSUER=https://your-tenant.logto.app/oidc
LOGTO_AUDIENCE=https://api.yourdomain.com

# Self-hosted Logto
LOGTO_ISSUER=https://auth.yourdomain.com/oidc
LOGTO_AUDIENCE=https://api.yourdomain.com
```

## Encryption

| Variable | Type | Required | Default | Runtime | Description |
|----------|------|----------|---------|---------|-------------|
| `ENCRYPTION_KEY` | `string` | Yes in production | — | Both | AES-GCM encryption key (base64-encoded, 128/192/256-bit; 256-bit recommended). Used for encrypting sensitive field values at rest. |
| `ENCRYPTION_KEY_FILE` | `string` | No | — | Docker | File path containing `ENCRYPTION_KEY`. Used for Docker secrets when `ENCRYPTION_KEY` is unset. |

### Generating an Encryption Key

```bash
# Generate a 256-bit key, base64-encoded
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## CORS

| Variable | Type | Required | Default | Runtime | Description |
|----------|------|----------|---------|---------|-------------|
| `CORS_ALLOWED_ORIGINS` | `string` | Yes in production | permissive in non-production | Both | Comma-separated list of allowed frontend origins, for example `https://studio.example.com,https://app.example.com`. Wildcard `*` is rejected in production. |

## Docker Compose Defaults

The following values are pre-configured in `docker/.env.example` for local development:

```bash
LUMIBASE_RUNTIME=docker
DATABASE_URL=postgresql://lumibase:lumibase_dev@postgres:5432/lumibase
REDIS_URL=redis://redis:6379
S3_ENDPOINT=http://minio:9000
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
S3_BUCKET=lumibase-media
MEILISEARCH_HOST=http://meilisearch:7700
MEILISEARCH_API_KEY=lumibase_dev_key
IMGPROXY_URL=http://imgproxy:8080
IMGPROXY_KEY=736563726574
IMGPROXY_SALT=736563726574
PORT=1989
```

> **Note:** These defaults use Docker Compose service names (e.g., `postgres`, `redis`) as hostnames. When running the CMS outside Docker, replace them with `localhost`.

## Cloudflare Bindings Summary

These are configured in `wrangler.toml`, not as environment variables:

| Binding | Type | `wrangler.toml` Section |
|---------|------|------------------------|
| `HYPERDRIVE` | Hyperdrive | `[[hyperdrive]]` |
| `CONFIG_CACHE` | KV Namespace | `[[kv_namespaces]]` |
| `MEDIA` | R2 Bucket | `[[r2_buckets]]` |

Secrets set via `wrangler secret put`:

| Secret | Description |
|--------|-------------|
| `JWT_SECRET` | Application JWT signing/verification secret |
| `CF_ACCESS_CERTS_URL` | Cloudflare Access JWKS URL |
| `CF_ACCESS_AUDIENCE` | Cloudflare Access application audience tag |
| `LOGTO_ISSUER` | OIDC issuer URL |
| `LOGTO_AUDIENCE` | OIDC audience |
| `ENCRYPTION_KEY` | AES-GCM key |
| `MEILISEARCH_HOST` | MeiliSearch Cloud URL |
| `MEILISEARCH_API_KEY` | MeiliSearch API key |

## Variable Validation

The CMS validates required environment variables at startup. If a required variable is missing, the process exits with a clear error message:

```
[lumibase-cms] ERROR: Missing required environment variable: DATABASE_URL
[lumibase-cms] See https://docs.lumibase.dev/deployment/environment-variables for reference.
```

## Next Steps

- [Deployment Overview](./overview.md) — Compare deployment options
- [Docker Deployment](./docker.md) — Production Docker setup
- [Cloudflare Deployment](./cloudflare.md) — Edge deployment setup
