import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

import {
  recommendApproach,
  HIGH_VOLUME_ROWS_PER_SECOND,
  LOW_VOLUME_ROWS_PER_SECOND,
  LOW_LATENCY_SECONDS,
  MATERIALIZED_MAX_LATENCY_SECONDS,
  type RecommendationInput,
} from '../modules/cdc/recommender';
import type { CdcConnectorType } from '../modules/cdc/connectors/types';

/**
 * Feature: clickhouse-cdc, Property 15: Approach recommendation consistency
 *
 * For any combination of estimated data volume (rows/second), maximum
 * latency requirement, Kafka availability, and managed-service preference,
 * the recommendation engine SHALL return a deterministic result that is
 * consistent with the documented decision criteria matrix:
 *
 *   1. rowsPerSecond > 10,000 OR maxLatencySeconds < 5  → debezium_kafka
 *   2. preferManagedService                              → airbyte
 *   3. rowsPerSecond < 5,000 AND no Kafka infra
 *        AND maxLatencySeconds < 30                      → materialized_engine
 *   4. fallback: hasKafkaInfrastructure
 *        ? debezium_kafka : materialized_engine
 *
 * **Validates: Requirements 6.3**
 */

// ── Reference implementation ───────────────────────────────────────────────
//
// An independent re-statement of the documented decision precedence. The
// property asserts the production engine agrees with this reference for
// arbitrary inputs. Keeping it separate (rather than importing the engine's
// own branches) is what gives the test its oracle value.
function referenceRecommendation(input: RecommendationInput): CdcConnectorType {
  const {
    estimatedRowsPerSecond,
    maxLatencySeconds,
    hasKafkaInfrastructure,
    preferManagedService,
  } = input;

  // Rule 1 — high volume or very low latency.
  if (
    estimatedRowsPerSecond > HIGH_VOLUME_ROWS_PER_SECOND ||
    maxLatencySeconds < LOW_LATENCY_SECONDS
  ) {
    return 'debezium_kafka';
  }

  // Rule 2 — managed-service preference.
  if (preferManagedService) {
    return 'airbyte';
  }

  // Rule 3 — low volume, no Kafka, relaxed latency.
  if (
    estimatedRowsPerSecond < LOW_VOLUME_ROWS_PER_SECOND &&
    !hasKafkaInfrastructure &&
    maxLatencySeconds < MATERIALIZED_MAX_LATENCY_SECONDS
  ) {
    return 'materialized_engine';
  }

  // Rule 4 — fallback.
  return hasKafkaInfrastructure ? 'debezium_kafka' : 'materialized_engine';
}

const ALL_CONNECTOR_TYPES: readonly CdcConnectorType[] = [
  'debezium_kafka',
  'materialized_engine',
  'airbyte',
];

// ── Arbitraries ─────────────────────────────────────────────────────────────

/**
 * A workload profile arbitrary that deliberately straddles every decision
 * boundary. Volume and latency are drawn from ranges that span well below,
 * around, and well above each threshold so generated inputs land in all four
 * precedence branches (including the fallback "gap" cases).
 */
const arbInput: fc.Arbitrary<RecommendationInput> = fc.record({
  estimatedRowsPerSecond: fc.integer({ min: 0, max: 25_000 }),
  maxLatencySeconds: fc.integer({ min: 0, max: 120 }),
  hasKafkaInfrastructure: fc.boolean(),
  preferManagedService: fc.boolean(),
});

// ── Property 15 ──────────────────────────────────────────────────────────────

describe('Feature: clickhouse-cdc, Property 15: Approach recommendation consistency', () => {
  it('(a) is deterministic — identical inputs yield deeply-equal output', () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        const first = recommendApproach(input);
        const second = recommendApproach(input);
        expect(second).toEqual(first);
      }),
      { numRuns: 200 },
    );
  });

  it('(b) is consistent with the documented decision matrix', () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        const { recommended } = recommendApproach(input);
        expect(recommended).toBe(referenceRecommendation(input));
      }),
      { numRuns: 200 },
    );
  });

  it('(c) rationale references the provided volume and latency parameters', () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        const { rationale } = recommendApproach(input);
        // The rationale must reference the caller-supplied parameters
        // (Req 6.3): both the volume and latency numbers appear verbatim.
        expect(rationale).toContain(`${input.estimatedRowsPerSecond} rows/s`);
        expect(rationale).toContain(`${input.maxLatencySeconds}s`);
        expect(rationale.length).toBeGreaterThan(0);
      }),
      { numRuns: 200 },
    );
  });

  it('(d) alternatives contain exactly the two non-recommended connector types', () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        const { recommended, alternatives } = recommendApproach(input);

        // Exactly two alternatives.
        expect(alternatives).toHaveLength(2);

        const altTypes = alternatives.map((a) => a.type);

        // None of the alternatives is the recommended approach.
        expect(altTypes).not.toContain(recommended);

        // The alternatives are distinct.
        expect(new Set(altTypes).size).toBe(2);

        // Together with the recommendation they cover all three approaches.
        expect(new Set([recommended, ...altTypes])).toEqual(
          new Set(ALL_CONNECTOR_TYPES),
        );

        // Each alternative carries a non-empty trade-off description.
        for (const alt of alternatives) {
          expect(typeof alt.tradeoff).toBe('string');
          expect(alt.tradeoff.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 200 },
    );
  });
});
