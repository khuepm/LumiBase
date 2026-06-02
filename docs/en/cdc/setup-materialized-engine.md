---
title: Setup — Materialized Engine
---

# Setup Guide: ClickHouse Materialized Engine

The Materialized Engine approach (`materialized_engine`) connects ClickHouse directly to a PostgreSQL replication slot using the `MaterializedPostgreSQL` database engine. There is no message bus and no intermediary service, which makes it the lowest-overhead approach. Choose it for **low-to-moderate volume (< 5,000 rows/s)** workloads with **no existing Kafka infrastructure** and a **relaxed latency budget (< 30s)**.

> To stand up ClickHouse, follow the [Docker Compose / managed-services deployment guide](./deployment-docker-compose.md) first.

## Prerequisites

- A PostgreSQL Source_Database with logical replication enabled:
  - `wal_level = logical`
  - A role with the `REPLICATION` attribute
  - `max_replication_slots` and `max_wal_senders` ≥ 1 (per pipeline)
- A ClickHouse Sink (version 24.x recommended) with the `MaterializedPostgreSQL` engine available. Enable it if needed:
  ```sql
  SET allow_experimental_database_materialized_postgresql = 1;
  ```
- Network connectivity from ClickHouse directly to PostgreSQL (port 5432).
- Admin access to the LumiBase CMS.

## Step 1: Prepare PostgreSQL

```sql
-- Verify WAL level (must return 'logical')
SHOW wal_level;

-- Grant replication to the CDC role
ALTER ROLE cdc_user WITH REPLICATION;
```

The Materialized Engine creates and owns its replication slot (default name `lumibase_mat`); you do not create it manually.

## Step 2: Set the environment variables

Configure the Materialized Engine variables described in the [Environment Variables reference](./environment-variables.md#materialized-engine-docker_compose). At minimum:

```bash
CDC_PIPELINE_NAME=catalog-analytics
CDC_APPROACH=materialized_engine
CDC_DEPLOYMENT_TARGET=docker_compose
SOURCE_DATABASE_URL=postgresql://cdc_user:secret@postgres:5432/lumibase
CLICKHOUSE_SINK_URL=clickhouse://clickhouse:9000/analytics
CDC_REPLICATION_TABLES=public.products,public.categories
MATERIALIZED_DATABASE_NAME=lumibase_cdc_mat
```

Validate before registering:

```bash
curl -sS -X POST https://your-cms-host/api/v1/cdc/deploy/validate-env \
  -H "Authorization: Bearer $LUMI_ADMIN_TOKEN" \
  -H "X-Lumi-Site: $SITE_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "approach": "materialized_engine",
    "target": "docker_compose",
    "env": {
      "CDC_PIPELINE_NAME": "catalog-analytics",
      "SOURCE_DATABASE_URL": "postgresql://cdc_user:secret@postgres:5432/lumibase",
      "CLICKHOUSE_SINK_URL": "clickhouse://clickhouse:9000/analytics",
      "CDC_REPLICATION_TABLES": "public.products,public.categories"
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
    "pipeline_name": "catalog-analytics",
    "cdc_connector_type": "materialized_engine",
    "source_database_connection": "postgresql://cdc_user:secret@postgres:5432/lumibase",
    "clickhouse_sink_connection": "clickhouse://clickhouse:9000/analytics",
    "replication_tables": ["public.products", "public.categories"]
  }'
```

The registry runs a 10-second connectivity check against the source and sink and returns the pipeline with a `nanoid` id.

## Step 4: Start replication

```bash
curl -sS -X POST https://your-cms-host/api/v1/cdc/pipelines/$PIPELINE_ID/start \
  -H "Authorization: Bearer $LUMI_ADMIN_TOKEN" \
  -H "X-Lumi-Site: $SITE_ID"
```

ClickHouse creates a `MaterializedPostgreSQL` database (`MATERIALIZED_DATABASE_NAME`), attaches to the replication slot, and automatically creates a ClickHouse table for each replicated table — mapping PostgreSQL column names and types to their ClickHouse equivalents (Requirement 3.3). A newly added table is materialized within 60 seconds (Requirement 3.3).

## Step 5: Verify

Run a health check:

```bash
curl -sS https://your-cms-host/api/v1/cdc/pipelines/$PIPELINE_ID/health \
  -H "Authorization: Bearer $LUMI_ADMIN_TOKEN" \
  -H "X-Lumi-Site: $SITE_ID"
```

Expected output:

```json
{
  "data": {
    "healthy": true,
    "services": [
      { "service": "source_database", "reachable": true },
      { "service": "clickhouse_sink", "reachable": true }
    ],
    "checkedAt": "2025-01-15T10:30:00.000Z"
  }
}
```

Confirm the replicated tables exist and the replication slot is active:

```bash
# ClickHouse: list the auto-created replicated tables
clickhouse-client --query "SHOW TABLES FROM lumibase_cdc_mat"

# PostgreSQL: confirm the slot is active
psql "$SOURCE_DATABASE_URL" -c \
  "SELECT slot_name, active FROM pg_replication_slots WHERE slot_name = 'lumibase_mat';"
```

## How this approach behaves

- **Replication lag** — stays ≤ 10 seconds under normal conditions (Requirement 3.2).
- **Connection interruption** — reconnects with exponential backoff (starting at `MATERIALIZED_RECONNECT_BASE_DELAY_MS`, default 1000ms) up to `MATERIALIZED_RECONNECT_MAX_RETRIES` (default 5), resuming from the last confirmed LSN (Requirement 3.4). After the retries are exhausted the pipeline goes to `error` with the connection-failure reason and outage duration (Requirement 3.5).
- **Schema drift** — a source schema change (column add/remove/type change) is detected within `MATERIALIZED_SCHEMA_DRIFT_INTERVAL_MS` (default 60000ms) and sets the pipeline to `error` with the affected table and change type (Requirement 3.6).
- **Deletion** — deleting the pipeline detaches the `MaterializedPostgreSQL` database and drops the PostgreSQL replication slot (Requirement 1.8).

For failure handling see the [Troubleshooting guide](./troubleshooting.md).

## Next steps

- [Environment Variables — Materialized Engine](./environment-variables.md#materialized-engine-docker_compose)
- [Deployment — Docker Compose / managed services](./deployment-docker-compose.md)
- [Troubleshooting](./troubleshooting.md)
