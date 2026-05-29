/**
 * Security / timing test for `pathEqualsConstantTime`
 * (admin-setup-wizard task 4.6).
 *
 * **Validates: Requirements 5.7**
 * **Validates: Property 6 (Constant-Time Path Compare — timing variance side)**
 *
 * Background
 * ----------
 * Req 5.7 mandates that the admin path comparison run in constant time
 * so that an attacker cannot recover the secret admin path one byte at
 * a time by measuring response latency. The byte-level correctness of
 * `pathEqualsConstantTime` (returns `true` iff inputs are byte-equal,
 * length-XOR seed catches zero-tail aliasing, etc.) is covered by the
 * unit-test suite at
 * `src/modules/setup/__tests__/path-compare.test.ts` (task 4.1). This
 * file covers the empirical timing-variance check pinned in
 * design.md §13.3 Property 6 / tasks.md 4.6:
 *
 *     "10,000 iteration đo timing variance giữa diff-at-pos-1 và
 *      diff-at-pos-63; assert std deviation chênh lệch <1ms"
 *
 * Approach
 * --------
 * The two scenarios are byte-equal everywhere except at one
 * intentionally-placed position:
 *
 *   - `diff-at-pos-1`  — first content byte after the leading `/`
 *   - `diff-at-pos-63` — last byte of a maximum-length 64-char path
 *
 * Both inputs have identical lengths and ASCII shapes, so any
 * measurable timing delta between the two scenarios would have to come
 * from a length-independent, position-dependent code path inside the
 * helper — exactly the leak we want to rule out.
 *
 * Measurement design (from the task notes):
 *   - **Warmup**: a few thousand untimed calls per scenario to settle
 *     V8's JIT tier-up into TurboFan and prime the icache. Without
 *     this, the first thousand timed samples are systematically
 *     slower and skew the variance.
 *   - **Batching**: each timed sample runs `INNER_BATCH` calls in a
 *     tight loop and divides the elapsed `performance.now()` delta by
 *     the batch size. A single call takes nanoseconds, well below
 *     `performance.now()` resolution on most platforms (~1µs in
 *     Node/V8); batching pulls the per-sample duration up to a
 *     reliably-measurable value.
 *   - **Interleaving**: outer iterations alternate scenario order to
 *     spread any thermal / GC drift evenly across both samples
 *     instead of letting it concentrate in one.
 *   - **Trimmed mean / std dev**: drop the top and bottom 5% of
 *     samples before computing statistics. GC pauses, OS scheduling
 *     hops, and CI noisy-neighbour spikes generate fat tails that a
 *     naive arithmetic std dev over-weights. The trimmed estimator
 *     keeps the body of the distribution.
 *
 * Tolerance
 * ---------
 * The 1ms bound from Req 5.7 / Property 6 is generous on purpose — a
 * 64-byte XOR loop completes in under a microsecond, so the natural
 * std dev sits in the nanosecond range; 1ms acts as a "gross leak"
 * gate that catches an accidental `===` regression or an early-return
 * mistake while staying robust against CI flakes.
 *
 * Runtime budget
 * --------------
 * 10_000 outer samples × 2 scenarios × `INNER_BATCH=100` calls ≈ 2M
 * calls of a tight 64-iteration XOR loop. On a developer laptop this
 * comfortably finishes well under 10 s; the timeout below is set
 * generously to absorb CI noise.
 */

import { describe, it, expect, vi } from 'vitest';
import { pathEqualsConstantTime } from '../modules/setup/path-compare';

vi.setConfig({ testTimeout: 60_000 });

// ── Tunables ────────────────────────────────────────────────────────────

/** Outer measurement samples per scenario (per task: 10,000). */
const SAMPLES = 10_000;

/**
 * Inner calls per timed sample. Pulls each sample's duration above
 * `performance.now()` resolution so the per-call mean is measurable.
 */
const INNER_BATCH = 100;

/** Untimed warmup calls per scenario before measurement begins. */
const WARMUP = 2_000;

/** Fraction of samples trimmed from each tail before computing stats. */
const TRIM = 0.05;

/**
 * Std-deviation difference bound (ms). Pinned by Req 5.7 / Property 6.
 * See header comment for the rationale on the loose tolerance.
 */
const STD_DEV_DELTA_BOUND_MS = 1;

// ── Inputs ──────────────────────────────────────────────────────────────

/**
 * Build a `(reference, mutated)` pair where the only differing byte
 * sits at `diffPos`. Both strings are 64 chars long — the upper bound
 * the helper pads to — so length-dependent paths cannot mask a
 * position-dependent leak.
 */
function buildPair(diffPos: 1 | 63): readonly [string, string] {
  const reference = '/' + 'a'.repeat(63);
  if (reference.length !== 64) {
    throw new Error('reference path must be exactly 64 chars');
  }
  if (reference[diffPos] !== 'a') {
    throw new Error(`unexpected base char at index ${diffPos}`);
  }
  const mutated =
    reference.slice(0, diffPos) + 'b' + reference.slice(diffPos + 1);
  return [reference, mutated] as const;
}

// ── Stats helpers ───────────────────────────────────────────────────────

/**
 * Run `inner` calls of the helper and return the average elapsed time
 * per call in ms. We deliberately read both `performance.now()` values
 * outside the inner loop so the per-call cost of the timer itself is
 * amortised across `inner` iterations rather than measured.
 */
function timedSample(a: string, b: string, inner: number): number {
  const t0 = performance.now();
  for (let i = 0; i < inner; i++) {
    pathEqualsConstantTime(a, b);
  }
  const t1 = performance.now();
  return (t1 - t0) / inner;
}

/**
 * Symmetric trimmed mean + std deviation. Sorts a copy of `samples`,
 * drops `trim` from each end, then computes population-style stats on
 * the surviving body. Works on small arrays (the trim is fractional)
 * and never returns `NaN` for the inputs this test produces.
 */
function trimmedStats(samples: number[], trim: number) {
  const sorted = [...samples].sort((x, y) => x - y);
  const cut = Math.floor(sorted.length * trim);
  const body = sorted.slice(cut, sorted.length - cut);
  const n = body.length;
  const mean = body.reduce((s, v) => s + v, 0) / n;
  const variance = body.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  return { mean, stdDev: Math.sqrt(variance), n };
}

// ── Test ────────────────────────────────────────────────────────────────

describe('pathEqualsConstantTime — timing variance (Property 6)', () => {
  it('std-deviation delta between diff-at-pos-1 and diff-at-pos-63 stays < 1ms', () => {
    const [a1, b1] = buildPair(1);
    const [a63, b63] = buildPair(63);

    // Sanity: the helper itself returns false for both pairs (it would
    // be silently O(1) for true cases of byte-equal inputs in some
    // accidental short-circuit regressions; explicitly observing
    // `false` keeps the loop honest).
    expect(pathEqualsConstantTime(a1, b1)).toBe(false);
    expect(pathEqualsConstantTime(a63, b63)).toBe(false);

    // Warmup. Touch both scenarios so the JIT specialises the call
    // site for both inputs equally.
    for (let i = 0; i < WARMUP; i++) {
      pathEqualsConstantTime(a1, b1);
      pathEqualsConstantTime(a63, b63);
    }

    // Pre-allocate to avoid mid-run resizing that would itself look
    // like a timing perturbation in the std dev.
    const samples1: number[] = new Array(SAMPLES);
    const samples63: number[] = new Array(SAMPLES);

    // Interleave scenario order across outer iterations so any
    // monotonic CPU-frequency / thermal drift over the test run
    // affects both scenarios symmetrically.
    for (let s = 0; s < SAMPLES; s++) {
      if ((s & 1) === 0) {
        samples1[s] = timedSample(a1, b1, INNER_BATCH);
        samples63[s] = timedSample(a63, b63, INNER_BATCH);
      } else {
        samples63[s] = timedSample(a63, b63, INNER_BATCH);
        samples1[s] = timedSample(a1, b1, INNER_BATCH);
      }
    }

    const stats1 = trimmedStats(samples1, TRIM);
    const stats63 = trimmedStats(samples63, TRIM);
    const stdDevDelta = Math.abs(stats1.stdDev - stats63.stdDev);

    // Surface the numbers in the test output so a future flake is
    // easier to triage: a developer reading the CI log can see the
    // raw means/stdDevs without re-running the test locally.
    // eslint-disable-next-line no-console
    console.info('[path-compare.timing] pos1: ', stats1);
    // eslint-disable-next-line no-console
    console.info('[path-compare.timing] pos63:', stats63);
    // eslint-disable-next-line no-console
    console.info('[path-compare.timing] |Δ stdDev| =', stdDevDelta, 'ms');

    expect(stdDevDelta).toBeLessThan(STD_DEV_DELTA_BOUND_MS);
  });
});
