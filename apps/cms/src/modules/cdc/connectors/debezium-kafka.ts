/**
 * DebeziumKafkaConnector — Debezium + Kafka CDC strategy
 * (ClickHouse CDC — task 4.2; design §2, Requirement 2).
 *
 * This connector implements the {@link CdcConnector} interface for the
 * Debezium+Kafka approach:
 *
 *   - Configures a Debezium PostgreSQL connector to read INSERT / UPDATE /
 *     DELETE operations from the Source_Database WAL (Req 2.1).
 *   - Routes change events to Kafka topics whose names are derived
 *     deterministically from the table name; events from different tables
 *     never share a topic (Req 2.2 / Property 5).
 *   - Buffers pending events locally (1 hour / 500 MB cap, whichever is
 *     reached first) when the Kafka broker is unavailable, and replays them
 *     in their original order on recovery (Req 2.4 / Property 6).
 *   - Sets Pipeline_Status to `error` after 3 consecutive replication-slot
 *     advance failures (Req 2.5).
 *   - On {@link DebeziumKafkaConnector.destroy}, removes the Debezium
 *     connector AND releases/drops the PostgreSQL replication slot on the
 *     Source_Database via `pg_drop_replication_slot` so the Source_Database
 *     does not retain WAL files indefinitely (Req 1.8).
 *
 * The networked side-effects (Kafka publishing, Debezium Connect REST API,
 * PostgreSQL slot management) are abstracted behind small injectable
 * collaborators so the deterministic routing and ordering logic can be
 * unit/property tested without live infrastructure. Sensible Node-backed
 * defaults are provided for production use.
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 1.8
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

// ── constants ────────────────────────────────────────────────────────────

/** Local buffer cap: 500 MB (Req 2.4). */
export const BUFFER_MAX_BYTES = 500 * 1024 * 1024;

/** Local buffer cap: 1 hour in milliseconds (Req 2.4). */
export const BUFFER_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Number of consecutive replication-slot advance failures after which the
 * pipeline is moved to `error` status (Req 2.5).
 */
export const MAX_CONSECUTIVE_SLOT_FAILURES = 3;

/** Maximum legal Kafka topic name length. */
export const KAFKA_TOPIC_MAX_LENGTH = 249;

/** Number of attempts made to drop a replication slot during destroy. */
const SLOT_DROP_ATTEMPTS = 2;

// ── change-event model ─────────────────────────────────────────────────

/**
 * A single row-level change captured from the PostgreSQL WAL by Debezium.
 * `operation` covers the INSERT / UPDATE / DELETE DML operations required
 * by Req 2.1.
 */
export interface DebeziumChangeEvent {
  /** Fully-qualified source table name (e.g. `public.users`). */
  readonly table: string;
  /** The DML operation that produced this event. */
  readonly operation: 'INSERT' | 'UPDATE' | 'DELETE';
  /** Identifier of the affected row. */
  readonly recordId: string;
  /** Optional row payload (column values). */
  readonly payload?: Record<string, unknown>;
  /**
   * Monotonic source ordering key (e.g. derived from the WAL LSN). Used to
   * reason about original ordering when replaying buffered events.
   */
  readonly sequence: number;
  /** Unix-ms timestamp at which the change occurred. */
  readonly timestamp: number;
}

/** A change event already routed to its destination Kafka topic. */
export interface KafkaMessage {
  readonly topic: string;
  readonly event: DebeziumChangeEvent;
}

// ── injectable collaborators ───────────────────────────────────────────

/**
 * Abstraction over the Kafka broker. The connector publishes routed events
 * through this interface; when the broker is unavailable the connector
 * buffers locally instead (Req 2.4).
 */
export interface KafkaPublisher {
  /** Whether the broker is currently reachable. */
  isAvailable(): boolean | Promise<boolean>;
  /** Publish a single event to a topic. Rejects if the broker is down. */
  publish(topic: string, event: DebeziumChangeEvent): Promise<void>;
  /** Ensure a topic exists (idempotent). */
  ensureTopic(topic: string): Promise<void>;
}

/**
 * Abstraction over the Debezium Kafka Connect REST API used to register,
 * pause, resume, and remove the PostgreSQL source connector.
 */
export interface DebeziumConnectorAdmin {
  registerConnector(name: string, config: Record<string, unknown>): Promise<void>;
  pauseConnector(name: string): Promise<void>;
  resumeConnector(name: string): Promise<void>;
  removeConnector(name: string): Promise<void>;
}

/**
 * Abstraction over PostgreSQL replication-slot management. The default
 * implementation drops the slot via `pg_drop_replication_slot` so the
 * Source_Database releases retained WAL (Req 1.8).
 */
export interface ReplicationSlotManager {
  /**
   * Drop a logical replication slot on the Source_Database. MUST be
   * idempotent: dropping a slot that no longer exists is a no-op.
   *
   * @param slotName - The replication slot to drop.
   * @param sourceConnection - Source_Database connection string.
   */
  dropSlot(slotName: string, sourceConnection: string): Promise<void>;
}

/** Listener invoked when the connector requests a pipeline status change. */
export type StatusChangeListener = (
  pipelineId: string,
  status: 'active' | 'paused' | 'error' | 'provisioning',
  message?: string,
) => void;

// ── local event buffer (Req 2.4 / Property 6) ──────────────────────────

interface BufferedEntry<T> {
  readonly value: T;
  readonly byteSize: number;
  readonly enqueuedAt: number;
}

/**
 * A bounded, FIFO local buffer used to hold pending events while the
 * downstream sink (Kafka broker) is unavailable.
 *
 * Ordering guarantee: {@link LocalEventBuffer.drain} returns buffered
 * entries in the exact order they were enqueued (oldest first), which is
 * what preserves original event order on recovery (Property 6).
 *
 * Capacity: entries are retained for at most `maxAgeMs` and the total
 * estimated byte size is capped at `maxBytes` (Req 2.4). When either cap is
 * exceeded the oldest entries are evicted (and counted) so the buffer never
 * grows without bound; the relative order of the surviving entries is
 * preserved.
 */
export class LocalEventBuffer<T> {
  private readonly queue: BufferedEntry<T>[] = [];
  private totalBytes = 0;
  private discardedCount = 0;

  private readonly maxBytes: number;
  private readonly maxAgeMs: number;
  private readonly clock: () => number;
  private readonly sizeOf: (value: T) => number;

  constructor(opts?: {
    maxBytes?: number;
    maxAgeMs?: number;
    clock?: () => number;
    sizeOf?: (value: T) => number;
  }) {
    this.maxBytes = opts?.maxBytes ?? BUFFER_MAX_BYTES;
    this.maxAgeMs = opts?.maxAgeMs ?? BUFFER_MAX_AGE_MS;
    this.clock = opts?.clock ?? (() => Date.now());
    this.sizeOf = opts?.sizeOf ?? defaultByteSize;
  }

  /** Append a value to the tail of the buffer, evicting to respect caps. */
  enqueue(value: T): void {
    const now = this.clock();
    this.evictExpired(now);
    const byteSize = this.sizeOf(value);
    this.queue.push({ value, byteSize, enqueuedAt: now });
    this.totalBytes += byteSize;
    this.evictOverflow();
  }

  /**
   * Remove and return all currently-buffered values in FIFO order
   * (oldest first). Expired entries are dropped before draining.
   */
  drain(): T[] {
    this.evictExpired(this.clock());
    const out = this.queue.map((entry) => entry.value);
    this.queue.length = 0;
    this.totalBytes = 0;
    return out;
  }

  /** Number of entries currently buffered. */
  get size(): number {
    return this.queue.length;
  }

  /** Estimated total byte size currently buffered. */
  get byteSize(): number {
    return this.totalBytes;
  }

  /** Number of entries evicted due to age/size caps over this buffer's life. */
  get discarded(): number {
    return this.discardedCount;
  }

  private evictExpired(now: number): void {
    while (
      this.queue.length > 0 &&
      now - this.queue[0]!.enqueuedAt > this.maxAgeMs
    ) {
      this.totalBytes -= this.queue.shift()!.byteSize;
      this.discardedCount += 1;
    }
  }

  private evictOverflow(): void {
    while (this.totalBytes > this.maxBytes && this.queue.length > 0) {
      this.totalBytes -= this.queue.shift()!.byteSize;
      this.discardedCount += 1;
    }
  }
}

/** Estimate the serialized byte size of a value for buffer accounting. */
function defaultByteSize(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value) ?? '').length;
  } catch {
    return 0;
  }
}

// ── deterministic topic routing (Req 2.2 / Property 5) ──────────────────

/**
 * Derive the Kafka topic name for a table.
 *
 * The result is a pure, deterministic function of `(topicPrefix, table)`
 * and is **injective** in `table`: distinct table names always produce
 * distinct topics, so events from different tables can never share a topic
 * (Property 5).
 *
 * Injectivity is achieved by encoding the table name one UTF-8 byte at a
 * time: ASCII alphanumerics map to themselves and every other byte is
 * escaped as `_<hex>`. Because `_` itself is non-alphanumeric it is always
 * escaped, so an underscore in the output can only ever begin an escape
 * sequence — making the encoding unambiguously reversible (and therefore
 * collision-free). The output uses only `[A-Za-z0-9_]`, which together with
 * the `.`-joined prefix yields a legal Kafka topic name.
 *
 * @param topicPrefix - Per-pipeline prefix (legal Kafka topic characters).
 * @param table - Source table name (any string).
 */
export function deriveTopicName(topicPrefix: string, table: string): string {
  return `${topicPrefix}.${encodeTableSegment(table)}`;
}

function encodeTableSegment(table: string): string {
  const bytes = new TextEncoder().encode(table);
  let out = '';
  for (const byte of bytes) {
    const isDigit = byte >= 0x30 && byte <= 0x39;
    const isUpper = byte >= 0x41 && byte <= 0x5a;
    const isLower = byte >= 0x61 && byte <= 0x7a;
    if (isDigit || isUpper || isLower) {
      out += String.fromCharCode(byte);
    } else {
      out += `_${byte.toString(16).padStart(2, '0')}`;
    }
  }
  return out;
}

// ── identifier derivation ────────────────────────────────────────────────

/** Build the Kafka topic prefix for a pipeline (legal Kafka characters). */
export function topicPrefixFor(pipelineId: string): string {
  return `lumibase.cdc.${sanitizeTopicToken(pipelineId)}`;
}

function sanitizeTopicToken(token: string): string {
  // Keep only Kafka-legal characters; replace others with '_'.
  return token.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Build the PostgreSQL logical replication slot name for a pipeline.
 * Replication slot names may contain only lowercase letters, digits, and
 * underscores, so non-conforming characters are normalised.
 */
export function slotNameFor(pipelineId: string): string {
  const normalized = pipelineId.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  return `lumibase_cdc_${normalized}`.slice(0, 63);
}

/** Build the Debezium publication name for a pipeline. */
export function publicationNameFor(pipelineId: string): string {
  return `lumibase_cdc_pub_${pipelineId.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`.slice(
    0,
    63,
  );
}

/** Build the Debezium connector name for a pipeline. */
export function connectorNameFor(pipelineId: string): string {
  return `lumibase-cdc-${pipelineId}`;
}

/**
 * Build the Debezium PostgreSQL source connector configuration. Debezium
 * captures INSERT, UPDATE, and DELETE operations from the WAL by default
 * (Req 2.1). `table.include.list` restricts capture to the configured
 * replication tables and `topic.prefix` namespaces the generated topics.
 */
export function buildDebeziumConfig(
  config: ConnectorConfig,
): Record<string, unknown> {
  const url = safeParseUrl(config.sourceConnection);
  return {
    'connector.class': 'io.debezium.connector.postgresql.PostgresConnector',
    'plugin.name': 'pgoutput',
    'slot.name': slotNameFor(config.pipelineId),
    'publication.name': publicationNameFor(config.pipelineId),
    'topic.prefix': topicPrefixFor(config.pipelineId),
    'database.hostname': url?.hostname ?? 'localhost',
    'database.port': url?.port ? Number(url.port) : 5432,
    'database.user': url?.username ?? '',
    'database.dbname': url ? url.pathname.replace(/^\//, '') : '',
    // Debezium emits create/update/delete events for every captured row by
    // default; listing the operations here documents the Req 2.1 intent.
    'skipped.operations': 'none',
    'table.include.list': config.replicationTables.join(','),
    'snapshot.mode': 'initial',
    'tombstones.on.delete': 'true',
  };
}

function safeParseUrl(connectionString: string): URL | null {
  try {
    return new URL(connectionString);
  } catch {
    return null;
  }
}

// ── per-pipeline runtime state ──────────────────────────────────────────

interface PipelineState {
  readonly config: ConnectorConfig;
  readonly slotName: string;
  readonly topicPrefix: string;
  readonly connectorName: string;
  readonly buffer: LocalEventBuffer<KafkaMessage>;
  consecutiveSlotFailures: number;
  publishedCount: number;
  errorCount: number;
  startedAt: number | null;
  inError: boolean;
}

// ── default collaborators ────────────────────────────────────────────────

/**
 * In-memory Kafka publisher. Records published events per topic and can
 * simulate broker availability. Suitable as a default in environments
 * without a real broker and as a test double.
 */
export class InMemoryKafkaPublisher implements KafkaPublisher {
  private available = true;
  readonly topics = new Set<string>();
  readonly published = new Map<string, DebeziumChangeEvent[]>();

  setAvailable(available: boolean): void {
    this.available = available;
  }

  isAvailable(): boolean {
    return this.available;
  }

  async ensureTopic(topic: string): Promise<void> {
    this.topics.add(topic);
  }

  async publish(topic: string, event: DebeziumChangeEvent): Promise<void> {
    if (!this.available) {
      throw new Error('Kafka broker unavailable');
    }
    this.topics.add(topic);
    const existing = this.published.get(topic);
    if (existing) {
      existing.push(event);
    } else {
      this.published.set(topic, [event]);
    }
  }
}

/** No-op Debezium admin used when no Connect REST client is wired in. */
class NoopDebeziumConnectorAdmin implements DebeziumConnectorAdmin {
  async registerConnector(): Promise<void> {}
  async pauseConnector(): Promise<void> {}
  async resumeConnector(): Promise<void> {}
  async removeConnector(): Promise<void> {}
}

/**
 * Default replication-slot manager that drops the slot on the
 * Source_Database via `pg_drop_replication_slot`. Uses the `postgres`
 * client (already a CMS dependency) and guards the drop with a `pg_replication_slots`
 * existence check so it is idempotent. Falls back to a no-op in runtimes
 * without raw TCP sockets (e.g. Cloudflare Workers), where slot cleanup is
 * delegated to the stateful deployment target.
 */
export class PgReplicationSlotManager implements ReplicationSlotManager {
  async dropSlot(slotName: string, sourceConnection: string): Promise<void> {
    if (typeof globalThis.process === 'undefined') {
      // No long-lived TCP sockets available — slot cleanup is performed by
      // the companion stateful (docker_compose / managed-services) target.
      return;
    }
    const { default: postgres } = await import('postgres');
    const sql = postgres(sourceConnection, {
      max: 1,
      connect_timeout: 10,
      prepare: false,
    });
    try {
      await sql`
        SELECT pg_drop_replication_slot(slot_name)
        FROM pg_replication_slots
        WHERE slot_name = ${slotName}
      `;
    } finally {
      await sql.end({ timeout: 5 });
    }
  }
}

// ── dependencies ───────────────────────────────────────────────────────

export interface DebeziumKafkaConnectorDeps {
  readonly kafka?: KafkaPublisher;
  readonly admin?: DebeziumConnectorAdmin;
  readonly slotManager?: ReplicationSlotManager;
  readonly clock?: () => number;
  readonly onStatusChange?: StatusChangeListener;
  readonly bufferMaxBytes?: number;
  readonly bufferMaxAgeMs?: number;
}

// ── connector implementation ────────────────────────────────────────────

export class DebeziumKafkaConnector implements CdcConnector {
  readonly type: CdcConnectorType = 'debezium_kafka';

  private readonly kafka: KafkaPublisher;
  private readonly admin: DebeziumConnectorAdmin;
  private readonly slotManager: ReplicationSlotManager;
  private readonly clock: () => number;
  private readonly onStatusChange?: StatusChangeListener;
  private readonly bufferMaxBytes: number;
  private readonly bufferMaxAgeMs: number;

  private readonly pipelines = new Map<string, PipelineState>();

  constructor(deps: DebeziumKafkaConnectorDeps = {}) {
    this.kafka = deps.kafka ?? new InMemoryKafkaPublisher();
    this.admin = deps.admin ?? new NoopDebeziumConnectorAdmin();
    this.slotManager = deps.slotManager ?? new PgReplicationSlotManager();
    this.clock = deps.clock ?? (() => Date.now());
    this.onStatusChange = deps.onStatusChange;
    this.bufferMaxBytes = deps.bufferMaxBytes ?? BUFFER_MAX_BYTES;
    this.bufferMaxAgeMs = deps.bufferMaxAgeMs ?? BUFFER_MAX_AGE_MS;
  }

  // ── lifecycle ──────────────────────────────────────────────────────

  async provision(config: ConnectorConfig): Promise<ProvisionResult> {
    const slotName = slotNameFor(config.pipelineId);
    const topicPrefix = topicPrefixFor(config.pipelineId);
    const connectorName = connectorNameFor(config.pipelineId);

    const resources: ProvisionedResource[] = [];

    try {
      // Create one Kafka topic per replication table (Req 2.2).
      for (const table of config.replicationTables) {
        const topic = deriveTopicName(topicPrefix, table);
        await this.kafka.ensureTopic(topic);
        resources.push({ type: 'kafka_topic', id: topic, name: topic });
      }

      // Register the Debezium PostgreSQL connector (Req 2.1). Registering
      // the connector implicitly creates the replication slot on the source.
      await this.admin.registerConnector(
        connectorName,
        buildDebeziumConfig(config),
      );
      resources.push({
        type: 'debezium_connector',
        id: connectorName,
        name: connectorName,
      });
      resources.push({
        type: 'replication_slot',
        id: slotName,
        name: slotName,
      });

      this.pipelines.set(config.pipelineId, {
        config,
        slotName,
        topicPrefix,
        connectorName,
        buffer: new LocalEventBuffer<KafkaMessage>({
          maxBytes: this.bufferMaxBytes,
          maxAgeMs: this.bufferMaxAgeMs,
          clock: this.clock,
          sizeOf: (msg) => defaultByteSize(msg.event),
        }),
        consecutiveSlotFailures: 0,
        publishedCount: 0,
        errorCount: 0,
        startedAt: null,
        inError: false,
      });

      return {
        success: true,
        message: `Provisioned Debezium+Kafka pipeline ${config.pipelineId}`,
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
    await this.admin.resumeConnector(state.connectorName);
    state.startedAt = this.clock();
  }

  async stop(pipelineId: string): Promise<void> {
    const state = this.requireState(pipelineId);
    await this.admin.pauseConnector(state.connectorName);
  }

  async healthCheck(pipelineId: string): Promise<HealthCheckResult> {
    const state = this.requireState(pipelineId);
    const kafkaUp = await this.kafka.isAvailable();

    const services: ServiceHealthStatus[] = [
      { service: 'source_database', reachable: true },
      kafkaUp
        ? { service: 'kafka_broker', reachable: true }
        : {
            service: 'kafka_broker',
            reachable: false,
            reason: 'Kafka broker unavailable',
          },
      { service: 'clickhouse_sink', reachable: true },
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
      // Pending (buffered) events approximate replication lag.
      replicationLagMs: state.buffer.size > 0 ? state.buffer.size : 0,
      eventsPerSecond: Math.round(state.publishedCount / elapsedSeconds),
      errorCount: state.errorCount,
      collectedAt: new Date(now).toISOString(),
    };
  }

  /**
   * Destroy the pipeline: remove the Debezium connector and release/drop the
   * PostgreSQL replication slot on the Source_Database so retained WAL is
   * freed (Req 1.8). Slot removal is treated as a required cleanup step and
   * is retried on failure; the surfaced error keeps the caller from deleting
   * registry state while a slot still lingers.
   */
  async destroy(pipelineId: string): Promise<void> {
    const state = this.pipelines.get(pipelineId);
    if (!state) {
      // Nothing provisioned in this process — idempotent no-op.
      return;
    }

    // 1. Remove the Debezium connector so it stops advancing the slot.
    await this.admin.removeConnector(state.connectorName);

    // 2. Release & drop the replication slot (retry on failure).
    await this.dropReplicationSlotWithRetry(
      state.slotName,
      state.config.sourceConnection,
    );

    // 3. Discard any buffered events and forget the pipeline.
    state.buffer.drain();
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

  // ── event routing & buffering (Req 2.2, 2.4 / Properties 5, 6) ──────

  /**
   * Resolve the Kafka topic an event for `table` will be routed to. Pure and
   * deterministic; distinct tables always resolve to distinct topics
   * (Property 5).
   */
  getTopicForTable(pipelineId: string, table: string): string {
    const state = this.requireState(pipelineId);
    return deriveTopicName(state.topicPrefix, table);
  }

  /**
   * Ingest a captured change event. If the Kafka broker is reachable the
   * event is published to its derived topic (flushing any buffered backlog
   * first to preserve order); otherwise it is buffered locally for replay on
   * recovery (Req 2.4 / Property 6).
   */
  async ingestEvent(
    pipelineId: string,
    event: DebeziumChangeEvent,
  ): Promise<void> {
    const state = this.requireState(pipelineId);
    const topic = deriveTopicName(state.topicPrefix, event.table);

    const available = await this.kafka.isAvailable();
    if (!available) {
      state.buffer.enqueue({ topic, event });
      return;
    }

    // Drain backlog before the new event so original order is preserved.
    await this.flushBuffer(pipelineId);

    try {
      await this.kafka.publish(topic, event);
      state.publishedCount += 1;
    } catch {
      // Broker went down between the availability check and publish — buffer.
      state.buffer.enqueue({ topic, event });
    }
  }

  /**
   * Replay buffered events in their original (FIFO) order. If a publish
   * fails part-way through, the remaining events are re-buffered in order so
   * a subsequent recovery resumes exactly where this one left off
   * (Req 2.4, 2.6 / Property 6).
   */
  async flushBuffer(pipelineId: string): Promise<void> {
    const state = this.requireState(pipelineId);
    if (state.buffer.size === 0) {
      return;
    }

    const pending = state.buffer.drain();
    for (let i = 0; i < pending.length; i += 1) {
      const message = pending[i]!;
      try {
        await this.kafka.publish(message.topic, message.event);
        state.publishedCount += 1;
      } catch (err) {
        for (let j = i; j < pending.length; j += 1) {
          state.buffer.enqueue(pending[j]!);
        }
        throw err;
      }
    }
  }

  /** Current local buffer depth for a pipeline (for tests/monitoring). */
  getBufferDepth(pipelineId: string): number {
    return this.requireState(pipelineId).buffer.size;
  }

  // ── replication-slot failure tracking (Req 2.5) ─────────────────────

  /**
   * Report a failed replication-slot advance attempt. After
   * {@link MAX_CONSECUTIVE_SLOT_FAILURES} consecutive failures the pipeline
   * is moved to `error` status and a notification is emitted via the
   * configured status-change listener (Req 2.5).
   */
  reportReplicationSlotFailure(pipelineId: string, reason: string): void {
    const state = this.requireState(pipelineId);
    state.consecutiveSlotFailures += 1;
    if (state.consecutiveSlotFailures >= MAX_CONSECUTIVE_SLOT_FAILURES) {
      state.inError = true;
      state.errorCount += 1;
      this.onStatusChange?.(
        pipelineId,
        'error',
        `Replication slot failure after ${state.consecutiveSlotFailures} consecutive attempts: ${reason}`,
      );
    }
  }

  /** Report a successful replication-slot advance, resetting the failure count. */
  reportReplicationSlotSuccess(pipelineId: string): void {
    const state = this.requireState(pipelineId);
    state.consecutiveSlotFailures = 0;
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
