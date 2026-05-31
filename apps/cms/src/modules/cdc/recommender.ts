/**
 * Approach recommendation engine — suggests which CDC connector strategy
 * best fits a workload (ClickHouse CDC — task 13.1; design "Approach
 * Recommendation Model", Requirement 6.3).
 *
 * Given an estimated workload profile (data volume, latency target,
 * available Kafka infrastructure, and managed-service preference), this
 * module returns a single recommended {@link CdcConnectorType} together
 * with a human-readable rationale that references the caller-provided
 * parameters and a list of the remaining approaches annotated with their
 * trade-offs.
 *
 * Decision matrix (design "Approach Recommendation Model"):
 *   - rowsPerSecond > 10,000 OR maxLatencySeconds < 5  → debezium_kafka
 *   - rowsPerSecond < 5,000 AND no Kafka infra
 *       AND maxLatencySeconds < 30                      → materialized_engine
 *   - preferManagedService OR minimal infra management  → airbyte
 *
 * Because those three rules do not, on their own, partition the entire
 * input space (e.g. 7,000 rows/s with Kafka available and a 60s latency
 * budget matches none of them), the engine applies them in a documented
 * **precedence order** and falls back to a sensible default so the function
 * is *total* — it always returns a recommendation for any valid input — and
 * *deterministic* — identical inputs always yield identical output. This is
 * what Property 15 (recommendation consistency) relies on.
 *
 * This module is pure: it performs no I/O and holds no state. The exported
 * {@link recommendApproach} function is a referentially-transparent mapping
 * from {@link RecommendationInput} to {@link RecommendationOutput}.
 *
 * Validates: Requirements 6.3
 */

import type { CdcConnectorType } from './connectors/types';

// ── decision thresholds (design "Approach Recommendation Model") ──────────

/**
 * Above this throughput (events/second) the workload is considered "high
 * volume" and routed to Debezium+Kafka, whose partitioned topics absorb
 * heavy write rates (Req 6.3, design rule 1).
 */
export const HIGH_VOLUME_ROWS_PER_SECOND = 10_000;

/**
 * At or below this throughput the workload is considered "low volume" and
 * becomes eligible for the dependency-free Materialized Engine approach
 * (design rule 2).
 */
export const LOW_VOLUME_ROWS_PER_SECOND = 5_000;

/**
 * Latency budgets tighter than this (seconds) demand the near-real-time
 * streaming path (Debezium+Kafka), even at modest volumes (design rule 1).
 */
export const LOW_LATENCY_SECONDS = 5;

/**
 * Upper latency bound (seconds) for the Materialized Engine approach. Its
 * direct replication-slot connection comfortably meets sub-30s targets
 * without extra infrastructure (design rule 2).
 */
export const MATERIALIZED_MAX_LATENCY_SECONDS = 30;

// ── public types (design "Approach Recommendation Model") ─────────────────

/**
 * Workload profile supplied by the caller (typically the Studio CDC wizard,
 * Req 6.3) describing the expected characteristics of a new pipeline.
 */
export interface RecommendationInput {
  /** Estimated sustained change volume from the source, in rows/second. */
  readonly estimatedRowsPerSecond: number;

  /** Maximum acceptable end-to-end replication latency, in seconds. */
  readonly maxLatencySeconds: number;

  /**
   * Whether the deployment already has Kafka infrastructure available.
   * When `false`, approaches that require a message bus are penalised so
   * the engine avoids recommending new operational dependencies.
   */
  readonly hasKafkaInfrastructure: boolean;

  /**
   * Whether the operator prefers a managed service over self-hosted
   * components (minimal infrastructure management). Steers the engine
   * toward Airbyte.
   */
  readonly preferManagedService: boolean;
}

/**
 * A non-recommended approach paired with the trade-off the operator accepts
 * by choosing it over the recommended approach.
 */
export interface RecommendationAlternative {
  /** The alternative connector approach. */
  readonly type: CdcConnectorType;

  /** Human-readable description of the trade-off this alternative entails. */
  readonly tradeoff: string;
}

/**
 * Result of {@link recommendApproach}: the single recommended approach, a
 * rationale that references the provided parameters (Req 6.3), and the
 * remaining approaches annotated with their trade-offs.
 */
export interface RecommendationOutput {
  /** The connector approach the engine recommends for this workload. */
  readonly recommended: CdcConnectorType;

  /**
   * Human-readable justification that references the caller-provided
   * parameters (volume, latency, Kafka availability, managed preference),
   * satisfying Requirement 6.3.
   */
  readonly rationale: string;

  /** The two non-recommended approaches, each with its trade-off. */
  readonly alternatives: readonly RecommendationAlternative[];
}

// ── trade-off copy ────────────────────────────────────────────────────────

/**
 * Static trade-off descriptions for each approach, surfaced when the
 * approach is offered as an *alternative* rather than the recommendation.
 * Keeping these in one place keeps the alternative list deterministic and
 * easy to audit against the documentation.
 */
const TRADEOFFS: Readonly<Record<CdcConnectorType, string>> = {
  debezium_kafka:
    'Highest throughput and lowest latency, but requires operating Kafka ' +
    'and Debezium infrastructure.',
  materialized_engine:
    'No extra infrastructure (direct PostgreSQL replication slot), but ' +
    'best suited to lower volumes and is sensitive to source schema drift.',
  airbyte:
    'Fully managed with the least operational overhead, but syncs are ' +
    'scheduled (minimum 5-minute interval) rather than streaming, so ' +
    'latency is higher.',
};

/** Stable display labels used inside generated rationale strings. */
const LABELS: Readonly<Record<CdcConnectorType, string>> = {
  debezium_kafka: 'Debezium+Kafka',
  materialized_engine: 'Materialized Engine',
  airbyte: 'Airbyte',
};

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Build the {@link RecommendationOutput.alternatives} list for a given
 * recommendation: every connector type except the recommended one, in a
 * fixed, deterministic order.
 */
function buildAlternatives(recommended: CdcConnectorType): RecommendationAlternative[] {
  const ALL_TYPES: readonly CdcConnectorType[] = [
    'debezium_kafka',
    'materialized_engine',
    'airbyte',
  ];

  return ALL_TYPES.filter((type) => type !== recommended).map((type) => ({
    type,
    tradeoff: TRADEOFFS[type],
  }));
}

// ── public API ───────────────────────────────────────────────────────────

/**
 * Recommend a CDC connector approach for the given workload profile.
 *
 * The decision rules are evaluated in a fixed precedence order so the
 * result is both **total** (some approach is always returned) and
 * **deterministic** (equal inputs → equal output), as required by
 * Property 15:
 *
 *   1. **Debezium+Kafka** — chosen when the workload is high volume
 *      (`estimatedRowsPerSecond > 10,000`) OR demands very low latency
 *      (`maxLatencySeconds < 5`). Streaming throughput / latency dominate
 *      every other consideration, so this rule is checked first.
 *   2. **Airbyte** — chosen when the operator prefers a managed service
 *      (`preferManagedService`) and the latency budget tolerates scheduled
 *      syncs (`maxLatencySeconds >= 5`, already guaranteed by rule 1 not
 *      matching). Managed preference outranks the lighter-weight
 *      Materialized Engine because it reflects an explicit operator choice.
 *   3. **Materialized Engine** — chosen for low-volume workloads
 *      (`estimatedRowsPerSecond < 5,000`) with no Kafka infrastructure and a
 *      relaxed latency budget (`maxLatencySeconds < 30`). Avoids introducing
 *      a message bus when one is neither present nor required.
 *   4. **Fallback** — any input matching none of the above (the "gap" cases,
 *      e.g. mid-range volume with Kafka available and a loose latency
 *      target). If Kafka infrastructure already exists we reuse it with
 *      Debezium+Kafka; otherwise we default to the zero-dependency
 *      Materialized Engine. This keeps the function total without ever
 *      recommending unavailable infrastructure.
 *
 * @param input - Estimated workload profile (Req 6.3).
 * @returns The recommended approach, a parameter-referencing rationale, and
 *   the remaining approaches with their trade-offs.
 */
export function recommendApproach(input: RecommendationInput): RecommendationOutput {
  const {
    estimatedRowsPerSecond,
    maxLatencySeconds,
    hasKafkaInfrastructure,
    preferManagedService,
  } = input;

  // Reusable, parameter-referencing description of the supplied workload so
  // every rationale satisfies Req 6.3 ("referencing the provided parameters").
  const profile =
    `estimated volume of ${estimatedRowsPerSecond} rows/s, ` +
    `a maximum latency of ${maxLatencySeconds}s, ` +
    `Kafka infrastructure ${hasKafkaInfrastructure ? 'available' : 'unavailable'}, ` +
    `and managed-service preference ${preferManagedService ? 'enabled' : 'disabled'}`;

  // Rule 1 — high volume or very low latency → Debezium+Kafka.
  if (estimatedRowsPerSecond > HIGH_VOLUME_ROWS_PER_SECOND || maxLatencySeconds < LOW_LATENCY_SECONDS) {
    const reason =
      estimatedRowsPerSecond > HIGH_VOLUME_ROWS_PER_SECOND
        ? `the volume exceeds the ${HIGH_VOLUME_ROWS_PER_SECOND} rows/s high-volume threshold`
        : `the latency budget is below the ${LOW_LATENCY_SECONDS}s streaming threshold`;
    return {
      recommended: 'debezium_kafka',
      rationale:
        `Recommending ${LABELS.debezium_kafka} because ${reason} ` +
        `(${profile}). Its partitioned Kafka topics provide the throughput ` +
        `and near-real-time latency this workload needs.`,
      alternatives: buildAlternatives('debezium_kafka'),
    };
  }

  // Rule 2 — managed-service preference → Airbyte.
  if (preferManagedService) {
    return {
      recommended: 'airbyte',
      rationale:
        `Recommending ${LABELS.airbyte} because a managed service is preferred ` +
        `and the ${maxLatencySeconds}s latency budget tolerates scheduled syncs ` +
        `(${profile}). It minimises infrastructure management at the cost of ` +
        `streaming-level latency.`,
      alternatives: buildAlternatives('airbyte'),
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
        `Recommending ${LABELS.materialized_engine} because the volume is below ` +
        `the ${LOW_VOLUME_ROWS_PER_SECOND} rows/s threshold, no Kafka ` +
        `infrastructure is available, and the ${maxLatencySeconds}s latency ` +
        `budget is within the ${MATERIALIZED_MAX_LATENCY_SECONDS}s ceiling ` +
        `(${profile}). It replicates directly from a PostgreSQL replication ` +
        `slot with no additional infrastructure.`,
      alternatives: buildAlternatives('materialized_engine'),
    };
  }

  // Rule 4 — fallback for inputs matching none of the explicit rules. Reuse
  // existing Kafka if present, otherwise default to the zero-dependency
  // Materialized Engine. Guarantees totality without recommending
  // infrastructure that is not available.
  if (hasKafkaInfrastructure) {
    return {
      recommended: 'debezium_kafka',
      rationale:
        `Recommending ${LABELS.debezium_kafka} because no single criterion ` +
        `dominates this workload, but Kafka infrastructure is already ` +
        `available to reuse (${profile}). Debezium+Kafka scales with future ` +
        `volume growth without adding new dependencies.`,
      alternatives: buildAlternatives('debezium_kafka'),
    };
  }

  return {
    recommended: 'materialized_engine',
    rationale:
      `Recommending ${LABELS.materialized_engine} because no single criterion ` +
      `dominates this workload and no Kafka infrastructure is available ` +
      `(${profile}). It is the lowest-overhead option, replicating directly ` +
      `from a PostgreSQL replication slot.`,
    alternatives: buildAlternatives('materialized_engine'),
  };
}
