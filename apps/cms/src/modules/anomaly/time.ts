/**
 * Time subscore for the Anomaly Detector (admin-setup-wizard task 7.3;
 * Req 10.1–10.5; design §8.2).
 *
 * `timeSubscore(userId, now)` reads the user's
 * `login_baselines.hour_histogram` (24 UTC-hour buckets), reconstructs
 * `totalLogins = Σ histogram[i]` from the histogram itself, and flags
 * the attempt as anomalous when the rate at the current UTC hour
 * (`histogram[h] / totalLogins < 0.02`) falls below 2 %. The result is
 * a {@link Subscore} that the {@link AnomalyDetector} aggregator picks
 * up alongside the geo and device subscores (design §8.4).
 *
 * The shape mirrors {@link
 *   /apps/cms/src/modules/anomaly/geo.ts createGeoSubscore}: a factory
 * binds the function to a Database handle (or a stubbed
 * {@link TimeBaselineLoader} in tests), the default loader is
 * Drizzle-backed against `login_baselines`, and the per-call shape is
 * `(userId, now)`.
 *
 * Spec mapping (kept linear so each Req maps to one code path):
 *
 *   1. **Req 10.4 — baseline warmup.** The histogram is only
 *      statistically meaningful once the user has accumulated at
 *      least 10 successful logins. While `successfulLogins < 10`,
 *      the subscore returns `{ value: 0, baselineWarmup: true }`
 *      regardless of the current hour. The aggregator then OR-folds
 *      `baselineWarmup` across the three detectors so a warmup-on
 *      *any* axis bypasses the threshold-action dispatch (Req 12.5).
 *
 *   2. **Req 10.1 / 10.2 / 10.3 — rate check.** Once the warmup gate
 *      is cleared, we derive the hour `h = now.getUTCHours()` and
 *      compute the rate `histogram[h] / totalLogins`. Below 2 %
 *      yields `{ value: 1, baselineWarmup: false }` (anomaly); at-or-
 *      above 2 % yields `{ value: 0, baselineWarmup: false }`.
 *
 *      We deliberately re-derive `totalLogins` from the histogram
 *      itself rather than reusing the stored `successfulLogins`
 *      counter — design §8.2 calls this out as "test reproducible".
 *      The two values *should* agree by construction (the baseline
 *      writer in task 7.5 increments both atomically), but if a
 *      historical row has drifted (e.g. a botched manual SQL fix),
 *      using the sum keeps the rate self-consistent: a histogram
 *      whose buckets all read 0 reads as `totalLogins=0` and short-
 *      circuits to the safe `value=0` branch instead of producing
 *      `NaN`.
 *
 *   3. **Req 10.5 — baseline updates.** This module is a *reader*;
 *      the histogram bucket increment for the current attempt
 *      happens in `apps/cms/src/modules/anomaly/baseline-store.ts`
 *      (task 7.5), which runs inside the same transaction as
 *      `LoginGuard.onSuccess`. Keeping read and write split mirrors
 *      the geo subscore's separation and avoids double-counting the
 *      *current* attempt against the baseline used to score it.
 *
 * Defensive branches:
 *
 *   - Baseline loader rejection (DB pool blip) collapses to "no
 *     baseline" via {@link safeLoadBaseline}, which falls into the
 *     warmup branch. The detector must never fail a successful
 *     login because of its own infrastructure.
 *   - A malformed or short histogram (`< 24` entries) is padded with
 *     zeros so the index lookup is always defined; entries that
 *     aren't finite non-negative numbers are coerced to 0 for the
 *     same reason.
 *   - `totalLogins === 0` after warmup gate (impossible by
 *     construction but cheap to guard) returns the safe `value=0`
 *     branch instead of dividing by zero.
 *
 * Validates: Requirements 10.1, 10.2, 10.3, 10.4, 10.5.
 */

import { eq } from 'drizzle-orm';
import { loginBaselines, type Database } from '@lumibase/database';

import type { Subscore, TimeBaselineSnapshot } from './types';

// ── Public types ────────────────────────────────────────────────────────

/**
 * Loads the per-user `login_baselines` snapshot the time detector
 * consults. Defaults to {@link loadTimeBaselineFromDb}; tests inject a
 * stub returning a known fixture so the detector's branching can be
 * exercised without a real DB row.
 */
export type TimeBaselineLoader = (
  userId: string,
) => Promise<TimeBaselineSnapshot | null>;

/**
 * Per-call hooks for {@link createTimeSubscore}. Production passes a
 * Database handle and lets the factory wire the Postgres baseline
 * loader; tests inject `loadBaseline` directly so the subscore logic
 * is exercised in isolation.
 */
export interface TimeSubscoreOptions {
  /** Override the baseline loader; defaults to a Drizzle row read. */
  readonly loadBaseline?: TimeBaselineLoader;
}

/**
 * Bound time subscore — the production-facing function shape. Matches
 * the {@link AnomalyDetector.timeSubscore} signature in design §6.3.
 */
export type TimeSubscoreFn = (
  userId: string,
  now: Date,
) => Promise<Subscore>;

// ── Public surface ──────────────────────────────────────────────────────

/**
 * Number of successful logins required before the time histogram is
 * considered statistically meaningful. Below this threshold the
 * subscore stays at 0 and flips `baselineWarmup` (Req 10.4).
 */
export const TIME_BASELINE_MIN_SUCCESSFUL_LOGINS = 10;

/**
 * Rate threshold below which the current UTC hour is flagged as
 * anomalous. `histogram[h] / totalLogins < 0.02` ⇒ subscore = 1
 * (Req 10.2). At-or-above ⇒ subscore = 0 (Req 10.3).
 */
export const TIME_ANOMALY_RATE_THRESHOLD = 0.02;

/** Number of UTC-hour buckets in `login_baselines.hour_histogram`. */
export const HOUR_HISTOGRAM_LENGTH = 24;

/**
 * Build a time subscore bound to a Database handle. The returned
 * function reads the per-user baseline through {@link
 * loadTimeBaselineFromDb} unless `options.loadBaseline` is supplied.
 */
export function createTimeSubscore(
  db: Database,
  options: TimeSubscoreOptions = {},
): TimeSubscoreFn {
  const loadBaseline =
    options.loadBaseline ?? ((userId) => loadTimeBaselineFromDb(db, userId));
  return (userId, now) => timeSubscoreImpl(userId, now, { loadBaseline });
}

/**
 * Convenience entry point that mirrors the {@link
 * AnomalyDetector.timeSubscore} signature in design §6.3. Builds a
 * fresh subscore function on every call from the supplied `db`; in
 * production hot paths prefer {@link createTimeSubscore} so the
 * baseline loader binds once per request lifecycle rather than once
 * per call.
 */
export function timeSubscore(
  db: Database,
  userId: string,
  now: Date,
  options?: TimeSubscoreOptions,
): Promise<Subscore> {
  return createTimeSubscore(db, options)(userId, now);
}

// ── Implementation ──────────────────────────────────────────────────────

interface ResolvedDeps {
  readonly loadBaseline: TimeBaselineLoader;
}

/**
 * Core branching logic. Sequence:
 *
 *   1. Load the baseline; a missing row (`null`) is treated as
 *      `successfulLogins=0` + zeroed histogram, which always trips
 *      warmup.
 *   2. Req 10.4 — warmup gate on `successfulLogins < 10`.
 *   3. Req 10.2 / 10.3 — rate check at the current UTC hour.
 */
async function timeSubscoreImpl(
  _userId: string,
  now: Date,
  deps: ResolvedDeps,
): Promise<Subscore> {
  const baseline = await safeLoadBaseline(deps.loadBaseline, _userId);
  const successfulLogins = baseline?.successfulLogins ?? 0;

  // Req 10.4 — warmup wins over signal.
  if (successfulLogins < TIME_BASELINE_MIN_SUCCESSFUL_LOGINS) {
    return { value: 0, baselineWarmup: true };
  }

  const histogram = normaliseHistogram(baseline?.hourHistogram);
  const totalLogins = histogram.reduce((sum, n) => sum + n, 0);

  // Defensive: an `successfulLogins >= 10` baseline whose histogram
  // sums to 0 is a data integrity issue (the writer in task 7.5
  // increments both atomically). Treating it as the safe `value=0`
  // branch — rather than dividing by zero — keeps the detector
  // graceful instead of throwing on the request path.
  if (totalLogins === 0) {
    return { value: 0, baselineWarmup: false };
  }

  const hour = now.getUTCHours();
  const rate = histogram[hour]! / totalLogins;

  // Req 10.2 / 10.3 — strictly below 2 % is anomalous.
  return {
    value: rate < TIME_ANOMALY_RATE_THRESHOLD ? 1 : 0,
    baselineWarmup: false,
  };
}

/**
 * Wrap a baseline loader call so a transient DB error (e.g.
 * connection pool blip) doesn't bubble up into the LoginGuard hook.
 * On rejection the time detector falls back to "no baseline known",
 * which collapses to warmup mode — strictly safer than crashing the
 * login.
 */
async function safeLoadBaseline(
  loader: TimeBaselineLoader,
  userId: string,
): Promise<TimeBaselineSnapshot | null> {
  try {
    return await loader(userId);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      '[anomaly/time] baseline load failed; treating as warmup',
      err,
    );
    return null;
  }
}

/**
 * Coerce the raw `hour_histogram` jsonb column into a fixed-length
 * 24-entry number array. The column ships with a `Array(24).fill(0)`
 * default and the writer always preserves the length, but driver
 * round-trips and historical data fixes can produce off-by-one or
 * stringified values; coercing here keeps the index access total.
 *
 *   - `Array.isArray` guards against the rare jsonb-as-string
 *     driver mode (mirrors `parseCountries` in geo.ts).
 *   - Each entry is normalised to a finite non-negative integer;
 *     `NaN`, negatives, and non-numbers fall to 0 so the rate math
 *     stays well-defined.
 *   - The output is *always* length 24 — shorter inputs are zero-
 *     padded; longer inputs are truncated.
 */
function normaliseHistogram(raw: readonly number[] | undefined): number[] {
  const out = new Array<number>(HOUR_HISTOGRAM_LENGTH).fill(0);
  if (!Array.isArray(raw)) return out;
  const len = Math.min(raw.length, HOUR_HISTOGRAM_LENGTH);
  for (let i = 0; i < len; i++) {
    const v = Number(raw[i]);
    out[i] = Number.isFinite(v) && v > 0 ? v : 0;
  }
  return out;
}

// ── Baseline loader ─────────────────────────────────────────────────────

/**
 * Read the time-relevant subset of `login_baselines` for a user.
 *
 * The detector only needs `hourHistogram` and `successfulLogins`;
 * the other columns (`countries`, `deviceFingerprints`) belong to
 * the geo / device subscores. Returning `null` when the row is
 * missing keeps the detector's warmup branch unified — the caller
 * doesn't have to special-case "first ever login" vs. "loaded
 * baseline with zero history".
 *
 * `hourHistogram` is stored as `jsonb` (design §3.5); driver shapes
 * vary, so {@link normaliseHistogram} coerces the result downstream
 * regardless of whether we get an array or a JSON string here.
 */
export async function loadTimeBaselineFromDb(
  db: Database,
  userId: string,
): Promise<TimeBaselineSnapshot | null> {
  const rows = await db
    .select({
      hourHistogram: loginBaselines.hourHistogram,
      successfulLogins: loginBaselines.successfulLogins,
    })
    .from(loginBaselines)
    .where(eq(loginBaselines.userId, userId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return {
    hourHistogram: parseHourHistogram(row.hourHistogram),
    successfulLogins: Number.isInteger(row.successfulLogins)
      ? row.successfulLogins
      : 0,
  };
}

function parseHourHistogram(raw: unknown): number[] {
  // jsonb with the typed default `Array(24).fill(0)` yields an array
  // on postgres-js; node-postgres returns the same. Some drivers
  // return a string when the column is queried via raw SQL — guard
  // both shapes for parity with `parseCountries` in geo.ts.
  if (Array.isArray(raw)) {
    return raw.map((entry) => {
      const v = Number(entry);
      return Number.isFinite(v) && v > 0 ? v : 0;
    });
  }
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map((entry) => {
          const v = Number(entry);
          return Number.isFinite(v) && v > 0 ? v : 0;
        });
      }
    } catch {
      // fall through
    }
  }
  return [];
}
