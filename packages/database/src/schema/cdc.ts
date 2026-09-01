import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { sites } from './core';
import { webhooks } from './platform';

/**
 * CDC (Change Data Capture) pipeline tables. Stores pipeline configurations,
 * health metrics history, and deployment records for real-time PostgreSQL
 * to ClickHouse replication.
 */

const id = () => text('id').$defaultFn(() => nanoid()).primaryKey();
const createdAt = () => timestamp('created_at').defaultNow().notNull();
const updatedAt = () => timestamp('updated_at').defaultNow().notNull();

export const cdcPipelines = pgTable(
  'lumibase_cdc_pipelines',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    pipelineName: text('pipeline_name').notNull(),
    /** 'debezium_kafka' | 'materialized_engine' | 'airbyte' */
    connectorType: text('connector_type').notNull(),
    /** 'active' | 'paused' | 'error' | 'provisioning' */
    status: text('status').default('provisioning').notNull(),
    statusMessage: text('status_message'),
    /** Encrypted source database connection string. */
    sourceConnection: text('source_connection').notNull(),
    /** Encrypted ClickHouse sink connection string. */
    sinkConnection: text('sink_connection').notNull(),
    /** Encrypted intermediary connection (Kafka broker or Airbyte URL). */
    intermediaryConnection: text('intermediary_connection'),
    replicationTables: jsonb('replication_tables').default([]).notNull(),
    /** Approach-specific configuration. */
    config: jsonb('config').default({}).notNull(),
    lastSyncAt: timestamp('last_sync_at'),
    lastSyncRecordCount: integer('last_sync_record_count'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    siteNameUnique: uniqueIndex('cdc_pipelines_site_name_unique').on(
      t.siteId,
      t.pipelineName,
    ),
    siteStatusIdx: index('cdc_pipelines_site_status_idx').on(t.siteId, t.status),
  }),
);

export const cdcPipelineHealth = pgTable(
  'lumibase_cdc_pipeline_health',
  {
    id: id(),
    pipelineId: text('pipeline_id')
      .notNull()
      .references(() => cdcPipelines.id, { onDelete: 'cascade' }),
    replicationLagMs: integer('replication_lag_ms').notNull(),
    eventsPerSecond: integer('events_per_second').notNull(),
    errorCount: integer('error_count').default(0).notNull(),
    recordedAt: timestamp('recorded_at').defaultNow().notNull(),
  },
  (t) => ({
    pipelineTimeIdx: index('cdc_health_pipeline_time_idx').on(
      t.pipelineId,
      t.recordedAt,
    ),
  }),
);

export const cdcDeployments = pgTable(
  'lumibase_cdc_deployments',
  {
    id: id(),
    pipelineId: text('pipeline_id').references(() => cdcPipelines.id, {
      onDelete: 'set null',
    }),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    approach: text('approach').notNull(),
    /** 'docker_compose' | 'cloudflare_workers' */
    target: text('target').notNull(),
    /** 'pending' | 'running' | 'completed' | 'failed' | 'rolled_back' */
    status: text('status').default('pending').notNull(),
    /** DeploymentStep[] */
    steps: jsonb('steps').default([]).notNull(),
    envConfig: jsonb('env_config').default({}).notNull(),
    errorMessage: text('error_message'),
    createdAt: createdAt(),
    completedAt: timestamp('completed_at'),
  },
  (t) => ({
    siteIdx: index('cdc_deployments_site_idx').on(t.siteId, t.status),
  }),
);

/*
 * ── Change Feed (spec: .kiro/specs/cdc-extension-integration) ───────────────
 *
 * First-party transactional outbox + relay over content mutations. Distinct
 * from the ClickHouse control-plane tables above.
 *
 * ID/cursor convention: PKs are nanoid text (matching `audit_log` and every
 * regulated/audit-grade table — see the note in `regulated.ts`; the codebase
 * deliberately carries no uuidv7 dependency). Feed ordering therefore comes
 * from the composite keyset `(occurred_at, id)` — `occurred_at` is stamped by
 * Postgres `now()` (one clock), with `id` as a deterministic tie-breaker —
 * not from the id itself. Cursors are opaque tokens encoding that pair
 * (`encodeCdcCursor` in `@lumibase/contracts/schemas`).
 */

/**
 * `lumibase_cdc_change_events` — append-only outbox. One row per committed
 * item mutation when the feed is enabled for the site. Never UPDATEd; only
 * retention pruning deletes. `payload` is the post-mutation snapshot with
 * pii/phi fields masked BEFORE insert (Req 1.4); NULL for deletes and for
 * reference-mode-only sites.
 */
export const cdcChangeEvents = pgTable(
  'lumibase_cdc_change_events',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /**
     * Resource kind the event describes: 'item' (default — content rows),
     * 'collection'/'field' (schema changes), or 'setting'. Drives the envelope
     * `type` prefix (`items.*`, `collections.*`, `fields.*`, `settings.*`).
     * Defaults to 'item' so rows written before this column read correctly.
     */
    resource: text('resource').default('item').notNull(),
    collection: text('collection').notNull(),
    itemId: text('item_id').notNull(),
    /** 'create' | 'update' | 'delete' */
    operation: text('operation').notNull(),
    /** Masked post-mutation snapshot; NULL on delete. */
    payload: jsonb('payload'),
    /** string[] of changed field names (update only). */
    changedFields: jsonb('changed_fields'),
    schemaVersion: integer('schema_version').default(1).notNull(),
    /** 'user' | 'api_key' | 'agent' | 'system' */
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    /** 'api' | 'agent' | 'flow' | 'system' */
    source: text('source').notNull(),
    /** Keyset major key — DB clock, not app clock. */
    occurredAt: timestamp('occurred_at').defaultNow().notNull(),
  },
  (t) => ({
    siteCursorIdx: index('cdc_change_events_site_cursor_idx').on(
      t.siteId,
      t.occurredAt,
      t.id,
    ),
    siteCollectionCursorIdx: index('cdc_change_events_site_collection_cursor_idx').on(
      t.siteId,
      t.collection,
      t.occurredAt,
      t.id,
    ),
  }),
);

/**
 * `lumibase_cdc_subscriptions` — consumer registry + checkpoint. The cursor
 * pair points at the LAST successfully delivered/acked event; NULL means
 * "start from the head at creation time". State machine per design §3.2:
 * active ⇄ paused; active → dead (10 consecutive failures);
 * active/paused → stale (cursor pruned past); dead/stale → active only via
 * explicit replay/resume.
 */
export const cdcSubscriptions = pgTable(
  'lumibase_cdc_subscriptions',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** 'pull' | 'webhook' | 'extension' */
    kind: text('kind').notNull(),
    /** string[] collection filter; [] = all. */
    collections: jsonb('collections').default([]).notNull(),
    /** string[] operation filter; [] = all. */
    operations: jsonb('operations').default([]).notNull(),
    /** 'reference' | 'snapshot' */
    payloadMode: text('payload_mode').default('reference').notNull(),
    cursorOccurredAt: timestamp('cursor_occurred_at'),
    cursorId: text('cursor_id'),
    /** 'active' | 'paused' | 'dead' | 'stale' */
    status: text('status').default('active').notNull(),
    webhookId: text('webhook_id').references(() => webhooks.id, {
      onDelete: 'set null',
    }),
    extensionName: text('extension_name'),
    consecutiveFailures: integer('consecutive_failures').default(0).notNull(),
    lastDeliveredAt: timestamp('last_delivered_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    siteNameUnique: uniqueIndex('cdc_subscriptions_site_name_unique').on(
      t.siteId,
      t.name,
    ),
    siteStatusIdx: index('cdc_subscriptions_site_status_idx').on(
      t.siteId,
      t.status,
    ),
  }),
);

/**
 * `lumibase_cdc_deliveries` — append-only delivery-attempt log (one row per
 * batch attempt). `errorMessage` is masked before insert. Pruned on the same
 * retention policy as the outbox.
 */
export const cdcDeliveries = pgTable(
  'lumibase_cdc_deliveries',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    subscriptionId: text('subscription_id')
      .notNull()
      .references(() => cdcSubscriptions.id, { onDelete: 'cascade' }),
    eventIdFrom: text('event_id_from'),
    eventIdTo: text('event_id_to'),
    eventCount: integer('event_count').default(0).notNull(),
    attempt: integer('attempt').default(1).notNull(),
    /** 'success' | 'failed' */
    status: text('status').notNull(),
    httpStatus: integer('http_status'),
    /** Masked — never raw provider/consumer output. */
    errorMessage: text('error_message'),
    durationMs: integer('duration_ms').default(0).notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    siteSubTimeIdx: index('cdc_deliveries_site_sub_time_idx').on(
      t.siteId,
      t.subscriptionId,
      t.createdAt,
    ),
  }),
);
