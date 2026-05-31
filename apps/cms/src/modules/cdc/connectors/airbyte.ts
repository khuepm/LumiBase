/**
 * AirbyteConnector — Airbyte platform CDC strategy
 * (ClickHouse CDC — task 6.1; design §2, Requirement 4).
 *
 * This connector implements the {@link CdcConnector} interface for the
 * Airbyte approach, which manages replication through the Airbyte platform's
 * source/destination/connection model rather than a self-hosted replication
 * slot or message bus:
 *
 *   - Provisions an Airbyte source (Source_Database) + destination
 *     (ClickHouse_Sink) + connection via the Airbyte API, completing within
 *     a 120-second budget (Req 4.1). If provisioning fails or exceeds the
 *     timeout, every partially-allocated Airbyte resource is released and the
 *     pipeline is reported in `error` status with the failure reason
 *     (Req 4.6).
 *   - Supports both `full_refresh` and `incremental_cdc` sync modes
 *     (Req 4.2) via {@link airbyteSyncModeFor}.
 *   - Validates the configured sync schedule against the shared
 *     {@link SyncScheduleSchema}, accepting an interval only within
 *     [300s, 86400s] (5 minutes to 24 hours) and rejecting anything outside
 *     that range with a clear error (Req 4.3, 4.7).
 *   - Retries a failed sync job up to 3 times with exponential backoff
 *     starting at 30 seconds before moving the pipeline to `error` status and
 *     recording the failure reason (Req 4.4).
 *   - On successful sync completion, updates the last-sync timestamp and the
 *     exact synced record count (Req 4.5 / Property 10). The metadata-update
 *     logic is exposed via {@link AirbyteConnector.completeSync} and the pure
 *     {@link buildSyncMetadata} helper so it is testable in isolation.
 *   - Because Airbyte is **not** replication-slot-based, its
 *     {@link AirbyteConnector.destroy} removes only the Airbyte
 *     connection/source/destination and performs **no** PostgreSQL
 *     replication-slot cleanup.
 *
 * The networked side-effects (the Airbyte REST API) are abstracted behind a
 * small injectable {@link AirbyteApiClient} so the deterministic schedule
 * validation, sync-mode mapping, retry, and metadata logic can be
 * unit/property tested without a live Airbyte instance. A sensible in-memory
 * default is provided for environments without a real platform.
 *
 * Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7
 */

import { SyncScheduleSchema, type SyncSchedule } from '@lumibase/shared';

import type {
  CdcConnector,
  CdcConnectorType,
  ConnectorConfig,
  HealthCheckResult,
  PipelineMetrics,
  ProvisionResult,
  ProvisionedResource,
  ServiceHealthStatus,
} from './types';
import type { StatusChangeListener } from './debezium-kafka';

// ── constants ────────────────────────────────────────────────────────────

/** Airbyte provisioning budget: 120 seconds (Req 4.1, 4.6). */
export const PROVISION_TIMEOUT_MS = 120_000;

/** Initial sync-retry backoff delay: 30 seconds (Req 4.4). */
export const SYNC_RETRY_BASE_DELAY_MS = 30_000;

/**
 * Number of times a failed sync is retried before the pipeline is moved to
 * `error` status. The initial attempt plus these retries gives at most
 * `MAX_SYNC_RETRIES + 1` total attempts (Req 4.4).
 */
export const MAX_SYNC_RETRIES = 3;

/** Minimum legal sync interval: 5 minutes (Req 4.3, 4.7). */
export const SYNC_INTERVAL_MIN_SECONDS = 300;

/** Maximum legal sync interval: 24 hours (Req 4.3, 4.7). */
export const SYNC_INTERVAL_MAX_SECONDS = 86_400;

// ── sync mode (Req 4.2) ─────────────────────────────────────────────────

/** The two sync modes supported by the Airbyte connector (Req 4.2). */
export type CdcSyncMode = SyncSchedule['sync_mode'];

/**
 * Map a LumiBase sync mode to the corresponding Airbyte stream sync mode.
 * Pure and deterministic. Both supported modes (Req 4.2) map to a concrete
 * Airbyte sync mode:
 *   - `full_refresh`    → `full_refresh_overwrite`
 *   - `incremental_cdc` → `incremental_append` (CDC via the source's
 *     change-data-capture cursor)
 */
export function airbyteSyncModeFor(mode: CdcSyncMode): string {
  switch (mode) {
    case 'full_refresh':
      return 'full_refresh_overwrite';
    case 'incremental_cdc':
      return 'incremental_append';
    default: {
      // Exhaustiveness guard — unreachable for valid CdcSyncMode values.
      const never: never = mode;
      throw new Error(`Unsupported sync mode: ${String(never)}`);
    }
  }
}

// ── schedule validation (Req 4.3, 4.7) ──────────────────────────────────

/**
 * Raised when a sync schedule is configured with an interval outside the
 * allowed [300s, 86400s] range (Req 4.7).
 */
export class SyncScheduleValidationError extends Error {
  readonly code = 'SYNC_SCHEDULE_INVALID' as const;
  /** The list of validation messages, one per violated constraint. */
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      `Invalid sync schedule: ${issues.join('; ')}. ` +
        `Allowed interval range is ${SYNC_INTERVAL_MIN_SECONDS}–${SYNC_INTERVAL_MAX_SECONDS} seconds ` +
        `(5 minutes to 24 hours).`,
    );
    this.name = 'SyncScheduleValidationError';
    this.issues = issues;
  }
}

/**
 * Validate a sync schedule against the shared {@link SyncScheduleSchema}.
 * Accepts the schedule if and only if `interval_seconds` is an integer in
 * [300, 86400] and `sync_mode` is one of the supported modes (Req 4.3, 4.7).
 *
 * @throws {SyncScheduleValidationError} when validation fails.
 */
export function validateSyncSchedule(input: unknown): SyncSchedule {
  const result = SyncScheduleSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.join('.') || '(root)';
      return `${path}: ${issue.message}`;
    });
    throw new SyncScheduleValidationError(issues);
  }
  return result.data;
}

/** A normalised Airbyte schedule derived from a validated interval. */
export interface AirbyteScheduleConfig {
  readonly scheduleType: 'basic';
  readonly timeUnit: 'minutes' | 'hours';
  readonly units: number;
}

/**
 * Build an Airbyte basic-schedule configuration from a validated interval.
 * Intervals that divide evenly into hours are expressed in hours; otherwise
 * minutes are used. Pure and deterministic.
 */
export function buildScheduleConfig(intervalSeconds: number): AirbyteScheduleConfig {
  if (intervalSeconds % 3_600 === 0) {
    return {
      scheduleType: 'basic',
      timeUnit: 'hours',
      units: intervalSeconds / 3_600,
    };
  }
  return {
    scheduleType: 'basic',
    timeUnit: 'minutes',
    units: Math.round(intervalSeconds / 60),
  };
}

// ── sync metadata (Req 4.5 / Property 10) ───────────────────────────────

/**
 * Metadata recorded in the Pipeline_Registry when a sync completes: the
 * completion timestamp and the exact number of records synced (Req 4.5).
 */
export interface SyncMetadata {
  /** ISO-8601 timestamp of when the sync completed. */
  readonly lastSyncAt: string;
  /** Exact number of records synced in the completed job. */
  readonly recordCount: number;
}

/**
 * Build {@link SyncMetadata} for a completed sync. Pure and deterministic
 * given the record count and clock reading — exposed so the Req 4.5 /
 * Property 10 behaviour can be tested without provisioning a pipeline.
 *
 * The record count is preserved exactly (no rounding or clamping) so the
 * registry reflects the precise number of records the sync reported.
 */
export function buildSyncMetadata(recordCount: number, nowMs: number): SyncMetadata {
  return {
    lastSyncAt: new Date(nowMs).toISOString(),
    recordCount,
  };
}

/**
 * Listener invoked when a sync completes, carrying the metadata that should
 * be persisted to the Pipeline_Registry (last-sync timestamp + record
 * count). Wiring this to the registry's update path satisfies Req 4.5.
 */
export type SyncMetadataListener = (
  pipelineId: string,
  metadata: SyncMetadata,
) => void | Promise<void>;

// ── Airbyte API model ────────────────────────────────────────────────────

/** A reference to a provisioned Airbyte resource. */
export interface AirbyteResourceRef {
  readonly id: string;
  readonly name: string;
}

/** Request payload for creating an Airbyte source from the Source_Database. */
export interface AirbyteSourceRequest {
  readonly name: string;
  readonly sourceType: string;
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly password: string;
  readonly replicationTables: readonly string[];
}

/** Request payload for creating an Airbyte destination at the ClickHouse_Sink. */
export interface AirbyteDestinationRequest {
  readonly name: string;
  readonly destinationType: string;
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly password: string;
}

/** Request payload for creating an Airbyte connection between source/destination. */
export interface AirbyteConnectionRequest {
  readonly name: string;
  readonly sourceId: string;
  readonly destinationId: string;
  readonly syncMode: string;
  readonly schedule: AirbyteScheduleConfig;
  readonly replicationTables: readonly string[];
}

/** Outcome of an Airbyte sync job. */
export interface AirbyteSyncResult {
  /** Terminal job status. */
  readonly status: 'succeeded' | 'failed';
  /** Number of records synced (meaningful when `status` is `succeeded`). */
  readonly recordsSynced: number;
  /** Failure reason (present when `status` is `failed`). */
  readonly failureReason?: string;
}

/**
 * Abstraction over the Airbyte REST API. The connector drives source,
 * destination, and connection lifecycle plus sync execution through this
 * interface so the orchestration logic is testable without a live platform.
 */
export interface AirbyteApiClient {
  /** Whether the Airbyte platform is currently reachable. */
  isAvailable(): boolean | Promise<boolean>;
  /** Create an Airbyte source. */
  createSource(req: AirbyteSourceRequest): Promise<AirbyteResourceRef>;
  /** Create an Airbyte destination. */
  createDestination(req: AirbyteDestinationRequest): Promise<AirbyteResourceRef>;
  /** Create an Airbyte connection linking a source and destination. */
  createConnection(req: AirbyteConnectionRequest): Promise<AirbyteResourceRef>;
  /** Enable or disable a connection's scheduled syncs. */
  setConnectionActive(connectionId: string, active: boolean): Promise<void>;
  /** Trigger a sync job for a connection and await its terminal result. */
  triggerSync(connectionId: string): Promise<AirbyteSyncResult>;
  /** Delete a connection. */
  deleteConnection(connectionId: string): Promise<void>;
  /** Delete a source. */
  deleteSource(sourceId: string): Promise<void>;
  /** Delete a destination. */
  deleteDestination(destinationId: string): Promise<void>;
}

// ── request builders ─────────────────────────────────────────────────────

function safeParseUrl(connectionString: string): URL | null {
  try {
    return new URL(connectionString);
  } catch {
    return null;
  }
}

/** Derive the Airbyte resource names for a pipeline. */
export function airbyteResourceNamesFor(pipelineId: string): {
  source: string;
  destination: string;
  connection: string;
} {
  return {
    source: `lumibase-cdc-src-${pipelineId}`,
    destination: `lumibase-cdc-dst-${pipelineId}`,
    connection: `lumibase-cdc-conn-${pipelineId}`,
  };
}

/** Build an Airbyte source request from the Source_Database connection. */
export function buildSourceRequest(
  config: ConnectorConfig,
  name: string,
): AirbyteSourceRequest {
  const url = safeParseUrl(config.sourceConnection);
  return {
    name,
    sourceType: 'postgres',
    host: url?.hostname ?? 'localhost',
    port: url?.port ? Number(url.port) : 5432,
    database: url ? url.pathname.replace(/^\//, '') : '',
    username: url?.username ?? '',
    password: url?.password ?? '',
    replicationTables: [...config.replicationTables],
  };
}

/** Build an Airbyte destination request from the ClickHouse_Sink connection. */
export function buildDestinationRequest(
  config: ConnectorConfig,
  name: string,
): AirbyteDestinationRequest {
  const url = safeParseUrl(config.sinkConnection);
  return {
    name,
    destinationType: 'clickhouse',
    host: url?.hostname ?? 'localhost',
    port: url?.port ? Number(url.port) : 8123,
    database: url ? url.pathname.replace(/^\//, '') : '',
    username: url?.username ?? '',
    password: url?.password ?? '',
  };
}

/** Build an Airbyte connection request linking the source and destination. */
export function buildConnectionRequest(
  sourceId: string,
  destinationId: string,
  config: ConnectorConfig,
  syncMode: CdcSyncMode,
  schedule: SyncSchedule,
  name: string,
): AirbyteConnectionRequest {
  return {
    name,
    sourceId,
    destinationId,
    syncMode: airbyteSyncModeFor(syncMode),
    schedule: buildScheduleConfig(schedule.interval_seconds),
    replicationTables: [...config.replicationTables],
  };
}

/**
 * Resolve and validate the sync schedule + mode from a connector config.
 * Reads `connectorSpecificConfig.syncSchedule` (or the schedule fields
 * directly on `connectorSpecificConfig`), defaulting to the minimum interval
 * with incremental CDC when nothing is supplied. The resolved schedule is
 * always validated via {@link validateSyncSchedule} (Req 4.3, 4.7).
 */
export function resolveSyncSchedule(config: ConnectorConfig): SyncSchedule {
  const specific = config.connectorSpecificConfig ?? {};
  const raw =
    (specific.syncSchedule as unknown) ??
    (('interval_seconds' in specific || 'sync_mode' in specific)
      ? {
          interval_seconds: (specific as Record<string, unknown>).interval_seconds,
          sync_mode: (specific as Record<string, unknown>).sync_mode,
        }
      : {
          interval_seconds: SYNC_INTERVAL_MIN_SECONDS,
          sync_mode: 'incremental_cdc' as const,
        });
  return validateSyncSchedule(raw);
}

// ── timeout helper (Req 4.1, 4.6) ───────────────────────────────────────

/** Raised when an Airbyte provisioning step exceeds its time budget. */
export class AirbyteProvisioningTimeoutError extends Error {
  readonly code = 'AIRBYTE_PROVISIONING_TIMEOUT' as const;
  constructor(message: string) {
    super(message);
    this.name = 'AirbyteProvisioningTimeoutError';
  }
}

/**
 * Reject with an {@link AirbyteProvisioningTimeoutError} if `promise` does not
 * settle within `ms`. The underlying promise is not cancellable, so callers
 * treat a timeout as a provisioning failure and release any resources that
 * were tracked up to that point.
 */
function raceTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new AirbyteProvisioningTimeoutError(message));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// ── in-memory default client ─────────────────────────────────────────────

/**
 * In-memory Airbyte API client. Records created resources and replays a
 * queue of programmed sync results. Suitable as a default in environments
 * without a real Airbyte platform and as a test double — failure injection
 * and sync-result programming let tests exercise retry and metadata logic.
 */
export class InMemoryAirbyteApiClient implements AirbyteApiClient {
  private available = true;
  private sequence = 0;
  private readonly syncResults: AirbyteSyncResult[] = [];

  readonly sources = new Map<string, AirbyteSourceRequest>();
  readonly destinations = new Map<string, AirbyteDestinationRequest>();
  readonly connections = new Map<string, AirbyteConnectionRequest>();
  readonly activeConnections = new Set<string>();

  setAvailable(available: boolean): void {
    this.available = available;
  }

  /** Program the result returned by the next {@link triggerSync} call. */
  enqueueSyncResult(result: AirbyteSyncResult): void {
    this.syncResults.push(result);
  }

  isAvailable(): boolean {
    return this.available;
  }

  async createSource(req: AirbyteSourceRequest): Promise<AirbyteResourceRef> {
    this.assertAvailable();
    const id = `src_${(this.sequence += 1)}`;
    this.sources.set(id, req);
    return { id, name: req.name };
  }

  async createDestination(
    req: AirbyteDestinationRequest,
  ): Promise<AirbyteResourceRef> {
    this.assertAvailable();
    const id = `dst_${(this.sequence += 1)}`;
    this.destinations.set(id, req);
    return { id, name: req.name };
  }

  async createConnection(
    req: AirbyteConnectionRequest,
  ): Promise<AirbyteResourceRef> {
    this.assertAvailable();
    const id = `conn_${(this.sequence += 1)}`;
    this.connections.set(id, req);
    this.activeConnections.add(id);
    return { id, name: req.name };
  }

  async setConnectionActive(connectionId: string, active: boolean): Promise<void> {
    if (active) {
      this.activeConnections.add(connectionId);
    } else {
      this.activeConnections.delete(connectionId);
    }
  }

  async triggerSync(_connectionId: string): Promise<AirbyteSyncResult> {
    this.assertAvailable();
    return (
      this.syncResults.shift() ?? { status: 'succeeded', recordsSynced: 0 }
    );
  }

  async deleteConnection(connectionId: string): Promise<void> {
    this.connections.delete(connectionId);
    this.activeConnections.delete(connectionId);
  }

  async deleteSource(sourceId: string): Promise<void> {
    this.sources.delete(sourceId);
  }

  async deleteDestination(destinationId: string): Promise<void> {
    this.destinations.delete(destinationId);
  }

  private assertAvailable(): void {
    if (!this.available) {
      throw new Error('Airbyte platform unavailable');
    }
  }
}

// ── sync run result ──────────────────────────────────────────────────────

/** Outcome of {@link AirbyteConnector.runSync}. */
export interface SyncRunResult {
  /** Whether the sync ultimately succeeded. */
  readonly success: boolean;
  /** Total number of attempts made (1 initial + up to {@link MAX_SYNC_RETRIES}). */
  readonly attempts: number;
  /** Metadata recorded on success (present only when `success` is `true`). */
  readonly metadata?: SyncMetadata;
  /** Failure reason after all retries are exhausted (present on failure). */
  readonly failureReason?: string;
}

// ── per-pipeline runtime state ──────────────────────────────────────────

interface PipelineState {
  readonly config: ConnectorConfig;
  readonly schedule: SyncSchedule;
  readonly sourceRef: AirbyteResourceRef;
  readonly destinationRef: AirbyteResourceRef;
  readonly connectionRef: AirbyteResourceRef;
  lastSyncAt: string | null;
  lastSyncRecordCount: number | null;
  totalRecordsSynced: number;
  errorCount: number;
  startedAt: number | null;
  inError: boolean;
}

/** Resources created during provisioning, tracked for partial cleanup. */
interface CreatedResources {
  source?: AirbyteResourceRef;
  destination?: AirbyteResourceRef;
  connection?: AirbyteResourceRef;
}

// ── dependencies ───────────────────────────────────────────────────────

export interface AirbyteConnectorDeps {
  readonly api?: AirbyteApiClient;
  readonly clock?: () => number;
  /** Sleep helper (injectable so backoff timing can be tested instantly). */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onStatusChange?: StatusChangeListener;
  /** Invoked with sync metadata on completion so the registry can be updated. */
  readonly onSyncMetadata?: SyncMetadataListener;
  /** Override the provisioning timeout (defaults to {@link PROVISION_TIMEOUT_MS}). */
  readonly provisionTimeoutMs?: number;
}

// ── connector implementation ────────────────────────────────────────────

export class AirbyteConnector implements CdcConnector {
  readonly type: CdcConnectorType = 'airbyte';

  private readonly api: AirbyteApiClient;
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onStatusChange?: StatusChangeListener;
  private readonly onSyncMetadata?: SyncMetadataListener;
  private readonly provisionTimeoutMs: number;

  private readonly pipelines = new Map<string, PipelineState>();

  constructor(deps: AirbyteConnectorDeps = {}) {
    this.api = deps.api ?? new InMemoryAirbyteApiClient();
    this.clock = deps.clock ?? (() => Date.now());
    this.sleep =
      deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    this.onStatusChange = deps.onStatusChange;
    this.onSyncMetadata = deps.onSyncMetadata;
    this.provisionTimeoutMs = deps.provisionTimeoutMs ?? PROVISION_TIMEOUT_MS;
  }

  // ── lifecycle ──────────────────────────────────────────────────────

  /**
   * Provision the Airbyte source, destination, and connection within the
   * 120-second budget (Req 4.1). The configured sync schedule is validated
   * up-front (Req 4.3, 4.7). On any failure — including a timeout — every
   * partially-allocated Airbyte resource is released and the pipeline is
   * reported in `error` status with the failure reason (Req 4.6).
   */
  async provision(config: ConnectorConfig): Promise<ProvisionResult> {
    const resources: ProvisionedResource[] = [];
    const created: CreatedResources = {};

    let schedule: SyncSchedule;
    try {
      // Validate the schedule + sync mode before allocating anything (Req 4.3, 4.7).
      schedule = resolveSyncSchedule(config);
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'invalid sync schedule';
      this.onStatusChange?.(config.pipelineId, 'error', reason);
      return {
        success: false,
        message: `Provisioning failed: ${reason}`,
        provisionedResources: [],
      };
    }

    try {
      await raceTimeout(
        this.provisionResources(config, schedule, created, resources),
        this.provisionTimeoutMs,
        `Airbyte provisioning exceeded ${this.provisionTimeoutMs / 1000}s timeout`,
      );

      this.pipelines.set(config.pipelineId, {
        config,
        schedule,
        sourceRef: created.source!,
        destinationRef: created.destination!,
        connectionRef: created.connection!,
        lastSyncAt: null,
        lastSyncRecordCount: null,
        totalRecordsSynced: 0,
        errorCount: 0,
        startedAt: null,
        inError: false,
      });

      return {
        success: true,
        message: `Provisioned Airbyte pipeline ${config.pipelineId}`,
        provisionedResources: resources,
      };
    } catch (err) {
      // Release any partially-allocated resources (Req 4.6).
      await this.releaseResources(created);
      const reason = err instanceof Error ? err.message : 'unknown error';
      this.onStatusChange?.(config.pipelineId, 'error', reason);
      return {
        success: false,
        message: `Provisioning failed: ${reason}`,
        provisionedResources: [],
      };
    }
  }

  /** Create the source, destination, and connection in order, tracking each. */
  private async provisionResources(
    config: ConnectorConfig,
    schedule: SyncSchedule,
    created: CreatedResources,
    resources: ProvisionedResource[],
  ): Promise<void> {
    const names = airbyteResourceNamesFor(config.pipelineId);

    const source = await this.api.createSource(
      buildSourceRequest(config, names.source),
    );
    created.source = source;
    resources.push({ type: 'airbyte_source', id: source.id, name: source.name });

    const destination = await this.api.createDestination(
      buildDestinationRequest(config, names.destination),
    );
    created.destination = destination;
    resources.push({
      type: 'airbyte_destination',
      id: destination.id,
      name: destination.name,
    });

    const connection = await this.api.createConnection(
      buildConnectionRequest(
        source.id,
        destination.id,
        config,
        schedule.sync_mode,
        schedule,
        names.connection,
      ),
    );
    created.connection = connection;
    resources.push({
      type: 'airbyte_connection',
      id: connection.id,
      name: connection.name,
    });
  }

  /**
   * Best-effort release of partially-allocated Airbyte resources. Deletes the
   * connection first (so no further syncs run) then the source and
   * destination. Individual deletion failures are swallowed so a single
   * lingering resource does not mask the original provisioning failure.
   */
  private async releaseResources(created: CreatedResources): Promise<void> {
    if (created.connection) {
      await this.safeDelete(() =>
        this.api.deleteConnection(created.connection!.id),
      );
    }
    if (created.source) {
      await this.safeDelete(() => this.api.deleteSource(created.source!.id));
    }
    if (created.destination) {
      await this.safeDelete(() =>
        this.api.deleteDestination(created.destination!.id),
      );
    }
  }

  private async safeDelete(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch {
      // Best-effort cleanup — ignore individual deletion failures.
    }
  }

  async start(pipelineId: string): Promise<void> {
    const state = this.requireState(pipelineId);
    await this.api.setConnectionActive(state.connectionRef.id, true);
    state.startedAt = this.clock();
    state.inError = false;
  }

  async stop(pipelineId: string): Promise<void> {
    const state = this.requireState(pipelineId);
    await this.api.setConnectionActive(state.connectionRef.id, false);
  }

  async healthCheck(pipelineId: string): Promise<HealthCheckResult> {
    const state = this.requireState(pipelineId);
    const platformUp = await this.api.isAvailable();

    // Airbyte mediates source → destination; the Airbyte platform is the
    // intermediary service for this approach.
    const services: ServiceHealthStatus[] = [
      { service: 'source_database', reachable: true },
      { service: 'clickhouse_sink', reachable: true },
      platformUp
        ? { service: 'airbyte_platform', reachable: true }
        : {
            service: 'airbyte_platform',
            reachable: false,
            reason: 'Airbyte platform unavailable',
          },
    ];

    return {
      healthy: services.every((s) => s.reachable) && !state.inError,
      services,
      checkedAt: new Date(this.clock()).toISOString(),
    };
  }

  async getMetrics(pipelineId: string): Promise<PipelineMetrics> {
    const state = this.requireState(pipelineId);
    const now = this.clock();
    const elapsedSeconds = state.startedAt
      ? Math.max(1, (now - state.startedAt) / 1000)
      : 1;

    // Airbyte replicates in scheduled batches; replication lag is the time
    // elapsed since the last successful sync completed.
    const replicationLagMs = state.lastSyncAt
      ? Math.max(0, now - Date.parse(state.lastSyncAt))
      : 0;

    return {
      replicationLagMs,
      eventsPerSecond: Math.round(state.totalRecordsSynced / elapsedSeconds),
      errorCount: state.errorCount,
      collectedAt: new Date(now).toISOString(),
    };
  }

  /**
   * Destroy the pipeline by removing the Airbyte connection, source, and
   * destination. Airbyte is **not** replication-slot-based, so — unlike the
   * Debezium and Materialized Engine connectors — this performs **no**
   * PostgreSQL replication-slot cleanup. Idempotent: a no-op if the pipeline
   * was not provisioned in this process.
   */
  async destroy(pipelineId: string): Promise<void> {
    const state = this.pipelines.get(pipelineId);
    if (!state) {
      // Nothing provisioned in this process — idempotent no-op.
      return;
    }

    // Remove the connection first so no further syncs are triggered, then the
    // source and destination. No replication-slot cleanup is required.
    await this.api.deleteConnection(state.connectionRef.id);
    await this.api.deleteSource(state.sourceRef.id);
    await this.api.deleteDestination(state.destinationRef.id);

    this.pipelines.delete(pipelineId);
  }

  // ── sync execution (Req 4.4, 4.5) ───────────────────────────────────

  /**
   * Run a sync job for a pipeline, retrying a failed job up to
   * {@link MAX_SYNC_RETRIES} times with exponential backoff starting at 30s
   * (30s, 60s, 120s) (Req 4.4). On success, the last-sync timestamp and the
   * exact record count are recorded (Req 4.5). If every attempt fails, the
   * pipeline is moved to `error` status with the failure reason recorded.
   */
  async runSync(pipelineId: string): Promise<SyncRunResult> {
    const state = this.requireState(pipelineId);
    let lastFailureReason = 'sync failed';

    for (let attempt = 0; attempt <= MAX_SYNC_RETRIES; attempt += 1) {
      if (attempt > 0) {
        // Exponential backoff before each retry: 30s, 60s, 120s (Req 4.4).
        const delay = SYNC_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
        await this.sleep(delay);
      }

      let result: AirbyteSyncResult;
      try {
        result = await this.api.triggerSync(state.connectionRef.id);
      } catch (err) {
        lastFailureReason = err instanceof Error ? err.message : 'sync failed';
        continue;
      }

      if (result.status === 'succeeded') {
        const metadata = this.completeSync(pipelineId, result.recordsSynced);
        state.inError = false;
        return { success: true, attempts: attempt + 1, metadata };
      }

      lastFailureReason = result.failureReason ?? 'sync failed';
    }

    // All attempts exhausted (Req 4.4): move to error + record the reason.
    state.inError = true;
    state.errorCount += 1;
    this.onStatusChange?.(
      pipelineId,
      'error',
      `Airbyte sync failed after ${MAX_SYNC_RETRIES} retries: ${lastFailureReason}`,
    );
    return {
      success: false,
      attempts: MAX_SYNC_RETRIES + 1,
      failureReason: lastFailureReason,
    };
  }

  /**
   * Record the completion of a sync job: update the last-sync timestamp and
   * the exact record count for the pipeline, and notify the configured
   * {@link SyncMetadataListener} so the Pipeline_Registry can persist the
   * metadata (Req 4.5 / Property 10).
   *
   * Exposed directly (separate from {@link runSync}) so the metadata-update
   * behaviour is testable in isolation.
   *
   * @returns The recorded {@link SyncMetadata}.
   */
  completeSync(pipelineId: string, recordCount: number): SyncMetadata {
    const state = this.requireState(pipelineId);
    const metadata = buildSyncMetadata(recordCount, this.clock());
    state.lastSyncAt = metadata.lastSyncAt;
    state.lastSyncRecordCount = metadata.recordCount;
    state.totalRecordsSynced += recordCount;
    void this.onSyncMetadata?.(pipelineId, metadata);
    return metadata;
  }

  /** Current recorded sync metadata for a pipeline, or `null` if never synced. */
  getSyncMetadata(pipelineId: string): SyncMetadata | null {
    const state = this.requireState(pipelineId);
    if (state.lastSyncAt === null || state.lastSyncRecordCount === null) {
      return null;
    }
    return {
      lastSyncAt: state.lastSyncAt,
      recordCount: state.lastSyncRecordCount,
    };
  }

  // ── helpers ──────────────────────────────────────────────────────────

  private requireState(pipelineId: string): PipelineState {
    const state = this.pipelines.get(pipelineId);
    if (!state) {
      throw new Error(
        `Pipeline "${pipelineId}" is not provisioned by this connector`,
      );
    }
    return state;
  }
}
