/**
 * PipelineRegistryService — CRUD + lifecycle management for CDC
 * pipeline configurations.
 *
 * Responsibilities:
 *   - Persist pipeline configs with encrypted connection parameters
 *   - Enforce per-site pipeline limit (max 50)
 *   - Enforce unique pipeline name per site
 *   - Connectivity check with 10-second timeout for source/sink
 *   - Status transitions
 *
 * Validates: Requirements 1.1, 1.2, 1.5, 1.6, 1.7
 */

import { and, eq, count } from 'drizzle-orm';
import { cdcPipelines, type Database } from '@lumibase/database';
import { nanoid } from 'nanoid';

import type { CdcConnector } from '../connectors/types';
import { encryptSync as encrypt, decryptSync as decrypt } from './encryption';

// ── constants ────────────────────────────────────────────────────────────

const MAX_PIPELINES_PER_SITE = 50;
const CONNECTIVITY_TIMEOUT_MS = 10_000;

// ── types ────────────────────────────────────────────────────────────────

export type PipelineStatus = 'active' | 'paused' | 'error' | 'provisioning';

export type CdcConnectorType =
  | 'debezium_kafka'
  | 'materialized_engine'
  | 'airbyte';

export interface PipelineCreateInput {
  pipeline_name: string;
  cdc_connector_type: CdcConnectorType;
  source_database_connection: string;
  clickhouse_sink_connection: string;
  replication_tables: string[];
  intermediary_connection?: string;
  config?: Record<string, unknown>;
}

export interface PipelinePatchInput {
  pipeline_name?: string;
  source_database_connection?: string;
  clickhouse_sink_connection?: string;
  intermediary_connection?: string | null;
  replication_tables?: string[];
  config?: Record<string, unknown>;
}

export interface PipelineRecord {
  id: string;
  siteId: string;
  pipelineName: string;
  connectorType: CdcConnectorType;
  status: PipelineStatus;
  statusMessage: string | null;
  sourceConnection: string;
  sinkConnection: string;
  intermediaryConnection: string | null;
  replicationTables: string[];
  config: Record<string, unknown>;
  lastSyncAt: Date | null;
  lastSyncRecordCount: number | null;
  createdAt: Date;
  updatedAt: Date;
}

// ── error types ──────────────────────────────────────────────────────────

export class PipelineLimitExceededError extends Error {
  readonly code = 'PIPELINE_LIMIT_EXCEEDED' as const;
  constructor(siteId: string) {
    super(
      `Site "${siteId}" has reached the maximum of ${MAX_PIPELINES_PER_SITE} pipelines`,
    );
    this.name = 'PipelineLimitExceededError';
  }
}

export class PipelineNameConflictError extends Error {
  readonly code = 'PIPELINE_NAME_CONFLICT' as const;
  constructor(name: string) {
    super(`A pipeline named "${name}" already exists for this site`);
    this.name = 'PipelineNameConflictError';
  }
}

export class ConnectivityCheckError extends Error {
  readonly code = 'CONNECTIVITY_CHECK_FAILED' as const;
  readonly endpoint: string;
  constructor(endpoint: string, reason?: string) {
    super(
      `Connectivity check failed for ${endpoint}${reason ? `: ${reason}` : ''}`,
    );
    this.name = 'ConnectivityCheckError';
    this.endpoint = endpoint;
  }
}

export class PipelineNotFoundError extends Error {
  readonly code = 'PIPELINE_NOT_FOUND' as const;
  constructor(pipelineId: string) {
    super(`Pipeline "${pipelineId}" not found`);
    this.name = 'PipelineNotFoundError';
  }
}

/**
 * Raised when a pipeline's connector fails to release/drop its PostgreSQL
 * replication slot(s) during {@link PipelineRegistry.delete}. The registry
 * record is intentionally kept when this is thrown so the orphaned slot is
 * not forgotten — the caller can retry the delete (Req 1.8; design Error
 * Handling row "Replication slot cleanup fails on delete").
 */
export class ReplicationSlotCleanupError extends Error {
  readonly code = 'REPLICATION_SLOT_CLEANUP_FAILED' as const;
  readonly pipelineId: string;
  constructor(pipelineId: string, reason?: string) {
    super(
      `Failed to clean up replication slot(s) for pipeline "${pipelineId}"` +
        `${reason ? `: ${reason}` : ''}`,
    );
    this.name = 'ReplicationSlotCleanupError';
    this.pipelineId = pipelineId;
  }
}

// ── connectivity checker ─────────────────────────────────────────────────

/**
 * Attempts a TCP-level connectivity check against a connection string.
 * Parses the host/port from the connection string and attempts to
 * connect within the timeout. Supports PostgreSQL and ClickHouse
 * connection string formats.
 */
export type ConnectivityChecker = (
  connectionString: string,
  timeoutMs: number,
) => Promise<void>;

/**
 * Default connectivity checker that parses host:port from a connection
 * string and attempts a TCP connection with the given timeout.
 */
export const defaultConnectivityChecker: ConnectivityChecker = async (
  connectionString: string,
  timeoutMs: number,
): Promise<void> => {
  const { host, port } = parseConnectionEndpoint(connectionString);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Use fetch with a HEAD-like request to test connectivity.
    // For database connections, we attempt a raw TCP socket check.
    // In environments without raw sockets (Workers), we validate
    // the connection string format and trust the provisioning step.
    if (typeof globalThis.process !== 'undefined') {
      // Node.js environment — use net.connect for TCP check
      const net = await import('node:net');
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect({ host, port, timeout: timeoutMs });
        socket.once('connect', () => {
          socket.destroy();
          resolve();
        });
        socket.once('timeout', () => {
          socket.destroy();
          reject(new Error('Connection timed out'));
        });
        socket.once('error', (err) => {
          socket.destroy();
          reject(err);
        });
      });
    } else {
      // Cloudflare Workers or other non-Node environments:
      // Validate the connection string is well-formed. Actual
      // connectivity is verified during the provisioning step.
      if (!host || port <= 0) {
        throw new Error('Invalid connection endpoint');
      }
    }
  } finally {
    clearTimeout(timeout);
  }
};

/**
 * Parse host and port from a connection string.
 * Supports formats:
 *   - postgresql://user:pass@host:port/db
 *   - clickhouse://user:pass@host:port/db
 *   - host:port
 */
function parseConnectionEndpoint(connectionString: string): {
  host: string;
  port: number;
} {
  try {
    // Try URL parsing first (covers postgresql://, clickhouse://, etc.)
    const url = new URL(connectionString);
    return {
      host: url.hostname || 'localhost',
      port: url.port ? parseInt(url.port, 10) : getDefaultPort(url.protocol),
    };
  } catch {
    // Fallback: try host:port format
    const parts = connectionString.split(':');
    if (parts.length === 2) {
      const port = parseInt(parts[1]!, 10);
      if (!isNaN(port)) {
        return { host: parts[0]!, port };
      }
    }
    return { host: connectionString, port: 5432 };
  }
}

function getDefaultPort(protocol: string): number {
  switch (protocol) {
    case 'postgresql:':
    case 'postgres:':
      return 5432;
    case 'clickhouse:':
      return 8123;
    case 'kafka:':
      return 9092;
    default:
      return 5432;
  }
}

// ── connector resolver (Req 1.8) ─────────────────────────────────────────

/**
 * Resolves the {@link CdcConnector} implementation responsible for a given
 * connector type. Injected into {@link PipelineRegistry} so {@link
 * PipelineRegistry.delete} can invoke `connector.destroy(pipelineId)` — which
 * for replication-slot-based approaches (Debezium+Kafka, Materialized Engine)
 * releases and drops the PostgreSQL replication slot(s) on the
 * Source_Database — before removing the registry record (Req 1.8).
 *
 * Implementations return `null`/`undefined` when no connector handles the
 * given type, in which case the registry skips connector teardown.
 */
export type ConnectorResolver = (
  connectorType: CdcConnectorType,
) => CdcConnector | null | undefined;

// ── service interface ────────────────────────────────────────────────────

export interface PipelineRegistryService {
  create(siteId: string, config: PipelineCreateInput): Promise<PipelineRecord>;
  get(siteId: string, pipelineId: string): Promise<PipelineRecord | null>;
  list(siteId: string): Promise<PipelineRecord[]>;
  update(
    siteId: string,
    pipelineId: string,
    patch: PipelinePatchInput,
  ): Promise<PipelineRecord>;
  delete(siteId: string, pipelineId: string): Promise<void>;
  updateStatus(
    pipelineId: string,
    status: PipelineStatus,
    message?: string,
  ): Promise<void>;
}

// ── dependencies ─────────────────────────────────────────────────────────

export interface PipelineRegistryDeps {
  readonly db: Database;
  /** Encryption key for connection parameters. */
  readonly encryptionKey: string;
  /**
   * Injectable connectivity checker. Defaults to
   * {@link defaultConnectivityChecker}.
   */
  readonly connectivityChecker?: ConnectivityChecker;
  /**
   * Injectable connector resolver used by {@link PipelineRegistry.delete} to
   * tear down a pipeline's connector (including replication-slot cleanup for
   * slot-based approaches) before the registry record is removed (Req 1.8).
   *
   * Optional: when omitted, delete falls back to a no-op resolver and simply
   * removes the record. Production call sites SHOULD provide a resolver that
   * returns the real connector instances so replication slots are dropped.
   */
  readonly connectorResolver?: ConnectorResolver;
}

// ── implementation ───────────────────────────────────────────────────────

export class PipelineRegistry implements PipelineRegistryService {
  private readonly db: Database;
  private readonly encryptionKey: string;
  private readonly checkConnectivity: ConnectivityChecker;
  private readonly resolveConnector: ConnectorResolver;

  constructor(deps: PipelineRegistryDeps) {
    this.db = deps.db;
    this.encryptionKey = deps.encryptionKey;
    this.checkConnectivity =
      deps.connectivityChecker ?? defaultConnectivityChecker;
    // Default to a no-op resolver so existing call sites/tests that do not
    // wire a resolver keep working — they simply skip connector teardown.
    this.resolveConnector = deps.connectorResolver ?? (() => null);
  }

  async create(
    siteId: string,
    input: PipelineCreateInput,
  ): Promise<PipelineRecord> {
    // 1. Enforce per-site pipeline limit (Req 1.7)
    await this.enforcePipelineLimit(siteId);

    // 2. Enforce unique pipeline name per site (Req 1.6)
    await this.enforceUniqueName(siteId, input.pipeline_name);

    // 3. Connectivity check for source and sink (Req 1.5)
    await this.performConnectivityCheck(
      input.source_database_connection,
      'source',
    );
    await this.performConnectivityCheck(
      input.clickhouse_sink_connection,
      'sink',
    );

    // 4. Encrypt connection parameters (Req 1.4)
    const encryptedSource = encrypt(
      input.source_database_connection,
      this.encryptionKey,
    );
    const encryptedSink = encrypt(
      input.clickhouse_sink_connection,
      this.encryptionKey,
    );
    const encryptedIntermediary = input.intermediary_connection
      ? encrypt(input.intermediary_connection, this.encryptionKey)
      : null;

    // 5. Persist the pipeline (Req 1.1)
    const id = nanoid();
    const now = new Date();

    const inserted = await this.db
      .insert(cdcPipelines)
      .values({
        id,
        siteId,
        pipelineName: input.pipeline_name,
        connectorType: input.cdc_connector_type,
        status: 'provisioning',
        sourceConnection: encryptedSource,
        sinkConnection: encryptedSink,
        intermediaryConnection: encryptedIntermediary,
        replicationTables: input.replication_tables,
        config: input.config ?? {},
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const row = inserted[0]!;
    return this.toRecord(row);
  }

  async get(
    siteId: string,
    pipelineId: string,
  ): Promise<PipelineRecord | null> {
    const rows = await this.db
      .select()
      .from(cdcPipelines)
      .where(
        and(eq(cdcPipelines.id, pipelineId), eq(cdcPipelines.siteId, siteId)),
      )
      .limit(1);

    const row = rows[0];
    if (!row) return null;
    return this.toRecord(row);
  }

  async list(siteId: string): Promise<PipelineRecord[]> {
    const rows = await this.db
      .select()
      .from(cdcPipelines)
      .where(eq(cdcPipelines.siteId, siteId));

    return rows.map((row) => this.toRecord(row));
  }

  async update(
    siteId: string,
    pipelineId: string,
    patch: PipelinePatchInput,
  ): Promise<PipelineRecord> {
    // Verify pipeline exists and belongs to site
    const existing = await this.get(siteId, pipelineId);
    if (!existing) {
      throw new PipelineNotFoundError(pipelineId);
    }

    // If renaming, enforce uniqueness (Req 1.6)
    if (patch.pipeline_name && patch.pipeline_name !== existing.pipelineName) {
      await this.enforceUniqueName(siteId, patch.pipeline_name);
    }

    // If updating connections, run connectivity checks (Req 1.5)
    if (patch.source_database_connection) {
      await this.performConnectivityCheck(
        patch.source_database_connection,
        'source',
      );
    }
    if (patch.clickhouse_sink_connection) {
      await this.performConnectivityCheck(
        patch.clickhouse_sink_connection,
        'sink',
      );
    }

    // Build the update set
    const updateSet: Record<string, unknown> = {
      updatedAt: new Date(),
    };

    if (patch.pipeline_name !== undefined) {
      updateSet.pipelineName = patch.pipeline_name;
    }
    if (patch.source_database_connection !== undefined) {
      updateSet.sourceConnection = encrypt(
        patch.source_database_connection,
        this.encryptionKey,
      );
    }
    if (patch.clickhouse_sink_connection !== undefined) {
      updateSet.sinkConnection = encrypt(
        patch.clickhouse_sink_connection,
        this.encryptionKey,
      );
    }
    if (patch.intermediary_connection !== undefined) {
      updateSet.intermediaryConnection =
        patch.intermediary_connection === null
          ? null
          : encrypt(patch.intermediary_connection, this.encryptionKey);
    }
    if (patch.replication_tables !== undefined) {
      updateSet.replicationTables = patch.replication_tables;
    }
    if (patch.config !== undefined) {
      updateSet.config = patch.config;
    }

    const updated = await this.db
      .update(cdcPipelines)
      .set(updateSet)
      .where(
        and(eq(cdcPipelines.id, pipelineId), eq(cdcPipelines.siteId, siteId)),
      )
      .returning();

    const row = updated[0];
    if (!row) {
      throw new PipelineNotFoundError(pipelineId);
    }
    return this.toRecord(row);
  }

  async delete(siteId: string, pipelineId: string): Promise<void> {
    // 1. Resolve the pipeline first so we know its connector type and can
    //    confirm it belongs to the site before tearing anything down.
    const existing = await this.get(siteId, pipelineId);
    if (!existing) {
      throw new PipelineNotFoundError(pipelineId);
    }

    // 2. Tear down the connector BEFORE removing the registry record. For
    //    replication-slot-based approaches (Debezium+Kafka, Materialized
    //    Engine) this releases and drops the PostgreSQL replication slot(s)
    //    on the Source_Database via pg_drop_replication_slot, so no orphaned
    //    slot remains and the Source_Database does not retain WAL files
    //    indefinitely (Req 1.8). If destroy() fails (e.g. slot cleanup
    //    fails after its internal retries), we surface the error and keep the
    //    registry record so the orphaned slot is not forgotten.
    const connector = this.resolveConnector(existing.connectorType);
    if (connector) {
      try {
        await connector.destroy(pipelineId);
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'unknown error';
        throw new ReplicationSlotCleanupError(pipelineId, reason);
      }
    }

    // 3. Only after destroy() (including slot cleanup) succeeds do we remove
    //    the registry record.
    const result = await this.db
      .delete(cdcPipelines)
      .where(
        and(eq(cdcPipelines.id, pipelineId), eq(cdcPipelines.siteId, siteId)),
      )
      .returning({ id: cdcPipelines.id });

    if (result.length === 0) {
      throw new PipelineNotFoundError(pipelineId);
    }
  }

  async updateStatus(
    pipelineId: string,
    status: PipelineStatus,
    message?: string,
  ): Promise<void> {
    const result = await this.db
      .update(cdcPipelines)
      .set({
        status,
        statusMessage: message ?? null,
        updatedAt: new Date(),
      })
      .where(eq(cdcPipelines.id, pipelineId))
      .returning({ id: cdcPipelines.id });

    if (result.length === 0) {
      throw new PipelineNotFoundError(pipelineId);
    }
  }

  // ── private helpers ──────────────────────────────────────────────────

  private async enforcePipelineLimit(siteId: string): Promise<void> {
    const result = await this.db
      .select({ value: count() })
      .from(cdcPipelines)
      .where(eq(cdcPipelines.siteId, siteId));

    const currentCount = result[0]?.value ?? 0;
    if (currentCount >= MAX_PIPELINES_PER_SITE) {
      throw new PipelineLimitExceededError(siteId);
    }
  }

  private async enforceUniqueName(
    siteId: string,
    pipelineName: string,
  ): Promise<void> {
    const existing = await this.db
      .select({ id: cdcPipelines.id })
      .from(cdcPipelines)
      .where(
        and(
          eq(cdcPipelines.siteId, siteId),
          eq(cdcPipelines.pipelineName, pipelineName),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      throw new PipelineNameConflictError(pipelineName);
    }
  }

  private async performConnectivityCheck(
    connectionString: string,
    endpoint: 'source' | 'sink',
  ): Promise<void> {
    try {
      await this.checkConnectivity(connectionString, CONNECTIVITY_TIMEOUT_MS);
    } catch (err) {
      const reason =
        err instanceof Error ? err.message : 'Connection failed';
      throw new ConnectivityCheckError(endpoint, reason);
    }
  }

  /**
   * Map a raw database row to a PipelineRecord, decrypting connection
   * parameters.
   */
  private toRecord(row: typeof cdcPipelines.$inferSelect): PipelineRecord {
    return {
      id: row.id,
      siteId: row.siteId,
      pipelineName: row.pipelineName,
      connectorType: row.connectorType as CdcConnectorType,
      status: row.status as PipelineStatus,
      statusMessage: row.statusMessage,
      sourceConnection: decrypt(row.sourceConnection, this.encryptionKey),
      sinkConnection: decrypt(row.sinkConnection, this.encryptionKey),
      intermediaryConnection: row.intermediaryConnection
        ? decrypt(row.intermediaryConnection, this.encryptionKey)
        : null,
      replicationTables: row.replicationTables as string[],
      config: row.config as Record<string, unknown>,
      lastSyncAt: row.lastSyncAt,
      lastSyncRecordCount: row.lastSyncRecordCount,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
