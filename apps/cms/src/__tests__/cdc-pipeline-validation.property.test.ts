import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  PipelineCreateSchema,
  SyncScheduleSchema,
  CdcConnectorTypeSchema,
} from '@lumibase/contracts';

/**
 * Feature: clickhouse-cdc, Property 1: Pipeline registration round-trip
 *
 * For any valid pipeline configuration (all required fields populated,
 * name 1–128 characters, valid connector type, non-empty replication_tables),
 * submitting it to PipelineCreateSchema SHALL parse successfully and the
 * parsed result SHALL contain all submitted fields.
 *
 * **Validates: Requirements 1.1**
 */

/**
 * Feature: clickhouse-cdc, Property 2: Validation completeness for missing fields
 *
 * For any non-empty subset of required pipeline fields that is omitted from
 * a submission, PipelineCreateSchema SHALL reject the request and the error
 * response SHALL list exactly the names of the omitted fields — no more,
 * no fewer.
 *
 * **Validates: Requirements 1.3**
 */

/**
 * Feature: clickhouse-cdc, Property 9: Sync schedule interval validation
 *
 * For any integer interval value, SyncScheduleSchema SHALL accept it if and
 * only if it falls within [300, 86400] seconds. Values outside this range
 * SHALL be rejected with a validation error.
 *
 * **Validates: Requirements 4.3, 4.7**
 */

// ── Arbitraries ─────────────────────────────────────────────────────────

const CONNECTOR_TYPES = ['debezium_kafka', 'materialized_engine', 'airbyte'] as const;

/** Generates a valid connector type. */
const arbConnectorType = fc.constantFrom(...CONNECTOR_TYPES);

/** Generates a valid pipeline name (1–128 non-empty characters). */
const arbPipelineName = fc.string({ minLength: 1, maxLength: 128 }).filter((s) => s.trim().length > 0);

/** Generates a non-empty connection string. */
const arbConnectionString = fc.string({ minLength: 1, maxLength: 256 }).filter((s) => s.length >= 1);

/** Generates a non-empty array of non-empty table names. */
const arbReplicationTables = fc.array(
  fc.string({ minLength: 1, maxLength: 64 }).filter((s) => s.length >= 1),
  { minLength: 1, maxLength: 10 },
);

/** Generates a complete valid pipeline config. */
const arbValidPipelineConfig = fc.record({
  pipeline_name: arbPipelineName,
  cdc_connector_type: arbConnectorType,
  source_database_connection: arbConnectionString,
  clickhouse_sink_connection: arbConnectionString,
  replication_tables: arbReplicationTables,
});

// ── Required fields for Property 2 ─────────────────────────────────────

const REQUIRED_FIELDS = [
  'pipeline_name',
  'cdc_connector_type',
  'source_database_connection',
  'clickhouse_sink_connection',
  'replication_tables',
] as const;

type RequiredField = (typeof REQUIRED_FIELDS)[number];

/**
 * Generates a non-empty subset of required fields to omit.
 * Uses a boolean mask and filters to ensure at least one field is omitted.
 */
const arbFieldSubsetToOmit = fc
  .tuple(
    fc.boolean(),
    fc.boolean(),
    fc.boolean(),
    fc.boolean(),
    fc.boolean(),
  )
  .filter((mask) => mask.some(Boolean))
  .map((mask) => REQUIRED_FIELDS.filter((_, i) => mask[i]));

// ── Tests ───────────────────────────────────────────────────────────────

describe('Feature: clickhouse-cdc, Property 1: Pipeline registration round-trip', () => {
  it('valid configs with all required fields parse successfully and preserve all fields', () => {
    fc.assert(
      fc.property(arbValidPipelineConfig, (config) => {
        const result = PipelineCreateSchema.safeParse(config);

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.pipeline_name).toBe(config.pipeline_name);
          expect(result.data.cdc_connector_type).toBe(config.cdc_connector_type);
          expect(result.data.source_database_connection).toBe(config.source_database_connection);
          expect(result.data.clickhouse_sink_connection).toBe(config.clickhouse_sink_connection);
          expect(result.data.replication_tables).toEqual(config.replication_tables);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('parsed result connector type is always one of the three valid types', () => {
    fc.assert(
      fc.property(arbValidPipelineConfig, (config) => {
        const result = PipelineCreateSchema.safeParse(config);
        expect(result.success).toBe(true);
        if (result.success) {
          const validTypes = CdcConnectorTypeSchema.options;
          expect(validTypes).toContain(result.data.cdc_connector_type);
        }
      }),
      { numRuns: 100 },
    );
  });
});

describe('Feature: clickhouse-cdc, Property 2: Validation completeness for missing fields', () => {
  it('omitted subsets of required fields produce errors listing exactly those fields', () => {
    fc.assert(
      fc.property(
        arbValidPipelineConfig,
        arbFieldSubsetToOmit,
        (validConfig, fieldsToOmit) => {
          // Build a config with the specified fields removed
          const incompleteConfig: Record<string, unknown> = { ...validConfig };
          for (const field of fieldsToOmit) {
            delete incompleteConfig[field];
          }

          const result = PipelineCreateSchema.safeParse(incompleteConfig);

          // Must fail
          expect(result.success).toBe(false);

          if (!result.success) {
            // Extract the field paths from the Zod error
            const errorFieldPaths = result.error.issues.map((issue) => issue.path[0] as string);
            const uniqueErrorFields = [...new Set(errorFieldPaths)];

            // The error should list exactly the omitted fields
            const omittedSet = new Set(fieldsToOmit);
            const errorSet = new Set(uniqueErrorFields);

            // Every omitted field must appear in the error
            for (const field of fieldsToOmit) {
              expect(errorSet.has(field)).toBe(true);
            }

            // No extra fields should appear in the error
            for (const field of uniqueErrorFields) {
              expect(omittedSet.has(field as RequiredField)).toBe(true);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('a single missing field produces exactly one error for that field', () => {
    fc.assert(
      fc.property(
        arbValidPipelineConfig,
        fc.constantFrom(...REQUIRED_FIELDS),
        (validConfig, fieldToOmit) => {
          const incompleteConfig: Record<string, unknown> = { ...validConfig };
          delete incompleteConfig[fieldToOmit];

          const result = PipelineCreateSchema.safeParse(incompleteConfig);

          expect(result.success).toBe(false);
          if (!result.success) {
            const errorFieldPaths = result.error.issues.map((issue) => issue.path[0] as string);
            const uniqueErrorFields = [...new Set(errorFieldPaths)];

            expect(uniqueErrorFields).toHaveLength(1);
            expect(uniqueErrorFields[0]).toBe(fieldToOmit);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('Feature: clickhouse-cdc, Property 9: Sync schedule interval validation', () => {
  it('values in [300, 86400] are accepted by SyncScheduleSchema', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 300, max: 86400 }),
        fc.constantFrom('full_refresh', 'incremental_cdc'),
        (interval, syncMode) => {
          const result = SyncScheduleSchema.safeParse({
            interval_seconds: interval,
            sync_mode: syncMode,
          });

          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.data.interval_seconds).toBe(interval);
            expect(result.data.sync_mode).toBe(syncMode);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('values below 300 are rejected by SyncScheduleSchema', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000, max: 299 }),
        fc.constantFrom('full_refresh', 'incremental_cdc'),
        (interval, syncMode) => {
          const result = SyncScheduleSchema.safeParse({
            interval_seconds: interval,
            sync_mode: syncMode,
          });

          expect(result.success).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('values above 86400 are rejected by SyncScheduleSchema', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 86401, max: 1_000_000 }),
        fc.constantFrom('full_refresh', 'incremental_cdc'),
        (interval, syncMode) => {
          const result = SyncScheduleSchema.safeParse({
            interval_seconds: interval,
            sync_mode: syncMode,
          });

          expect(result.success).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('non-integer values are rejected by SyncScheduleSchema', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 300.01, max: 86399.99, noNaN: true, noDefaultInfinity: true })
          .filter((n) => !Number.isInteger(n)),
        fc.constantFrom('full_refresh', 'incremental_cdc'),
        (interval, syncMode) => {
          const result = SyncScheduleSchema.safeParse({
            interval_seconds: interval,
            sync_mode: syncMode,
          });

          expect(result.success).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('boundary values 300 and 86400 are accepted', () => {
    const lower = SyncScheduleSchema.safeParse({
      interval_seconds: 300,
      sync_mode: 'full_refresh',
    });
    expect(lower.success).toBe(true);

    const upper = SyncScheduleSchema.safeParse({
      interval_seconds: 86400,
      sync_mode: 'incremental_cdc',
    });
    expect(upper.success).toBe(true);
  });

  it('boundary values 299 and 86401 are rejected', () => {
    const belowLower = SyncScheduleSchema.safeParse({
      interval_seconds: 299,
      sync_mode: 'full_refresh',
    });
    expect(belowLower.success).toBe(false);

    const aboveUpper = SyncScheduleSchema.safeParse({
      interval_seconds: 86401,
      sync_mode: 'incremental_cdc',
    });
    expect(aboveUpper.success).toBe(false);
  });
});
