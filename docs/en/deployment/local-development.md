---
version: 5
lastUpdated: 2026-10-13T21:43:49.229Z
sourceLang: en
contentHash: 1e3d2d3993956138
codeVerified: 2026-10-13T21:43:49.229Z
codeVerifiedHash: 1e3d2d3993956138
codeVerifiedClaims: 8
---

# Local Development

> **Prerequisites:** Node.js 22.22.2+ (22.x), 24.15.0+ (24.x), or 26+, pnpm 9.12.0, Docker + Docker Compose, Git ≥ 2.40

## Quick start

```bash
# 1. Clone and install
git clone https://github.com/khuepm/lumibase.git
cd lumibase
pnpm install

# 2. Start infrastructure only; the CMS runs on the host below
docker compose -f docker/docker-compose.yml up -d postgres redis minio minio-init meilisearch imgproxy

# 3. Save the environment block below as .env.local, then export it
set -a
. ./.env.local
set +a

# 4. Apply migrations to your local development database
pnpm db:migrate

# 5. Run the Node CMS (:1989) in this terminal
pnpm -F @lumibase/cms exec tsx src/serve.ts
```

There is no root `.env.example`. Create the gitignored `.env.local` from the [environment block](#environment-file) below. These commands assume the default Compose ports and a local development database. `docker/.env.example` uses container hostnames and is not a host-process environment file. In a second terminal, from the repository root, start Studio:

```bash
pnpm -F @lumibase/studio exec vite --host 127.0.0.1 --port 2026
```

**Services running:**

| Service | URL | Description |
|---------|-----|-------------|
| CMS API | http://localhost:1989 | Hono REST + WebSocket API |
| Studio | http://localhost:2026 | Admin SPA |
| Docs viewer (optional) | http://localhost:5174 | Start separately with `pnpm docs:dev` |
| PostgreSQL | localhost:5432 | Database |
| Redis | localhost:6379 | Cache + queues |
| MeiliSearch | http://localhost:7700 | Search |
| MinIO | http://localhost:9000 (console :9001) | S3-compatible object storage |
| imgproxy | http://localhost:8080 | Image transformation |

---

## Running individual services

```bash
# CMS API only
pnpm -F @lumibase/cms exec tsx src/serve.ts # Load .env.local first (port 1989)

# Studio only
pnpm -F @lumibase/studio exec vite --host 127.0.0.1 --port 2026

# Docs only
pnpm -F @lumibase/docs dev       # Vite docs (port 5174)
```

---

## First-time setup wizard

On first run, the CMS API detects an empty database and activates the setup wizard. Visit http://localhost:2026/setup to:

1. Create the first admin user
2. Set the site name and default language
3. Configure the admin panel URL (security through obscurity)

---

## Environment file

Save this as `.env.local` at the repository root. Re-run `set -a; . ./.env.local; set +a` in each terminal that runs migrations or the Node CMS; those commands do not load it automatically. Use these credentials only for local development:

```env
LUMIBASE_ENV=development
LUMIBASE_RUNTIME=docker
LUMIBASE_DEV_AUTH=true
JWT_SECRET=local-dev-secret-min-32-chars-long
DATABASE_URL=postgresql://lumibase:lumibase_dev@localhost:5432/lumibase
REDIS_URL=redis://localhost:6379
S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
S3_BUCKET=lumibase-media
MEILISEARCH_HOST=http://localhost:7700
MEILISEARCH_API_KEY=lumibase_dev_key
IMGPROXY_URL=http://localhost:8080
IMGPROXY_KEY=736563726574
IMGPROXY_SALT=736563726574
LLM_PROVIDER=echo
```

---

## Database management

```bash
# Generate a new migration after schema changes
pnpm db:generate

# Check connectivity, current version, and pending migrations without applying DDL
pnpm db:migrate:preflight

# Apply pending migrations
pnpm db:migrate

# Print the current migration version
pnpm db:migrate:version

# Open Drizzle Studio (database GUI)
pnpm db:studio

# Seed development data
pnpm db:seed-dev
```

---

## Testing

```bash
# Run all tests
pnpm test

# Run tests in a specific package
pnpm -F @lumibase/cms test

# Watch mode
pnpm -F @lumibase/cms test --watch

# Type-check all packages
pnpm typecheck

# Lint all packages
pnpm lint
```

---

## Simulating Cloudflare Workers locally

```bash
# Alternative to the Node CMS; stop it first to free port 1989
pnpm -F @lumibase/cms dev
```

For this alternative, put secrets such as `DATABASE_URL` and `JWT_SECRET` in
`apps/cms/.dev.vars`. Wrangler uses `apps/cms/wrangler.toml` and local binding
emulation; the Docker environment above does not configure R2/KV bindings.
Without the corresponding bindings, storage/cache checks in `/health` can fail.
Use the Node CMS path above when working with Docker infrastructure.

---

## Common issues

### Port conflicts

If ports are already in use, override the published container port in
`docker/.env`:

```env
CMS_PORT=1990
```

Studio's dev port is set in `apps/studio/vite.config.ts` (`server.port: 2026`)
and has no environment-variable override. Pass the port to Vite instead:

```bash
pnpm -F @lumibase/studio exec vite --host 127.0.0.1 --port 2027
```

### Docker not starting

```bash
# Check logs
docker compose -f docker/docker-compose.yml logs

# Force recreate
docker compose -f docker/docker-compose.yml up -d --force-recreate postgres redis minio minio-init meilisearch imgproxy
```

### Type errors after `git pull`

Schema or package changes may require regenerating types:

```bash
pnpm db:generate
pnpm install  # Update pnpm-lock if packages changed
pnpm typecheck
```

### MeiliSearch index out of sync

```bash
# Reindex all searchable collections
curl -X POST http://localhost:1989/api/v1/search/reindex \
  -H "Authorization: Bearer <admin-token>" \
  -H "X-Lumi-Site: <your-site-id>"
```
