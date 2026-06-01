---
title: ClickHouse CDC
---

# ClickHouse CDC

The ClickHouse CDC (Change Data Capture) system replicates data in real time from PostgreSQL (the **Source_Database**) to ClickHouse (the **ClickHouse_Sink**) for OLAP/analytics workloads, and automatically refreshes the Redis cache when configuration tables change. It supports three interchangeable replication strategies behind a common connector interface so you can pick the right trade-off for each pipeline.

This section is the entry point for the CDC documentation. Start with the [Architecture Overview](./architecture.md), then follow the setup guide for the approach you chose.

## Documentation map

| Document | What it covers |
|----------|----------------|
| [Architecture Overview](./architecture.md) | System diagram, components, data flow, and deployment topology |
| [Choosing an Approach](#decision-criteria-choosing-an-approach) | Decision-criteria comparison table (below) |
| [Setup — Debezium + Kafka](./setup-debezium-kafka.md) | High-throughput streaming via Kafka + Debezium |
| [Setup — Materialized Engine](./setup-materialized-engine.md) | Direct PostgreSQL→ClickHouse replication, no message bus |
| [Setup — Airbyte](./setup-airbyte.md) | Managed, UI/API-driven scheduled replication |
| [Environment Variables](./environment-variables.md) | Per-approach variable reference + complete working config example per approach |
| [Troubleshooting](./troubleshooting.md) | Replication slot errors, connectivity failures, sync failures, schema drift |
| [Deployment — Docker Compose / managed services](./deployment-docker-compose.md) | Full stateful stack (Kafka, Debezium, ClickHouse, Materialized Engine, Airbyte) |
| [Deployment — Cloudflare Workers (edge only)](./deployment-cloudflare-workers.md) | CDC API/control-plane + Cache_Invalidator at the edge |

## The three CDC approaches

- **Debezium + Kafka** (`debezium_kafka`) — Debezium reads the PostgreSQL write-ahead log (WAL) and publishes INSERT/UPDATE/DELETE events to Kafka topics partitioned by table; ClickHouse ingests them via the Kafka table engine. Built for the highest throughput and lowest latency, at the cost of running Kafka and Debezium.
- **ClickHouse Materialized Engine** (`materialized_engine`) — ClickHouse connects directly to a PostgreSQL replication slot using the `MaterializedPostgreSQL` engine. No intermediary services, lowest operational overhead, best for low-to-moderate volume.
- **Airbyte** (`airbyte`) — Airbyte manages the PostgreSQL source, ClickHouse destination, and a scheduled connection through its platform. The least infrastructure to operate, with scheduled (not streaming) syncs.

## Decision criteria: choosing an approach

Use this table to select an approach. The thresholds match the built-in recommendation engine (`apps/cms/src/modules/cdc/recommender.ts`): high volume (> 10,000 rows/s) or a sub-5-second latency budget steers you to Debezium+Kafka; low volume (< 5,000 rows/s) with no Kafka and a relaxed (< 30s) budget steers you to the Materialized Engine; a managed-service preference steers you to Airbyte.

| Criteria | Debezium + Kafka | Materialized Engine | Airbyte |
|----------|------------------|---------------------|---------|
| **Data volume threshold (rows/sec)** | High — designed for **> 10,000 rows/s**; partitioned topics absorb heavy write rates | Low–moderate — best **< 5,000 rows/s** | Low–moderate — batch oriented; throughput bounded by sync interval |
| **Replication latency range** | Streaming: typically **< 30s** end-to-end (events ingested within 30s of publication); sub-second under light load | Near-real-time: **≤ 10s** lag under normal conditions | Scheduled: **5 minutes – 24 hours** (configurable interval) |
| **Infrastructure dependencies** | Kafka Broker + Debezium (Kafka Connect) + ClickHouse Sink | ClickHouse Sink only (direct PostgreSQL replication slot) | Airbyte platform + ClickHouse Sink |
| **Manual configuration steps** | **Most** (~8): publication, replication slot, Debezium connector, Kafka topics, Kafka table engine, materialized view, sink table, network wiring | **Few** (~3): create `MaterializedPostgreSQL` database, grant replication, select tables | **Fewest** (~3): create source, destination, and connection (UI/API-driven) |

> The Studio pipeline wizard surfaces a recommendation from the same engine when you enter your estimated volume and latency requirements (Requirement 6.3).

## Documentation update policy

Per **Requirement 9.5**, whenever a new CDC approach or configuration option is added, this documentation **must be updated before the feature is merged into the main branch**, following the same structure used here:

1. An **architecture section** describing the approach (add to [Architecture Overview](./architecture.md)).
2. A **setup guide** (`setup-<approach>.md`) mirroring the existing setup guides.
3. An **environment variable reference** for the approach (add to [Environment Variables](./environment-variables.md)) including descriptions, defaults, and validation rules, plus a complete working configuration example.
4. **Deployment steps** (update the relevant deployment guide) and a row in the [decision-criteria table](#decision-criteria-choosing-an-approach) above.

Environment variable definitions in this documentation are generated from, and must stay consistent with, `apps/cms/src/modules/cdc/ai-flow/config-generator.ts`.

## Related links

- Project repository: [github.com/khuepm/lumibase](https://github.com/khuepm/lumibase)
- Project website: [lumibase.dev](https://lumibase.dev)
- Platform deployment docs: [LumiBase Documentation index](../README.md)
