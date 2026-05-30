/**
 * Aggregate the three anomaly subscores (geo / time / device) into a
 * single `{ score, baselineWarmup }` shape that LoginGuard.onSuccess
 * compares against `Lockout_Policy.anomalyScoreThreshold` (admin-
 * setup-wizard task 7.6; Req 12.1; design §8.4).
 *
 * Spec mapping:
 *
 *   - **Req 12.1 / design §8.4** — `score = max(g.value, t.value,
 *     d.value)` rounded to exactly 2 decimal places. The subscore
 *     value type is `0 | 1` so the maximum is also `0 | 1`; the
 *     2-decimal canonicalisation comes from running `Number(max
 *     .toFixed(2))`, which yields the numbers `0` (= `0.00`) or `1`
 *     (= `1.00`). This matches the design listing verbatim and
 *     keeps Property 9 ("`anomalyScore ∈ {0.00, 1.00}` with exact
 *     2-decimal precision") trivially satisfied — every output of
 *     {@link aggregate} lands in `{0, 1}` because the inputs do.
 *
 *   - **Req 12.5** — `baselineWarmup` is the OR-fold of the three
 *     inputs. The aggregator does not consult the threshold or the
 *     policy at all; the OR-fold is consumed downstream by
 *     LoginGuard (task 8.1, design §8.5) which short-circuits the
 *     threshold-action dispatch when *any* detector is still
 *     warming up.
 *
 *   - **Detector disabled by policy.** When the operator turns an
 *     axis off (e.g. `geoAnomalyEnabled=false`), the caller is
 *     responsible for substituting {@link DISABLED_SUBSCORE} for
 *     that axis. The aggregator stays policy-agnostic so it can be
 *     unit-tested in isolation. The {@link runDetectors} helper
 *     wires policy gating + subscore execution + aggregation in one
 *     call; LoginGuard.onSuccess uses it on the success path so the
 *     "all three off → score=0, no warmup" rule from design §8.4
 *     (final paragraph) holds without any per-detector branching at
 *     the call site.
 *
 * Validates: Requirements 12.1 (Property 9: Anomaly Score Bound).
 */

import type { Subscore } from './types';

// ── Public surface ──────────────────────────────────────────────────────

/**
 * Result returned by {@link aggregate} (and {@link runDetectors}).
 *
 * `score` is a finite number in `{0, 1}` post-2-decimal rounding;
 * downstream consumers may format it as `"0.00"` / `"1.00"` for
 * persistence to `login_attempts.anomaly_score` (a `numeric(4,2)`
 * column — design §3.4 / `packages/database/src/schema/security.ts`)
 * but the in-memory shape is numeric for cheap threshold comparison.
 *
 * `baselineWarmup` is the OR-fold (Req 12.5); LoginGuard short-
 * circuits the threshold-action dispatch when this is `true`.
 */
export interface AggregateResult {
  /** `0.00` or `1.00`; numeric for cheap threshold comparison (Req 12.1). */
  readonly score: number;
  /** `true` when *any* axis is still warming up (Req 12.5; design §8.4). */
  readonly baselineWarmup: boolean;
}

/**
 * Sentinel subscore for an axis disabled by policy. Callers
 * substitute this for `geoSubscoreFn()` / `timeSubscoreFn()` /
 * `deviceSubscoreFn()` when the corresponding `*AnomalyEnabled`
 * flag is `false`.
 *
 *   - `value=0` keeps the axis from inflating `Math.max`.
 *   - `baselineWarmup=false` keeps the OR-fold honest: a *disabled*
 *     axis is not "warming up" — operator intent is "ignore this
 *     signal entirely". Treating disabled-as-warmup would silently
 *     bypass the threshold-action dispatch (Req 12.5) for active
 *     axes too, which is the opposite of what the operator asked
 *     for.
 *
 * Frozen so the constant can't be mutated by a misbehaving caller
 * — `Subscore` is a `readonly` type so this is mostly belt-and-
 * braces, but the runtime guard catches the rare cast-and-mutate
 * pattern in tests.
 */
export const DISABLED_SUBSCORE: Subscore = Object.freeze({
  value: 0,
  baselineWarmup: false,
});

/**
 * Aggregate three subscores into a single `{ score, baselineWarmup }`
 * pair (Req 12.1; design §8.4 listing).
 *
 * Pure function — no I/O, no policy lookups, no logging — so the
 * Property 9 tests can hammer it across thousands of input
 * permutations without any setup. The two invariants the function
 * preserves are:
 *
 *   - `score === Number(Math.max(g.value, t.value, d.value).toFixed(2))`
 *     for every well-formed `Subscore` triple. Since `value` is
 *     typed `0 | 1`, the output is always exactly `0` or `1` (=
 *     `0.00` or `1.00`), satisfying Property 9.
 *
 *   - `baselineWarmup === g.baselineWarmup || t.baselineWarmup ||
 *     d.baselineWarmup` — short-circuit OR matches the design
 *     listing verbatim and keeps the fold associative.
 */
export function aggregate(g: Subscore, t: Subscore, d: Subscore): AggregateResult {
  const baselineWarmup = g.baselineWarmup || t.baselineWarmup || d.baselineWarmup;
  // Math.max over `0 | 1` triples lands in `{0, 1}` → toFixed(2) →
  // Number → `{0, 1}`. The double conversion through string is the
  // canonical way to enforce 2-decimal precision in the design §8.4
  // listing; we keep it identical so the persistence column
  // (`numeric(4,2)`) round-trips byte-equal whether the caller goes
  // through the aggregator or formats `score.toFixed(2)` themselves.
  const score = Number(Math.max(g.value, t.value, d.value).toFixed(2));
  return { score, baselineWarmup };
}

/**
 * Subset of `LockoutPolicy` (`apps/cms/src/modules/setup/policy-codec
 * .ts`) the detector runner cares about. Typed structurally so
 * callers don't have to import the full Zod-derived type just to
 * gate three booleans — keeps the module dependency-light and
 * easy to unit-test.
 */
export interface AnomalyPolicyView {
  readonly geoAnomalyEnabled: boolean;
  readonly timeAnomalyEnabled: boolean;
  readonly deviceAnomalyEnabled: boolean;
}

/**
 * Per-call hooks for {@link runDetectors}. Each `*SubscoreFn` is the
 * pre-bound subscore the caller wants to run when the matching
 * policy flag is on; production wires it to the factories from
 * `geo.ts` / `time.ts` / `device.ts`, tests pass synchronous stubs.
 *
 * The shape is kept thunk-based (`() => Promise<Subscore>`) rather
 * than `(...args) => Promise<Subscore>` because each detector takes
 * a different argument list (geo wants `userId, ip, attempt`; time
 * wants `userId, now`; device wants `userId, ua, lang, attempt`);
 * binding the args at the call site keeps `runDetectors` axis-
 * agnostic.
 */
export interface RunDetectorsArgs {
  readonly policy: AnomalyPolicyView;
  /** Pre-bound geo subscore; called only when `policy.geoAnomalyEnabled`. */
  readonly geoSubscoreFn: () => Promise<Subscore>;
  /** Pre-bound time subscore; called only when `policy.timeAnomalyEnabled`. */
  readonly timeSubscoreFn: () => Promise<Subscore>;
  /** Pre-bound device subscore; called only when `policy.deviceAnomalyEnabled`. */
  readonly deviceSubscoreFn: () => Promise<Subscore>;
}

/**
 * Run the three subscores under policy gating and aggregate the
 * result.
 *
 *   - When a `*AnomalyEnabled` flag is `false`, the matching
 *     subscore function is **not invoked** — substituting {@link
 *     DISABLED_SUBSCORE} on the spot avoids a round-trip through
 *     the detector's I/O (DB read for the baseline, MMDB lookup
 *     for geo, etc.) when the operator has explicitly told us not
 *     to care about that axis.
 *
 *   - Enabled detectors run in parallel via `Promise.all`. They're
 *     independent — the geo subscore's result has no dependency on
 *     the time subscore's result and vice versa — so parallelising
 *     is correct and saves a few hundred ms on cold MMDB loads.
 *     If a detector rejects, the rejection bubbles up as-is; the
 *     caller (LoginGuard.onSuccess in task 8.1) is responsible for
 *     wrapping in a try/catch and falling back to the safe "no
 *     anomaly" branch.
 *
 *   - When all three flags are `false`, no subscore runs and
 *     `aggregate(DISABLED_SUBSCORE, DISABLED_SUBSCORE,
 *     DISABLED_SUBSCORE)` returns `{ score: 0, baselineWarmup:
 *     false }` — which is exactly the "anomaly disabled" outcome
 *     described in design §8.4 final paragraph and §8.5 ("score = 0
 *     never crosses any non-trivial threshold so no action fires").
 */
export async function runDetectors(args: RunDetectorsArgs): Promise<AggregateResult> {
  const { policy } = args;
  const [g, t, d] = await Promise.all([
    policy.geoAnomalyEnabled ? args.geoSubscoreFn() : Promise.resolve(DISABLED_SUBSCORE),
    policy.timeAnomalyEnabled ? args.timeSubscoreFn() : Promise.resolve(DISABLED_SUBSCORE),
    policy.deviceAnomalyEnabled ? args.deviceSubscoreFn() : Promise.resolve(DISABLED_SUBSCORE),
  ]);
  return aggregate(g, t, d);
}
