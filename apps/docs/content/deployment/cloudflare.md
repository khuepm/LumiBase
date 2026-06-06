# Cloudflare Deployment Guide

Deploy Lumibase to Cloudflare Workers for ultra-low latency edge delivery. This guide covers setting up all required Cloudflare services.

## Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/sign-up) (Workers Paid plan recommended)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) v3+
- Node.js 20+ and pnpm
- A PostgreSQL database accessible from the internet (Neon, Supabase, or any hosted PG)

## Step 1: Install and Authenticate Wrangler

```bash
# Install Wrangler globally
pnpm add -g wrangler

# Authenticate with your Cloudflare account
wrangler login
```

Verify authentication:

```bash
wrangler whoami
```

## Step 2: Configure Hyperdrive (Database Pooling)

Hyperdrive provides connection pooling between Cloudflare Workers and your PostgreSQL database, dramatically reducing query latency.

```bash
# Create a Hyperdrive configuration
wrangler hyperdrive create lumibase-hyperdrive \
  --connection-string="postgresql://user:password@host:5432/lumibase"
```

Note the returned Hyperdrive ID. Add it to `wrangler.toml`:

```toml
[[hyperdrive]]
binding = "HYPERDRIVE"
id = "your-hyperdrive-id-here"
```

### Hyperdrive Tips

- Use a database in a region close to your primary user base
- Hyperdrive caches prepared statements and pools connections automatically
- Connection string format: `postgresql://USER:PASSWORD@HOST:PORT/DATABASE?sslmode=require`

## Step 3: Create KV Namespace (Cache)

KV provides globally distributed key-value storage for caching configurations and permissions.

```bash
# Create the KV namespace
wrangler kv namespace create CONFIG_CACHE

# Create a preview namespace for local development
wrangler kv namespace create CONFIG_CACHE --preview
```

Add both namespace IDs to `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "CONFIG_CACHE"
id = "your-kv-namespace-id"
preview_id = "your-preview-kv-namespace-id"
```

## Step 4: Create R2 Bucket (Object Storage)

R2 provides S3-compatible object storage for media files with zero egress fees.

```bash
# Create the R2 bucket
wrangler r2 bucket create lumibase-media
```

Add the bucket binding to `wrangler.toml`:

```toml
[[r2_buckets]]
binding = "MEDIA"
bucket_name = "lumibase-media"
```

### Optional: Configure Custom Domain for R2

To serve media files from a custom domain:

1. Go to **R2 > lumibase-media > Settings > Public access**
2. Add a custom domain (e.g., `media.yourdomain.com`)
3. Cloudflare will automatically provision TLS

## Step 5: Configure MeiliSearch Cloud (Search)

For search functionality on Cloudflare, use [MeiliSearch Cloud](https://www.meilisearch.com/cloud):

1. Create a MeiliSearch Cloud project
2. Note the host URL and API key
3. Set them as secrets (see Step 6)

## Step 6: Set Environment Variables

Use Wrangler secrets for sensitive production values. Do not hardcode these values in `wrangler.toml` or commit them to git:

```bash
# CMS auth and Cloudflare Access
wrangler secret put JWT_SECRET --env production
wrangler secret put CF_ACCESS_CERTS_URL --env production
wrangler secret put CF_ACCESS_AUDIENCE --env production

# Optional providers/features
wrangler secret put ENCRYPTION_KEY --env production
wrangler secret put MEILISEARCH_HOST --env production
wrangler secret put MEILISEARCH_API_KEY --env production
```

Set only non-sensitive variables in `wrangler.toml`. Keep local/dev defaults in top-level `[vars]`, and keep staging/production values under named environments:

```toml
[vars]
LUMIBASE_ENV = "development"
LUMIBASE_DEV_AUTH = "true"
JWT_SECRET = "dev_secret_key"

[env.staging.vars]
LUMIBASE_ENV = "staging"
LUMIBASE_DEV_AUTH = "false"

[env.production.vars]
LUMIBASE_ENV = "production"
LUMIBASE_DEV_AUTH = "false"
```

## Step 7: Deploy

```bash
# Validate production config before deploy
pnpm release:check

# Deploy to production
pnpm --filter @lumibase/cms deploy:production

# Deploy to staging
pnpm --filter @lumibase/cms deploy:staging
```

### Verify Deployment

```bash
# Check the health endpoint
curl https://your-worker.your-subdomain.workers.dev/health
```

Expected response:

```json
{
  "status": "healthy",
  "services": {
    "database": "healthy",
    "cache": "healthy",
    "storage": "healthy",
    "search": "healthy"
  }
}
```

## Step 8: Configure Custom Domain (Optional)

1. Go to **Workers & Pages > lumibase-cms > Settings > Triggers**
2. Add a custom domain (e.g., `api.yourdomain.com`)
3. Cloudflare handles TLS and DNS automatically

## Complete `wrangler.toml` Example

```toml
name = "lumibase-cms"
main = "src/index.ts"
compatibility_date = "2024-10-01"
compatibility_flags = ["nodejs_compat"]

[vars]
LUMIBASE_RUNTIME = "cloudflare"
LUMIBASE_ENV = "production"

[[hyperdrive]]
binding = "HYPERDRIVE"
id = "abc123-your-hyperdrive-id"

[[kv_namespaces]]
binding = "CONFIG_CACHE"
id = "def456-your-kv-id"
preview_id = "ghi789-your-preview-kv-id"

[[r2_buckets]]
binding = "MEDIA"
bucket_name = "lumibase-media"

# Staging environment overrides
[env.staging.vars]
LUMIBASE_ENV = "staging"
LUMIBASE_DEV_AUTH = "false"

# Production environment overrides
[env.production.vars]
LUMIBASE_ENV = "production"
LUMIBASE_DEV_AUTH = "false"

# Production secrets are set with Wrangler, not hardcoded:
# wrangler secret put JWT_SECRET --env production
# wrangler secret put CF_ACCESS_CERTS_URL --env production
# wrangler secret put CF_ACCESS_AUDIENCE --env production
```

## Multi-Environment Setup

### Staging

```bash
# Create separate resources for staging
wrangler hyperdrive create lumibase-hyperdrive-staging \
  --connection-string="postgresql://user:password@host:5432/lumibase_staging"

wrangler kv namespace create CONFIG_CACHE --env staging
wrangler r2 bucket create lumibase-media-staging
```

### Environment-Specific Deploys

```bash
wrangler deploy --env staging
wrangler deploy --env production
```

## Monitoring on Cloudflare

Cloudflare provides built-in observability:

- **Workers Analytics** — Request counts, CPU time, errors
- **Logpush** — Stream Worker logs to external services
- **Tail** — Real-time log streaming during development

```bash
# Stream live logs
wrangler tail
```

## Troubleshooting

### Hyperdrive Connection Failures

- Verify your database allows connections from Cloudflare IP ranges
- Check that the connection string includes `?sslmode=require`
- Ensure the database is not behind a private network

### KV Consistency

- KV is eventually consistent (reads may be stale for up to 60 seconds)
- Use short TTLs for frequently changing data
- Critical data should always be read from the database

### R2 Upload Size Limits

- Workers have a 100MB request body limit
- For larger files, use R2 multipart upload or presigned URLs
- The CMS API handles chunked uploads automatically

## Next Steps

- [Environment Variables Reference](./environment-variables.md) — All configuration options
- [Docker Deployment](./docker.md) — Alternative self-hosted deployment
- [Tooling Recommendations](../guides/tooling-recommendations.md) — Complementary services
