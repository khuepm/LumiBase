import { describe, it, expect } from 'vitest';

import {
  HOUR_HISTOGRAM_LENGTH,
  TIME_ANOMALY_RATE_THRESHOLD,
  TIME_BASELINE_MIN_SUCCESSFUL_LOGINS,
  createTimeSubscore,
} from '../time';
import type { TimeBaselineSnapshot } from '../types';

/**
 * Unit tests for the time subscore (admin-setup-wizard task 7.3;
 * Req 10.1–10.5; design §8.2).
 *
 * The detector is exercised through {@link createTimeSubscore} with a
 * stub `loadBaseline` so the tests never touch a real DB connection.
 * Each `describe` block targets one acceptance criterion from Req 10
 * so the trace is easy to follow:
 *
 *   - 10.1 — histogram is read for users with ≥10 successful logins.
 *   - 10.2 — rate < 2 % at hour `h` ⇒ subscore = 1.
 *   - 10.3 — rate ≥ 2 % at hour `h` ⇒ subscore = 0.
 *   - 10.4 — `successfulLogins < 10` ⇒ baseline warmup.
 *   - 10.5 — baseline updates are out of scope here (handled by the
 *            baseline-store writer in task 7.5).
 *
 * The Database handle is irrelevant because `loadBaseline` is
 * stubbed; we cast `null` for clarity in the test body.
 */

const NULL_DB = null as unknown as Parameters<typeof createTimeSubscore>[0];

function makeBaselineLoader(
  baselines: Record<string, TimeBaselineSnapshot | null>,
): (userId: string) => Promise<TimeBaselineSnapshot | null> {
  return async (userId) => baselines[userId] ?? null;
}

/**
 * Build a histogram that puts `count` logins into hour `h` and
 * `padOther` logins into every other bucket. Useful for crafting
 * baselines whose total is exactly known, so the rate `count / total`
 * lands precisely on either side of the 2 % threshold.
 */
function histogramAt(
  h: number,
  count: number,
  padOther: number = 0,
): number[] {
  const buckets = new Array<number>(HOUR_HISTOGRAM_LENGTH).fill(padOther);
  buckets[h] = count;
  return buckets;
}

function utcHour(h: number): Date {
  // Use a fixed date so tests are deterministic; only the hour matters.
  return new Date(Date.UTC(2025, 0, 1, h, 0, 0, 0));
}

// ── Req 10.4: baseline warmup ───────────────────────────────────────────

describe('timeSubscore — baseline warmup (Req 10.4)', () => {
  it('returns warmup=true when successfulLogins < 10', async () => {
    const subscore = createTimeSubscore(NULL_DB, {
      loadBaseline: makeBaselineLoader({
        u1: {
          // Hour 3 has zero history but warmup must still suppress
          // the anomaly signal until we cross the threshold.
          hourHistogram: histogramAt(0, 9),
          successfulLogins: 9,
        },
      }),
    });
    const result = await subscore('u1', utcHour(3));
    expect(result).toEqual({ value: 0, baselineWarmup: true });
  });

  it('returns warmup=true when there is no baseline row yet', async () => {
    const subscore = createTimeSubscore(NULL_DB, {
      loadBaseline: makeBaselineLoader({}),
    });
    const result = await subscore('first-time-user', utcHour(12));
    expect(result).toEqual({ value: 0, baselineWarmup: true });
  });

  it(`exits warmup at successfulLogins=${TIME_BASELINE_MIN_SUCCESSFUL_LOGINS}`, async () => {
    // 10 logins, all at hour 12: rate(12) = 1.0, rate(other) = 0.0.
    const subscore = createTimeSubscore(NULL_DB, {
      loadBaseline: makeBaselineLoader({
        u1: {
          hourHistogram: histogramAt(12, 10),
          successfulLogins: 10,
        },
      }),
    });
    const result = await subscore('u1', utcHour(12));
    expect(result.baselineWarmup).toBe(false);
  });
});

// ── Req 10.2 / 10.3: rate check ────────────────────────────────────────

describe('timeSubscore — rate check (Req 10.2, 10.3)', () => {
  it('subscore=1 when histogram[h] = 0 (rate < 2 %) at the current hour', async () => {
    // 100 logins concentrated at hour 9; hour 3 has zero count.
    const subscore = createTimeSubscore(NULL_DB, {
      loadBaseline: makeBaselineLoader({
        u1: {
          hourHistogram: histogramAt(9, 100),
          successfulLogins: 100,
        },
      }),
    });
    const result = await subscore('u1', utcHour(3));
    expect(result).toEqual({ value: 1, baselineWarmup: false });
  });

  it('subscore=1 when rate is just below the 2 % threshold', async () => {
    // 100 logins total; hour 5 has 1 login → rate = 0.01 < 0.02.
    const histogram = new Array<number>(HOUR_HISTOGRAM_LENGTH).fill(0);
    histogram[5] = 1;
    histogram[9] = 99;
    const subscore = createTimeSubscore(NULL_DB, {
      loadBaseline: makeBaselineLoader({
        u1: { hourHistogram: histogram, successfulLogins: 100 },
      }),
    });
    const result = await subscore('u1', utcHour(5));
    expect(result).toEqual({ value: 1, baselineWarmup: false });
  });

  it('subscore=0 at exactly the 2 % threshold (≥ 2 % is normal, Req 10.3)', async () => {
    // 50 logins total; hour 5 has 1 login → rate = 0.02 = threshold.
    // Req 10.3 says "≥ 0.02 ⇒ 0.0".
    const histogram = new Array<number>(HOUR_HISTOGRAM_LENGTH).fill(0);
    histogram[5] = 1;
    histogram[9] = 49;
    const subscore = createTimeSubscore(NULL_DB, {
      loadBaseline: makeBaselineLoader({
        u1: { hourHistogram: histogram, successfulLogins: 50 },
      }),
    });
    const result = await subscore('u1', utcHour(5));
    expect(result).toEqual({ value: 0, baselineWarmup: false });
    // Sanity check — make sure the test fixture really is at the boundary.
    expect(1 / 50).toBe(TIME_ANOMALY_RATE_THRESHOLD);
  });

  it('subscore=0 when the current hour has high count', async () => {
    // 100 logins all at hour 14 → rate(14) = 1.0.
    const subscore = createTimeSubscore(NULL_DB, {
      loadBaseline: makeBaselineLoader({
        u1: {
          hourHistogram: histogramAt(14, 100),
          successfulLogins: 100,
        },
      }),
    });
    const result = await subscore('u1', utcHour(14));
    expect(result).toEqual({ value: 0, baselineWarmup: false });
  });

  it('uses UTC hour from the supplied Date (Req 10.1)', async () => {
    // Hour 0 UTC should look up bucket 0, not the local-time hour.
    const histogram = new Array<number>(HOUR_HISTOGRAM_LENGTH).fill(5);
    histogram[0] = 0; // anomalous bucket
    const subscore = createTimeSubscore(NULL_DB, {
      loadBaseline: makeBaselineLoader({
        u1: { hourHistogram: histogram, successfulLogins: 115 },
      }),
    });
    // 2025-01-01T00:00:00Z — UTC hour 0.
    const result = await subscore('u1', new Date('2025-01-01T00:00:00.000Z'));
    expect(result).toEqual({ value: 1, baselineWarmup: false });
  });
});

// ── Defensive: histogram derived total wins over stored counter ────────

describe('timeSubscore — total derived from histogram (design §8.2)', () => {
  it('uses Σ histogram[i] rather than the stored successfulLogins', async () => {
    // Stored successfulLogins=20 (warmup gate cleared) but the
    // histogram itself sums to 100. A bucket with 1 hit → rate
    // 0.01 < 0.02, so subscore should be 1.
    const histogram = new Array<number>(HOUR_HISTOGRAM_LENGTH).fill(0);
    histogram[3] = 1;
    histogram[9] = 99;
    const subscore = createTimeSubscore(NULL_DB, {
      loadBaseline: makeBaselineLoader({
        u1: { hourHistogram: histogram, successfulLogins: 20 },
      }),
    });
    const result = await subscore('u1', utcHour(3));
    expect(result).toEqual({ value: 1, baselineWarmup: false });
  });

  it('returns safe value=0 when the histogram sums to 0 even past warmup', async () => {
    // Pathological data drift: warmup gate cleared but the histogram
    // is all zeros. The detector must not divide by zero.
    const subscore = createTimeSubscore(NULL_DB, {
      loadBaseline: makeBaselineLoader({
        u1: {
          hourHistogram: new Array<number>(HOUR_HISTOGRAM_LENGTH).fill(0),
          successfulLogins: 50,
        },
      }),
    });
    const result = await subscore('u1', utcHour(3));
    expect(result).toEqual({ value: 0, baselineWarmup: false });
  });
});

// ── Defensive: baseline loader rejection ───────────────────────────────

describe('timeSubscore — baseline loader rejection', () => {
  it('falls back to warmup when the baseline loader throws', async () => {
    const subscore = createTimeSubscore(NULL_DB, {
      loadBaseline: async () => {
        throw new Error('db pool exhausted');
      },
    });
    const result = await subscore('u1', utcHour(3));
    expect(result).toEqual({ value: 0, baselineWarmup: true });
  });
});
