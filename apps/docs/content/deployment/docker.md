# Docker Deployment Guide

Deploy Lumibase as a Docker container on any platform that supports containers. This guide covers building the production image, configuring it, and deploying to popular container platforms.

## Prerequisites

- Docker Engine 24+ (or Docker Desktop)
- Docker Compose v2
- Access to a PostgreSQL 16 database
- Access to a Redis 7 instance
- S3-compatible object storage (MinIO, AWS S3, etc.)

## Building the Production Image

### From Source

```bash
# Clone the repository
git clone https://github.com/your-org/lumibase.git
cd lumibase

# Build the production image
docker build -f docker/Dockerfile -t lumibase-cms:latest .
```

### Multi-Stage Build Details

The Dockerfile uses a two-stage build:

1. **Builder stage** — Installs all dependencies, compiles TypeScript
2. **Runtime stage** — Copies only compiled output and production dependencies

The final image is ~150MB based on `node:20-slim` and runs as a non-root user.

### Build Arguments

```bash
# Specify a custom Node.js version
docker build --build-arg NODE_VERSION=20 -f docker/Dockerfile -t lumibase-cms:latest .
```

## Running with Docker Compose

For a complete self-hosted stack with all services:

```bash
cd docker/

# Copy and configure environment variables
cp .env.example .env
# Edit .env with your values

# Start all services
docker compose up -d

# Check status
docker compose ps

# View logs
docker compose logs -f cms
```

This starts:
- **PostgreSQL 16** on port 5432
- **Redis 7** on port 6379
- **MinIO** on ports 9000 (API) / 9001 (console)
- **MeiliSearch** on port 7700
- **Imgproxy** on port 8080
- **Lumibase CMS** on port 1989
- **Bull Board** on port 3001

### With Monitoring Stack

```bash
# Start core services + Prometheus, Grafana, Loki
docker compose -f docker-compose.yml -f docker-compose.monitoring.yml up -d
```

This adds:
- **Prometheus** on port 9090
- **Grafana** on port 3002 (admin/admin)
- **Loki** on port 3100

## Running a Standalone Container

If you already have external PostgreSQL, Redis, and S3:

```bash
docker run -d \
  --name lumibase-cms \
  -p 1989:1989 \
  -e LUMIBASE_RUNTIME=docker \
  -e DATABASE_URL="postgresql://user:pass@db-host:5432/lumibase" \
  -e REDIS_URL="redis://redis-host:6379" \
  -e S3_ENDPOINT="https://s3.amazonaws.com" \
  -e S3_ACCESS_KEY="AKIAIOSFODNN7EXAMPLE" \
  -e S3_SECRET_KEY="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" \
  -e S3_BUCKET="lumibase-media" \
  -e MEILISEARCH_HOST="http://meilisearch-host:7700" \
  -e MEILISEARCH_API_KEY="your-api-key" \
  -e IMGPROXY_URL="http://imgproxy-host:8080" \
  -e IMGPROXY_KEY="your-hex-key" \
  -e IMGPROXY_SALT="your-hex-salt" \
  -e LOGTO_ISSUER="https://your-logto.logto.app/oidc" \
  -e LOGTO_AUDIENCE="https://api.yourdomain.com" \
  lumibase-cms:latest
```

### Health Check

```bash
curl http://localhost:1989/health
```

Expected response:

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

## Deploying to Container Platforms

### AWS ECS (Elastic Container Service)

1. **Push image to ECR:**

```bash
# Authenticate Docker to ECR
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin 123456789.dkr.ecr.us-east-1.amazonaws.com

# Tag and push
docker tag lumibase-cms:latest 123456789.dkr.ecr.us-east-1.amazonaws.com/lumibase-cms:latest
docker push 123456789.dkr.ecr.us-east-1.amazonaws.com/lumibase-cms:latest
```

2. **Create a Task Definition** with:
   - Container image: your ECR image URI
   - Port mapping: 3000
   - Environment variables from AWS Secrets Manager or Parameter Store
   - Health check: `CMD-SHELL, wget -qO- http://localhost:1989/health || exit 1`
   - Memory: 512MB minimum, 1GB recommended
   - CPU: 256 units minimum (0.25 vCPU)

3. **Create a Service** in your ECS cluster with:
   - Desired count: 2+ for high availability
   - Load balancer: Application Load Balancer on port 443
   - Auto-scaling based on CPU/memory utilization

### Google Cloud Run

```bash
# Build and push to Artifact Registry
gcloud builds submit --tag gcr.io/YOUR_PROJECT/lumibase-cms

# Deploy to Cloud Run
gcloud run deploy lumibase-cms \
  --image gcr.io/YOUR_PROJECT/lumibase-cms \
  --port 1989 \
  --memory 512Mi \
  --cpu 1 \
  --min-instances 0 \
  --max-instances 10 \
  --set-env-vars "LUMIBASE_RUNTIME=docker" \
  --set-secrets "DATABASE_URL=lumibase-db-url:latest,REDIS_URL=lumibase-redis-url:latest" \
  --allow-unauthenticated
```

Cloud Run considerations:
- Set `--min-instances 1` to avoid cold starts in production
- Use Cloud SQL with Unix socket for database connections
- Use Memorystore for Redis
- Use Cloud Storage as S3-compatible storage (with interoperability API)

### Railway

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login and initialize
railway login
railway init

# Deploy from Dockerfile
railway up
```

Or connect your GitHub repository for automatic deploys. Configure environment variables in the Railway dashboard.

Railway configuration (`railway.toml`):

```toml
[build]
dockerfilePath = "docker/Dockerfile"

[deploy]
healthcheckPath = "/health"
healthcheckTimeout = 30
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 3
```

### Fly.io

```bash
# Install flyctl
curl -L https://fly.io/install.sh | sh

# Launch the app
fly launch --dockerfile docker/Dockerfile --no-deploy

# Set secrets
fly secrets set DATABASE_URL="postgresql://..." REDIS_URL="redis://..." ...

# Deploy
fly deploy
```

Fly.io configuration (`fly.toml`):

```toml
app = "lumibase-cms"
primary_region = "iad"

[build]
  dockerfile = "docker/Dockerfile"

[http_service]
  internal_port = 1989
  force_https = true
  auto_stop_machines = true
  auto_start_machines = true
  min_machines_running = 1

[[services]]
  protocol = "tcp"
  internal_port = 1989

  [[services.ports]]
    port = 443
    handlers = ["tls", "http"]

  [[services.http_checks]]
    interval = 10000
    grace_period = "10s"
    method = "get"
    path = "/health"
    protocol = "http"
    timeout = 2000
```

## Production Recommendations

### Resource Sizing

| Workload | CPU | Memory | Instances |
|----------|-----|--------|-----------|
| Low (< 100 req/s) | 0.5 vCPU | 512 MB | 1-2 |
| Medium (100-1000 req/s) | 1 vCPU | 1 GB | 2-4 |
| High (> 1000 req/s) | 2 vCPU | 2 GB | 4+ |

### Security Checklist

- [ ] Run as non-root user (handled by Dockerfile)
- [ ] Use TLS termination at load balancer / reverse proxy
- [ ] Store secrets in a secrets manager, not environment files
- [ ] Restrict network access to database and Redis
- [ ] Enable database SSL (`?sslmode=require` in DATABASE_URL)
- [ ] Set `ENCRYPTION_KEY` for sensitive data at rest
- [ ] Configure CORS appropriately for your frontend domains

### Networking

- Place the CMS container in the same VPC/network as PostgreSQL and Redis
- Use internal DNS names for service-to-service communication
- Expose only port 1989 (or your configured PORT) externally
- Use a reverse proxy (nginx, Caddy, Traefik) or cloud load balancer for TLS

### Logging

The CMS outputs structured JSON logs to stdout:

```json
{
  "timestamp": "2024-01-15T10:30:00.000Z",
  "level": "info",
  "requestId": "req_abc123",
  "method": "GET",
  "path": "/api/items",
  "status": 200,
  "duration": 45
}
```

Collect logs with your preferred aggregator (Loki, CloudWatch, Datadog, etc.).

## Updating

```bash
# Pull the latest image
docker pull ghcr.io/your-org/lumibase-cms:latest

# Restart with zero downtime (compose)
docker compose up -d --no-deps cms

# Or for standalone containers
docker stop lumibase-cms
docker rm lumibase-cms
docker run -d --name lumibase-cms ... lumibase-cms:latest
```

Migrations run automatically on container startup. For major version upgrades, check the changelog for breaking changes.

## Next Steps

- [Environment Variables Reference](./environment-variables.md) — All configuration options
- [Local Development](./local-development.md) — Development workflow with Docker Compose
- [Backup & Recovery](../guides/backup-recovery.md) — Database backup strategy
- [Tooling Recommendations](../guides/tooling-recommendations.md) — Complementary services
