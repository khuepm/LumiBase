/**
 * Pure validation logic for the CDC Pipeline creation wizard
 * (ClickHouse CDC — task 13.3; design "Studio CDC Panel" §6, Requirement
 * 6.7). This module is intentionally **React-free** so it can be unit- and
 * property-tested in isolation (task 13.4 / Property 16 exercises
 * {@link validatePipelineForm} without rendering any component).
 *
 * The constraints mirror the server-side contract in
 * `packages/contracts/src/schemas/cdc.ts` (`PipelineCreateSchema`,
 * `SyncScheduleSchema`) so the wizard rejects the same inputs the API would,
 * and surfaces field-level messages BEFORE a round-trip.
 *
 * ── Requirement 6.7 (the key behaviour) ──────────────────────────────────
 *
 *   "IF the pipeline creation wizard is submitted with invalid or incomplete
 *    configuration, THEN the Studio_CDC_Panel SHALL display field-level
 *    validation errors indicating which fields failed validation and the
 *    reason for each failure, WITHOUT discarding the user-entered data."
 *
 * To guarantee the "without discarding" half, {@link validatePipelineForm} is
 * a pure function that NEVER mutates or resets its input. It returns:
 *   - `errors`: a map keyed ONLY by the fields that failed, each with a
 *     human-readable reason; valid fields never appear here;
 *   - `values`: the caller's values, preserved verbatim (same reference
 *     contents), so the form can re-render with everything the user typed
 *     still in place;
 *   - `valid`: `true` iff `errors` is empty.
 *
 * This is exactly what Property 16 checks: for any mix of valid/invalid
 * fields, errors appear only for the invalid ones and the valid values are
 * preserved.
 *
 * Validates: Requirements 6.7 (also mirrors 1.3, 4.7 constraints)
 */

import type { CdcConnectorType } from './types';

// ── constraints (mirror packages/contracts/src/schemas/cdc.ts) ───────────────

/** Maximum pipeline name length (Req 1.7 / PipelineCreateSchema). */
export const PIPELINE_NAME_MAX_LENGTH = 128;

/** Minimum Airbyte sync interval, in seconds (5 minutes — SyncScheduleSchema). */
export const SYNC_INTERVAL_MIN_SECONDS = 300;

/** Maximum Airbyte sync interval, in seconds (24 hours — SyncScheduleSchema). */
export const SYNC_INTERVAL_MAX_SECONDS = 86_400;

/** The three valid connector types (Req 1.2). */
export const CDC_CONNECTOR_TYPES: readonly CdcConnectorType[] = [
  'debezium_kafka',
  'materialized_engine',
  'airbyte',
];

/** The two valid Airbyte sync modes (Req 4.2). */
export const SYNC_MODES = ['full_refresh', 'incremental_cdc'] as const;
export type SyncMode = (typeof SYNC_MODES)[number];

// ── form value shape ──────────────────────────────────────────────────────

/**
 * The raw values held by the wizard form. Text inputs are kept as strings
 * (including `syncIntervalSeconds`, which the user types) so the validator
 * sees exactly what the user entered — preserving it verbatim is what
 * Requirement 6.7 demands.
 *
 * `connectorType` may be the empty string before the user picks an approach;
 * `replicationTables` is an array of row strings as edited in the UI.
 */
export interface PipelineFormValues {
  /** Machine/display name for the pipeline. */
  readonly pipelineName: string;
  /** Selected connector approach, or `''` before a choice is made. */
  readonly connectorType: CdcConnectorType | '';
  /** PostgreSQL source connection string (write-only secret). */
  readonly sourceConnection: string;
  /** ClickHouse sink connection string (write-only secret). */
  readonly sinkConnection: string;
  /** Tables to replicate; one entry per UI row. */
  readonly replicationTables: readonly string[];
  /**
   * Intermediary connection — Kafka broker URL (debezium_kafka) or Airbyte
   * API base URL (airbyte). Unused for materialized_engine.
   */
  readonly intermediaryConnection: string;
  /** Airbyte sync interval (seconds), as typed. Only used for `airbyte`. */
  readonly syncIntervalSeconds: string;
  /** Airbyte sync mode. Only used for `airbyte`. */
  readonly syncMode: SyncMode | '';
}

/** Every validatable field name in the wizard form. */
export type PipelineFormField = keyof PipelineFormValues;

/** Map of field → human-readable error reason. Only invalid fields appear. */
export type PipelineFormErrors = Partial<Record<PipelineFormField, string>>;

/**
 * Result of {@link validatePipelineForm}: the per-field errors, the preserved
 * input values, and a convenience `valid` flag.
 */
export interface PipelineFormValidationResult {
  /** Errors keyed by field; empty when the form is valid. */
  readonly errors: PipelineFormErrors;
  /** The caller's values, returned untouched so the UI never loses input. */
  readonly values: PipelineFormValues;
  /** `true` iff there are no field errors. */
  readonly valid: boolean;
}

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Whether a connector approach requires an intermediary connection string.
 * Debezium needs a Kafka broker URL and Airbyte needs an API base URL;
 * the Materialized Engine connects directly to the source (no intermediary).
 */
export function requiresIntermediaryConnection(
  connectorType: CdcConnectorType | '',
): boolean {
  return connectorType === 'debezium_kafka' || connectorType === 'airbyte';
}

/** Whether a connector approach exposes sync-schedule fields (Airbyte only). */
export function usesSyncSchedule(
  connectorType: CdcConnectorType | '',
): boolean {
  return connectorType === 'airbyte';
}

/** Non-empty after trimming whitespace. */
function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

// ── default values ──────────────────────────────────────────────────────────

/**
 * A blank form. Useful as the wizard's initial state and as a base for tests
 * that override only the fields under examination.
 */
export function emptyPipelineForm(): PipelineFormValues {
  return {
    pipelineName: '',
    connectorType: '',
    sourceConnection: '',
    sinkConnection: '',
    replicationTables: [''],
    intermediaryConnection: '',
    syncIntervalSeconds: '',
    syncMode: '',
  };
}

// ── validator ───────────────────────────────────────────────────────────────

/**
 * Validate a wizard submission, returning per-field errors WITHOUT discarding
 * any user input (Req 6.7).
 *
 * Validation rules (mirroring the server `PipelineCreateSchema` /
 * `SyncScheduleSchema`):
 *   - `pipelineName` — required, ≤ {@link PIPELINE_NAME_MAX_LENGTH} chars;
 *   - `connectorType` — must be one of {@link CDC_CONNECTOR_TYPES};
 *   - `sourceConnection` / `sinkConnection` — required (non-blank);
 *   - `replicationTables` — at least one non-blank table name;
 *   - `intermediaryConnection` — required iff the approach needs one
 *     ({@link requiresIntermediaryConnection}); ignored otherwise;
 *   - `syncIntervalSeconds` — for Airbyte only: an integer within
 *     [{@link SYNC_INTERVAL_MIN_SECONDS}, {@link SYNC_INTERVAL_MAX_SECONDS}];
 *   - `syncMode` — for Airbyte only: one of {@link SYNC_MODES}.
 *
 * Fields that are not relevant to the chosen approach are never flagged, so a
 * valid Materialized-Engine form is not penalised for an empty Kafka URL.
 *
 * @param values - The current form values.
 * @returns `{ errors, values, valid }` — errors only for invalid fields, the
 *   original `values` preserved, and `valid` set when there are no errors.
 */
export function validatePipelineForm(
  values: PipelineFormValues,
): PipelineFormValidationResult {
  const errors: PipelineFormErrors = {};

  // pipeline_name — required, length-bounded.
  if (isBlank(values.pipelineName)) {
    errors.pipelineName = 'Pipeline name is required.';
  } else if (values.pipelineName.length > PIPELINE_NAME_MAX_LENGTH) {
    errors.pipelineName = `Pipeline name must be ${PIPELINE_NAME_MAX_LENGTH} characters or fewer.`;
  }

  // cdc_connector_type — required, must be a known approach.
  if (!CDC_CONNECTOR_TYPES.includes(values.connectorType as CdcConnectorType)) {
    errors.connectorType = 'Select a connector type.';
  }

  // source / sink connection — required.
  if (isBlank(values.sourceConnection)) {
    errors.sourceConnection = 'Source database connection is required.';
  }
  if (isBlank(values.sinkConnection)) {
    errors.sinkConnection = 'ClickHouse sink connection is required.';
  }

  // replication_tables — at least one non-blank entry.
  const nonBlankTables = values.replicationTables.filter((t) => !isBlank(t));
  if (nonBlankTables.length === 0) {
    errors.replicationTables = 'Add at least one table to replicate.';
  }

  // intermediary_connection — required only for approaches that need it.
  if (
    requiresIntermediaryConnection(values.connectorType) &&
    isBlank(values.intermediaryConnection)
  ) {
    errors.intermediaryConnection =
      values.connectorType === 'debezium_kafka'
        ? 'Kafka broker connection is required for the Debezium+Kafka approach.'
        : 'Airbyte API connection is required for the Airbyte approach.';
  }

  // sync schedule — Airbyte only.
  if (usesSyncSchedule(values.connectorType)) {
    const intervalError = validateSyncInterval(values.syncIntervalSeconds);
    if (intervalError) {
      errors.syncIntervalSeconds = intervalError;
    }
    if (!SYNC_MODES.includes(values.syncMode as SyncMode)) {
      errors.syncMode = 'Select a sync mode.';
    }
  }

  return {
    errors,
    // Preserve the caller's input verbatim (Req 6.7 — never discard data).
    values,
    valid: Object.keys(errors).length === 0,
  };
}

/**
 * Validate the raw sync-interval string. Returns an error message, or `null`
 * when the value is an integer within the accepted range. Exported so the
 * wizard can validate the single field inline as the user types.
 */
export function validateSyncInterval(raw: string): string | null {
  if (isBlank(raw)) {
    return 'Sync interval is required for the Airbyte approach.';
  }
  // Reject non-integer / non-numeric input explicitly so "12.5" or "abc"
  // produce a clear message rather than silently coercing.
  if (!/^-?\d+$/.test(raw.trim())) {
    return 'Sync interval must be a whole number of seconds.';
  }
  const seconds = Number.parseInt(raw.trim(), 10);
  if (seconds < SYNC_INTERVAL_MIN_SECONDS || seconds > SYNC_INTERVAL_MAX_SECONDS) {
    return `Sync interval must be between ${SYNC_INTERVAL_MIN_SECONDS} and ${SYNC_INTERVAL_MAX_SECONDS} seconds (5 minutes to 24 hours).`;
  }
  return null;
}

/**
 * Convert validated form values into the API create payload
 * (`POST /api/v1/cdc/pipelines`). Assumes {@link validatePipelineForm} has
 * already passed — blank table rows are dropped and the Airbyte sync schedule
 * is folded into `config`. Throws if the connector type is still unset, which
 * a valid form guarantees cannot happen.
 */
export function toCreatePayload(values: PipelineFormValues): {
  pipeline_name: string;
  cdc_connector_type: CdcConnectorType;
  source_database_connection: string;
  clickhouse_sink_connection: string;
  replication_tables: string[];
  intermediary_connection?: string;
  config?: Record<string, unknown>;
} {
  if (values.connectorType === '') {
    throw new Error('Cannot build payload from a form without a connector type.');
  }

  const config: Record<string, unknown> = {};
  if (usesSyncSchedule(values.connectorType)) {
    config.sync_schedule = {
      interval_seconds: Number.parseInt(values.syncIntervalSeconds.trim(), 10),
      sync_mode: values.syncMode,
    };
  }

  return {
    pipeline_name: values.pipelineName.trim(),
    cdc_connector_type: values.connectorType,
    source_database_connection: values.sourceConnection.trim(),
    clickhouse_sink_connection: values.sinkConnection.trim(),
    replication_tables: values.replicationTables
      .map((t) => t.trim())
      .filter((t) => t.length > 0),
    ...(requiresIntermediaryConnection(values.connectorType)
      ? { intermediary_connection: values.intermediaryConnection.trim() }
      : {}),
    ...(Object.keys(config).length > 0 ? { config } : {}),
  };
}
