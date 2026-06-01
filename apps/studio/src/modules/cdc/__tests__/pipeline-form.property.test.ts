import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

import {
  validatePipelineForm,
  PIPELINE_NAME_MAX_LENGTH,
  SYNC_INTERVAL_MIN_SECONDS,
  SYNC_INTERVAL_MAX_SECONDS,
  CDC_CONNECTOR_TYPES,
  SYNC_MODES,
  type PipelineFormValues,
  type PipelineFormField,
  type SyncMode,
} from '../pipeline-form';
import type { CdcConnectorType } from '../types';

/**
 * Feature: clickhouse-cdc, Property 16: Form validation preserves valid data
 *
 * For any pipeline wizard submission containing a mix of valid and invalid
 * fields, the validation response SHALL list errors only for invalid fields,
 * and the valid field values SHALL be preserved (not discarded or reset).
 *
 * The property is checked against an INDEPENDENT reference oracle
 * ({@link expectedInvalidFields}) that re-states the documented validation
 * rules without sharing branches with the implementation. We assert:
 *   (a) the set of error keys equals the oracle's set exactly — errors only
 *       for invalid fields, never for valid ones;
 *   (b) `result.values` is the same reference as the input and the input is
 *       not mutated — no user-entered data is discarded or reset;
 *   (c) `valid === (Object.keys(errors).length === 0)`.
 *
 * **Validates: Requirements 6.7**
 */

// ── Independent reference oracle ─────────────────────────────────────────────
//
// A re-statement of the documented field rules (pipeline-form.ts JSDoc /
// PipelineCreateSchema). Kept structurally separate from the implementation so
// it has genuine oracle value. References only the published contract
// CONSTANTS (lengths/bounds/enums), not the validator's control flow.

/** Non-empty after trimming whitespace (mirrors the documented "required"). */
function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

/** Whether the chosen approach requires an intermediary connection. */
function needsIntermediary(connectorType: PipelineFormValues['connectorType']): boolean {
  return connectorType === 'debezium_kafka' || connectorType === 'airbyte';
}

/** Whether the chosen approach exposes the Airbyte sync-schedule fields. */
function usesSchedule(connectorType: PipelineFormValues['connectorType']): boolean {
  return connectorType === 'airbyte';
}

/** Independently decide whether the raw sync interval is invalid. */
function syncIntervalInvalid(raw: string): boolean {
  if (isBlank(raw)) return true;
  if (!/^-?\d+$/.test(raw.trim())) return true;
  const seconds = Number.parseInt(raw.trim(), 10);
  return seconds < SYNC_INTERVAL_MIN_SECONDS || seconds > SYNC_INTERVAL_MAX_SECONDS;
}

/**
 * The exact set of fields that SHOULD be flagged as invalid for `values`,
 * derived independently from the documented rules.
 */
function expectedInvalidFields(values: PipelineFormValues): Set<PipelineFormField> {
  const invalid = new Set<PipelineFormField>();

  // pipeline_name — required, then length-bounded.
  if (isBlank(values.pipelineName)) {
    invalid.add('pipelineName');
  } else if (values.pipelineName.length > PIPELINE_NAME_MAX_LENGTH) {
    invalid.add('pipelineName');
  }

  // cdc_connector_type — must be a known approach.
  if (!CDC_CONNECTOR_TYPES.includes(values.connectorType as CdcConnectorType)) {
    invalid.add('connectorType');
  }

  // source / sink connection — required.
  if (isBlank(values.sourceConnection)) invalid.add('sourceConnection');
  if (isBlank(values.sinkConnection)) invalid.add('sinkConnection');

  // replication_tables — at least one non-blank entry.
  if (values.replicationTables.filter((t) => !isBlank(t)).length === 0) {
    invalid.add('replicationTables');
  }

  // intermediary_connection — required only for approaches that need it.
  if (needsIntermediary(values.connectorType) && isBlank(values.intermediaryConnection)) {
    invalid.add('intermediaryConnection');
  }

  // sync schedule — Airbyte only.
  if (usesSchedule(values.connectorType)) {
    if (syncIntervalInvalid(values.syncIntervalSeconds)) invalid.add('syncIntervalSeconds');
    if (!SYNC_MODES.includes(values.syncMode as SyncMode)) invalid.add('syncMode');
  }

  return invalid;
}

const ALL_FIELDS: readonly PipelineFormField[] = [
  'pipelineName',
  'connectorType',
  'sourceConnection',
  'sinkConnection',
  'replicationTables',
  'intermediaryConnection',
  'syncIntervalSeconds',
  'syncMode',
];

// ── Arbitraries ──────────────────────────────────────────────────────────────
//
// Each field arbitrary deliberately spans BOTH its valid and invalid input
// space so generated forms mix valid and invalid fields across every
// connector type (including the approach-specific Airbyte fields).

/** Guaranteed-non-blank text (a leading non-space token + arbitrary tail). */
const arbNonBlank: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom('a', 'x', 'public.users', 'postgres://h:5432/db', 'kafka://h:9092'),
    fc.string({ maxLength: 20 }),
  )
  .map(([head, tail]) => head + tail);

/** Whitespace-only / empty strings (always blank). */
const arbBlank: fc.Arbitrary<string> = fc.constantFrom('', ' ', '   ', '\t', '\n', ' \t\n ');

/** A field that is sometimes blank (invalid) and sometimes filled (valid). */
const arbMaybeBlank: fc.Arbitrary<string> = fc.oneof(arbNonBlank, arbBlank);

/** Pipeline name spanning valid, blank, boundary, and over-length cases. */
const arbPipelineName: fc.Arbitrary<string> = fc.oneof(
  arbNonBlank, // valid (short, non-blank)
  arbBlank, // invalid (required)
  fc.constant('a'.repeat(PIPELINE_NAME_MAX_LENGTH)), // valid boundary (== max)
  fc.integer({ min: PIPELINE_NAME_MAX_LENGTH + 1, max: 200 }).map((n) => 'a'.repeat(n)), // invalid (too long)
);

/** Connector type spanning the three valid approaches plus invalid values. */
const arbConnectorType: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom('debezium_kafka', 'materialized_engine', 'airbyte'),
  fc.constantFrom('', 'bogus', 'kafka', 'mysql'),
);

/** A single replication-table row (sometimes blank). */
const arbTableRow: fc.Arbitrary<string> = fc.oneof(arbNonBlank, arbBlank);

/** Replication tables: 0..4 rows; valid iff at least one is non-blank. */
const arbReplicationTables: fc.Arbitrary<string[]> = fc.array(arbTableRow, {
  minLength: 0,
  maxLength: 4,
});

/** Sync interval spanning in-range, out-of-range, non-integer, and blank. */
const arbSyncInterval: fc.Arbitrary<string> = fc.oneof(
  fc.integer({ min: SYNC_INTERVAL_MIN_SECONDS, max: SYNC_INTERVAL_MAX_SECONDS }).map(String), // valid
  fc.integer({ min: -100, max: SYNC_INTERVAL_MIN_SECONDS - 1 }).map(String), // too low
  fc.integer({ min: SYNC_INTERVAL_MAX_SECONDS + 1, max: 200_000 }).map(String), // too high
  fc.constantFrom('', '   ', 'abc', '12.5', '3e2', '  600  ', '300px'), // non-integer / blank / padded
);

/** Sync mode spanning the two valid modes plus invalid values. */
const arbSyncMode: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom('full_refresh', 'incremental_cdc'),
  fc.constantFrom('', 'cdc', 'bogus'),
);

/** A whole form with a mix of valid and invalid fields. */
const arbFormValues: fc.Arbitrary<PipelineFormValues> = fc.record({
  pipelineName: arbPipelineName,
  connectorType: arbConnectorType,
  sourceConnection: arbMaybeBlank,
  sinkConnection: arbMaybeBlank,
  replicationTables: arbReplicationTables,
  intermediaryConnection: arbMaybeBlank,
  syncIntervalSeconds: arbSyncInterval,
  syncMode: arbSyncMode,
}) as unknown as fc.Arbitrary<PipelineFormValues>;

// ── Property 16 ──────────────────────────────────────────────────────────────

describe('Feature: clickhouse-cdc, Property 16: Form validation preserves valid data', () => {
  it('(a) flags errors for exactly the invalid fields and never the valid ones', () => {
    fc.assert(
      fc.property(arbFormValues, (values) => {
        const { errors } = validatePipelineForm(values);
        const reported = new Set(Object.keys(errors) as PipelineFormField[]);
        const expected = expectedInvalidFields(values);

        // Exact set equality: only invalid fields appear, all of them appear.
        expect(reported).toEqual(expected);

        // Every reported error carries a non-empty, human-readable reason and
        // is keyed by a known form field.
        for (const field of reported) {
          expect(ALL_FIELDS).toContain(field);
          expect(typeof errors[field]).toBe('string');
          expect((errors[field] as string).length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('(b) preserves the user-entered values verbatim — same reference, no mutation', () => {
    fc.assert(
      fc.property(arbFormValues, (values) => {
        const before = structuredClone(values);
        const result = validatePipelineForm(values);

        // Returned values are the SAME object the caller passed in.
        expect(result.values).toBe(values);
        // ...and deep-equal a snapshot taken before validation (no mutation).
        expect(result.values).toEqual(before);
        expect(values).toEqual(before);
      }),
      { numRuns: 200 },
    );
  });

  it('(c) valid is true iff there are no field errors', () => {
    fc.assert(
      fc.property(arbFormValues, (values) => {
        const result = validatePipelineForm(values);
        expect(result.valid).toBe(Object.keys(result.errors).length === 0);
        // And cross-check against the independent oracle.
        expect(result.valid).toBe(expectedInvalidFields(values).size === 0);
      }),
      { numRuns: 200 },
    );
  });
});
