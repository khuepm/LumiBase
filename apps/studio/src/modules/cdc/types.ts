/**
 * Shared TypeScript types for the Studio CDC Management Panel
 * (ClickHouse CDC — task 13.3; design "Studio CDC Panel" §6).
 *
 * These mirror the API-safe shapes returned by the CMS CDC routes
 * (`apps/cms/src/modules/cdc/routes.ts` — `serializePipeline`,
 * `PipelineMetrics`, `HealthCheckResult`). Connection strings are
 * deliberately ABSENT here: the control plane treats them as write-only
 * secrets and never echoes them back over the API, so the read models the
 * panel consumes never carry plaintext credentials.
 *
 * This module is type-only — it has no runtime behaviour.
 */

/** The three supported CDC connector approaches (design §2, Req 1.2). */
export type CdcConnectorType =
  | 'debezium_kafka'
  | 'materialized_engine'
  | 'airbyte';

/** Operational state of a pipeline (Pipeline_Status glossary entry). */
export type PipelineStatus = 'active' | 'paused' | 'error' | 'provisioning';

/**
 * Read model for a single pipeline as returned by
 * `GET /api/v1/cdc/pipelines` and `GET /api/v1/cdc/pipelines/:id`.
 *
 * Timestamps arrive as ISO-8601 strings (Date values are JSON-serialised
 * over HTTP), hence `string | null` rather than `Date`.
 */
export interface PipelineSummary {
  readonly id: string;
  readonly siteId: string;
  readonly pipelineName: string;
  readonly connectorType: CdcConnectorType;
  readonly status: PipelineStatus;
  readonly statusMessage: string | null;
  readonly replicationTables: string[];
  readonly config: Record<string, unknown>;
  readonly lastSyncAt: string | null;
  readonly lastSyncRecordCount: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Current operational metrics for an active pipeline, as returned by
 * `GET /api/v1/cdc/pipelines/:id/metrics` (Req 8.1). Surfaced on the detail
 * dashboard and refreshed at ≤ 10s intervals while the pipeline is active
 * (Req 6.6).
 */
export interface PipelineMetrics {
  readonly replicationLagMs: number;
  readonly eventsPerSecond: number;
  readonly errorCount: number;
  readonly collectedAt: string;
}

/** Connectivity status of a single service in a pipeline (Req 8.5). */
export interface ServiceHealthStatus {
  readonly service: string;
  readonly reachable: boolean;
  readonly reason?: string;
}

/** Result of a pipeline health check, `GET /pipelines/:id/health` (Req 8.5). */
export interface HealthCheckResult {
  readonly healthy: boolean;
  readonly services: ServiceHealthStatus[];
  readonly checkedAt: string;
}

/**
 * Request body for creating a pipeline (`POST /api/v1/cdc/pipelines`). Mirrors
 * `PipelineCreateSchema` in `@lumibase/shared` — snake_case to match the
 * server contract.
 */
export interface PipelineCreatePayload {
  readonly pipeline_name: string;
  readonly cdc_connector_type: CdcConnectorType;
  readonly source_database_connection: string;
  readonly clickhouse_sink_connection: string;
  readonly replication_tables: string[];
  readonly intermediary_connection?: string;
  readonly config?: Record<string, unknown>;
}
