---
title: Deployment — Cloudflare Workers (Edge Components Only)
version: 1
lastUpdated: 2026-07-28T11:34:33.128Z
sourceLang: en
contentHash: 3a7f4f65f8ffeea8
codeVerified: 2026-07-28T11:34:33.128Z
codeVerifiedHash: 3a7f4f65f8ffeea8
codeVerifiedClaims: 10
---

# Deployment Guide: Cloudflare Workers (Edge Components Only)

This guide deploys **only the lightweight edge components** of the CDC system to Cloudflare Workers: the **CDC API / control-plane endpoints** and the **Cache_Invalidator**. It corresponds to the `cloudflare_workers` deployment target and satisfies the edge-components portion of **Requirement 9.4**.

> **This deployment is not self-contained.** Cloudflare Workers cannot host stateful CDC connectors, the Kafka message bus, or the PostgreSQL/ClickHouse replication engines (V8 isolate CPU/memory limits and no long-lived TCP connections). The Workers runtime communicates with the stateful stack over HTTPS, so a `cloudflare_workers` deployment **always depends on a companion stateful deployment**. Provision the stateful stack first using the [Docker Compose / managed-services deployment guide](./deployment-docker-compose.md), then return here.

## Prerequisites

- A completed [Docker Compose / managed-services deployment](./deployment-docker-compose.md) of the stateful stack, reachable over HTTPS. Note its base URL — this is `CDC_STATEFUL_STACK_URL`.
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (Workers Paid plan recommended).
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) v3+.
- Node.js 22+ and pnpm.
- A reachable Redis instance for the Cache_Invalidator (e.g. Upstash) — this is `REDIS_URL`.
- A strong bearer token to secure the control-plane API — this is `CDC_API_AUTH_TOKEN`.

## Step 1: Authenticate Wrangler

```bash
pnpm add -g wrangler
wrangler login
wrangler whoami
```

## Step 2: Configure environment variables

The edge deployment uses the universal variables plus the edge variables only (no stateful connection variables). See [Environment Variables — edge components](./environment-variables.md#edge-components-cloudflare_workers).

Set non-secret values in `wrangler.toml`:

```toml
name = "lumibase-cdc-edge"
main = "src/index.ts"
compatibility_date = "2024-10-01"
compatibility_flags = ["nodejs_compat"]

[vars]
CDC_APPROACH = "debezium_kafka"          # match the companion stateful stack
CDC_DEPLOYMENT_TARGET = "cloudflare_workers"
CDC_PIPELINE_NAME = "orders-analytics"
CACHE_KEY_NAMESPACE = "lumibase"
CACHE_INVALIDATOR_QUEUE_MAX = "10000"
CACHE_INVALIDATOR_DEDUP_WINDOW_MS = "1000"
```

Set secrets with `wrangler secret put` (never commit these):

```bash
wrangler secret put CDC_STATEFUL_STACK_URL   # https endpoint of the stateful stack
wrangler secret put CDC_API_AUTH_TOKEN       # bearer token for the control-plane API
wrangler secret put REDIS_URL                # redis:// or rediss:// connection string
```

## Step 3: Validate the edge configuration

Validate the edge variables against the schema before deploying (Requirements 7.4, 7.5):

```bash
curl -sS -X POST https://your-cms-host/api/v1/cdc/deploy/validate-env \
  -H "Authorization: Bearer $LUMI_ADMIN_TOKEN" \
  -H "X-Lumi-Site: $SITE_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "approach": "debezium_kafka",
    "target": "cloudflare_workers",
    "env": {
      "CDC_PIPELINE_NAME": "orders-analytics",
      "CDC_STATEFUL_STACK_URL": "https://cdc-stack.internal.example.com",
      "CDC_API_AUTH_TOKEN": "replace-with-a-strong-random-token",
      "REDIS_URL": "rediss://default:token@us1-abc-12345.upstash.io:6379"
    }
  }'
```

Expected output:

```json
{ "data": { "valid": true } }
```

## Step 4: Deploy the edge components

You can deploy with Wrangler directly:

```bash
wrangler deploy
```

Or drive it through the AI Flow Engine, which scopes the deployment to **edge components only** — it will not attempt to provision stateful connectors, the message bus, or replication engines on Workers (Requirement 7.2):

```bash
curl -sS -X POST https://your-cms-host/api/v1/cdc/deploy \
  -H "Authorization: Bearer $LUMI_ADMIN_TOKEN" \
  -H "X-Lumi-Site: $SITE_ID" \
  -H "Content-Type: application/json" \
  -d '{ "approach": "debezium_kafka", "target": "cloudflare_workers" }'
```

The resulting deployment provisions exactly two services: `cdc_api` (CDC API / control plane) and `cache_invalidator`.

## Verification

### Verification command

```bash
curl -sS https://lumibase-cdc-edge.<your-subdomain>.workers.dev/api/v1/cdc/health \
  -H "Authorization: Bearer $CDC_API_AUTH_TOKEN"
```

### Expected output

The edge components report healthy and confirm connectivity to the companion stateful stack and Redis:

```json
{
  "data": {
    "status": "healthy",
    "target": "cloudflare_workers",
    "components": [
      { "service": "cdc_api", "reachable": true },
      { "service": "cache_invalidator", "reachable": true }
    ],
    "dependencies": [
      { "service": "stateful_stack", "reachable": true },
      { "service": "redis", "reachable": true }
    ]
  }
}
```

If `stateful_stack` is unreachable, confirm the companion [Docker Compose / managed-services deployment](./deployment-docker-compose.md) is running and that `CDC_STATEFUL_STACK_URL` is correct and HTTPS.

The AI Flow Engine `/deploy` response for the edge deployment:

```json
{
  "data": {
    "deploymentId": "Td9_kLm3Qa1",
    "approach": "debezium_kafka",
    "target": "cloudflare_workers",
    "status": "completed",
    "health": {
      "passed": true,
      "services": [
        { "service": "cdc_api", "reachable": true },
        { "service": "cache_invalidator", "reachable": true }
      ]
    }
  }
}
```

## How the edge components behave

- **CDC API / control plane** — exposes the CDC endpoints (admin-gated by `CDC_API_AUTH_TOKEN`) and proxies stateful operations to `CDC_STATEFUL_STACK_URL` over HTTPS.
- **Cache_Invalidator** — consumes CDC change events and refreshes Redis (INSERT/UPDATE → SET, DELETE → DEL) within 5 seconds of commit. During a Redis outage it buffers up to `CACHE_INVALIDATOR_QUEUE_MAX` events and replays them in order; consecutive UPDATEs for the same key are deduplicated within `CACHE_INVALIDATOR_DEDUP_WINDOW_MS`.

## Security note

These are network-exposed control-plane endpoints. They must be protected by `CDC_API_AUTH_TOKEN`; do not deploy them without it. Keep `CDC_API_AUTH_TOKEN`, `REDIS_URL`, and `CDC_STATEFUL_STACK_URL` as Wrangler secrets, not plaintext vars.

## Next steps

- [Docker Compose / managed-services deployment](./deployment-docker-compose.md) — the required companion stateful stack
- [Troubleshooting](./troubleshooting.md)
- [Environment Variables](./environment-variables.md)
