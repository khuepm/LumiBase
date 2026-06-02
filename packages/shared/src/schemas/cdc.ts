import { z } from 'zod';

/**
 * CDC Zod validation schemas.
 *
 * These schemas validate pipeline configuration payloads, sync schedules,
 * monitor settings, and environment variable definitions for the ClickHouse
 * CDC system.
 */

export const CdcConnectorTypeSchema = z.enum([
  'debezium_kafka',
  'materialized_engine',
  'airbyte',
]);

export const PipelineCreateSchema = z.object({
  pipeline_name: z.string().min(1).max(128),
  cdc_connector_type: CdcConnectorTypeSchema,
  source_database_connection: z.string().min(1),
  clickhouse_sink_connection: z.string().min(1),
  replication_tables: z.array(z.string().min(1)).min(1),
  intermediary_connection: z.string().optional(),
  config: z.record(z.unknown()).optional(),
});

export const SyncScheduleSchema = z.object({
  interval_seconds: z.number().int().min(300).max(86400), // 5 min to 24 hours
  sync_mode: z.enum(['full_refresh', 'incremental_cdc']),
});

export const MonitorConfigSchema = z.object({
  lag_threshold_ms: z.number().int().min(10_000).max(3_600_000).default(60_000),
  emit_interval_ms: z.number().int().default(30_000),
  retention_days: z.number().int().min(1).default(7),
});

export const EnvVarSchema = z.object({
  key: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
  value: z.string(),
  required: z.boolean().default(true),
});

/** Inferred types for convenience */
export type CdcConnectorType = z.infer<typeof CdcConnectorTypeSchema>;
export type PipelineCreateInput = z.infer<typeof PipelineCreateSchema>;
export type SyncSchedule = z.infer<typeof SyncScheduleSchema>;
export type MonitorConfig = z.infer<typeof MonitorConfigSchema>;
export type EnvVar = z.infer<typeof EnvVarSchema>;
