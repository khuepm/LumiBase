---
title: CDC Troubleshooting
version: 1
lastUpdated: 2026-07-28T11:32:43.008Z
sourceLang: en
contentHash: 554b71767fc0509f
codeVerified: 2026-07-28T11:32:43.008Z
codeVerifiedHash: 554b71767fc0509f
codeVerifiedClaims: 36
---

# CDC Troubleshooting

This guide covers the error scenarios defined in Requirements 2–4 and the registration/health behaviors from the design's Error Handling tables: **replication slot errors**, **connectivity failures**, **sync job failures**, and **schema drift**. It satisfies the troubleshooting portion of **Requirement 9.1**.

When a pipeline enters the `error` state, inspect it first:

```bash
curl -sS https://your-cms-host/api/v1/cdc/pipelines/$PIPELINE_ID \
  -H "Authorization: Bearer $LUMI_ADMIN_TOKEN" \
  -H "X-Lumi-Site: $SITE_ID"
```

The `status` and `statusMessage` fields describe the failure. The Studio CDC Panel shows the same information with the error timestamp, source component, description, and at least one remediation step (Requirement 6.4).

---

## 1. Replication slot errors

Applies to Debezium + Kafka and Materialized Engine (both replication-slot-based).

### Symptom: pipeline status `error`, message references the replication slot

- **Debezium**: after `DEBEZIUM_MAX_SLOT_FAILURES` (default 3) consecutive failures to advance the slot offset, the pipeline is set to `error` and a critical notification is emitted (Requirement 2.5).
- **Materialized Engine**: after `MATERIALIZED_RECONNECT_MAX_RETRIES` (default 5) exhausted reconnection attempts, the pipeline is set to `error` with the connection-failure reason and the outage duration (Requirement 3.5).

### Diagnosis

```sql
-- Inspect replication slots and how far behind / inactive they are
SELECT slot_name, active, restart_lsn,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained_wal
FROM pg_replication_slots;
```

### Common causes and fixes

| Cause | Fix |
|-------|-----|
| Slot inactive while WAL accumulates (disk filling) | Restart the connector (`/start`). If the pipeline was abandoned, delete it so the slot is dropped (see below). |
| `max_replication_slots` exhausted | Increase `max_replication_slots` in PostgreSQL and restart; delete unused slots. |
| Replication role lost the `REPLICATION` attribute | `ALTER ROLE cdc_user WITH REPLICATION;` |
| Slot name collision with another tool | Set a unique `DEBEZIUM_SLOT_NAME` / `MATERIALIZED_SLOT_NAME`. |

### Orphaned slots after deletion

Deleting a pipeline drops its replication slot as part of `connector.destroy()` (Requirement 1.8). If slot cleanup fails, the API returns `409 REPLICATION_SLOT_CLEANUP_FAILED` and **keeps the registry record** so the orphaned slot is not forgotten. Retry the delete after resolving the cause; as a last resort drop the slot manually:

```sql
SELECT pg_drop_replication_slot('lumibase_debezium');
```

> A slot can only be dropped when inactive. Stop the consuming connector first.

---

## 2. Connectivity failures

Applies to pipeline registration, health checks, and all approaches.

### Symptom: registration rejected

| HTTP | Code | Meaning | Fix |
|------|------|---------|-----|
| 400 | `CONNECTIVITY_CHECK_FAILED` | An endpoint is unreachable; the `endpoint` field names which one | Fix the connection string / network path to that endpoint |
| 408 | `CONNECTIVITY_TIMEOUT` | The connectivity check exceeded its 10-second timeout | Verify network access, security groups, and DNS to the endpoint |

The connectivity check has a 10-second timeout per endpoint and reports which endpoint (source or sink) is unreachable.

### Symptom: health check shows a service unreachable

```bash
curl -sS https://your-cms-host/api/v1/cdc/pipelines/$PIPELINE_ID/health \
  -H "Authorization: Bearer $LUMI_ADMIN_TOKEN" -H "X-Lumi-Site: $SITE_ID"
```

```json
{
  "data": {
    "healthy": false,
    "services": [
      { "service": "kafka_broker", "reachable": false, "reason": "connection refused" }
    ]
  }
}
```

### Common causes and fixes

| Service | Checks |
|---------|--------|
| PostgreSQL | Reachable on 5432? Credentials valid? `?sslmode=require` if TLS is enforced? |
| ClickHouse | Reachable on 8123 (HTTP) / 9000 (native)? Database exists? |
| Kafka | `KAFKA_BOOTSTRAP_SERVERS` host:port correct and routable from Debezium? |
| Airbyte | `AIRBYTE_API_URL` reachable? Workspace ID valid? |
| Redis (Cache_Invalidator) | `REDIS_URL` reachable from the Workers/edge deployment? |

### Kafka / ClickHouse outages (Debezium approach)

These are handled automatically and recover without intervention:

- **Kafka unavailable** — events buffer locally up to 1 hour / 500 MB (`KAFKA_BUFFER_MAX_AGE_MS` / `KAFKA_BUFFER_MAX_BYTES`) and replay in order on recovery (Requirement 2.4).
- **ClickHouse unavailable** — events remain on Kafka topics and ingestion resumes in order when ClickHouse is reachable again (Requirement 2.6).

If buffering caps are reached, scale Kafka/ClickHouse capacity or reduce the replication table set.

### Redis unavailable (Cache_Invalidator)

The Cache_Invalidator queues up to `CACHE_INVALIDATOR_QUEUE_MAX` (default 10,000) events during a Redis outage and replays them in chronological order on reconnection. On overflow the oldest events are discarded and a warning is logged with the discard count (Requirements 5.4, 5.5). If you see discard warnings, increase the queue cap or restore Redis faster.

---

## 3. Sync job failures

Applies to Airbyte.

### Symptom: pipeline status `error` after sync retries

A failed Airbyte sync is retried up to `AIRBYTE_SYNC_MAX_RETRIES` (default 3) times with exponential backoff starting at 30 seconds. After the retries are exhausted, the pipeline is set to `error` and the failure reason is recorded in the registry (Requirement 4.4).

### Symptom: provisioning failed or timed out

If Airbyte provisioning fails or exceeds the 120-second timeout, the pipeline goes to `error`, the reason is recorded, and partially allocated resources are released (Requirement 4.6).

### Diagnosis and fixes

| Cause | Fix |
|-------|-----|
| Invalid sync interval | Use a value in **[300, 86400]** seconds; otherwise registration is rejected (Requirements 4.3, 4.7) |
| Source/destination credentials rejected by Airbyte | Re-check `SOURCE_DATABASE_URL` / `CLICKHOUSE_SINK_URL`; confirm Airbyte can reach both |
| Airbyte API unreachable / wrong workspace | Verify `AIRBYTE_API_URL` and `AIRBYTE_WORKSPACE_ID` |
| Schema/type incompatibility at the destination | Review the Airbyte job logs; adjust the stream/field mapping |
| Provisioning timeout | Confirm Airbyte has capacity; retry the start; check for leftover partial resources |

Inspect the recorded reason and last-sync metadata:

```bash
curl -sS https://your-cms-host/api/v1/cdc/pipelines/$PIPELINE_ID \
  -H "Authorization: Bearer $LUMI_ADMIN_TOKEN" -H "X-Lumi-Site: $SITE_ID"
# statusMessage, lastSyncAt, lastSyncRecordCount
```

---

## 4. Schema drift

Applies to Materialized Engine (Requirement 3.6); also relevant to Debezium and Airbyte when source schemas change.

### Symptom: pipeline status `error`, message names the affected table and change type

The Materialized Engine checks for source schema drift every `MATERIALIZED_SCHEMA_DRIFT_INTERVAL_MS` (default 60000ms). A column addition, column removal, or type alteration on a replicated table is detected within 60 seconds and sets the pipeline to `error`, reporting the affected table and the type of change (Requirement 3.6).

### Resolution workflow

1. Read `statusMessage` to identify the affected table and the change type (added / removed / type-changed column).
2. Reconcile the ClickHouse target schema with the new PostgreSQL schema:
   - **Column added** — add the corresponding column to the ClickHouse table (or recreate the replicated table to pick up the new column).
   - **Column removed** — remove or stop referencing the column downstream.
   - **Type changed** — align the ClickHouse column type with the new PostgreSQL type.
3. Restart replication:
   ```bash
   curl -sS -X POST https://your-cms-host/api/v1/cdc/pipelines/$PIPELINE_ID/start \
     -H "Authorization: Bearer $LUMI_ADMIN_TOKEN" -H "X-Lumi-Site: $SITE_ID"
   ```
4. Confirm recovery with a health check; the Health Monitor emits a recovery notification on the error→active transition (Requirement 8.6).

> **Prevention:** coordinate source schema migrations with pipeline maintenance windows. Pause the pipeline (`/stop`) before applying a breaking migration, then update the target schema and resume.

---

## Health monitoring reference

| Condition | Behavior |
|-----------|----------|
| Replication lag > threshold (default 60s, range 10s–3600s) | Warning notification (Requirement 8.2) |
| Pipeline in `error` > 5 minutes | Critical alert (Requirement 8.3) |
| Metrics missed for 3 consecutive intervals (90s) | Status → `error`, critical alert (Requirement 8.7) |
| `error` → `active` transition | Recovery notification (Requirement 8.6) |

Check current and historical metrics:

```bash
curl -sS https://your-cms-host/api/v1/cdc/pipelines/$PIPELINE_ID/metrics \
  -H "Authorization: Bearer $LUMI_ADMIN_TOKEN" -H "X-Lumi-Site: $SITE_ID"

curl -sS "https://your-cms-host/api/v1/cdc/pipelines/$PIPELINE_ID/metrics/history?since=2025-01-01T00:00:00Z" \
  -H "Authorization: Bearer $LUMI_ADMIN_TOKEN" -H "X-Lumi-Site: $SITE_ID"
```

## See also

- [Architecture Overview](./architecture.md)
- [Environment Variables](./environment-variables.md)
- Setup guides: [Debezium + Kafka](./setup-debezium-kafka.md) · [Materialized Engine](./setup-materialized-engine.md) · [Airbyte](./setup-airbyte.md)
