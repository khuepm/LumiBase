---
title: Setup — Debezium + Kafka
---

# Setup Guide: Debezium + Kafka

The Debezium + Kafka approach (`debezium_kafka`) reads the PostgreSQL write-ahead log (WAL) with Debezium and publishes INSERT/UPDATE/DELETE events to Kafka topics partitioned by table. ClickHouse ingests those topics through the Kafka table engine. Choose this approach for **high throughput (> 10,000 rows/s)** or **very low latency (< 5s)** workloads.

> This guide configures the connector itself. To stand up the underlying services (Kafka, Debezium, ClickHouse), follow the [Docker Compose / managed-services deployment guide](./deployment-docker-compose.md) first.

## Prerequisites

- A PostgreSQL Source_Database with logical replication enabled:
  - `wal_level = logical`
  - A role with the `REPLICATION` attribute
  - `max_replication_slots` and `max_wal_senders` ≥ 1 (per pipeline)
- A reachable Kafka Broker (self-hosted or Confluent Cloud).
- A Debezium / Kafka Connect worker that can reach both PostgreSQL and Kafka.
- A reachable ClickHouse Sink with the Kafka table engine available.
- Admin access to the LumiBase CMS (`/api/v1/cdc` is admin-gated and site-scoped).

## Step 1: Prepare PostgreSQL

Confirm logical replication is enabled and create a publication for the tables you want to replicate:

```sql
-- Verify WAL level (must return 'logical')
SHOW wal_level;

-- Create a publication for the replicated tables
CREATE PUBLICATION lumibase_cdc_pub FOR TABLE public.orders, public.customers;
```

Debezium creates its own replication slot (default name `lumibase_debezium`) on first start; you do not need to create the slot manually.

## Step 2: Set the environment variables

Configure the Debezium+Kafka variables described in the [Environment Variables reference](./environment-variables.md#debezium--kafka-docker_compose). At minimum:

```bash
CDC_PIPELINE_NAME=orders-analytics
CDC_APPROACH=debezium_kafka
CDC_DEPLOYMENT_TARGET=docker_compose
SOURCE_DATABASE_URL=postgresql://cdc_user:secret@postgres:5432/lumibase
CLICKHOUSE_SINK_URL=clickhouse://clickhouse:9000/analytics
CDC_REPLICATION_TABLES=public.orders,public.customers
KAFKA_BOOTSTRAP_SERVERS=kafka:9092
DEBEZIUM_CONNECT_URL=http://debezium:8083
```

Validate the values before registering the pipeline:

```bash
curl -sS -X POST https://your-cms-host/api/v1/cdc/deploy/validate-env \
  -H "Authorization: Bearer $LUMI_ADMIN_TOKEN" \
  -H "X-Lumi-Site: $SITE_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "approach": "debezium_kafka",
    "target": "docker_compose",
    "env": {
      "CDC_PIPELINE_NAME": "orders-analytics",
      "SOURCE_DATABASE_URL": "postgresql://cdc_user:secret@postgres:5432/lumibase",
      "CLICKHOUSE_SINK_URL": "clickhouse://clickhouse:9000/analytics",
      "CDC_REPLICATION_TABLES": "public.orders,public.customers",
      "KAFKA_BOOTSTRAP_SERVERS": "kafka:9092",
      "DEBEZIUM_CONNECT_URL": "http://debezium:8083"
    }
  }'
```

Expected output:

```json
{ "data": { "valid": true } }
```

## Step 3: Register the pipeline

```bash
curl -sS -X POST https://your-cms-host/api/v1/cdc/pipelines \
  -H "Authorization: Bearer $LUMI_ADMIN_TOKEN" \
  -H "X-Lumi-Site: $SITE_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "pipeline_name": "orders-analytics",
    "cdc_connector_type": "debezium_kafka",
    "source_database_connection": "postgresql://cdc_user:secret@postgres:5432/lumibase",
    "clickhouse_sink_connection": "clickhouse://clickhouse:9000/analytics",
    "intermediary_connection": "kafka://kafka:9092",
    "replication_tables": ["public.orders", "public.customers"]
  }'
```

The registry runs a connectivity check (10s timeout) against the source and sink, then returns the new pipeline with a `nanoid` id and `status: "provisioning"`.

## Step 4: Start replication

```bash
curl -sS -X POST https://your-cms-host/api/v1/cdc/pipelines/$PIPELINE_ID/start \
  -H "Authorization: Bearer $LUMI_ADMIN_TOKEN" \
  -H "X-Lumi-Site: $SITE_ID"
```

Debezium registers the connector, creates one Kafka topic per table (prefixed by `KAFKA_TOPIC_PREFIX`, default `lumibase_cdc`), and ClickHouse begins ingesting via the Kafka table engine.

## Step 5: Verify

Run a health check:

```bash
curl -sS https://your-cms-host/api/v1/cdc/pipelines/$PIPELINE_ID/health \
  -H "Authorization: Bearer $LUMI_ADMIN_TOKEN" \
  -H "X-Lumi-Site: $SITE_ID"
```

Expected output (each provisioned service reachable):

```json
{
  "data": {
    "pipelineId": "V1StGXR8_Z5",
    "healthy": true,
    "services": [
      { "service": "source_database", "reachable": true },
      { "service": "kafka_broker", "reachable": true },
      { "service": "clickhouse_sink", "reachable": true }
    ]
  }
}
```

Confirm topics were created and data is landing in ClickHouse:

```bash
# Kafka topics (one per replicated table)
kafka-topics.sh --bootstrap-server kafka:9092 --list | grep lumibase_cdc

# Row count in the ClickHouse target
clickhouse-client --query "SELECT count() FROM analytics.orders"
```

## How this approach behaves

- **Topic routing** — each table maps to a deterministic, unique topic name (Requirement 2.2).
- **Kafka outage** — events are buffered locally up to 1 hour / 500 MB and replayed in order on recovery (Requirement 2.4); see `KAFKA_BUFFER_MAX_AGE_MS` / `KAFKA_BUFFER_MAX_BYTES`.
- **ClickHouse outage** — events are retained on Kafka topics and ingestion resumes in order when ClickHouse is reachable again (Requirement 2.6).
- **Replication slot failure** — after `DEBEZIUM_MAX_SLOT_FAILURES` (default 3) consecutive failures the pipeline status becomes `error` with the failure reason (Requirement 2.5).
- **Deletion** — deleting the pipeline drops the PostgreSQL replication slot so WAL files are not retained (Requirement 1.8).

For failure handling see the [Troubleshooting guide](./troubleshooting.md).

## Next steps

- [Environment Variables — Debezium + Kafka](./environment-variables.md#debezium--kafka-docker_compose)
- [Deployment — Docker Compose / managed services](./deployment-docker-compose.md)
- [Troubleshooting](./troubleshooting.md)
