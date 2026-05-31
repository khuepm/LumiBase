/**
 * PipelineRegistryService — CRUD + lifecycle management for CDC
 * pipeline configurations.
 *
 * Responsibilities:
 *   - Persist pipeline configs with encrypted connection parameters
 *   - Enforce tenant pipeline limit (max 50)
 *   - Enforce unique pipeline name per tenant
 *   - Connectivity check with 5-second timeout for source/sink
 *   - Status transitions
 *
 * Validates: Requirements 1.1, 1.2, 1.5, 1.6, 1.7
 */

import { and, eq, count } from 'drizzle-orm';
import { cdcPipelines, type Database } from '@lumibase/database';
import { nanoid } from 'nanoid';

import { encryptSync as encrypt, decryptSync as decrypt } from './encryption';

// ── constants ────────────────────────────────────────────────────────────

const MAX_PIPELINES_PER_TENANT = 50;
const CONNECTIVITY_TIMEOUT_MS = 5_000;

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
  constructor(tenantId: string) {
    super(
      `Tenant "${tenantId}" has reached the maximum of ${MAX_PIPELINES_PER_TENANT} pipelines`,
    );
    this.name = 'PipelineLimitExceededError';
  }
}

export class PipelineNameConflictError extends Error {
  readonly code = 'PIPELINE_NAME_CONFLICT' as const;
  constructor(name: string) {
    super(`A pipeline named "${name}" already exists for this tenant`);
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

// ── service interface ────────────────────────────────────────────────────

export interface PipelineRegistryService {
  create(
    tenantId: string,
    config: PipelineCreateInput,
  ): Promise<PipelineRecord>;
  get(tenantId: string, pipelineId: string): Promise<PipelineRecord | null>;
  list(tenantId: string): Promise<PipelineRecord[]>;
  update(
    tenantId: string,
    pipelineId: string,
    patch: PipelinePatchInput,
  ): Promise<PipelineRecord>;
  delete(tenantId: string, pipelineId: string): Promise<void>;
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
}

// ── implementation ───────────────────────────────────────────────────────

export class PipelineRegistry implements PipelineRegistryService {
  private readonly db: Database;
  private readonly encryptionKey: string;
  private readonly checkConnectivity: ConnectivityChecker;

  constructor(deps: PipelineRegistryDeps) {
    this.db = deps.db;
    this.encryptionKey = deps.encryptionKey;
    this.checkConnectivity =
      deps.connectivityChecker ?? defaultConnectivityChecker;
  }

  async create(
    tenantId: string,
    input: PipelineCreateInput,
  ): Promise<PipelineRecord> {
    // 1. Enforce tenant pipeline limit (Req 1.7)
    await this.enforcePipelineLimit(tenantId);

    // 2. Enforce unique pipeline name per tenant (Req 1.6)
    await this.enforceUniqueName(tenantId, input.pipeline_name);

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
        siteId: tenantId,
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
    tenantId: string,
    pipelineId: string,
  ): Promise<PipelineRecord | null> {
    const rows = await this.db
      .select()
      .from(cdcPipelines)
      .where(
        and(eq(cdcPipelines.id, pipelineId), eq(cdcPipelines.siteId, tenantId)),
      )
      .limit(1);

    const row = rows[0];
    if (!row) return null;
    return this.toRecord(row);
  }

  async list(tenantId: string): Promise<PipelineRecord[]> {
    const rows = await this.db
      .select()
      .from(cdcPipelines)
      .where(eq(cdcPipelines.siteId, tenantId));

    return rows.map((row) => this.toRecord(row));
  }

  async update(
    tenantId: string,
    pipelineId: string,
    patch: PipelinePatchInput,
  ): Promise<PipelineRecord> {
    // Verify pipeline exists and belongs to tenant
    const existing = await this.get(tenantId, pipelineId);
    if (!existing) {
      throw new PipelineNotFoundError(pipelineId);
    }

    // If renaming, enforce uniqueness (Req 1.6)
    if (patch.pipeline_name && patch.pipeline_name !== existing.pipelineName) {
      await this.enforceUniqueName(tenantId, patch.pipeline_name);
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
        and(eq(cdcPipelines.id, pipelineId), eq(cdcPipelines.siteId, tenantId)),
      )
      .returning();

    const row = updated[0];
    if (!row) {
      throw new PipelineNotFoundError(pipelineId);
    }
    return this.toRecord(row);
  }

  async delete(tenantId: string, pipelineId: string): Promise<void> {
    const result = await this.db
      .delete(cdcPipelines)
      .where(
        and(eq(cdcPipelines.id, pipelineId), eq(cdcPipelines.siteId, tenantId)),
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

  private async enforcePipelineLimit(tenantId: string): Promise<void> {
    const result = await this.db
      .select({ value: count() })
      .from(cdcPipelines)
      .where(eq(cdcPipelines.siteId, tenantId));

    const currentCount = result[0]?.value ?? 0;
    if (currentCount >= MAX_PIPELINES_PER_TENANT) {
      throw new PipelineLimitExceededError(tenantId);
    }
  }

  private async enforceUniqueName(
    tenantId: string,
    pipelineName: string,
  ): Promise<void> {
    const existing = await this.db
      .select({ id: cdcPipelines.id })
      .from(cdcPipelines)
      .where(
        and(
          eq(cdcPipelines.siteId, tenantId),
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
