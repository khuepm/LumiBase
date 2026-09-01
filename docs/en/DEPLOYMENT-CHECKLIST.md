---
version: 2
lastUpdated: 2026-08-02T19:05:49.466Z
sourceLang: en
contentHash: 8213b15617869cfe
codeVerified: 2026-08-02T19:05:54.545Z
codeVerifiedHash: 8213b15617869cfe
codeVerifiedClaims: 26
---

# LumiBase Production Deployment Checklist

> Complete checklist for deploying LumiBase to production. Supports both **Cloudflare Workers** (edge) and **Docker** (self-hosted) deployments.

---

## Table of Contents

1. [Pre-Deployment Preparation](#1-pre-deployment-preparation)
2. [Infrastructure Setup](#2-infrastructure-setup)
3. [Secrets & Environment Variables](#3-secrets--environment-variables)
4. [Database Setup](#4-database-setup)
5. [Storage & Services](#5-storage--services)
6. [Cloudflare Workers Deployment](#6-cloudflare-workers-deployment)
7. [Docker Deployment](#7-docker-deployment)
8. [Post-Deployment Verification](#8-post-deployment-verification)
9. [Security Hardening](#9-security-hardening)
10. [Monitoring & Observability](#10-monitoring--observability)
11. [Backup & Recovery](#11-backup--recovery)
12. [Troubleshooting](#12-troubleshooting)

---

## 1. Pre-Deployment Preparation

### Code Readiness

- [ ] All tests pass: `pnpm test`
- [ ] Type check passes: `pnpm typecheck`
- [ ] Build succeeds: `pnpm build`
- [ ] No `console.log` statements in production code
- [ ] All TODO/FIXME items addressed or documented
- [ ] CHANGELOG updated with release notes

### Version & Release

- [ ] Version bumped in `package.json` files
- [ ] Git tag created: `git tag v0.x.x`
- [ ] Release branch created (if using GitFlow)

---

## 2. Infrastructure Setup

### Cloudflare (Edge Deployment)

- [ ] Cloudflare account with Workers Paid plan
- [ ] Wrangler CLI installed and authenticated: `wrangler login`
- [ ] Zone configured for your domain (e.g., `lumibase.dev`)
- [ ] Hyperdrive instance created:
  ```bash
  wrangler hyperdrive create lumibase-hyperdrive \
    --connection-string="postgresql://user:pass@host:5432/db?sslmode=require"
  ```
- [ ] KV namespace created:
  ```bash
  wrangler kv:namespace create CONFIG_CACHE
  ```
- [ ] R2 bucket created:
  ```bash
  wrangler r2 bucket create lumibase-media
  ```
- [ ] Queue created (for realtime):
  ```bash
  wrangler queues create lumibase-realtime
  ```
- [ ] Update `wrangler.toml` with binding IDs

### Docker (Self-Hosted Deployment)

- [ ] Docker Engine 24+ installed
- [ ] Docker Compose v2 installed
- [ ] Sufficient resources: 4GB+ RAM, 20GB+ disk
- [ ] Domain pointing to server IP
- [ ] Firewall rules configured (allow 80, 443)

---

## 3. Secrets & Environment Variables

### Generate Secrets

```bash
# JWT Secret (required)
openssl rand -base64 32

# Encryption Key (required)
openssl rand -base64 32

# Imgproxy Key & Salt (required for Docker)
openssl rand -hex 32  # key
openssl rand -hex 32  # salt

# MeiliSearch Master Key
openssl rand -base64 32

# Metrics Token
openssl rand -base64 24
```

### Cloudflare Workers Secrets

Set via `wrangler secret put --env production`:

| Secret | Required | Command |
|--------|----------|---------|
| `JWT_SECRET` | Yes | `wrangler secret put JWT_SECRET --env production` |
| `ENCRYPTION_KEY` | Yes | `wrangler secret put ENCRYPTION_KEY --env production` |
| `CF_ACCESS_CERTS_URL` | If using CF Access | `wrangler secret put CF_ACCESS_CERTS_URL --env production` |
| `CF_ACCESS_AUDIENCE` | If using CF Access | `wrangler secret put CF_ACCESS_AUDIENCE --env production` |
| `SENTRY_DSN` | Recommended | `wrangler secret put SENTRY_DSN --env production` |
| `METRICS_TOKEN` | Recommended | `wrangler secret put METRICS_TOKEN --env production` |
| `OPENAI_API_KEY` | If using AI | `wrangler secret put OPENAI_API_KEY --env production` |

### Docker Environment

- [ ] Copy template: `cp docker/.env.prod.example docker/.env`
- [ ] Fill all `REPLACE_*` placeholders
- [ ] Verify no dev values remain:
  ```bash
  grep -E "dev_secret|lumibase_dev|minioadmin|REPLACE" docker/.env
  # Should return empty!
  ```

### Critical Security Checks

- [ ] `LUMIBASE_DEV_AUTH=false` (CRITICAL!)
- [ ] `LUMIBASE_ENV=production`
- [ ] `JWT_SECRET` is random (not `dev_secret_key`)
- [ ] `ENCRYPTION_KEY` is set
- [ ] `DATABASE_SSL_MODE=require` (not `disable`)
- [ ] `CORS_ALLOWED_ORIGINS` does not contain `*` or `localhost`

---

## 4. Database Setup

### PostgreSQL Requirements

- [ ] PostgreSQL 15+ running
- [ ] SSL/TLS enabled
- [ ] Dedicated user with limited privileges:
  ```sql
  CREATE USER lumibase WITH PASSWORD 'strong_password';
  CREATE DATABASE lumibase OWNER lumibase;
  GRANT ALL PRIVILEGES ON DATABASE lumibase TO lumibase;
  ```
- [ ] Connection pooling (PgBouncer or Hyperdrive)

### Run Migrations

```bash
# From the repo root (db:migrate is a root script)
pnpm db:migrate

# Dry-run the pending migrations first
pnpm db:migrate:preflight

# Or, filtering to the package — note the script there is `migrate`, not `db:migrate`
pnpm -F @lumibase/database migrate
```

- [ ] Migrations completed without errors
- [ ] Schema version matches codebase

### Database Security

- [ ] Row Level Security (RLS) enabled
- [ ] No public schema access
- [ ] Audit logging enabled
- [ ] Backup schedule configured

---

## 5. Storage & Services

### S3-Compatible Storage

- [ ] Bucket created with appropriate permissions
- [ ] CORS configured for your domains:
  ```json
  {
    "AllowedOrigins": ["https://studio.example.com"],
    "AllowedMethods": ["GET", "PUT", "POST"],
    "AllowedHeaders": ["*"]
  }
  ```
- [ ] Lifecycle rules for temp uploads (optional)

### MeiliSearch

- [ ] MeiliSearch instance running
- [ ] Master key set (not default)
- [ ] Index created for content search

### Redis

- [ ] Redis instance running
- [ ] Password authentication enabled
- [ ] TLS enabled (if remote)
- [ ] Persistence configured (RDB/AOF)

### Imgproxy

- [ ] Imgproxy instance running
- [ ] Signing keys configured
- [ ] Memory limits set appropriately

---

## 6. Cloudflare Workers Deployment

### Pre-Deploy Checks

- [ ] `wrangler.toml` reviewed for production env
- [ ] All binding IDs filled in:
  - [ ] `HYPERDRIVE` id
  - [ ] `CONFIG_CACHE` KV id
  - [ ] `MEDIA` R2 bucket name
  - [ ] `REALTIME_QUEUE` queue name
- [ ] Routes configured correctly:
  ```toml
  [[env.production.routes]]
  pattern = "api.yourdomain.com"
  custom_domain = true
  ```

### Deploy

```bash
# Build (dry-run bundle for the production env)
pnpm -F @lumibase/cms build:production

# Deploy
wrangler deploy --env production

# Verify
curl https://api.yourdomain.com/health
```

- [ ] Deployment successful
- [ ] Health check returns `{ "status": "ok" }`
- [ ] No errors in Cloudflare dashboard

### Durable Objects

- [ ] SiteRoom DO migrated (tag: v1)
- [ ] WebSocket connections working

---

## 7. Docker Deployment

### Pre-Deploy Checks

- [ ] `docker/.env` configured (from `.env.prod.example`)
- [ ] Docker images pulled: `docker compose pull`
- [ ] Volumes created for persistence

### Deploy

```bash
cd docker

# Start infrastructure services first
docker compose up -d postgres redis meilisearch imgproxy

# Wait for services to be healthy
docker compose ps

# Run migrations
docker compose run --rm cms pnpm -F @lumibase/database migrate

# Start CMS
docker compose up -d cms

# (Optional) Start with TLS
docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d
```

- [ ] All containers running: `docker compose ps`
- [ ] No restart loops in logs: `docker compose logs --tail=100`
- [ ] Health check passes:
  ```bash
  curl http://localhost:1989/health
  ```

### Scaling (Optional)

**Single process (default)** — one container runs HTTP + cron + queue consumers (`LUMIBASE_PROCESS_ROLE=all`):

```bash
docker compose up -d cms
```

**Split web / worker (recommended for horizontal scale)** — HTTP replicas without duplicated cron; one or more worker replicas with Redis leader locks:

```bash
# Start infra + split roles (compose profile `split`)
docker compose --profile split up -d postgres redis minio minio-init meilisearch imgproxy cms-web cms-worker

# Scale HTTP tier (workers stay at 1 unless you add more with shared Redis locks)
docker compose --profile split up -d --scale cms-web=3
```

| Service | `LUMIBASE_PROCESS_ROLE` | Listens on |
|---------|-------------------------|------------|
| `cms` / `cms-web` | `all` / `web` | `PORT` (default 1989) — Delivery + API |
| `cms-worker` | `worker` | `LUMIBASE_WORKER_HEALTH_PORT` (default 1988) — `/health` only |

Worker processes consume queues and run `node-cron` jobs; only the Redis lock holder executes each cron tick when `REDIS_URL` is set.

> **Avoid** `docker compose up -d --scale cms=3` on the monolithic `cms` service — that duplicates every cron and queue consumer. Use the split profile instead.

---

## 8. Post-Deployment Verification

### Health & Connectivity

```bash
# Health endpoint
curl https://api.yourdomain.com/health
# Expected: { "status": "ok", "env": "production", ... }

# API version
curl https://api.yourdomain.com/api/v1/health
```

- [ ] Health check returns `ok`
- [ ] Database connection working
- [ ] Redis connection working
- [ ] Storage connection working
- [ ] Search connection working

### Functional Tests

- [ ] Admin login works
- [ ] Create a test site
- [ ] Create content item
- [ ] Upload media file
- [ ] Search returns results
- [ ] WebSocket realtime works (if enabled)

### Performance Baseline

- [ ] Response time < 200ms for simple queries
- [ ] No memory leaks (monitor over 1 hour)
- [ ] CPU usage stable under load

---

## 9. Security Hardening

### Authentication

- [ ] Dev auth disabled (`LUMIBASE_DEV_AUTH=false`)
- [ ] JWT expiration configured appropriately
- [ ] Rate limiting enabled
- [ ] Account lockout working

### Network

- [ ] HTTPS enforced (no HTTP)
- [ ] HSTS header enabled
- [ ] CORS restricted to known origins
- [ ] CSP headers configured (for Studio)

### API Security

- [ ] `/metrics` endpoint protected by `METRICS_TOKEN`
- [ ] SCIM endpoint protected (if used)
- [ ] GraphQL introspection disabled in production
- [ ] File upload MIME type validation enabled

### Data Protection

- [ ] Encryption at rest (database)
- [ ] Encryption in transit (TLS everywhere)
- [ ] Field encryption for sensitive data (`ENCRYPTION_KEY`)
- [ ] PII audit logging enabled

---

## 10. Monitoring & Observability

### Error Tracking

- [ ] Sentry configured (Cloudflare):
  ```bash
  wrangler secret put SENTRY_DSN --env production
  ```
- [ ] Sentry project receiving errors
- [ ] Alert rules configured

### Metrics

- [ ] Prometheus scraping `/metrics`
- [ ] Grafana dashboards set up
- [ ] Key metrics monitored:
  - [ ] Request rate
  - [ ] Error rate (5xx)
  - [ ] Response latency (p50, p95, p99)
  - [ ] Database query duration
  - [ ] Active connections

### Logging

- [ ] Structured JSON logs enabled
- [ ] Log aggregation set up (Loki, CloudWatch, etc.)
- [ ] Log retention policy configured
- [ ] Sensitive data not logged

### Alerting

- [ ] Error rate spike alert
- [ ] Latency degradation alert
- [ ] Database connection pool exhaustion alert
- [ ] Disk space alert (Docker)
- [ ] Certificate expiry alert

---

## 11. Backup & Recovery

### Database Backups

- [ ] Automated daily backups
- [ ] Backups stored off-site (S3, etc.)
- [ ] Backup encryption enabled
- [ ] Retention policy: 30 days minimum
- [ ] Backup restoration tested

### Media Backups

- [ ] S3 versioning enabled (or cross-region replication)
- [ ] Lifecycle rules for old versions

### Configuration Backups

- [ ] `wrangler.toml` in version control
- [ ] Docker `.env` backed up securely (encrypted)
- [ ] Secrets documented in password manager

### Disaster Recovery

- [ ] Recovery procedure documented
- [ ] Recovery time objective (RTO) defined
- [ ] Recovery point objective (RPO) defined
- [ ] DR test performed

---

## 12. Troubleshooting

### Common Issues

#### Health check fails

```bash
# Check service logs
docker compose logs cms --tail=100

# Check the database connection by dry-running migrations
docker compose exec cms pnpm -F @lumibase/database migrate:preflight

# Check Redis connection
docker compose exec redis redis-cli ping
```

#### 500 errors on requests

```bash
# Check for missing secrets
grep "JWT_SECRET\|ENCRYPTION_KEY" docker/.env

# Verify secrets are set (Cloudflare)
wrangler secret list --env production
```

#### Database connection errors

- Verify `DATABASE_URL` format
- Check SSL mode matches server config
- Verify network connectivity
- Check connection pool limits

#### CORS errors

- Verify `CORS_ALLOWED_ORIGINS` includes your frontend domain
- Check for trailing slashes (should not have them)
- Verify protocol (https, not http)

### Rollback Procedure

```bash
# Cloudflare Workers
wrangler rollback --env production

# Docker
docker compose down
docker compose pull  # pull previous tag
docker compose up -d
```

---

## Quick Reference: Required Secrets

### Cloudflare Workers

| Secret | Required | Generate |
|--------|----------|----------|
| `JWT_SECRET` | Yes | `openssl rand -base64 32` |
| `ENCRYPTION_KEY` | Yes | `openssl rand -base64 32` |
| `CF_ACCESS_CERTS_URL` | If using CF Access | From CF dashboard |
| `CF_ACCESS_AUDIENCE` | If using CF Access | From CF dashboard |
| `SENTRY_DSN` | Recommended | From Sentry project |
| `METRICS_TOKEN` | Recommended | `openssl rand -base64 24` |

### Docker

| Variable | Required | Generate |
|----------|----------|----------|
| `JWT_SECRET` | Yes | `openssl rand -base64 32` |
| `ENCRYPTION_KEY` | Yes | `openssl rand -base64 32` |
| `DATABASE_URL` | Yes | Connection string with SSL |
| `REDIS_URL` | Yes | Connection string |
| `S3_ACCESS_KEY` | Yes | From provider |
| `S3_SECRET_KEY` | Yes | From provider |
| `MEILISEARCH_API_KEY` | Yes | `openssl rand -base64 32` |
| `IMGPROXY_KEY` | Yes | `openssl rand -hex 32` |
| `IMGPROXY_SALT` | Yes | `openssl rand -hex 32` |

---

## Sign-Off

| Check | Verified By | Date |
|-------|-------------|------|
| Pre-deployment complete | | |
| Infrastructure ready | | |
| Secrets configured | | |
| Database migrated | | |
| Services healthy | | |
| Security hardened | | |
| Monitoring active | | |
| Backups verified | | |

**Deployed Version:** `v____`
**Deployment Date:** `____-__-__`
**Deployed By:** `____________`
