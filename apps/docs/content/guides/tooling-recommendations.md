# Tooling Recommendations

This guide covers the tools integrated with LumiBase and recommends alternatives for different use cases. Tools are categorized as:

- **Integrated** — Included in the Docker Compose stack, configured out of the box
- **Alternative** — Drop-in replacements with different trade-offs
- **Optional** — Complementary tools for specific needs

## Full-Text Search

### Integrated: MeiliSearch

MeiliSearch provides instant, typo-tolerant full-text search with minimal configuration.

| Feature | Details |
|---------|---------|
| Category | Integrated |
| Docker port | 7700 |
| Latency | < 50ms for most queries |
| Index size | Up to 100GB per index |
| Best for | Content search, autocomplete, faceted filtering |

**Configuration:**

```yaml
# docker-compose.yml (already included)
meilisearch:
  image: getmeili/meilisearch:v1.7
  environment:
    MEILI_MASTER_KEY: your-master-key
    MEILI_ENV: production
  ports:
    - "7700:7700"
  volumes:
    - meilidata:/meili_data
```

**Usage in LumiBase:**

Content is automatically indexed on create/update and removed on delete via the `SearchProvider` interface. The `/search` endpoint provides query access.

### Alternative: Typesense

| Feature | MeiliSearch | Typesense |
|---------|-------------|-----------|
| Typo tolerance | Excellent | Excellent |
| Geo search | Yes | Yes |
| Faceting | Yes | Yes |
| RAM usage | Moderate | Lower |
| Clustering | Cloud only | Built-in (HA) |
| License | MIT | GPL-3.0 |
| Managed option | MeiliSearch Cloud | Typesense Cloud |

**Docker Compose override:**

```yaml
# docker-compose.typesense.yml
services:
  typesense:
    image: typesense/typesense:0.25.2
    environment:
      TYPESENSE_API_KEY: your-api-key
      TYPESENSE_DATA_DIR: /data
    ports:
      - "8108:8108"
    volumes:
      - typesensedata:/data

volumes:
  typesensedata:
```

### Alternative: Elasticsearch

| Feature | MeiliSearch | Elasticsearch |
|---------|-------------|---------------|
| Setup complexity | Low | High |
| Resource usage | Low-moderate | High (JVM) |
| Query language | Simple filters | Full DSL |
| Analytics | Basic | Advanced |
| Clustering | Cloud only | Built-in |
| Best for | Simple search | Complex queries, analytics |

**When to choose Elasticsearch:**
- You need complex aggregations and analytics
- You have > 1 billion documents
- You need cross-index joins
- You already have Elastic infrastructure

## Background Job Queue

### Integrated: BullMQ

BullMQ provides reliable job processing backed by Redis with priorities, retries, and rate limiting.

| Feature | Details |
|---------|---------|
| Category | Integrated |
| Backend | Redis (shared with cache) |
| Dashboard | Bull Board on port 3001 |
| Best for | Webhooks, media processing, search indexing |

**Configuration:**

```yaml
# docker-compose.yml (already included)
bull-board:
  image: deadly0/bull-board:latest
  environment:
    REDIS_HOST: redis
    REDIS_PORT: 6379
  ports:
    - "3001:3000"
```

**Features:**
- Job priorities (high, normal, low)
- Exponential backoff retries (default: 3 attempts)
- Delayed jobs and scheduled execution
- Job progress tracking
- Dead letter queue for failed jobs

### Alternative: RabbitMQ

| Feature | BullMQ | RabbitMQ |
|---------|--------|----------|
| Backend | Redis | Standalone |
| Protocol | Custom | AMQP |
| Routing | Queue-based | Exchange + routing keys |
| Clustering | Redis Cluster | Built-in |
| Management UI | Bull Board | Built-in (port 15672) |
| Best for | Simple queues | Complex routing, pub/sub |

**Docker Compose override:**

```yaml
# docker-compose.rabbitmq.yml
services:
  rabbitmq:
    image: rabbitmq:3.13-management-alpine
    environment:
      RABBITMQ_DEFAULT_USER: lumibase
      RABBITMQ_DEFAULT_PASS: lumibase_dev
    ports:
      - "5672:5672"
      - "15672:15672"
    volumes:
      - rabbitmqdata:/var/lib/rabbitmq

volumes:
  rabbitmqdata:
```

**When to choose RabbitMQ:**
- You need complex message routing patterns
- You need message acknowledgment guarantees
- You have multiple consumers with different routing needs
- You want protocol-level interoperability (AMQP)

### Alternative: AWS SQS / Google Cloud Tasks

For managed queue services when running on cloud platforms:

| Feature | BullMQ | AWS SQS | Cloud Tasks |
|---------|--------|---------|-------------|
| Hosting | Self-managed | Managed | Managed |
| Cost | Redis cost | Per-message | Per-operation |
| Max delay | Unlimited | 15 minutes | 30 days |
| FIFO | Yes | Optional | Yes |
| Dead letter | Yes | Yes | Yes |
| Best for | Self-hosted | AWS deployments | GCP deployments |

## Media Processing

### Integrated: Imgproxy

Imgproxy provides on-the-fly image resizing, format conversion, and optimization with signed URLs for security.

| Feature | Details |
|---------|---------|
| Category | Integrated |
| Docker port | 8080 |
| Formats | WebP, AVIF, JPEG, PNG, GIF |
| Operations | Resize, crop, rotate, watermark, blur |
| Security | HMAC-signed URLs |

**Configuration:**

```yaml
# docker-compose.yml (already included)
imgproxy:
  image: darthsim/imgproxy:latest
  environment:
    IMGPROXY_KEY: ${IMGPROXY_KEY}
    IMGPROXY_SALT: ${IMGPROXY_SALT}
    IMGPROXY_USE_S3: "true"
    AWS_ACCESS_KEY_ID: minioadmin
    AWS_SECRET_ACCESS_KEY: minioadmin
    IMGPROXY_S3_ENDPOINT: http://minio:9000
  ports:
    - "8080:8080"
```

**Features:**
- Lazy processing (transforms on first request, then cached)
- Supports reading from S3/MinIO directly
- Low memory footprint (libvips-based)
- Automatic format negotiation (serves WebP/AVIF when supported)

### Alternative: Cloudinary

| Feature | Imgproxy | Cloudinary |
|---------|----------|------------|
| Hosting | Self-managed | Managed (CDN) |
| Cost | Infrastructure only | Per-transformation + storage |
| CDN | BYO | Built-in (global) |
| AI features | None | Auto-crop, background removal |
| Video | Limited | Full support |
| Best for | Self-hosted, cost control | Managed, AI features |

**When to choose Cloudinary:**
- You need AI-powered transformations (smart crop, background removal)
- You need video processing
- You want a global CDN without managing infrastructure
- Budget allows per-transformation pricing

### Alternative: Thumbor

| Feature | Imgproxy | Thumbor |
|---------|----------|---------|
| Language | Go | Python |
| Performance | Very fast | Moderate |
| Plugins | Limited | Extensive |
| Smart crop | Basic | AI-based (OpenCV) |
| License | MIT | MIT |

**Docker Compose override:**

```yaml
# docker-compose.thumbor.yml
services:
  thumbor:
    image: thumbororg/thumbor:latest
    environment:
      THUMBOR_SECURITY_KEY: your-security-key
      THUMBOR_ALLOW_UNSAFE_URL: "false"
    ports:
      - "8888:8888"
```

### Alternative: Bunny CDN (Optimizer)

| Feature | Imgproxy | Bunny Optimizer |
|---------|----------|-----------------|
| Hosting | Self-managed | Managed CDN |
| Pricing | Infrastructure | Per-image (cheap) |
| Setup | Docker config | DNS change |
| Formats | All modern | WebP, AVIF |
| Best for | Self-hosted | Simple CDN optimization |

## Monitoring and Observability

### Integrated: Prometheus + Grafana

Full observability stack with metrics collection, dashboards, and log aggregation.

| Feature | Details |
|---------|---------|
| Category | Integrated (optional overlay) |
| Prometheus port | 9090 |
| Grafana port | 3002 |
| Loki port | 3100 |
| Dashboard | Pre-configured LumiBase dashboard |

**Enable monitoring:**

```bash
docker compose -f docker-compose.yml -f docker-compose.monitoring.yml up -d
```

**Pre-configured metrics:**
- HTTP request rate and latency (p50, p95, p99)
- Error rate by status code
- Cache hit/miss ratio
- Queue depth and processing time
- Search query latency
- Active database connections

### Alternative: Datadog

| Feature | Prometheus + Grafana | Datadog |
|---------|---------------------|---------|
| Hosting | Self-managed | Managed |
| Cost | Infrastructure only | Per-host pricing |
| APM | Manual instrumentation | Auto-instrumentation |
| Log management | Loki (basic) | Full-featured |
| Alerting | Alertmanager | Built-in |
| Best for | Self-hosted, budget | Teams wanting managed observability |

### Alternative: Sentry

| Feature | Prometheus + Grafana | Sentry |
|---------|---------------------|--------|
| Focus | Metrics + dashboards | Error tracking + performance |
| Error grouping | Manual | Automatic |
| Source maps | N/A | Yes |
| Release tracking | Manual | Built-in |
| Best for | Infrastructure metrics | Application errors |

**Recommendation:** Use Sentry alongside Prometheus/Grafana. They serve different purposes — Sentry for error tracking, Prometheus for infrastructure metrics.

### Alternative: New Relic

| Feature | Prometheus + Grafana | New Relic |
|---------|---------------------|-----------|
| Hosting | Self-managed | Managed |
| Free tier | Unlimited (self-hosted) | 100GB/month |
| APM | Manual | Auto-instrumentation |
| Distributed tracing | Jaeger (add-on) | Built-in |
| Best for | Full control | Quick setup, generous free tier |

## Caching Strategies

### Integrated: Redis

Redis serves dual duty as both cache and queue backend in the Docker stack.

| Feature | Details |
|---------|---------|
| Category | Integrated |
| Port | 6379 |
| Use cases | API response cache, session store, queue backend |

### Optional: CDN for Content Delivery

For production deployments, add a CDN in front of the CMS API:

| CDN | Best for | Cache invalidation |
|-----|----------|-------------------|
| Cloudflare | Global, free tier | Instant purge API |
| Fastly | Real-time purge | Instant surrogate keys |
| Bunny CDN | Cost-effective | Purge API |
| AWS CloudFront | AWS ecosystem | Invalidation API |

**Recommended pattern:**

```
Client → CDN → LumiBase CMS → Database
                    ↓
              Redis (L1 cache)
```

Set appropriate `Cache-Control` headers on content delivery endpoints:

```
Cache-Control: public, max-age=60, stale-while-revalidate=300
```

### Optional: Varnish

For high-traffic deployments needing aggressive HTTP caching:

```yaml
# docker-compose.varnish.yml
services:
  varnish:
    image: varnish:7.4
    ports:
      - "80:80"
    volumes:
      - ./varnish/default.vcl:/etc/varnish/default.vcl
    depends_on:
      - cms
```

## Summary Table

| Tool | Category | Purpose | Included in Stack |
|------|----------|---------|-------------------|
| MeiliSearch | Integrated | Full-text search | Yes |
| BullMQ | Integrated | Job queue | Yes (via Redis) |
| Imgproxy | Integrated | Image processing | Yes |
| Prometheus | Integrated | Metrics | Yes (monitoring overlay) |
| Grafana | Integrated | Dashboards | Yes (monitoring overlay) |
| Loki | Integrated | Log aggregation | Yes (monitoring overlay) |
| Redis | Integrated | Cache + queue backend | Yes |
| Typesense | Alternative | Search (lower RAM) | No |
| Elasticsearch | Alternative | Search (complex queries) | No |
| RabbitMQ | Alternative | Queue (complex routing) | No |
| AWS SQS | Alternative | Queue (managed) | No |
| Cloudinary | Alternative | Media (managed + AI) | No |
| Thumbor | Alternative | Media (Python, plugins) | No |
| Datadog | Alternative | Observability (managed) | No |
| Sentry | Optional | Error tracking | No |
| New Relic | Alternative | APM (managed) | No |
| CDN | Optional | Edge caching | No |
| Varnish | Optional | HTTP cache | No |

## Next Steps

- [Docker Deployment](../deployment/docker.md) — Set up the full Docker stack
- [Backup & Recovery](./backup-recovery.md) — Database backup strategy
- [Environment Variables](../deployment/environment-variables.md) — Configure all services
