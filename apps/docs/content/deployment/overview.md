# Deployment Overview

Lumibase supports two deployment modes: **Cloudflare Workers** (edge) and **Docker** (self-hosted). Both modes share the same CMS API codebase and business logic — only the infrastructure adapters differ.

## Choosing a Deployment Mode

| Criteria | Cloudflare Workers | Docker (Self-Hosted) |
|----------|-------------------|---------------------|
| Latency | Ultra-low (edge, global PoPs) | Depends on region/provider |
| Scaling | Automatic, per-request | Manual or platform-managed |
| Cost model | Pay-per-request | Fixed compute + storage |
| Data residency | Cloudflare regions | Full control |
| Vendor lock-in | Cloudflare ecosystem | Any container platform |
| Local development | Wrangler dev (limited) | Full stack via Docker Compose |
| Monitoring | Workers Analytics Engine | Prometheus + Grafana |
| Search | MeiliSearch Cloud (HTTP) | Self-hosted MeiliSearch |
| Queue | Cloudflare Queues | BullMQ (Redis) |
| Media processing | CF Image Resizing | Imgproxy |

## Architecture: Cloudflare Workers

```
┌─────────────────────────────────────────────────────────────────┐
│                        Cloudflare Edge                           │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │              Lumibase CMS (Hono.js Worker)                │  │
│  │                                                           │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌──────────────────┐  │  │
│  │  │   Routes    │  │ Middleware  │  │    Services      │  │  │
│  │  └──────┬──────┘  └──────┬──────┘  └────────┬─────────┘  │  │
│  │         └─────────────────┼──────────────────┘            │  │
│  │                           │                               │  │
│  │              ┌────────────▼────────────┐                  │  │
│  │              │  @lumibase/runtime      │                  │  │
│  │              │  (Cloudflare Adapter)   │                  │  │
│  │              └────────────┬────────────┘                  │  │
│  └───────────────────────────┼───────────────────────────────┘  │
│                              │                                   │
│  ┌───────────┐  ┌───────────▼───┐  ┌─────────────────────────┐ │
│  │  KV Cache │  │  Hyperdrive   │  │  R2 Object Storage      │ │
│  │           │  │  (PG Pooler)  │  │                         │ │
│  └───────────┘  └───────┬───────┘  └─────────────────────────┘ │
│                          │                                       │
└──────────────────────────┼───────────────────────────────────────┘
                           │
                  ┌────────▼────────┐
                  │   PostgreSQL    │
                  │  (Neon / Supabase)│
                  └─────────────────┘

External Services:
  ┌──────────────────┐  ┌──────────────────┐
  │ MeiliSearch Cloud│  │ Cloudflare Queues │
  └──────────────────┘  └──────────────────┘
```

## Architecture: Docker (Self-Hosted)

```
┌─────────────────────────────────────────────────────────────────┐
│                     Docker Host / Cluster                         │
│                                                                   │
│  ┌───────────────────────────────────────────────────────────┐   │
│  │              Lumibase CMS (Node.js + Hono)                │   │
│  │              Port 1989                                    │   │
│  │                                                           │   │
│  │              ┌────────────────────────────┐               │   │
│  │              │  @lumibase/runtime         │               │   │
│  │              │  (Docker Adapter)          │               │   │
│  │              └────────────┬───────────────┘               │   │
│  └───────────────────────────┼───────────────────────────────┘   │
│                              │                                    │
│         ┌────────────────────┼────────────────────┐              │
│         │                    │                    │              │
│  ┌──────▼──────┐  ┌─────────▼─────────┐  ┌──────▼──────┐       │
│  │    Redis    │  │    PostgreSQL     │  │    MinIO    │       │
│  │  Port 6379 │  │    Port 5432      │  │  Port 9000  │       │
│  │  (Cache +  │  │                   │  │  (S3-compat │       │
│  │   Queues)  │  │                   │  │   storage)  │       │
│  └─────────────┘  └───────────────────┘  └─────────────┘       │
│                                                                   │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │ MeiliSearch │  │  Imgproxy   │  │  Prometheus + Grafana   │  │
│  │  Port 7700  │  │  Port 8080  │  │  Ports 9090 / 3002     │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

## Service Topology Summary

### Core Services (Required)

| Service | Cloudflare | Docker |
|---------|-----------|--------|
| CMS API | Worker (edge) | Node.js container |
| Database | PostgreSQL via Hyperdrive | PostgreSQL 16 container |
| Cache | Cloudflare KV | Redis 7 |
| Object Storage | Cloudflare R2 | MinIO (S3-compatible) |

### Integrated Tooling (Docker)

| Service | Port | Purpose |
|---------|------|---------|
| MeiliSearch | 7700 | Full-text search |
| Imgproxy | 8080 | Image transformation |
| BullMQ (via Redis) | — | Background job queue |
| Bull Board | 3001 | Queue monitoring UI |

### Observability Stack (Optional Overlay)

| Service | Port | Purpose |
|---------|------|---------|
| Prometheus | 9090 | Metrics collection |
| Grafana | 3002 | Dashboards and visualization |
| Loki | 3100 | Log aggregation |

## Runtime Selection

The active runtime is determined by the `LUMIBASE_RUNTIME` environment variable:

```bash
# Cloudflare Workers (default when deployed via Wrangler)
LUMIBASE_RUNTIME=cloudflare

# Docker / self-hosted (default when LUMIBASE_RUNTIME is unset in Node.js)
LUMIBASE_RUNTIME=docker
```

The runtime factory (`createRuntime(env)`) instantiates the correct set of adapters at startup. All business logic, routes, and middleware remain identical across both modes.

## Next Steps

- [Cloudflare Deployment Guide](./cloudflare.md) — Deploy to Cloudflare Workers
- [Docker Deployment Guide](./docker.md) — Deploy with Docker
- [Local Development](./local-development.md) — Get started locally with Docker Compose
- [Environment Variables](./environment-variables.md) — Complete configuration reference
