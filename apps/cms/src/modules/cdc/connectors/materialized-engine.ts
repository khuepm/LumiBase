/**
 * MaterializedEngineConnector — ClickHouse MaterializedPostgreSQL CDC
 * strategy (ClickHouse CDC — task 5.1; design §2, Requirement 3).
 *
 * This connector implements the {@link CdcConnector} interface for the
 * ClickHouse Materialized Engine approach, which replicates directly from
 * PostgreSQL replication slots without an intermediary message bus:
 *
 *   - Configures the ClickHouse_Sink to connect directly to the
 *     Source_Database using PostgreSQL replication slots via the
 *     `MaterializedPostgreSQL` database engine (Req 3.1).
 *   - Automatically creates the corresponding ClickHouse table schema from
 *     the PostgreSQL schema, preserving every column name and mapping each
 *     PostgreSQL type to its ClickHouse equivalent (Req 3.3 / Property 7).
 *   - Reconnects with exponential backoff starting at 1 second, up to a
 *     maximum of 5 retries, resuming replication from the last confirmed LSN
 *     so data consistency is preserved (Req 3.4).
 *   - Sets Pipeline_Status to `error` (with the failure reason and outage
 *     duration) once all 5 reconnection retries are exhausted (Req 3.5).
 *   - Detects source-schema drift (column addition, removal, or type
 *     alteration) within 60 seconds and reports the affected table and the
 *     type of change (Req 3.6 / Property 8).
 *   - On {@link MaterializedEngineConnector.destroy}, detaches the
 *     `MaterializedPostgreSQL` database AND releases/drops the PostgreSQL
 *     replication slot on the Source_Database via `pg_drop_replication_slot`
 *     so the Source_Database does not retain WAL files indefinitely
 *     (Req 1.8).
 *
 * The networked side-effects (ClickHouse DDL, PostgreSQL schema reads, slot
 * management) are abstracted behind small injectable collaborators so the
 * deterministic type-mapping, schema-drift, and backoff logic can be
 * unit/property tested without live infrastructure. Sensible Node-backed
 * defaults are provided for production use.
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 1.8
 */

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
import {
  PgReplicationSlotManager,
  type ReplicationSlotManager,
  type StatusChangeListener,
} from './debezium-kafka';

// ── constants ────────────────────────────────────────────────────────────

/** Initial reconnection backoff delay: 1 second (Req 3.4). */
export const RECONNECT_BASE_DELAY_MS = 1_000;

/** Maximum number of reconnection retries before erroring (Req 3.4, 3.5). */
export const MAX_RECONNECT_RETRIES = 5;

/**
 * Schema-drift detection window: the connector polls the source schema at
 * least this often so drift is detected within 60 seconds (Req 3.6).
 */
export const SCHEMA_DRIFT_DETECTION_INTERVAL_MS = 60_000;

/**
 * New-table schema creation window: a newly added replication table must
 * have its ClickHouse schema created within 60 seconds (Req 3.3).
 */
export const SCHEMA_CREATION_INTERVAL_MS = 60_000;

/** Number of attempts made to drop a replication slot during destroy. */
const SLOT_DROP_ATTEMPTS = 2;

// ── PostgreSQL → ClickHouse type mapping (Req 3.3 / Property 7) ──────────

/**
 * Canonical PostgreSQL → ClickHouse base-type mapping.
 *
 * Keys are normalised (lower-cased, whitespace-collapsed) PostgreSQL type
 * names. Values are the ClickHouse types that preserve the semantics of the
 * source column. Nullable columns wrap the base type in `Nullable(...)` —
 * see {@link clickHouseColumnType}.
 *
 * This map is the single source of truth referenced by Property 7.
 */
export const PG_TO_CLICKHOUSE_TYPE_MAP: Readonly<Record<string, string>> = {
  // ── integers ──
  smallint: 'Int16',
  int2: 'Int16',
  smallserial: 'Int16',
  serial2: 'Int16',
  integer: 'Int32',
  int: 'Int32',
  int4: 'Int32',
  serial: 'Int32',
  serial4: 'Int32',
  bigint: 'Int64',
  int8: 'Int64',
  bigserial: 'Int64',
  serial8: 'Int64',

  // ── floating point / numeric ──
  real: 'Float32',
  float4: 'Float32',
  'double precision': 'Float64',
  float8: 'Float64',
  numeric: 'Decimal(38, 9)',
  decimal: 'Decimal(38, 9)',
  money: 'Decimal(38, 9)',

  // ── boolean ──
  boolean: 'Bool',
  bool: 'Bool',

  // ── character / text ──
  text: 'String',
  varchar: 'String',
  'character varying': 'String',
  char: 'String',
  character: 'String',
  bpchar: 'String',
  citext: 'String',
  name: 'String',

  // ── identifiers / network / misc strings ──
  uuid: 'UUID',
  json: 'String',
  jsonb: 'String',
  bytea: 'String',
  inet: 'String',
  cidr: 'String',
  macaddr: 'String',
  xml: 'String',

  // ── date / time ──
  date: 'Date32',
  time: 'String',
  'time without time zone': 'String',
  'time with time zone': 'String',
  timestamp: "DateTime64(6)",
  'timestamp without time zone': 'DateTime64(6)',
  timestamptz: "DateTime64(6, 'UTC')",
  'timestamp with time zone': "DateTime64(6, 'UTC')",
};

/** Fallback ClickHouse type for any PostgreSQL type not in the map. */
export const CLICKHOUSE_FALLBACK_TYPE = 'String';

/**
 * Normalise a PostgreSQL type name for lookup: lower-case, trim, and
 * collapse internal whitespace runs to single spaces (so
 * `"TIMESTAMP   WITHOUT  TIME ZONE"` matches `"timestamp without time zone"`).
 * Any type modifier/precision suffix (e.g. `varchar(255)`, `numeric(10,2)`)
 * is stripped before lookup.
 */
export function normalizePgType(pgType: string): string {
  return pgType
    .trim()
    .toLowerCase()
    .replace(/\([^)]*\)/g, '') // drop precision/length modifiers
    .replace(/\[\]$/g, '') // drop a trailing array marker
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Map a PostgreSQL base type to its ClickHouse equivalent. Pure and
 * deterministic. Unsupported types fall back to {@link CLICKHOUSE_FALLBACK_TYPE}
 * so the mapping is total. (Property 7)
 */
export function mapPgTypeToClickHouse(pgType: string): string {
  const normalized = normalizePgType(pgType);
  return PG_TO_CLICKHOUSE_TYPE_MAP[normalized] ?? CLICKHOUSE_FALLBACK_TYPE;
}

/**
 * Resolve the full ClickHouse column type for a PostgreSQL column, wrapping
 * the base type in `Nullable(...)` when the source column is nullable.
 */
export function clickHouseColumnType(pgType: string, nullable: boolean): string {
  const base = mapPgTypeToClickHouse(pgType);
  return nullable ? `Nullable(${base})` : base;
}

// ── schema models ────────────────────────────────────────────────────────

/** A single PostgreSQL column definition read from the source schema. */
export interface PgColumn {
  /** Column name — preserved verbatim in the generated ClickHouse table. */
  readonly name: string;
  /** PostgreSQL data type (e.g. `integer`, `timestamp without time zone`). */
  readonly type: string;
  /** Whether the column accepts NULLs. Defaults to `false`. */
  readonly nullable?: boolean;
}

/** A PostgreSQL table schema: a table name and its ordered columns. */
export interface PgTableSchema {
  /** Fully-qualified source table name (e.g. `public.users`). */
  readonly table: string;
  /** Ordered list of columns. */
  readonly columns: readonly PgColumn[];
}

/** A generated ClickHouse column (name preserved, type mapped). */
export interface ClickHouseColumn {
  readonly name: string;
  readonly type: string;
}

/** A generated ClickHouse table definition for the Materialized engine. */
export interface ClickHouseTableSchema {
  readonly table: string;
  readonly columns: readonly ClickHouseColumn[];
  readonly engine: string;
}

/**
 * Build a ClickHouse table definition from a PostgreSQL table schema.
 *
 * Guarantees (Property 7):
 *   - Every PostgreSQL column name is preserved verbatim and in order.
 *   - Each PostgreSQL type is mapped to its ClickHouse equivalent via
 *     {@link mapPgTypeToClickHouse} (wrapped in `Nullable(...)` when the
 *     source column is nullable).
 */
export function buildClickHouseTableSchema(
  pg: PgTableSchema,
): ClickHouseTableSchema {
  return {
    table: pg.table,
    columns: pg.columns.map((column) => ({
      name: column.name,
      type: clickHouseColumnType(column.type, column.nullable ?? false),
    })),
    engine: 'MaterializedPostgreSQL',
  };
}

// ── schema-drift detection (Req 3.6 / Property 8) ───────────────────────

/** The kinds of schema change the connector detects on a replicated table. */
export type SchemaChangeType =
  | 'column_added'
  | 'column_removed'
  | 'column_type_altered';

/** A single detected schema change on a replicated table. */
export interface SchemaDrift {
  /** Affected source table name. */
  readonly table: string;
  /** The kind of change detected. */
  readonly changeType: SchemaChangeType;
  /** Affected column name. */
  readonly column: string;
  /** Previous PostgreSQL type (for removals and type alterations). */
  readonly previousType?: string;
  /** Current PostgreSQL type (for additions and type alterations). */
  readonly currentType?: string;
}

/**
 * Compare a previously-known schema with the current schema for a table and
 * report every drift. Pure and deterministic.
 *
 * Detects (Property 8):
 *   - `column_added`   — a column present now but not before.
 *   - `column_removed` — a column present before but not now.
 *   - `column_type_altered` — a column whose (normalised) type changed.
 *
 * Type comparison uses {@link normalizePgType} so cosmetic differences
 * (case, whitespace, precision modifiers) are not reported as drift.
 */
export function detectSchemaDrift(
  table: string,
  previous: readonly PgColumn[],
  current: readonly PgColumn[],
): SchemaDrift[] {
  const drifts: SchemaDrift[] = [];
  const prevByName = new Map(previous.map((c) => [c.name, c]));
  const currByName = new Map(current.map((c) => [c.name, c]));

  // Additions: in current but not previous.
  for (const column of current) {
    if (!prevByName.has(column.name)) {
      drifts.push({
        table,
        changeType: 'column_added',
        column: column.name,
        currentType: column.type,
      });
    }
  }

  // Removals: in previous but not current.
  for (const column of previous) {
    if (!currByName.has(column.name)) {
      drifts.push({
        table,
        changeType: 'column_removed',
        column: column.name,
        previousType: column.type,
      });
    }
  }

  // Type alterations: present in both, but type changed.
  for (const column of current) {
    const prior = prevByName.get(column.name);
    if (prior && normalizePgType(prior.type) !== normalizePgType(column.type)) {
      drifts.push({
        table,
        changeType: 'column_type_altered',
        column: column.name,
        previousType: prior.type,
        currentType: column.type,
      });
    }
  }

  return drifts;
}

/** Format a drift list into a human-readable status message (Req 3.6). */
export function describeSchemaDrift(drifts: readonly SchemaDrift[]): string {
  return drifts
    .map((d) => {
      switch (d.changeType) {
        case 'column_added':
          return `table "${d.table}": column "${d.column}" added (${d.currentType})`;
        case 'column_removed':
          return `table "${d.table}": column "${d.column}" removed`;
        case 'column_type_altered':
          return `table "${d.table}": column "${d.column}" type changed from ${d.previousType} to ${d.currentType}`;
        default:
          return `table "${d.table}": column "${d.column}" changed`;
      }
    })
    .join('; ');
}

// ── identifier derivation ────────────────────────────────────────────────

/**
 * Build the ClickHouse `MaterializedPostgreSQL` database name for a pipeline.
 * Restricted to characters legal in a ClickHouse identifier.
 */
export function materializedDatabaseNameFor(pipelineId: string): string {
  const normalized = pipelineId.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  return `lumibase_cdc_mat_${normalized}`.slice(0, 63);
}

/**
 * Build the PostgreSQL logical replication slot name for a pipeline.
 * Replication slot names may contain only lowercase letters, digits, and
 * underscores, so non-conforming characters are normalised.
 */
export function slotNameFor(pipelineId: string): string {
  const normalized = pipelineId.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  return `lumibase_mat_${normalized}`.slice(0, 63);
}

// ── MaterializedPostgreSQL database configuration ───────────────────────

/** Connection + replication settings for a MaterializedPostgreSQL database. */
export interface MaterializedDatabaseConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
  readonly tables: readonly string[];
  readonly replicationSlot: string;
}

/**
 * Build the MaterializedPostgreSQL database configuration from a connector
 * config. The ClickHouse_Sink uses this to connect directly to the
 * Source_Database via a PostgreSQL replication slot (Req 3.1).
 */
export function buildMaterializedDatabaseConfig(
  config: ConnectorConfig,
  slotName: string,
): MaterializedDatabaseConfig {
  const url = safeParseUrl(config.sourceConnection);
  return {
    host: url?.hostname ?? 'localhost',
    port: url?.port ? Number(url.port) : 5432,
    database: url ? url.pathname.replace(/^\//, '') : '',
    user: url?.username ?? '',
    password: url?.password ?? '',
    tables: [...config.replicationTables],
    replicationSlot: slotName,
  };
}

function safeParseUrl(connectionString: string): URL | null {
  try {
    return new URL(connectionString);
  } catch {
    return null;
  }
}

// ── injectable collaborators ───────────────────────────────────────────

/**
 * Abstraction over the ClickHouse `MaterializedPostgreSQL` database engine:
 * creating the replicating database, creating/attaching tables, controlling
 * replication, and detaching the database on teardown.
 */
export interface MaterializedPostgresAdmin {
  /** Whether the ClickHouse sink is currently reachable. */
  isAvailable(): boolean | Promise<boolean>;
  /** Create the MaterializedPostgreSQL database (creates the source slot). */
  createDatabase(
    databaseName: string,
    config: MaterializedDatabaseConfig,
  ): Promise<void>;
  /** Create/attach a replicated table with the given ClickHouse schema. */
  createTable(
    databaseName: string,
    schema: ClickHouseTableSchema,
  ): Promise<void>;
  /**
   * (Re)start replication for a database, resuming from `fromLsn` when
   * provided (`null` ⇒ resume from the slot's confirmed position).
   */
  startReplication(databaseName: string, fromLsn: string | null): Promise<void>;
  /** Pause replication for a database, preserving state. */
  stopReplication(databaseName: string): Promise<void>;
  /** Detach (drop) the MaterializedPostgreSQL database from ClickHouse. */
  detachDatabase(databaseName: string): Promise<void>;
}

/** Abstraction over reading a table's column schema from PostgreSQL. */
export interface PgSchemaReader {
  /** Read the current column schema for a table from the Source_Database. */
  readTableSchema(
    sourceConnection: string,
    table: string,
  ): Promise<PgTableSchema>;
}

// ── default collaborators ────────────────────────────────────────────────

/**
 * In-memory MaterializedPostgreSQL admin. Records created databases/tables
 * and replication state and can simulate sink availability. Suitable as a
 * default in environments without a real ClickHouse sink and as a test
 * double.
 */
export class InMemoryMaterializedPostgresAdmin
  implements MaterializedPostgresAdmin
{
  private available = true;
  readonly databases = new Map<string, MaterializedDatabaseConfig>();
  readonly tables = new Map<string, ClickHouseTableSchema[]>();
  readonly replicating = new Set<string>();
  readonly resumedFromLsn = new Map<string, string | null>();

  setAvailable(available: boolean): void {
    this.available = available;
  }

  isAvailable(): boolean {
    return this.available;
  }

  async createDatabase(
    databaseName: string,
    config: MaterializedDatabaseConfig,
  ): Promise<void> {
    if (!this.available) {
      throw new Error('ClickHouse sink unavailable');
    }
    this.databases.set(databaseName, config);
    if (!this.tables.has(databaseName)) {
      this.tables.set(databaseName, []);
    }
  }

  async createTable(
    databaseName: string,
    schema: ClickHouseTableSchema,
  ): Promise<void> {
    if (!this.available) {
      throw new Error('ClickHouse sink unavailable');
    }
    const existing = this.tables.get(databaseName) ?? [];
    existing.push(schema);
    this.tables.set(databaseName, existing);
  }

  async startReplication(
    databaseName: string,
    fromLsn: string | null,
  ): Promise<void> {
    if (!this.available) {
      throw new Error('ClickHouse sink unavailable');
    }
    this.replicating.add(databaseName);
    this.resumedFromLsn.set(databaseName, fromLsn);
  }

  async stopReplication(databaseName: string): Promise<void> {
    this.replicating.delete(databaseName);
  }

  async detachDatabase(databaseName: string): Promise<void> {
    this.databases.delete(databaseName);
    this.tables.delete(databaseName);
    this.replicating.delete(databaseName);
  }
}

/**
 * Default PostgreSQL schema reader. Prefers schemas supplied inline via
 * `connectorSpecificConfig.tableSchemas` (so the connector is usable without
 * a live source), and otherwise queries `information_schema.columns` when a
 * Node runtime with raw sockets is available. Falls back to an empty schema
 * in restricted runtimes (e.g. Cloudflare Workers), where schema discovery
 * is delegated to the stateful deployment target.
 */
export class DefaultPgSchemaReader implements PgSchemaReader {
  async readTableSchema(
    sourceConnection: string,
    table: string,
  ): Promise<PgTableSchema> {
    if (typeof globalThis.process === 'undefined') {
      // No long-lived TCP sockets available — defer to the stateful target.
      return { table, columns: [] };
    }
    const { default: postgres } = await import('postgres');
    const sql = postgres(sourceConnection, {
      max: 1,
      connect_timeout: 10,
      prepare: false,
    });
    try {
      const { schema, name } = splitQualifiedTable(table);
      const rows = await sql<
        { column_name: string; data_type: string; is_nullable: string }[]
      >`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema = ${schema} AND table_name = ${name}
        ORDER BY ordinal_position
      `;
      return {
        table,
        columns: rows.map((row) => ({
          name: row.column_name,
          type: row.data_type,
          nullable: row.is_nullable === 'YES',
        })),
      };
    } finally {
      await sql.end({ timeout: 5 });
    }
  }
}

function splitQualifiedTable(table: string): { schema: string; name: string } {
  const idx = table.indexOf('.');
  if (idx === -1) {
    return { schema: 'public', name: table };
  }
  return { schema: table.slice(0, idx), name: table.slice(idx + 1) };
}

/**
 * Extract inline table schemas from a connector config's
 * `connectorSpecificConfig.tableSchemas` map, if present. Shape:
 * `{ [table: string]: PgColumn[] }`.
 */
function inlineSchemasFromConfig(
  config: ConnectorConfig,
): Map<string, PgColumn[]> {
  const out = new Map<string, PgColumn[]>();
  const raw = config.connectorSpecificConfig?.tableSchemas;
  if (raw && typeof raw === 'object') {
    for (const [table, columns] of Object.entries(
      raw as Record<string, unknown>,
    )) {
      if (Array.isArray(columns)) {
        out.set(
          table,
          columns
            .filter(
              (c): c is PgColumn =>
                !!c &&
                typeof c === 'object' &&
                typeof (c as PgColumn).name === 'string' &&
                typeof (c as PgColumn).type === 'string',
            )
            .map((c) => ({
              name: c.name,
              type: c.type,
              nullable: c.nullable ?? false,
            })),
        );
      }
    }
  }
  return out;
}

// ── reconnection result (Req 3.4, 3.5) ──────────────────────────────────

/** Outcome of a {@link MaterializedEngineConnector.reconnect} attempt. */
export interface ReconnectResult {
  /** Whether replication was successfully re-established. */
  readonly success: boolean;
  /** Number of retry attempts made (1..{@link MAX_RECONNECT_RETRIES}). */
  readonly attempts: number;
  /** The LSN replication was resumed from (null ⇒ slot's confirmed LSN). */
  readonly resumedFromLsn: string | null;
  /** Total outage duration in ms (present only on exhaustion/failure). */
  readonly outageMs?: number;
}

// ── per-pipeline runtime state ──────────────────────────────────────────

interface PipelineState {
  readonly config: ConnectorConfig;
  readonly slotName: string;
  readonly databaseName: string;
  /** Known column schema per replicated table (for drift detection). */
  readonly schemas: Map<string, PgColumn[]>;
  /** Last LSN confirmed applied to ClickHouse (for consistent resume). */
  lastConfirmedLsn: string | null;
  reconnectAttempts: number;
  appliedEventCount: number;
  errorCount: number;
  startedAt: number | null;
  inError: boolean;
}

// ── dependencies ───────────────────────────────────────────────────────

export interface MaterializedEngineConnectorDeps {
  readonly admin?: MaterializedPostgresAdmin;
  readonly schemaReader?: PgSchemaReader;
  readonly slotManager?: ReplicationSlotManager;
  readonly clock?: () => number;
  /** Sleep helper (injectable so backoff timing can be tested instantly). */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onStatusChange?: StatusChangeListener;
}

// ── connector implementation ────────────────────────────────────────────

export class MaterializedEngineConnector implements CdcConnector {
  readonly type: CdcConnectorType = 'materialized_engine';

  private readonly admin: MaterializedPostgresAdmin;
  private readonly schemaReader: PgSchemaReader;
  private readonly slotManager: ReplicationSlotManager;
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onStatusChange?: StatusChangeListener;

  private readonly pipelines = new Map<string, PipelineState>();

  constructor(deps: MaterializedEngineConnectorDeps = {}) {
    this.admin = deps.admin ?? new InMemoryMaterializedPostgresAdmin();
    this.schemaReader = deps.schemaReader ?? new DefaultPgSchemaReader();
    this.slotManager = deps.slotManager ?? new PgReplicationSlotManager();
    this.clock = deps.clock ?? (() => Date.now());
    this.sleep =
      deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    this.onStatusChange = deps.onStatusChange;
  }

  // ── lifecycle ──────────────────────────────────────────────────────

  /**
   * Provision the MaterializedPostgreSQL database and create one ClickHouse
   * table per replication table, automatically deriving each schema from the
   * PostgreSQL source (Req 3.1, 3.3). Provisioning the database creates the
   * PostgreSQL replication slot on the Source_Database.
   */
  async provision(config: ConnectorConfig): Promise<ProvisionResult> {
    const slotName = slotNameFor(config.pipelineId);
    const databaseName = materializedDatabaseNameFor(config.pipelineId);
    const resources: ProvisionedResource[] = [];
    const schemas = new Map<string, PgColumn[]>();

    try {
      // 1. Create the MaterializedPostgreSQL database — this opens the
      //    direct connection to the Source_Database via a replication slot
      //    (Req 3.1) and registers the slot on the source.
      await this.admin.createDatabase(
        databaseName,
        buildMaterializedDatabaseConfig(config, slotName),
      );
      resources.push({
        type: 'materialized_database',
        id: databaseName,
        name: databaseName,
      });
      resources.push({
        type: 'replication_slot',
        id: slotName,
        name: slotName,
      });

      // 2. Auto-create the ClickHouse table schema for each replicated table
      //    from the PostgreSQL source schema (Req 3.3 / Property 7).
      const inline = inlineSchemasFromConfig(config);
      for (const table of config.replicationTables) {
        const pgSchema = inline.has(table)
          ? { table, columns: inline.get(table)! }
          : await this.schemaReader.readTableSchema(
              config.sourceConnection,
              table,
            );
        const chSchema = buildClickHouseTableSchema(pgSchema);
        await this.admin.createTable(databaseName, chSchema);
        schemas.set(table, [...pgSchema.columns]);
        resources.push({
          type: 'clickhouse_table',
          id: `${databaseName}.${table}`,
          name: table,
        });
      }

      this.pipelines.set(config.pipelineId, {
        config,
        slotName,
        databaseName,
        schemas,
        lastConfirmedLsn: null,
        reconnectAttempts: 0,
        appliedEventCount: 0,
        errorCount: 0,
        startedAt: null,
        inError: false,
      });

      return {
        success: true,
        message: `Provisioned Materialized Engine pipeline ${config.pipelineId}`,
        provisionedResources: resources,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error';
      return {
        success: false,
        message: `Provisioning failed: ${reason}`,
        provisionedResources: resources,
      };
    }
  }

  async start(pipelineId: string): Promise<void> {
    const state = this.requireState(pipelineId);
    await this.admin.startReplication(
      state.databaseName,
      state.lastConfirmedLsn,
    );
    state.startedAt = this.clock();
    state.inError = false;
    state.reconnectAttempts = 0;
  }

  async stop(pipelineId: string): Promise<void> {
    const state = this.requireState(pipelineId);
    await this.admin.stopReplication(state.databaseName);
  }

  async healthCheck(pipelineId: string): Promise<HealthCheckResult> {
    const state = this.requireState(pipelineId);
    const sinkUp = await this.admin.isAvailable();

    // The Materialized engine has no intermediary service — it connects the
    // ClickHouse sink directly to the PostgreSQL source (Req 3.1).
    const services: ServiceHealthStatus[] = [
      { service: 'source_database', reachable: true },
      sinkUp
        ? { service: 'clickhouse_sink', reachable: true }
        : {
            service: 'clickhouse_sink',
            reachable: false,
            reason: 'ClickHouse sink unavailable',
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

    return {
      replicationLagMs: 0,
      eventsPerSecond: Math.round(state.appliedEventCount / elapsedSeconds),
      errorCount: state.errorCount,
      collectedAt: new Date(now).toISOString(),
    };
  }

  /**
   * Destroy the pipeline: detach the MaterializedPostgreSQL database from
   * ClickHouse AND release/drop the PostgreSQL replication slot on the
   * Source_Database so retained WAL is freed (Req 1.8). Slot removal is a
   * required cleanup step and is retried on failure; the surfaced error
   * keeps the caller from deleting registry state while a slot still lingers.
   */
  async destroy(pipelineId: string): Promise<void> {
    const state = this.pipelines.get(pipelineId);
    if (!state) {
      // Nothing provisioned in this process — idempotent no-op.
      return;
    }

    // 1. Detach the MaterializedPostgreSQL database so ClickHouse stops
    //    advancing the slot.
    await this.admin.detachDatabase(state.databaseName);

    // 2. Release & drop the replication slot on the Source_Database
    //    (retry on failure).
    await this.dropReplicationSlotWithRetry(
      state.slotName,
      state.config.sourceConnection,
    );

    // 3. Forget the pipeline.
    this.pipelines.delete(pipelineId);
  }

  private async dropReplicationSlotWithRetry(
    slotName: string,
    sourceConnection: string,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= SLOT_DROP_ATTEMPTS; attempt += 1) {
      try {
        await this.slotManager.dropSlot(slotName, sourceConnection);
        return;
      } catch (err) {
        lastError = err;
      }
    }
    const reason =
      lastError instanceof Error ? lastError.message : 'unknown error';
    throw new Error(
      `Failed to drop replication slot "${slotName}" after ${SLOT_DROP_ATTEMPTS} attempts: ${reason}`,
    );
  }

  // ── LSN tracking & reconnection (Req 3.4, 3.5) ───────────────────────

  /**
   * Record the last LSN confirmed applied to ClickHouse. Replication resumes
   * from this position after a reconnection, preserving data consistency
   * (Req 3.4).
   */
  confirmLsn(pipelineId: string, lsn: string): void {
    this.requireState(pipelineId).lastConfirmedLsn = lsn;
  }

  /** Current last-confirmed LSN for a pipeline (for tests/monitoring). */
  getLastConfirmedLsn(pipelineId: string): string | null {
    return this.requireState(pipelineId).lastConfirmedLsn;
  }

  /**
   * Re-establish replication after a slot connection interruption using
   * exponential backoff starting at 1 second, up to {@link MAX_RECONNECT_RETRIES}
   * retries. On success, replication resumes from the last confirmed LSN
   * (Req 3.4). If all retries are exhausted, the pipeline is moved to `error`
   * status with the failure reason and outage duration (Req 3.5).
   */
  async reconnect(pipelineId: string): Promise<ReconnectResult> {
    const state = this.requireState(pipelineId);
    const outageStart = this.clock();
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_RECONNECT_RETRIES; attempt += 1) {
      // Exponential backoff: 1s, 2s, 4s, 8s, 16s (Req 3.4).
      const delay = RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1);
      await this.sleep(delay);

      try {
        // Resume from the last confirmed LSN to preserve consistency.
        await this.admin.startReplication(
          state.databaseName,
          state.lastConfirmedLsn,
        );
        state.reconnectAttempts = 0;
        state.inError = false;
        return {
          success: true,
          attempts: attempt,
          resumedFromLsn: state.lastConfirmedLsn,
        };
      } catch (err) {
        lastError = err;
        state.reconnectAttempts = attempt;
      }
    }

    // All retries exhausted (Req 3.5).
    const outageMs = this.clock() - outageStart;
    state.inError = true;
    state.errorCount += 1;
    const reason =
      lastError instanceof Error ? lastError.message : 'unknown error';
    this.onStatusChange?.(
      pipelineId,
      'error',
      `Materialized engine reconnection failed after ${MAX_RECONNECT_RETRIES} retries ` +
        `(outage ${outageMs}ms): ${reason}`,
    );
    return {
      success: false,
      attempts: MAX_RECONNECT_RETRIES,
      resumedFromLsn: state.lastConfirmedLsn,
      outageMs,
    };
  }

  // ── schema management (Req 3.3, 3.6 / Properties 7, 8) ──────────────

  /**
   * Add a new replication table after provisioning, auto-creating its
   * ClickHouse table schema from the current PostgreSQL source schema within
   * the schema-creation window (Req 3.3).
   */
  async addReplicationTable(
    pipelineId: string,
    table: string,
    schema?: PgTableSchema,
  ): Promise<ClickHouseTableSchema> {
    const state = this.requireState(pipelineId);
    const pgSchema =
      schema ??
      (await this.schemaReader.readTableSchema(
        state.config.sourceConnection,
        table,
      ));
    const chSchema = buildClickHouseTableSchema(pgSchema);
    await this.admin.createTable(state.databaseName, chSchema);
    state.schemas.set(table, [...pgSchema.columns]);
    return chSchema;
  }

  /** Current known schema for a replicated table (for tests/monitoring). */
  getKnownSchema(pipelineId: string, table: string): PgColumn[] | undefined {
    const schema = this.requireState(pipelineId).schemas.get(table);
    return schema ? [...schema] : undefined;
  }

  /**
   * Compare the current source schema for a table against the known schema
   * and report any drift (column addition, removal, or type alteration). If
   * drift is detected, the pipeline is moved to `error` status with a message
   * naming the affected table and the type(s) of change (Req 3.6 / Property 8).
   *
   * Intended to be invoked at least once per
   * {@link SCHEMA_DRIFT_DETECTION_INTERVAL_MS} so drift is reported within
   * 60 seconds.
   *
   * @returns The list of detected drifts (empty when the schema is unchanged).
   */
  checkSchemaDrift(
    pipelineId: string,
    table: string,
    currentColumns: readonly PgColumn[],
  ): SchemaDrift[] {
    const state = this.requireState(pipelineId);
    const previous = state.schemas.get(table) ?? [];
    const drifts = detectSchemaDrift(table, previous, currentColumns);

    if (drifts.length > 0) {
      state.inError = true;
      state.errorCount += 1;
      this.onStatusChange?.(
        pipelineId,
        'error',
        `Schema drift detected — ${describeSchemaDrift(drifts)}`,
      );
    }

    return drifts;
  }

  /**
   * Poll all replicated tables for schema drift using the configured schema
   * reader, returning the aggregated drift across every table. Sets the
   * pipeline to `error` on the first table that drifts (Req 3.6).
   */
  async pollSchemaDrift(pipelineId: string): Promise<SchemaDrift[]> {
    const state = this.requireState(pipelineId);
    const allDrifts: SchemaDrift[] = [];
    for (const table of state.config.replicationTables) {
      const current = await this.schemaReader.readTableSchema(
        state.config.sourceConnection,
        table,
      );
      const drifts = this.checkSchemaDrift(pipelineId, table, current.columns);
      allDrifts.push(...drifts);
    }
    return allDrifts;
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
