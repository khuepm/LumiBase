/**
 * Client-side CDC approach recommender for the Studio wizard
 * (ClickHouse CDC — task 13.3; design "Studio CDC Panel" §6, Requirement
 * 6.3).
 *
 * This is a lightweight, dependency-free REPLICA of the small decision matrix
 * that lives server-side in `apps/cms/src/modules/cdc/recommender.ts`. It is
 * intentionally a placeholder per the task title ("placeholder structure"):
 * the wizard renders an instant, offline recommendation as the operator types
 * volume/latency figures, without a network round-trip. The authoritative
 * recommendation (with full rationale + alternatives) remains the CMS module;
 * a later task can swap this for a `POST /api/v1/cdc/recommend` call if the
 * panel needs the server's exact copy.
 *
 * The matrix mirrors the documented rules (design "Approach Recommendation
 * Model") so the two stay consistent:
 *   - rowsPerSecond > 10,000 OR maxLatencySeconds < 5  → debezium_kafka
 *   - preferManagedService                              → airbyte
 *   - low volume, no Kafka, relaxed latency             → materialized_engine
 *   - fallback: reuse Kafka if present, else materialized_engine
 *
 * Pure and deterministic: identical inputs always yield identical output.
 *
 * Validates: Requirements 6.3
 */

import type { CdcConnectorType } from './types';

/** Above this throughput the workload is "high volume" → Debezium+Kafka. */
export const HIGH_VOLUME_ROWS_PER_SECOND = 10_000;

/** At/below this throughput the workload is eligible for Materialized Engine. */
export const LOW_VOLUME_ROWS_PER_SECOND = 5_000;

/** Latency budgets tighter than this demand the streaming path. */
export const LOW_LATENCY_SECONDS = 5;

/** Upper latency bound for the Materialized Engine approach. */
export const MATERIALIZED_MAX_LATENCY_SECONDS = 30;

/** Workload profile supplied by the wizard (Req 6.3). */
export interface RecommendationInput {
  readonly estimatedRowsPerSecond: number;
  readonly maxLatencySeconds: number;
  readonly hasKafkaInfrastructure: boolean;
  readonly preferManagedService: boolean;
}

/** Output of {@link recommendApproach}: a choice plus a parameter-aware rationale. */
export interface RecommendationOutput {
  readonly recommended: CdcConnectorType;
  readonly rationale: string;
}

/** Human-readable labels used inside the rationale copy. */
const LABELS: Readonly<Record<CdcConnectorType, string>> = {
  debezium_kafka: 'Debezium + Kafka',
  materialized_engine: 'Materialized Engine',
  airbyte: 'Airbyte',
};

/**
 * Recommend a CDC connector approach for the given workload profile.
 *
 * Rules are evaluated in a fixed precedence order so the result is total
 * (always returns) and deterministic (equal inputs → equal output), matching
 * the server-side engine's contract.
 */
export function recommendApproach(
  input: RecommendationInput,
): RecommendationOutput {
  const {
    estimatedRowsPerSecond,
    maxLatencySeconds,
    hasKafkaInfrastructure,
    preferManagedService,
  } = input;

  const profile =
    `~${estimatedRowsPerSecond} rows/s, ${maxLatencySeconds}s max latency, ` +
    `Kafka ${hasKafkaInfrastructure ? 'available' : 'unavailable'}, ` +
    `managed preference ${preferManagedService ? 'on' : 'off'}`;

  // Rule 1 — high volume or very low latency → Debezium+Kafka.
  if (
    estimatedRowsPerSecond > HIGH_VOLUME_ROWS_PER_SECOND ||
    maxLatencySeconds < LOW_LATENCY_SECONDS
  ) {
    return {
      recommended: 'debezium_kafka',
      rationale:
        `${LABELS.debezium_kafka}: the workload is high throughput or needs ` +
        `near-real-time latency (${profile}).`,
    };
  }

  // Rule 2 — managed-service preference → Airbyte.
  if (preferManagedService) {
    return {
      recommended: 'airbyte',
      rationale:
        `${LABELS.airbyte}: a managed service is preferred and the latency ` +
        `budget tolerates scheduled syncs (${profile}).`,
    };
  }

  // Rule 3 — low volume, no Kafka, relaxed latency → Materialized Engine.
  if (
    estimatedRowsPerSecond < LOW_VOLUME_ROWS_PER_SECOND &&
    !hasKafkaInfrastructure &&
    maxLatencySeconds < MATERIALIZED_MAX_LATENCY_SECONDS
  ) {
    return {
      recommended: 'materialized_engine',
      rationale:
        `${LABELS.materialized_engine}: low volume with no Kafka and a ` +
        `relaxed latency budget — direct replication, no extra infra ` +
        `(${profile}).`,
    };
  }

  // Rule 4 — fallback: reuse existing Kafka, else default to Materialized.
  if (hasKafkaInfrastructure) {
    return {
      recommended: 'debezium_kafka',
      rationale:
        `${LABELS.debezium_kafka}: no single criterion dominates, but Kafka ` +
        `is already available to reuse (${profile}).`,
    };
  }

  return {
    recommended: 'materialized_engine',
    rationale:
      `${LABELS.materialized_engine}: no single criterion dominates and no ` +
      `Kafka infrastructure is available — the lowest-overhead option ` +
      `(${profile}).`,
  };
}
