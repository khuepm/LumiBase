---
version: 1
lastUpdated: 2026-08-02T19:22:18.301Z
sourceLang: en
contentHash: af86294c13f54058
codeVerified: 2026-08-02T19:22:18.301Z
codeVerifiedHash: af86294c13f54058
codeVerifiedClaims: 4
---

# Local Development

> **Prerequisites:** Node.js ≥ 22, pnpm ≥ 9, Docker + Docker Compose, Git ≥ 2.40

## Quick start

```bash
# 1. Clone the repository
git clone https://github.com/khuepm/lumibase.git
cd lumibase

# 2. Install dependencies
pnpm install

# 3. Copy and configure environment
cp .env.example .env
# Edit .env — see docs/en/deployment/environment-variables.md

# 4. Start infrastructure (PostgreSQL, Redis, MeiliSearch, Logto)
docker compose -f docker/docker-compose.yml up -d

# 5. Run database migrations
pnpm -F @lumibase/database db:migrate

# 6. Start all dev servers
pnpm dev
```

**Services running:**

| Service | URL | Description |
|---------|-----|-------------|
| CMS API | http://localhost:1989 | Hono REST + WebSocket API |
| Studio | http://localhost:2026 | Admin SPA |
| Docs viewer | http://localhost:5174 | This docs site |
| PostgreSQL | localhost:5432 | Database |
| Redis | localhost:6379 | Cache + queues |
| MeiliSearch | http://localhost:7700 | Search |
| Logto | http://localhost:3001 | Auth server |

---

## Running individual services

```bash
# CMS API only
pnpm -F @lumibase/cms dev        # Hono with hot-reload (port 1989)

# Studio only
pnpm -F @lumibase/studio dev     # Vite SPA (port 2026)

# Docs only
pnpm -F @lumibase/docs dev       # Vite docs (port 5174)
```

---

## First-time setup wizard

On first run, the CMS API detects an empty database and activates the setup wizard. Visit http://localhost:1989/setup to:

1. Create the first admin user
2. Set the site name and default language
3. Configure the admin panel URL (security through obscurity)

---

## Environment file

Minimum `.env` for local dev:

```env
# Runtime
LUMIBASE_ENV=development
LUMIBASE_RUNTIME=docker
LUMIBASE_DEV_AUTH=true         # Skip Logto auth locally
JWT_SECRET=local-dev-secret-min-32-chars-long

# Database
DATABASE_URL=postgres://postgres:postgres@localhost:5432/lumibase

# Cache
REDIS_URL=redis://localhost:6379

# Search
MEILISEARCH_URL=http://localhost:7700
MEILISEARCH_API_KEY=masterKey

# AI (optional for local dev)
LLM_PROVIDER=echo              # Use echo mock — no API key needed
# Optional real provider smoke tests:
# LLM_PROVIDER=openai
# LLM_MODEL=gpt-4.1-nano
# OPENAI_API_KEY=...
# LLM_PROVIDER=gemini
# LLM_MODEL=gemini-3.5-flash
# GEMINI_API_KEY=...
```

---

## Database management

```bash
# Generate a new migration after schema changes
pnpm -F @lumibase/database db:generate

# Check connectivity, current version, and pending migrations without applying DDL
pnpm db:migrate:preflight

# Apply pending migrations
pnpm db:migrate

# Print the current migration version
pnpm db:migrate:version

# Reset database (drops all tables and re-runs migrations)
pnpm -F @lumibase/database db:reset

# Open Drizzle Studio (database GUI)
pnpm -F @lumibase/database db:studio
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
# Use Wrangler dev to simulate CF Workers environment
pnpm -F @lumibase/cms wrangler:dev

# This uses wrangler.toml and miniflare for:
# - KV (CONFIG_CACHE) → in-memory
# - R2 (MEDIA) → local ./tmp/r2
# - Durable Objects (SITE_ROOM) → local simulation
# - Hyperdrive → direct DB connection (no pooling)
```

> Note: `LUMIBASE_RUNTIME` is automatically set to `cloudflare` when using Wrangler.

---

## Common issues

### Port conflicts

If ports are already in use, override in `.env`:

```env
CMS_PORT=1990
STUDIO_PORT=2027
```

### Docker not starting

```bash
# Check logs
docker compose -f docker/docker-compose.yml logs

# Force recreate
docker compose -f docker/docker-compose.yml up -d --force-recreate
```

### Type errors after `git pull`

Schema or package changes may require regenerating types:

```bash
pnpm -F @lumibase/database db:generate
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
