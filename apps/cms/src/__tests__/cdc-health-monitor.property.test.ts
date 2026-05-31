import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

import {
  HealthMonitor,
  InMemoryHealthNotificationSink,
  InMemoryPipelineStatusGateway,
  shouldEmitLagWarning,
  isRecoveryTransition,
  MIN_LAG_THRESHOLD_MS,
  MAX_LAG_THRESHOLD_MS,
  type HealthMetricsSource,
  type IntervalScheduler,
  type MonitorTimers,
  type PipelineStatus,
} from '../modules/cdc/health-monitor';
import type {
  HealthCheckResult,
  PipelineMetrics,
} from '../modules/cdc/connectors/types';

/**
 * Property tests for the CDC Health Monitor (ClickHouse CDC — task 9.2;
 * design §4, Requirement 8). Covers the two named properties:
 *
 *   - Property 20 — Replication lag threshold alerting (Req 8.2)
 *   - Property 21 — Pipeline recovery notification on state transition (Req 8.6)
 *
 * Both the pure decision helpers (`shouldEmitLagWarning`,
 * `isRecoveryTransition`) and the end-to-end behaviour through the
 * `HealthMonitor` are exercised. The monitor is driven deterministically:
 * the interval scheduler and one-shot timers are replaced by no-op doubles
 * (so no wall-clock timers fire), the clock is fixed, and metrics/statuses
 * are fed directly via `tick`/`observeStatus`.
 */

// ── deterministic collaborators ────────────────────────────────────────────

const PIPELINE_ID = 'pipeline-under-test';
const FIXED_NOW = 1_700_000_000_000;

/** Interval scheduler that never fires — `tick` is invoked manually instead. */
const noopScheduler: IntervalScheduler = {
  setInterval: () => ({ noop: true }),
  clearInterval: () => {},
};

/**
 * One-shot timers that never fire. `getMetrics` resolves synchronously, so
 * `withTimeout` always resolves via the metrics path before any timeout would
 * elapse; the timeout handle is simply cleared.
 */
const noopTimers: MonitorTimers = {
  setTimeout: () => ({ noop: true }),
  clearTimeout: () => {},
};

const fixedClock = () => FIXED_NOW;

/** A metrics source whose `getMetrics` returns a fixed sample. */
function makeMetricsSource(metrics: PipelineMetrics): HealthMetricsSource {
  return {
    async getMetrics(): Promise<PipelineMetrics> {
      return metrics;
    },
    async healthCheck(): Promise<HealthCheckResult> {
      return {
        healthy: true,
        services: [],
        checkedAt: new Date(FIXED_NOW).toISOString(),
      };
    },
  };
}

// ── arbitraries ──────────────────────────────────────────────────────────

const ALL_STATUSES: readonly PipelineStatus[] = [
  'active',
  'paused',
  'error',
  'provisioning',
];

const arbStatus: fc.Arbitrary<PipelineStatus> = fc.constantFrom(...ALL_STATUSES);

/**
 * A replication-lag value (ms). The range spans well below and above the
 * configurable threshold window so both the "warn" and "no warn" branches are
 * exercised heavily across runs.
 */
const arbLagMs = fc.integer({ min: 0, max: MAX_LAG_THRESHOLD_MS + 100_000 });

/** A lag threshold (ms) within the schema-valid configurable range. */
const arbThresholdMs = fc.integer({
  min: MIN_LAG_THRESHOLD_MS,
  max: MAX_LAG_THRESHOLD_MS,
});

// ── Property 20 ──────────────────────────────────────────────────────────

describe('Feature: clickhouse-cdc, Property 20: Replication lag threshold alerting', () => {
  // **Validates: Requirements 8.2**

  it('pure helper: shouldEmitLagWarning fires iff lag strictly exceeds threshold', () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (lagMs, thresholdMs) => {
        expect(shouldEmitLagWarning(lagMs, thresholdMs)).toBe(lagMs > thresholdMs);
      }),
      { numRuns: 100 },
    );
  });

  it('end-to-end: a lag_warning notification is emitted iff lag > threshold', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbLagMs,
        arbThresholdMs,
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 0, max: 1_000 }),
        async (lagMs, thresholdMs, eventsPerSecond, errorCount) => {
          const sink = new InMemoryHealthNotificationSink();
          const source = makeMetricsSource({
            replicationLagMs: lagMs,
            eventsPerSecond,
            errorCount,
            collectedAt: new Date(FIXED_NOW).toISOString(),
          });

          const monitor = new HealthMonitor({
            metricsSourceResolver: (id) => (id === PIPELINE_ID ? source : null),
            notificationSink: sink,
            statusGateway: new InMemoryPipelineStatusGateway(),
            scheduler: noopScheduler,
            timers: noopTimers,
            clock: fixedClock,
          });

          monitor.start(PIPELINE_ID, { lagThresholdMs: thresholdMs });
          await monitor.tick(PIPELINE_ID);
          monitor.stop(PIPELINE_ID);

          const warnings = sink.notificationsOfType('lag_warning');
          const expectedWarning = shouldEmitLagWarning(lagMs, thresholdMs);

          // Exactly one warning iff lag exceeds threshold, none otherwise.
          expect(warnings.length).toBe(expectedWarning ? 1 : 0);

          if (expectedWarning) {
            expect(warnings[0].pipelineId).toBe(PIPELINE_ID);
            expect(warnings[0].lagMs).toBe(lagMs);
            expect(warnings[0].thresholdMs).toBe(thresholdMs);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ── Property 21 ──────────────────────────────────────────────────────────

describe('Feature: clickhouse-cdc, Property 21: Pipeline recovery notification on state transition', () => {
  // **Validates: Requirements 8.6**

  it('pure helper: isRecoveryTransition is true iff previous=error and next=active', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<PipelineStatus | null>(null, ...ALL_STATUSES),
        arbStatus,
        (previous, next) => {
          expect(isRecoveryTransition(previous, next)).toBe(
            previous === 'error' && next === 'active',
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it('end-to-end: exactly one recovery notification per error→active transition', () => {
    fc.assert(
      fc.property(
        fc.array(arbStatus, { minLength: 0, maxLength: 30 }),
        (sequence) => {
          const sink = new InMemoryHealthNotificationSink();
          const monitor = new HealthMonitor({
            notificationSink: sink,
            statusGateway: new InMemoryPipelineStatusGateway(),
            scheduler: noopScheduler,
            timers: noopTimers,
            clock: fixedClock,
          });

          monitor.start(PIPELINE_ID);
          for (const status of sequence) {
            monitor.observeStatus(PIPELINE_ID, status);
          }
          monitor.stop(PIPELINE_ID);

          // Count adjacent error→active transitions; the initial "previous"
          // is null, so the first observation can never be a recovery.
          let previous: PipelineStatus | null = null;
          let expectedRecoveries = 0;
          for (const status of sequence) {
            if (isRecoveryTransition(previous, status)) {
              expectedRecoveries += 1;
            }
            previous = status;
          }

          const recoveries = sink.notificationsOfType('recovery');
          expect(recoveries.length).toBe(expectedRecoveries);
          for (const recovery of recoveries) {
            expect(recovery.pipelineId).toBe(PIPELINE_ID);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
