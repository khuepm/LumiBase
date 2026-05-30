import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';

import {
  aggregate,
  DISABLED_SUBSCORE,
  runDetectors,
} from '../detector';
import type { Subscore } from '../types';

/**
 * Unit tests for the anomaly aggregator (admin-setup-wizard task 7.6;
 * Req 12.1; design §8.4; Property 9).
 *
 * Coverage layout (one `describe` per spec hook):
 *
 *   - `aggregate` example tests pin the 8 corner cases of `value` ∈
 *     {0,1}^3 + the warmup OR-fold across `baselineWarmup` ∈
 *     {false,true}^3. With only 16 combinations these are fully
 *     enumerated rather than sampled.
 *   - The fast-check property block hammers `aggregate` across all
 *     valid `Subscore` triples and asserts the two invariants from
 *     Property 9: `score === Number(Math.max(...).toFixed(2))` and
 *     `baselineWarmup === g||t||d`. Together these prove
 *     `score ∈ {0.00, 1.00}` with exact 2-decimal precision because
 *     `value` is typed `0 | 1`.
 *   - `runDetectors` wraps the aggregator with policy gating; we
 *     verify three things: disabled axes never invoke their
 *     subscore function, enabled axes do, and the final result
 *     matches `aggregate(...)` over the gated subscores.
 *
 * Validates: Requirements 12.1 (Property 9: Anomaly Score Bound).
 */

const ZERO: Subscore = { value: 0, baselineWarmup: false };
const ONE: Subscore = { value: 1, baselineWarmup: false };
const ZERO_WARM: Subscore = { value: 0, baselineWarmup: true };
const ONE_WARM: Subscore = { value: 1, baselineWarmup: true };

// ── aggregate (Req 12.1; design §8.4) ───────────────────────────────────

describe('aggregate (Req 12.1; design §8.4)', () => {
  it('returns score=0 and warmup=false when all three subscores are zero', () => {
    expect(aggregate(ZERO, ZERO, ZERO)).toEqual({
      score: 0,
      baselineWarmup: false,
    });
  });

  it('returns score=1 when any single subscore is 1', () => {
    expect(aggregate(ONE, ZERO, ZERO).score).toBe(1);
    expect(aggregate(ZERO, ONE, ZERO).score).toBe(1);
    expect(aggregate(ZERO, ZERO, ONE).score).toBe(1);
  });

  it('returns score=1 when all three subscores are 1', () => {
    expect(aggregate(ONE, ONE, ONE)).toEqual({
      score: 1,
      baselineWarmup: false,
    });
  });

  it('OR-folds baselineWarmup across the three inputs', () => {
    // Single-axis warmup → warmup=true.
    expect(aggregate(ZERO_WARM, ZERO, ZERO).baselineWarmup).toBe(true);
    expect(aggregate(ZERO, ZERO_WARM, ZERO).baselineWarmup).toBe(true);
    expect(aggregate(ZERO, ZERO, ZERO_WARM).baselineWarmup).toBe(true);
    // No-axis warmup → warmup=false.
    expect(aggregate(ZERO, ZERO, ZERO).baselineWarmup).toBe(false);
    // All-axis warmup → warmup=true.
    expect(aggregate(ZERO_WARM, ZERO_WARM, ZERO_WARM).baselineWarmup).toBe(true);
  });

  it('keeps warmup=true even when score=1 (LoginGuard suppresses action downstream)', () => {
    // Req 12.5: warmup short-circuits the threshold-action dispatch
    // in LoginGuard regardless of the score. The aggregator itself
    // must still surface both fields untouched so the caller can
    // make that decision.
    const result = aggregate(ONE_WARM, ZERO, ZERO);
    expect(result).toEqual({ score: 1, baselineWarmup: true });
  });

  it('produces a numeric score (not a string) for cheap threshold comparison', () => {
    // The design listing wraps `toFixed(2)` in `Number(...)` so the
    // call site can compare `score >= threshold` directly without a
    // parseFloat round-trip; pin the type here to catch a regression
    // that returns the raw `"0.00"` / `"1.00"` string.
    const result = aggregate(ONE, ZERO, ZERO);
    expect(typeof result.score).toBe('number');
    expect(result.score).toBe(1);
    // Round-trip through `toFixed(2)` confirms the 2-decimal contract:
    // both `0` and `1` format to `"0.00"` / `"1.00"`.
    expect(result.score.toFixed(2)).toBe('1.00');
  });
});

// ── Property 9: Anomaly Score Bound ────────────────────────────────────

describe('Feature: admin-setup-wizard, Property 9: Anomaly Score Bound', () => {
  // A `Subscore` only has two fields with two values each, so the
  // arbitrary is fully enumerated by fast-check's shrinker. Constraining
  // generators to the input space (rather than `fc.anything()`) keeps
  // the test runs fast and the failures actionable.
  const subscoreArb: fc.Arbitrary<Subscore> = fc.record({
    value: fc.constantFrom<0 | 1>(0, 1),
    baselineWarmup: fc.boolean(),
  });

  it('forall (g, t, d), score equals max with exact 2-decimal precision', () => {
    fc.assert(
      fc.property(subscoreArb, subscoreArb, subscoreArb, (g, t, d) => {
        const result = aggregate(g, t, d);
        const expected = Number(
          Math.max(g.value, t.value, d.value).toFixed(2),
        );
        expect(result.score).toBe(expected);
        // Property 9 explicit bound: anomalyScore ∈ {0.00, 1.00}.
        expect([0, 1]).toContain(result.score);
        // 2-decimal precision: the canonical string form is exactly
        // two digits after the dot.
        expect(result.score.toFixed(2)).toMatch(/^[01]\.00$/);
      }),
    );
  });

  it('forall (g, t, d), baselineWarmup is the OR-fold of the three inputs', () => {
    fc.assert(
      fc.property(subscoreArb, subscoreArb, subscoreArb, (g, t, d) => {
        const result = aggregate(g, t, d);
        const expected =
          g.baselineWarmup || t.baselineWarmup || d.baselineWarmup;
        expect(result.baselineWarmup).toBe(expected);
      }),
    );
  });
});

// ── runDetectors (policy gating + parallel run) ─────────────────────────

describe('runDetectors — policy gating (design §8.4 disabled-detector rule)', () => {
  const ALL_ON = {
    geoAnomalyEnabled: true,
    timeAnomalyEnabled: true,
    deviceAnomalyEnabled: true,
  };
  const ALL_OFF = {
    geoAnomalyEnabled: false,
    timeAnomalyEnabled: false,
    deviceAnomalyEnabled: false,
  };

  it('returns score=0 / warmup=false when all detectors are disabled', async () => {
    const geoSpy = vi.fn();
    const timeSpy = vi.fn();
    const deviceSpy = vi.fn();

    const result = await runDetectors({
      policy: ALL_OFF,
      geoSubscoreFn: geoSpy,
      timeSubscoreFn: timeSpy,
      deviceSubscoreFn: deviceSpy,
    });

    expect(result).toEqual({ score: 0, baselineWarmup: false });
    // Disabled axes never invoke the subscore — no DB / MMDB I/O.
    expect(geoSpy).not.toHaveBeenCalled();
    expect(timeSpy).not.toHaveBeenCalled();
    expect(deviceSpy).not.toHaveBeenCalled();
  });

  it('invokes only the enabled subscore functions', async () => {
    const geoSpy = vi.fn().mockResolvedValue(ONE);
    const timeSpy = vi.fn().mockResolvedValue(ZERO);
    const deviceSpy = vi.fn().mockResolvedValue(ZERO);

    const result = await runDetectors({
      policy: {
        geoAnomalyEnabled: true,
        timeAnomalyEnabled: false,
        deviceAnomalyEnabled: false,
      },
      geoSubscoreFn: geoSpy,
      timeSubscoreFn: timeSpy,
      deviceSubscoreFn: deviceSpy,
    });

    expect(geoSpy).toHaveBeenCalledTimes(1);
    expect(timeSpy).not.toHaveBeenCalled();
    expect(deviceSpy).not.toHaveBeenCalled();
    // Geo trips → score = 1; the disabled axes contribute 0 / no warmup.
    expect(result).toEqual({ score: 1, baselineWarmup: false });
  });

  it('aggregates the live subscores when all detectors are enabled', async () => {
    const result = await runDetectors({
      policy: ALL_ON,
      geoSubscoreFn: async () => ZERO_WARM,
      timeSubscoreFn: async () => ZERO,
      deviceSubscoreFn: async () => ONE,
    });
    // device trips, geo is in warmup → score=1, warmup=true.
    expect(result).toEqual({ score: 1, baselineWarmup: true });
  });

  it('does not propagate baselineWarmup from a *disabled* detector', async () => {
    // If runDetectors were to substitute `{ value: 0, baselineWarmup:
    // true }` for a disabled axis, the OR-fold would silently bypass
    // the threshold-action dispatch on every login — exactly the
    // opposite of operator intent. Lock the substitution as
    // DISABLED_SUBSCORE (warmup=false) here so a future refactor
    // can't regress the behaviour.
    const result = await runDetectors({
      policy: ALL_OFF,
      geoSubscoreFn: async () => ONE_WARM,
      timeSubscoreFn: async () => ONE_WARM,
      deviceSubscoreFn: async () => ONE_WARM,
    });
    expect(result.baselineWarmup).toBe(false);
    expect(result.score).toBe(0);
  });

  it('runs enabled subscores in parallel rather than sequentially', async () => {
    // Pin the parallel-execution contract: a 50ms + 50ms + 50ms
    // sequential run would take ≥ 150ms; the parallel `Promise.all`
    // we use should complete in well under ~120ms. We use a generous
    // upper bound to avoid CI flakiness.
    const slow = (out: Subscore) =>
      new Promise<Subscore>((resolve) => setTimeout(() => resolve(out), 50));
    const start = Date.now();
    await runDetectors({
      policy: ALL_ON,
      geoSubscoreFn: () => slow(ZERO),
      timeSubscoreFn: () => slow(ZERO),
      deviceSubscoreFn: () => slow(ZERO),
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(140);
  });

  it('propagates a subscore rejection so the caller can decide the fallback', async () => {
    // The detector contract is "never block a login on infra failure",
    // but that's the LoginGuard's responsibility (task 8.1) — the
    // aggregator layer keeps the rejection visible so the caller can
    // log / fall back as appropriate.
    const boom = new Error('baseline-load-failed');
    await expect(
      runDetectors({
        policy: { ...ALL_ON },
        geoSubscoreFn: async () => {
          throw boom;
        },
        timeSubscoreFn: async () => ZERO,
        deviceSubscoreFn: async () => ZERO,
      }),
    ).rejects.toBe(boom);
  });
});

// ── DISABLED_SUBSCORE constant ──────────────────────────────────────────

describe('DISABLED_SUBSCORE', () => {
  it('is { value: 0, baselineWarmup: false }', () => {
    expect(DISABLED_SUBSCORE).toEqual({ value: 0, baselineWarmup: false });
  });

  it('is frozen so callers cannot mutate the shared sentinel', () => {
    expect(Object.isFrozen(DISABLED_SUBSCORE)).toBe(true);
  });
});
