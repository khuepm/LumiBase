# Implementation Plan: ClickHouse CDC

## Overview

This plan implements the ClickHouse CDC system for LumiBase, providing real-time data replication from PostgreSQL to ClickHouse with three connector strategies, Redis cache auto-invalidation, a Studio management UI, AI-powered deployment flows, and health monitoring. Implementation follows a bottom-up approach: schema and validation first, then core services, connectors, cache invalidation, monitoring, AI flows, API routes, and finally the Studio UI.

## Tasks

- [x] 1. Set up database schema and shared validation
  - [x] 1.1 Create CDC Drizzle schema in `packages/database/src/schema/cdc.ts`
    - Define `cdcPipelines`, `cdcPipelineHealth`, and `cdcDeployments` tables
    - Add unique index on `(siteId, pipelineName)` and status index
    - Export schema from `packages/database/src/schema/index.ts`
    - _Requirements: 1.1, 1.4, 1.6, 1.7, 4.5, 8.4_

  - [x] 1.2 Create Zod validation schemas in `packages/shared/src/schemas/cdc.ts`
    - Define `PipelineCreateSchema` with all required fields and constraints (name max 128 chars)
    - Define `CdcConnectorTypeSchema`, `SyncScheduleSchema`, `MonitorConfigSchema`, `EnvVarSchema`
    - Export schemas from `packages/shared/src/schemas/index.ts`
    - _Requirements: 1.1, 1.2, 1.3, 1.7, 4.3, 4.7, 8.2_

  - [x] 1.3 Write property tests for pipeline validation (Properties 1, 2, 9)
    - **Property 1: Pipeline registration round-trip** — valid configs with all required fields produce a parseable result with UUID
    - **Property 2: Validation completeness for missing fields** — omitted subsets produce errors listing exactly those fields
    - **Property 9: Sync schedule interval validation** — values in [60, 86400] accepted, outside rejected
    - **Validates: Requirements 1.1, 1.3, 4.3, 4.7**

- [x] 2. Implement Pipeline Registry service
  - [x] 2.1 Create `apps/cms/src/modules/cdc/registry/pipeline-registry.ts`
    - Implement `PipelineRegistryService` interface (create, get, list, update, delete, updateStatus)
    - Enforce tenant pipeline limit (max 50)
    - Enforce unique pipeline name per tenant
    - Implement connectivity check with 5-second timeout
    - _Requirements: 1.1, 1.2, 1.5, 1.6, 1.7_

  - [x] 2.2 Create encryption utilities in `apps/cms/src/modules/cdc/registry/encryption.ts`
    - Implement encrypt/decrypt for connection parameters
    - Ensure encrypted values never equal plaintext
    - _Requirements: 1.4_

  - [x] 2.3 Write property tests for registry logic (Properties 3, 4)
    - **Property 3: Connection parameter encryption round-trip** — encrypt then decrypt produces original, encrypted ≠ plaintext
    - **Property 4: Pipeline name uniqueness per site (site_id)** — duplicate names rejected per site
    - **Validates: Requirements 1.4, 1.6**

- [x] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement CDC Connector interface and Debezium+Kafka connector
  - [x] 4.1 Create connector interface in `apps/cms/src/modules/cdc/connectors/types.ts`
    - Define `CdcConnector` interface with provision, start, stop, healthCheck, getMetrics, destroy
    - Define `CdcConnectorType`, `ConnectorConfig`, `ProvisionResult`, `HealthCheckResult`, `PipelineMetrics` types
    - _Requirements: 1.2, 2.1, 3.1, 4.1_

  - [x] 4.2 Implement Debezium+Kafka connector in `apps/cms/src/modules/cdc/connectors/debezium-kafka.ts`
    - Implement `DebeziumKafkaConnector` class
    - Configure Debezium to read INSERT/UPDATE/DELETE from WAL
    - Publish events to Kafka topics partitioned by table name
    - Implement local buffering (1 hour / 500MB cap) for Kafka outages
    - Implement ordered delivery on recovery
    - Set status to error after 3 consecutive replication slot failures
    - Implement `destroy(pipelineId)` to remove the Debezium connector AND release/drop the corresponding PostgreSQL replication slot on the Source_Database (e.g. via `pg_drop_replication_slot`) so WAL files are not retained
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 1.8_

  - [x] 4.3 Write property tests for Debezium connector (Properties 5, 6)
    - **Property 5: Kafka topic routing by table name** — each table maps to a unique deterministic topic
    - **Property 6: Event ordering preservation during outages** — buffered events delivered in original order
    - **Validates: Requirements 2.2, 2.4, 2.6**

- [x] 5. Implement Materialized Engine connector
  - [x] 5.1 Implement Materialized Engine connector in `apps/cms/src/modules/cdc/connectors/materialized-engine.ts`
    - Implement `MaterializedEngineConnector` class
    - Configure direct PostgreSQL replication slot connection
    - Implement automatic ClickHouse table schema creation from PostgreSQL schema
    - Implement exponential backoff reconnection (1s start, max 5 retries)
    - Resume from last confirmed LSN on reconnection
    - Detect schema drift within 60 seconds and report affected table + change type
    - Implement `destroy(pipelineId)` to detach the `MaterializedPostgreSQL` database AND release/drop the corresponding PostgreSQL replication slot on the Source_Database (e.g. via `pg_drop_replication_slot`) so WAL files are not retained
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 1.8_

  - [x] 5.2 Write property tests for Materialized Engine (Properties 7, 8)
    - **Property 7: PostgreSQL-to-ClickHouse schema mapping** — all column names preserved, types correctly mapped
    - **Property 8: Schema drift detection** — column add/remove/type change detected and reported
    - **Validates: Requirements 3.3, 3.6**

- [x] 6. Implement Airbyte connector
  - [x] 6.1 Implement Airbyte connector in `apps/cms/src/modules/cdc/connectors/airbyte.ts`
    - Implement `AirbyteConnector` class
    - Provision source + destination + connection via Airbyte API within 120s timeout
    - Support full-refresh and incremental CDC sync modes
    - Implement sync scheduling with interval validation [60s, 86400s]
    - Retry failed syncs 3 times with exponential backoff (30s start)
    - Update last-sync timestamp and record count on completion
    - Release partial resources on provisioning failure/timeout
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7_

  - [x] 6.2 Write property test for Airbyte sync metadata (Property 10)
    - **Property 10: Sync metadata update on completion** — completed sync with N records updates registry with correct timestamp and count
    - **Validates: Requirements 4.5**

- [x] 7. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Implement Cache Invalidator
  - [x] 8.1 Create Cache Invalidator in `apps/cms/src/modules/cdc/cache-invalidator.ts`
    - Implement `CacheInvalidator` class with handleEvent, flush, getQueueDepth
    - Map CDC operations to Redis operations: INSERT→SET (pre-warm), UPDATE→SET (refresh), DELETE→DEL
    - Derive cache keys from (table, recordId) using existing CacheProvider namespace
    - Implement 1-second deduplication window that applies ONLY to consecutive UPDATE events for the same key; INSERT and DELETE events are processed immediately (no dedup), flushing any pending UPDATE for that key first, to preserve operation ordering and data integrity
    - Implement bounded queue (max 10,000 events) during Redis outage
    - Discard oldest events on queue overflow with warning log
    - Replay queued events in order on Redis reconnection
    - Retry failed operations 3 times, then skip with error log
    - Log each event with table name, record ID, and operation type
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8_

  - [x] 8.2 Write property tests for Cache Invalidator (Properties 11, 12, 13, 14)
    - **Property 11: Cache invalidation correctness by operation type** — INSERT→SET, UPDATE→SET, DELETE→DEL with correct key
    - **Property 12: Cache event deduplication within time window** — only consecutive UPDATEs for the same key collapse; an intervening INSERT/DELETE forces immediate processing (no dropped INSERT/DELETE, no reordering)
    - **Property 13: Cache event queue ordering and replay** — queued events replayed in chronological order
    - **Property 14: Cache invalidation log completeness** — every event log contains table, recordId, operation
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.6, 5.8**

- [x] 9. Implement Health Monitor
  - [x] 9.1 Create Health Monitor in `apps/cms/src/modules/cdc/health-monitor.ts`
    - Implement `HealthMonitor` class with start, stop, checkHealth, getHistory
    - Emit metrics (replication lag, events/sec, error count) at 30-second intervals
    - Emit warning when lag exceeds configurable threshold (default 60s, range [10s, 3600s])
    - Emit critical alert when pipeline in error state > 5 minutes
    - Set status to error if metrics missed for 3 consecutive intervals (90s)
    - Emit recovery notification on error→active transition
    - Store health history with 7-day retention
    - Verify connectivity to all services with 10s timeout per service
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7_

  - [x] 9.2 Write property tests for Health Monitor (Properties 20, 21)
    - **Property 20: Replication lag threshold alerting** — warning emitted iff lag > threshold
    - **Property 21: Pipeline recovery notification on state transition** — exactly one recovery notification on error→active
    - **Validates: Requirements 8.2, 8.6**

- [x] 10. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Implement AI Flow Engine
  - [x] 11.1 Create config generator in `apps/cms/src/modules/cdc/ai-flow/config-generator.ts`
    - Generate `EnvironmentConfig` for each approach + target combination
    - Include all required environment variables with descriptions, defaults, and validation rules
    - Scope services by target: `docker_compose`/managed services host the full stateful stack (Kafka, Debezium, ClickHouse, Materialized Engine, Airbyte); `cloudflare_workers` config includes ONLY the edge components (CDC API/control-plane endpoints + Cache_Invalidator) and excludes stateful connectors, the message bus, and replication engines
    - _Requirements: 7.1, 7.2_

  - [x] 11.2 Create environment variable validator in `apps/cms/src/modules/cdc/ai-flow/env-validator.ts`
    - Validate env vars against approach-specific schema
    - Return list of invalid fields with violated constraints
    - _Requirements: 7.4, 7.5_

  - [x] 11.3 Create deployment orchestrator in `apps/cms/src/modules/cdc/ai-flow/deployment-orchestrator.ts`
    - Implement `deploy` method with step-by-step provisioning
    - Support Docker Compose and Cloudflare Workers targets
    - For `docker_compose`/managed services, provision the full stateful stack (Kafka, Debezium, ClickHouse, Materialized Engine, Airbyte) — e.g. Kafka, Debezium, ClickHouse containers on a shared network for the Debezium approach
    - For `cloudflare_workers`, deploy ONLY the edge components (CDC API/control-plane endpoints + Cache_Invalidator); MUST NOT attempt to deploy stateful connectors, the message bus, or replication engines (these depend on a companion `docker_compose`/managed-services deployment)
    - Run post-deployment health check (verify each service reachable within 30s)
    - _Requirements: 7.2, 7.3, 7.7_

  - [x] 11.4 Create rollback manager in `apps/cms/src/modules/cdc/ai-flow/rollback-manager.ts`
    - Implement rollback of completed steps in reverse order within 60s
    - Ensure no partially-provisioned resources remain
    - Report failed step name, error type, and description
    - _Requirements: 7.6_

  - [x] 11.5 Write property tests for AI Flow Engine (Properties 17, 18, 19)
    - **Property 17: Environment config generation completeness** — all required vars present for each approach+target
    - **Property 18: Environment variable schema validation** — invalid vars correctly identified with specific violated rule
    - **Property 19: Deployment rollback completeness** — steps 1..N-1 undone in reverse, no partial resources
    - **Validates: Requirements 7.1, 7.4, 7.5, 7.6**

- [x] 12. Implement CDC API Routes
  - [x] 12.1 Create CDC API routes in `apps/cms/src/modules/cdc/routes.ts`
    - Mount routes under `/api/v1/cdc/`
    - Implement POST `/pipelines` — create pipeline with validation
    - Implement GET `/pipelines` — list pipelines for tenant
    - Implement GET `/pipelines/:id` — get pipeline details
    - Implement PATCH `/pipelines/:id` — update pipeline config
    - Implement DELETE `/pipelines/:id` — delete pipeline
    - Implement POST `/pipelines/:id/start` and `/pipelines/:id/stop`
    - Implement GET `/pipelines/:id/health` and `/pipelines/:id/metrics`
    - Implement GET `/pipelines/:id/metrics/history`
    - Implement POST `/deploy`, POST `/deploy/validate-env`, POST `/deploy/:id/rollback`
    - _Requirements: 1.1, 1.2, 1.3, 1.5, 1.6, 1.7, 7.4, 7.5, 7.6, 8.5_

  - [x] 12.2 Wire CDC module into main app in `apps/cms/src/modules/cdc/index.ts`
    - Create module barrel export
    - Register routes in the Hono app
    - _Requirements: 1.1_

  - [x] 12.3 Write unit tests for API route handlers
    - Test validation error responses (400 with field list)
    - Test duplicate name rejection (409)
    - Test tenant pipeline limit (403)
    - Test connectivity timeout (408)
    - _Requirements: 1.3, 1.5, 1.6, 1.7_

- [~] 13. Implement Studio CDC Management Panel
  - [x] 13.1 Create approach recommendation engine in `apps/cms/src/modules/cdc/recommender.ts`
    - Implement decision logic: high volume → Debezium, low volume + no Kafka → Materialized, managed → Airbyte
    - Return recommended approach with rationale and alternatives
    - _Requirements: 6.3_

  - [x] 13.2 Write property test for recommendation engine (Property 15)
    - **Property 15: Approach recommendation consistency** — deterministic result consistent with decision matrix
    - **Validates: Requirements 6.3**

  - [x] 13.3 Create Studio CDC Panel components (placeholder structure)
    - Create `CdcPipelineList` — table view with status, connector type, last-sync
    - Create `CdcPipelineWizard` — multi-step form with approach-specific fields
    - Create `CdcPipelineDetail` — metrics dashboard placeholder
    - Implement field-level validation that preserves valid data on error
    - Implement confirmation dialog for pipeline deletion
    - Implement error state display with remediation steps
    - Implement 10-second metric refresh for active pipelines
    - Implement retry option when pipeline data unavailable
    - _Requirements: 6.1, 6.2, 6.4, 6.5, 6.6, 6.7, 6.8_

  - [ ] 13.4 Write property test for form validation (Property 16)
    - **Property 16: Form validation preserves valid data** — mixed valid/invalid fields only errors on invalid, valid preserved
    - **Validates: Requirements 6.7**

- [ ] 14. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 15. Create CDC Documentation
  - [ ] 15.1 Create architecture and setup documentation
    - Write architecture overview with system diagram
    - Write setup guides for Debezium+Kafka, Materialized Engine, and Airbyte approaches
    - Write troubleshooting procedures for replication slot errors, connectivity failures, sync failures, schema drift
    - Include decision-criteria comparison table (volume, latency, dependencies, manual steps)
    - Include environment variable reference with descriptions, defaults, and validation rules per approach
    - Include complete working configuration example per approach
    - Write two scoped deployment guides: (1) a Docker Compose / managed-services guide for the full stateful stack (Kafka, Debezium, ClickHouse, Materialized Engine, Airbyte), and (2) a Cloudflare Workers edge-components-only guide (CDC API/control-plane endpoints + Cache_Invalidator) that points to guide (1) for the stateful stack — each with prerequisites, steps, verification command, and expected output
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

- [ ] 16. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 17. Spec Revision Corrections
  - Corrective tasks for already-completed foundational work (Tasks 1.1, 1.2, 1.3, 2.1) affected by the requirements/design revisions, plus new replication-slot cleanup work from Requirement 1.8. All boxes are unchecked because the underlying code must be revised.

  - [x] 17.1 Correct CDC schema primary keys to use `nanoid()` (corrects Task 1.1)
    - In `packages/database/src/schema/cdc.ts`, change `cdcPipelines.id` and `cdcDeployments.id` from `crypto.randomUUID()` to `nanoid()` per `.cursorrules` (all primary keys must use nanoid); `cdcPipelineHealth.id` already uses `nanoid()`
    - _Requirements: 1.1_

  - [x] 17.2 Correct sync interval minimum to 300s (corrects Task 1.2)
    - In `packages/shared/src/schemas/cdc.ts`, change `SyncScheduleSchema.interval_seconds` from `.min(60)` to `.min(300)` to enforce the 5-minute Airbyte minimum
    - _Requirements: 4.3, 4.7_

  - [x] 17.3 Update Property 9 test bounds (corrects Task 1.3)
    - In `apps/cms/src/__tests__/cdc-pipeline-validation.property.test.ts`, update the Property 9 accepted range from [60, 86400] to [300, 86400]
    - **Property 9: Sync schedule interval validation** — values in [300, 86400] accepted, outside rejected
    - **Validates: Requirements 4.3, 4.7**

  - [x] 17.4 Correct Pipeline Registry to site-scoping and 10s timeout (corrects Task 2.1)
    - In `apps/cms/src/modules/cdc/registry/pipeline-registry.ts`: (a) change the connectivity-check timeout from 5 seconds to 10 seconds; (b) replace the `tenantId` parameter and "per tenant" limit-and-uniqueness logic with `siteId` / "per site" (max 50 pipelines per site, unique pipeline name per site)
    - _Requirements: 1.5, 1.6, 1.7_

  - [x] 17.5 Implement replication slot cleanup in Pipeline Registry delete flow (new — Requirement 1.8)
    - In `apps/cms/src/modules/cdc/registry/pipeline-registry.ts`, update `delete(siteId, pipelineId)` to resolve the pipeline's connector and invoke `connector.destroy(pipelineId)` BEFORE removing the registry record, so replication-slot-based connectors (Debezium+Kafka, Materialized Engine) release and drop the PostgreSQL replication slot(s) on the Source_Database (e.g. via `pg_drop_replication_slot`); delete the record only after `destroy()` (including slot cleanup) succeeds
    - On slot cleanup failure, retry `pg_drop_replication_slot`, surface the error, and keep the registry record until the slot is dropped
    - _Requirements: 1.8_

  - [x] 17.6 Write property test for replication slot cleanup on deletion (Property 22)
    - **Property 22: Replication slot cleanup on deletion** — for any replication-slot-based pipeline (Debezium+Kafka or Materialized Engine) that is deleted, no PostgreSQL replication slot associated with it remains on the Source_Database
    - **Validates: Requirements 1.8**

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Property-based tests use `fast-check` (already in devDependencies) with minimum 100 iterations
- Checkpoints ensure incremental validation at logical boundaries
- The project uses TypeScript throughout with Hono framework, Drizzle ORM, and Vitest
- All 22 correctness properties from the design are covered by property test sub-tasks
- All 9 requirements are covered by implementation tasks

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3", "2.1", "2.2", "4.1", "17.1", "17.2"] },
    { "id": 2, "tasks": ["2.3", "4.2", "5.1", "6.1", "17.3", "17.4"] },
    { "id": 3, "tasks": ["4.3", "5.2", "6.2", "8.1", "17.5"] },
    { "id": 4, "tasks": ["8.2", "9.1", "13.1", "17.6"] },
    { "id": 5, "tasks": ["9.2", "11.1", "11.2", "13.2"] },
    { "id": 6, "tasks": ["11.3", "11.4"] },
    { "id": 7, "tasks": ["11.5", "12.1"] },
    { "id": 8, "tasks": ["12.2", "12.3", "13.3"] },
    { "id": 9, "tasks": ["13.4", "15.1"] }
  ]
}
```
