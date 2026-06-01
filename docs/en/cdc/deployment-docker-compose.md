---
title: Deployment — Docker Compose / Managed Services
---

# Deployment Guide: Docker Compose / Managed Services (Full Stateful Stack)

This guide deploys the **full stateful CDC stack** — Kafka Broker, Debezium Connector, ClickHouse Sink, Materialized Engine, and Airbyte Connector — using Docker Compose on a shared network or external managed services (Confluent Cloud, ClickHouse Cloud, Airbyte Cloud). It corresponds to the `docker_compose` deployment target and satisfies the stateful-stack portion of **Requirement 9.4**.

> Only the services required by your chosen approach are provisioned. Debezium+Kafka needs Kafka + Debezium + ClickHouse; the Materialized Engine needs only ClickHouse; Airbyte needs the Airbyte platform + ClickHouse. See [Choosing an Approach](./README.md#decision-criteria-choosing-an-approach).

## Prerequisites

- Docker Engine 24+ and Docker Compose v2 (for self-hosting), **or** accounts for the managed equivalents (Confluent Cloud / ClickHouse Cloud / Airbyte Cloud).
- A PostgreSQL Source_Database with logical replication enabled (`wal_level = logical`, a `REPLICATION` role, and sufficient `max_replication_slots` / `max_wal_senders`).
- A running LumiBase CMS with the CDC module enabled, and an admin token + site id for `/api/v1/cdc`.
- Network reachability between the services on a shared network (or correct firewall rules / VPC peering for managed services).

## Step 1: Configure environment variables

Create a `.env` for the stack using the [Environment Variables reference](./environment-variables.md) for your approach + the `docker_compose` target. Example for Debezium + Kafka:

```bash
CDC_PIPELINE_NAME=orders-analytics
CDC_APPROACH=debezium_kafka
CDC_DEPLOYMENT_TARGET=docker_compose
SOURCE_DATABASE_URL=postgresql://cdc_user:secret@postgres:5432/lumibase
CLICKHOUSE_SINK_URL=clickhouse://clickhouse:9000/analytics
CLICKHOUSE_DATABASE=analytics
CDC_REPLICATION_TABLES=public.orders,public.customers
KAFKA_BOOTSTRAP_SERVERS=kafka:9092
DEBEZIUM_CONNECT_URL=http://debezium:8083
```

## Step 2: Define the Docker Compose stack

The services and their ports/dependencies come from the config generator's service catalog. A minimal Debezium+Kafka stack:

```yaml
# docker-compose.cdc.yml
services:
  kafka:
    image: confluentinc/cp-kafka:7.6.0
    ports: ["9092:9092"]
    networks: [cdc]

  debezium:
    image: debezium/connect:2.6
    ports: ["8083:8083"]
    depends_on: [kafka]
    environment:
      BOOTSTRAP_SERVERS: kafka:9092
      GROUP_ID: lumibase-cdc
      CONFIG_STORAGE_TOPIC: lumibase_cdc_configs
      OFFSET_STORAGE_TOPIC: lumibase_cdc_offsets
      STATUS_STORAGE_TOPIC: lumibase_cdc_status
    networks: [cdc]

  clickhouse:
    image: clickhouse/clickhouse-server:24.3
    ports: ["8123:8123", "9000:9000"]
    networks: [cdc]

networks:
  cdc:
    driver: bridge
```

For the **Materialized Engine** approach, include only the `clickhouse` service. For **Airbyte**, replace Kafka/Debezium with the `airbyte/server:0.63.0` service on port 8001. Service images, ports, and start-ordering match `STATEFUL_SERVICES_BY_APPROACH` in `apps/cms/src/modules/cdc/ai-flow/config-generator.ts`.

| Approach | Services | Images | Ports |
|----------|----------|--------|-------|
| Debezium + Kafka | kafka_broker, debezium_connector, clickhouse_sink | `confluentinc/cp-kafka:7.6.0`, `debezium/connect:2.6`, `clickhouse/clickhouse-server:24.3` | 9092, 8083, 8123/9000 |
| Materialized Engine | clickhouse_sink (+ materialized_engine runs inside ClickHouse) | `clickhouse/clickhouse-server:24.3` | 8123/9000 |
| Airbyte | airbyte_connector, clickhouse_sink | `airbyte/server:0.63.0`, `clickhouse/clickhouse-server:24.3` | 8001, 8123/9000 |

## Step 3: Start the stack

```bash
docker compose -f docker-compose.cdc.yml --env-file .env up -d
docker compose -f docker-compose.cdc.yml ps
```

> **Managed services alternative:** instead of running these containers, point `KAFKA_BOOTSTRAP_SERVERS` at Confluent Cloud, `CLICKHOUSE_SINK_URL` at ClickHouse Cloud, and `AIRBYTE_API_URL` at Airbyte Cloud. The rest of the steps are identical.

## Step 4: Deploy via the AI Flow Engine (recommended)

Let the AI Flow Engine provision and order the services for you. It performs a step-by-step deployment and a post-deployment connectivity health check (Requirements 7.2, 7.3, 7.7):

```bash
curl -sS -X POST https://your-cms-host/api/v1/cdc/deploy \
  -H "Authorization: Bearer $LUMI_ADMIN_TOKEN" \
  -H "X-Lumi-Site: $SITE_ID" \
  -H "Content-Type: application/json" \
  -d '{ "approach": "debezium_kafka", "target": "docker_compose" }'
```

If a step fails, the orchestrator rolls back all previously completed steps in reverse order within 60 seconds and reports the failed step, error type, and description (Requirement 7.6).

## Step 5: Register and start a pipeline

Follow the approach-specific setup guide to register and start the pipeline against this stack:

- [Debezium + Kafka](./setup-debezium-kafka.md)
- [Materialized Engine](./setup-materialized-engine.md)
- [Airbyte](./setup-airbyte.md)

## Verification

### Verification command

The deploy response includes a per-service health report. To re-verify at any time, run a pipeline health check:

```bash
curl -sS https://your-cms-host/api/v1/cdc/pipelines/$PIPELINE_ID/health \
  -H "Authorization: Bearer $LUMI_ADMIN_TOKEN" \
  -H "X-Lumi-Site: $SITE_ID"
```

### Expected output

Every provisioned service reports reachable (Debezium+Kafka example):

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

The `/deploy` response for a successful deployment looks like:

```json
{
  "data": {
    "deploymentId": "9bX2_qE7tA0",
    "approach": "debezium_kafka",
    "target": "docker_compose",
    "status": "completed",
    "health": {
      "passed": true,
      "services": [
        { "service": "kafka_broker", "reachable": true },
        { "service": "debezium_connector", "reachable": true },
        { "service": "clickhouse_sink", "reachable": true }
      ]
    }
  }
}
```

You can also verify the underlying services directly:

```bash
# ClickHouse reachable
curl -sS http://localhost:8123/ping            # → Ok.

# Debezium Kafka Connect reachable
curl -sS http://localhost:8083/connectors      # → [] or a list of connectors

# Kafka topics created (one per replicated table)
kafka-topics.sh --bootstrap-server localhost:9092 --list | grep lumibase_cdc
```

## Updating and teardown

```bash
# Update images and restart
docker compose -f docker-compose.cdc.yml pull
docker compose -f docker-compose.cdc.yml up -d

# Tear down (delete the pipeline first so replication slots are dropped — Req 1.8)
curl -sS -X DELETE https://your-cms-host/api/v1/cdc/pipelines/$PIPELINE_ID \
  -H "Authorization: Bearer $LUMI_ADMIN_TOKEN" -H "X-Lumi-Site: $SITE_ID"
docker compose -f docker-compose.cdc.yml down
```

> Always delete the pipeline through the API before tearing down the stack so the PostgreSQL replication slots are released; otherwise the Source_Database retains WAL files.

## Next steps

- [Cloudflare Workers edge deployment](./deployment-cloudflare-workers.md) — deploy the edge components that front this stack
- [Troubleshooting](./troubleshooting.md)
- [Environment Variables](./environment-variables.md)
