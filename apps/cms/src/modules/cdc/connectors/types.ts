/**
 * Shared types for the CDC Connector subsystem (ClickHouse CDC —
 * task 4.1; design §2).
 *
 * The CDC system uses a strategy pattern to abstract three replication
 * approaches — Debezium+Kafka, ClickHouse Materialized Engine, and
 * Airbyte — behind a common {@link CdcConnector} interface. Each
 * concrete connector implements this interface so the Pipeline Registry
 * and API routes can manage pipelines uniformly regardless of the
 * underlying replication mechanism.
 *
 * This module is intentionally **type-only**: it owns no runtime
 * behaviour. Concrete implementations live in sibling files
 * (`debezium-kafka.ts`, `materialized-engine.ts`, `airbyte.ts`).
 *
 * Validates: Requirements 1.2, 2.1, 3.1, 4.1
 */

// ── Connector type (Req 1.2) ────────────────────────────────────────────

/**
 * The three supported CDC connector approaches. Mirrors the
 * `CdcConnectorTypeSchema` enum in `packages/shared/src/schemas/cdc.ts`
 * so runtime validation and type-level checks stay in sync.
 *
 *   - `'debezium_kafka'` — Debezium reads PostgreSQL WAL and publishes
 *     change events to Kafka topics; ClickHouse ingests via Kafka Table
 *     Engine (Req 2.1).
 *   - `'materialized_engine'` — ClickHouse connects directly to
 *     PostgreSQL replication slots via MaterializedPostgreSQL engine
 *     (Req 3.1).
 *   - `'airbyte'` — Airbyte platform manages source/destination/connection
 *     with UI-driven configuration (Req 4.1).
 */
export type CdcConnectorType = 'debezium_kafka' | 'materialized_engine' | 'airbyte';

// ── Connector configuration (Req 1.1, 2.1, 3.1, 4.1) ───────────────────

/**
 * Configuration payload passed to {@link CdcConnector.provision} when
 * setting up a new pipeline. Contains all connection details and
 * approach-specific settings needed to establish replication.
 *
 * Connection strings are provided in plaintext here — encryption is
 * handled at the registry layer before persistence (Req 1.4).
 */
export interface ConnectorConfig {
  /** Unique pipeline identifier (UUID v4). */
  readonly pipelineId: string;

  /** Tenant/site identifier that owns this pipeline. */
  readonly tenantId: string;

  /**
   * PostgreSQL source connection string.
   * Format: `postgresql://user:pass@host:port/dbname`
   */
  readonly sourceConnection: string;

  /**
   * ClickHouse sink connection string.
   * Format: `clickhouse://user:pass@host:port/dbname`
   */
  readonly sinkConnection: string;

  /**
   * Optional intermediary service connection string.
   * For Debezium+Kafka: Kafka broker URL (e.g. `kafka://host:9092`).
   * For Airbyte: Airbyte API base URL.
   * For Materialized Engine: not used (direct connection).
   */
  readonly intermediaryConnection?: string;

  /**
   * List of PostgreSQL table names to replicate.
   * Each entry is a fully-qualified table name (e.g. `public.users`).
   */
  readonly replicationTables: readonly string[];

  /**
   * Approach-specific configuration options.
   * Contents vary by connector type:
   *   - Debezium: slot name, publication name, topic prefix, etc.
   *   - Materialized: replication slot settings, polling interval, etc.
   *   - Airbyte: sync mode, schedule interval, workspace ID, etc.
   */
  readonly connectorSpecificConfig?: Record<string, unknown>;
}

// ── Provision result (Req 2.1, 3.1, 4.1) ────────────────────────────────

/**
 * Outcome of a {@link CdcConnector.provision} call. Reports whether
 * the connector infrastructure was successfully set up and lists the
 * provisioned resources for later cleanup via
 * {@link CdcConnector.destroy}.
 */
export interface ProvisionResult {
  /** Whether provisioning completed successfully. */
  readonly success: boolean;

  /**
   * Human-readable message describing the outcome.
   * On failure, contains the error reason.
   */
  readonly message: string;

  /**
   * Identifiers of resources that were provisioned.
   * Used by {@link CdcConnector.destroy} to clean up.
   * Examples: Kafka topic names, replication slot IDs, Airbyte connection IDs.
   */
  readonly provisionedResources: readonly ProvisionedResource[];
}

/**
 * A single resource provisioned during connector setup.
 * Tracked so that {@link CdcConnector.destroy} can release each
 * resource individually and report partial cleanup failures.
 */
export interface ProvisionedResource {
  /** Resource type identifier (e.g. 'kafka_topic', 'replication_slot', 'airbyte_connection'). */
  readonly type: string;

  /** Unique identifier of the provisioned resource. */
  readonly id: string;

  /** Human-readable name or description. */
  readonly name: string;
}

// ── Health check result (Req 8.5) ────────────────────────────────────────

/**
 * Outcome of a {@link CdcConnector.healthCheck} call. Reports
 * per-service reachability status so the caller can identify which
 * component in the pipeline is degraded.
 */
export interface HealthCheckResult {
  /** Overall health status of the pipeline. */
  readonly healthy: boolean;

  /** Per-service connectivity status. */
  readonly services: readonly ServiceHealthStatus[];

  /** ISO-8601 timestamp of when the check was performed. */
  readonly checkedAt: string;
}

/**
 * Connectivity status of a single service in the CDC pipeline.
 * Each connector reports on its relevant services:
 *   - Debezium: source DB, Kafka broker, ClickHouse sink
 *   - Materialized: source DB, ClickHouse sink
 *   - Airbyte: source DB, ClickHouse sink, Airbyte platform
 */
export interface ServiceHealthStatus {
  /** Service name (e.g. 'source_database', 'kafka_broker', 'clickhouse_sink', 'airbyte_platform'). */
  readonly service: string;

  /** Whether the service is reachable. */
  readonly reachable: boolean;

  /**
   * Reason for unreachability. Present only when `reachable` is `false`.
   * Contains a human-readable description of the failure (e.g. 'connection timeout after 10s').
   */
  readonly reason?: string;
}

// ── Pipeline metrics (Req 8.1) ───────────────────────────────────────────

/**
 * Current operational metrics for an active CDC pipeline. Emitted at
 * 30-second intervals by the Health Monitor (Req 8.1) and available
 * on-demand via {@link CdcConnector.getMetrics}.
 */
export interface PipelineMetrics {
  /** Current replication lag in milliseconds. */
  readonly replicationLagMs: number;

  /** Current throughput in events per second. */
  readonly eventsPerSecond: number;

  /** Cumulative error count since pipeline start or last reset. */
  readonly errorCount: number;

  /** ISO-8601 timestamp of when the metrics were collected. */
  readonly collectedAt: string;
}

// ── Connector interface (design §2) ─────────────────────────────────────

/**
 * Strategy interface for CDC connectors. Each of the three supported
 * approaches (Debezium+Kafka, Materialized Engine, Airbyte) implements
 * this interface so the Pipeline Registry and API routes can manage
 * pipelines uniformly.
 *
 * Lifecycle:
 *   1. `provision` — set up infrastructure (topics, slots, connections)
 *   2. `start` — begin replication
 *   3. `healthCheck` / `getMetrics` — monitor while running
 *   4. `stop` — pause replication (preserves state)
 *   5. `destroy` — tear down all provisioned resources
 *
 * Implementations MUST be stateless between calls — all pipeline state
 * is persisted in the Pipeline Registry. The `pipelineId` parameter on
 * lifecycle methods is used to look up configuration and state.
 */
export interface CdcConnector {
  /** The connector approach this implementation handles. */
  readonly type: CdcConnectorType;

  /**
   * Provision infrastructure for a new pipeline.
   * Creates all necessary resources (topics, replication slots,
   * Airbyte connections) based on the provided configuration.
   *
   * @param config - Pipeline configuration with connection details
   * @returns Provision outcome with list of created resources
   */
  provision(config: ConnectorConfig): Promise<ProvisionResult>;

  /**
   * Start replication for an existing pipeline.
   * The pipeline must have been previously provisioned.
   *
   * @param pipelineId - UUID of the pipeline to start
   * @throws If the pipeline is not provisioned or already running
   */
  start(pipelineId: string): Promise<void>;

  /**
   * Stop replication for a running pipeline.
   * Preserves pipeline state and provisioned resources so replication
   * can be resumed via {@link start}.
   *
   * @param pipelineId - UUID of the pipeline to stop
   * @throws If the pipeline is not currently running
   */
  stop(pipelineId: string): Promise<void>;

  /**
   * Check connectivity to all services in the pipeline.
   * Each service is checked with a 10-second timeout (Req 8.5).
   *
   * @param pipelineId - UUID of the pipeline to check
   * @returns Per-service health status
   */
  healthCheck(pipelineId: string): Promise<HealthCheckResult>;

  /**
   * Retrieve current operational metrics for the pipeline.
   *
   * @param pipelineId - UUID of the pipeline to query
   * @returns Current replication lag, throughput, and error count
   */
  getMetrics(pipelineId: string): Promise<PipelineMetrics>;

  /**
   * Destroy all provisioned resources for a pipeline.
   * This is irreversible — the pipeline cannot be restarted after
   * destruction without re-provisioning.
   *
   * @param pipelineId - UUID of the pipeline to destroy
   */
  destroy(pipelineId: string): Promise<void>;
}
