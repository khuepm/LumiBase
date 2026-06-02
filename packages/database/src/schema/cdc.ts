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

/**
 * CDC (Change Data Capture) pipeline tables. Stores pipeline configurations,
 * health metrics history, and deployment records for real-time PostgreSQL
 * to ClickHouse replication.
 */

const id = () => text('id').$defaultFn(() => nanoid()).primaryKey();
const createdAt = () => timestamp('created_at').defaultNow().notNull();
const updatedAt = () => timestamp('updated_at').defaultNow().notNull();

export const cdcPipelines = pgTable(
  'cdc_pipelines',
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
  'cdc_pipeline_health',
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
  'cdc_deployments',
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
