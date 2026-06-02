# Local Development Guide

Get Lumibase running locally with a single command using Docker Compose. This provides a full development stack without needing a Cloudflare account.

## Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Docker | 24+ | Container runtime |
| Docker Compose | v2+ | Service orchestration |
| Node.js | 20+ | Build tooling and scripts |
| pnpm | 9+ | Package manager |

### Install Prerequisites

**macOS:**

```bash
# Docker Desktop (includes Docker Compose)
brew install --cask docker

# Node.js via nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install 20

# pnpm
corepack enable
corepack prepare pnpm@9 --activate
```

**Linux (Ubuntu/Debian):**

```bash
# Docker Engine
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# pnpm
corepack enable
corepack prepare pnpm@9 --activate
```

**Windows:**

- Install [Docker Desktop](https://docs.docker.com/desktop/install/windows-install/) (WSL 2 backend recommended)
- Install Node.js 20 from [nodejs.org](https://nodejs.org/)
- Run `corepack enable` in an elevated terminal

## Quickstart

### 1. Clone and Setup

```bash
git clone https://github.com/your-org/lumibase.git
cd lumibase
```

### 2. Configure Environment

```bash
cd docker/
cp .env.example .env
```

The defaults in `.env.example` work out of the box for local development. No changes needed to get started.

### 3. Start the Stack

```bash
docker compose up -d
```

This starts all services in the background. First run will pull images (~2-3 minutes).

### 4. Verify Services

```bash
# Check all services are running
docker compose ps

# Test the CMS API
curl http://localhost:1989/health
```

Expected output:

```json
{
  "status": "healthy",
  "services": {
    "database": "healthy",
    "cache": "healthy",
    "storage": "healthy",
    "search": "healthy",
    "queue": "healthy"
  }
}
```

### 5. Access Services

| Service | URL | Credentials |
|---------|-----|-------------|
| CMS API | http://localhost:1989 | — |
| MinIO Console | http://localhost:9001 | minioadmin / minioadmin |
| MeiliSearch | http://localhost:7700 | Key: `lumibase_dev_key` |
| Bull Board | http://localhost:3001 | — |
| PostgreSQL | localhost:5432 | lumibase / lumibase_dev |
| Redis | localhost:6379 | — |

## Connecting to the Local Database

### Using psql

```bash
psql postgresql://lumibase:lumibase_dev@localhost:5432/lumibase
```

### Using a GUI Client

Connect with any PostgreSQL client (pgAdmin, DBeaver, TablePlus):

- **Host:** localhost
- **Port:** 5432
- **Database:** lumibase
- **User:** lumibase
- **Password:** lumibase_dev

### Using Drizzle Studio

```bash
# From the project root
pnpm --filter @lumibase/database drizzle-kit studio
```

## Running Migrations

Migrations run automatically when the CMS container starts. To run them manually:

```bash
# Run pending migrations
pnpm --filter @lumibase/database migrate

# Or via Docker
docker compose exec cms pnpm --filter @lumibase/database migrate
```

### Creating New Migrations

```bash
# Generate a migration from schema changes
pnpm --filter @lumibase/database drizzle-kit generate

# Push schema directly (development only)
pnpm --filter @lumibase/database drizzle-kit push
```

## Development Workflow

### Hot Reload

The development Docker Compose mounts your source code as volumes. Changes to files in `apps/cms/src/` and `packages/` are reflected immediately without rebuilding the container.

### Running the CMS Outside Docker

If you prefer running the CMS directly on your host (for faster iteration or debugging):

```bash
# Start only infrastructure services
docker compose up -d postgres redis minio meilisearch imgproxy

# Install dependencies
pnpm install

# Run the CMS in development mode
cd apps/cms
pnpm dev
```

Set these environment variables in your shell or a local `.env` file:

```bash
export LUMIBASE_RUNTIME=docker
export DATABASE_URL=postgresql://lumibase:lumibase_dev@localhost:5432/lumibase
export REDIS_URL=redis://localhost:6379
export S3_ENDPOINT=http://localhost:9000
export S3_ACCESS_KEY=minioadmin
export S3_SECRET_KEY=minioadmin
export S3_BUCKET=lumibase-media
export MEILISEARCH_HOST=http://localhost:7700
export MEILISEARCH_API_KEY=lumibase_dev_key
export IMGPROXY_URL=http://localhost:8080
export IMGPROXY_KEY=736563726574
export IMGPROXY_SALT=736563726574
```

### Viewing Logs

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f cms

# Last 100 lines
docker compose logs --tail 100 cms
```

### Restarting Services

```bash
# Restart a single service
docker compose restart cms

# Rebuild and restart (after Dockerfile changes)
docker compose up -d --build cms
```

## Enabling the Monitoring Stack

For Prometheus metrics and Grafana dashboards:

```bash
docker compose -f docker-compose.yml -f docker-compose.monitoring.yml up -d
```

Access Grafana at http://localhost:3002 (admin / admin). A pre-configured Lumibase dashboard is available showing request rates, latency, and error rates.

## Resetting the Environment

### Reset a Single Service

```bash
# Reset PostgreSQL (deletes all data)
docker compose down -v postgres
docker compose up -d postgres
```

### Full Reset

```bash
# Stop all services and remove volumes
docker compose down -v

# Start fresh
docker compose up -d
```

## Troubleshooting

### Port Conflicts

If a port is already in use, modify the port mapping in `docker-compose.yml`:

```yaml
services:
  postgres:
    ports:
      - "5433:5432"  # Use 5433 on host instead
```

### Container Won't Start

```bash
# Check logs for the failing service
docker compose logs cms

# Common issues:
# - Database not ready: wait a few seconds and retry
# - Port conflict: change the host port mapping
# - Missing .env: ensure .env file exists in docker/ directory
```

### Slow on macOS

Docker Desktop on macOS can be slow with volume mounts. Options:

1. Use `:cached` volume flag (already configured)
2. Increase Docker Desktop memory allocation (4GB+ recommended)
3. Run the CMS natively and only use Docker for infrastructure services

### Database Connection Refused

If the CMS can't connect to PostgreSQL:

```bash
# Check if PostgreSQL is healthy
docker compose ps postgres

# Check PostgreSQL logs
docker compose logs postgres

# Manually test the connection
docker compose exec postgres pg_isready -U lumibase
```

## Next Steps

- [Docker Deployment Guide](./docker.md) — Deploy to production
- [Environment Variables](./environment-variables.md) — All configuration options
- [Tooling Recommendations](../guides/tooling-recommendations.md) — Additional services
