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

## Start production

Pin the CMS image with `LUMIBASE_VERSION` so production runs a predictable
release. If unset, `docker/docker-compose.prod.yml` falls back to `latest`.

```bash
LUMIBASE_VERSION=0.4.2 docker compose -f docker/docker-compose.yml -f docker/docker-compose.prod.yml up -d
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
