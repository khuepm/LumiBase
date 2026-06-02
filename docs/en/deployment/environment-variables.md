# Environment Variables

This page lists the deployment variables most operators need when running LumiBase.

## CMS Runtime

| Variable | Required | Notes |
| --- | --- | --- |
| `LUMIBASE_ENV` | Yes | Environment label such as `development`, `staging` or `production`. |
| `LUMIBASE_RUNTIME` | Docker only | Set to `docker` for Node.js self-hosting. Workers infer the Cloudflare runtime from bindings. |
| `LUMIBASE_DEV_AUTH` | Local only | Set to `true` only for local development. Keep it disabled in production. |
| `JWT_SECRET` | Yes | Secret used for application JWT verification/signing. Store as a secret. |
| `CF_ACCESS_CERTS_URL` | Production admin auth | Cloudflare Access JWKS URL. |
| `CF_ACCESS_AUDIENCE` | Production admin auth | Cloudflare Access application audience. |

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
