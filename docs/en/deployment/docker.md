# Docker Deployment

Docker mode runs the same CMS API in Node.js and uses self-hosted infrastructure for stateful services.

## Services

The production compose file is `docker/docker-compose.prod.yml`. It is intended to run:

- CMS API as a Node.js container.
- PostgreSQL for application data.
- Redis for cache and queue adapters.
- MinIO for S3-compatible media storage.
- Optional observability services such as Prometheus and Grafana.

## Build

```bash
pnpm --filter @lumibase/cms build:node
docker compose -f docker/docker-compose.prod.yml build
```

## Configure

Start from the example environment file:

```bash
cp docker/.env.example docker/.env
```

Set production values for database, Redis, object storage, JWT and admin authentication before starting the stack.

## Start

```bash
docker compose -f docker/docker-compose.prod.yml --env-file docker/.env up -d
```

Verify the API:

```bash
curl -fsS http://localhost:3000/health
```

Docker mode is useful for local production rehearsals and self-hosted installations. Cloudflare Workers remains the default edge deployment path.
