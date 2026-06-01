---
title: Setup — Airbyte
---

# Setup Guide: Airbyte

The Airbyte approach (`airbyte`) provisions an Airbyte source (PostgreSQL), destination (ClickHouse), and a scheduled connection through the Airbyte API. It has the least infrastructure to operate and is ideal when you **prefer a managed service** and your latency budget tolerates **scheduled syncs (5 minutes to 24 hours)** rather than streaming.

> To stand up the Airbyte platform and ClickHouse, follow the [Docker Compose / managed-services deployment guide](./deployment-docker-compose.md) first, or use Airbyte Cloud.

## Prerequisites

- A reachable Airbyte instance (self-hosted or Airbyte Cloud) with API access.
- An Airbyte workspace ID.
- A PostgreSQL Source_Database reachable from Airbyte. For incremental CDC sync mode, enable logical replication (`wal_level = logical`) and a replication role, as with the other approaches.
- A ClickHouse Sink reachable from Airbyte.
- Admin access to the LumiBase CMS.

## Step 1: Note your Airbyte connection details

You need the Airbyte API base URL and workspace ID:

```bash
AIRBYTE_API_URL=http://airbyte:8001/api
AIRBYTE_WORKSPACE_ID=00000000-0000-0000-0000-000000000000
```

## Step 2: Set the environment variables

Configure the Airbyte variables described in the [Environment Variables reference](./environment-variables.md#airbyte-docker_compose). At minimum:

```bash
CDC_PIPELINE_NAME=reporting-sync
CDC_APPROACH=airbyte
CDC_DEPLOYMENT_TARGET=docker_compose
SOURCE_DATABASE_URL=postgresql://cdc_user:secret@postgres:5432/lumibase
CLICKHOUSE_SINK_URL=clickhouse://clickhouse:9000/analytics
CDC_REPLICATION_TABLES=public.invoices,public.payments
AIRBYTE_API_URL=http://airbyte:8001/api
AIRBYTE_WORKSPACE_ID=00000000-0000-0000-0000-000000000000
AIRBYTE_SYNC_MODE=incremental_cdc
AIRBYTE_SYNC_INTERVAL_SECONDS=300
```

> **Sync interval** must be between **300 seconds (5 minutes)** and **86400 seconds (24 hours)**. Values outside this range are rejected with a validation error (Requirements 4.3, 4.7).

Validate before registering:

```bash
curl -sS -X POST https://your-cms-host/api/v1/cdc/deploy/validate-env \
  -H "Authorization: Bearer $LUMI_ADMIN_TOKEN" \
  -H "X-Lumi-Site: $SITE_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "approach": "airbyte",
    "target": "docker_compose",
    "env": {
      "CDC_PIPELINE_NAME": "reporting-sync",
      "SOURCE_DATABASE_URL": "postgresql://cdc_user:secret@postgres:5432/lumibase",
      "CLICKHOUSE_SINK_URL": "clickhouse://clickhouse:9000/analytics",
      "CDC_REPLICATION_TABLES": "public.invoices,public.payments",
      "AIRBYTE_API_URL": "http://airbyte:8001/api",
      "AIRBYTE_WORKSPACE_ID": "00000000-0000-0000-0000-000000000000",
      "AIRBYTE_SYNC_INTERVAL_SECONDS": "300"
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
    "pipeline_name": "reporting-sync",
    "cdc_connector_type": "airbyte",
    "source_database_connection": "postgresql://cdc_user:secret@postgres:5432/lumibase",
    "clickhouse_sink_connection": "clickhouse://clickhouse:9000/analytics",
    "intermediary_connection": "http://airbyte:8001/api",
    "replication_tables": ["public.invoices", "public.payments"],
    "config": { "sync_mode": "incremental_cdc", "interval_seconds": 300 }
  }'
```

On start, the connector provisions the Airbyte source, destination, and connection within a 120-second timeout (Requirement 4.1). If provisioning fails or exceeds the timeout, the pipeline goes to `error`, the reason is recorded, and any partially allocated resources are released (Requirement 4.6).

## Step 4: Start replication

```bash
curl -sS -X POST https://your-cms-host/api/v1/cdc/pipelines/$PIPELINE_ID/start \
  -H "Authorization: Bearer $LUMI_ADMIN_TOKEN" \
  -H "X-Lumi-Site: $SITE_ID"
```

Airbyte runs sync jobs at the configured interval. On each successful sync, the Pipeline Registry updates the last-sync timestamp and record count (Requirement 4.5).

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
    "pipelineId": "V1StGXR8_Z5",
    "healthy": true,
    "services": [
      { "service": "source_database", "reachable": true },
      { "service": "airbyte_connector", "reachable": true },
      { "service": "clickhouse_sink", "reachable": true }
    ]
  }
}
```

Confirm the last sync recorded a timestamp and record count:

```bash
curl -sS https://your-cms-host/api/v1/cdc/pipelines/$PIPELINE_ID \
  -H "Authorization: Bearer $LUMI_ADMIN_TOKEN" \
  -H "X-Lumi-Site: $SITE_ID"
```

The response includes `lastSyncAt` and `lastSyncRecordCount`.

## How this approach behaves

- **Sync modes** — supports both `full_refresh` and `incremental_cdc` (Requirement 4.2).
- **Sync interval** — validated to the 5-minute–24-hour range (Requirements 4.3, 4.7).
- **Sync failure** — a failed sync is retried up to `AIRBYTE_SYNC_MAX_RETRIES` (default 3) times with exponential backoff (starting at 30s) before the pipeline goes to `error` with the failure reason (Requirement 4.4).
- **Deletion** — this approach is not replication-slot-based, so deleting the pipeline removes the Airbyte source/destination/connection without PostgreSQL replication-slot cleanup.

For failure handling see the [Troubleshooting guide](./troubleshooting.md).

## Next steps

- [Environment Variables — Airbyte](./environment-variables.md#airbyte-docker_compose)
- [Deployment — Docker Compose / managed services](./deployment-docker-compose.md)
- [Troubleshooting](./troubleshooting.md)
