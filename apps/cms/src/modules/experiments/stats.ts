/**
 * Assignment and statistics for A/B experiments (#763). Pure functions: no
 * database, no clock, so delivery, the report route and the agent skills all
 * agree on the same numbers.
 */

export const CONTROL_ARM = 'control';
/** Buckets per experiment; weights are spread across them. */
export const BUCKETS = 10_000;
/** Two-sided significance level used for a recommendation. */
export const DEFAULT_ALPHA = 0.05;

export interface ArmWeight {
  key: string;
  weight: number;
}

/** FNV-1a 32-bit: stable across runtimes (Workers and Node), no crypto needed. */
export function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The visitor's bucket for one experiment, in `[0, BUCKETS)`. Salted by the experiment key so experiments split independently. */
export function bucketFor(experimentKey: string, visitorId: string): number {
  return fnv1a(`${experimentKey}:${visitorId}`) % BUCKETS;
}

/**
 * The arm a visitor sees. Arms are taken in the given order (callers sort by
 * key); a zero-weight arm never receives traffic. Returns `null` when no arm
 * has weight.
 */
export function assignArm(experimentKey: string, visitorId: string, arms: readonly ArmWeight[]): string | null {
  const live = arms.filter((a) => a.weight > 0);
  const total = live.reduce((s, a) => s + a.weight, 0);
  if (total <= 0) return null;
  const point = (bucketFor(experimentKey, visitorId) / BUCKETS) * total;
  let acc = 0;
  for (const arm of live) {
    acc += arm.weight;
    if (point < acc) return arm.key;
  }
  return live[live.length - 1]!.key;
}

export interface ArmCounts {
  key: string;
  exposures: number;
  conversions: number;
}

export interface ArmResult extends ArmCounts {
  /** conversions / exposures, 0 without exposures. */
  rate: number;
  /** Relative change of `rate` against control; null for control or a control without conversions. */
  uplift: number | null;
  /** Two-proportion z-test against control; null for control or without data. */
  z: number | null;
  pValue: number | null;
  significant: boolean;
}

export interface ExperimentReport {
  arms: ArmResult[];
  totals: { exposures: number; conversions: number };
  /** Every arm reached `minSampleSize` exposures. */
  sampleReached: boolean;
  /** The arm a reviewer should promote, or null when the data does not support one. */
  recommendation: { arm: string; reason: string } | null;
}

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 erf approximation, |error| < 1.5e-7). */
export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * (Math.abs(x) / Math.SQRT2));
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-((x / Math.SQRT2) ** 2));
  return x >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/** Two-proportion pooled z-test. Returns null when either side has no exposures or the pooled variance is zero. */
export function twoProportionZ(a: ArmCounts, b: ArmCounts): { z: number; pValue: number } | null {
  if (a.exposures <= 0 || b.exposures <= 0) return null;
  const p1 = a.conversions / a.exposures;
  const p2 = b.conversions / b.exposures;
  const pooled = (a.conversions + b.conversions) / (a.exposures + b.exposures);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / a.exposures + 1 / b.exposures));
  if (!Number.isFinite(se) || se === 0) return null;
  const z = (p2 - p1) / se;
  return { z, pValue: 2 * (1 - normalCdf(Math.abs(z))) };
}

const round = (v: number, d = 4) => Math.round(v * 10 ** d) / 10 ** d;

/**
 * Per-arm rates against control and a recommendation:
 * - nothing before every arm has `minSampleSize` exposures;
 * - the best challenger when it beats control with p < alpha (Bonferroni-
 *   corrected for the number of challengers);
 * - `control` when every challenger is significantly worse;
 * - otherwise nothing (keep running or stop without a winner).
 */
export function buildReport(
  counts: readonly ArmCounts[],
  opts: { minSampleSize: number; alpha?: number } = { minSampleSize: 100 },
): ExperimentReport {
  const alpha = opts.alpha ?? DEFAULT_ALPHA;
  const control = counts.find((c) => c.key === CONTROL_ARM) ?? null;
  const challengers = counts.filter((c) => c.key !== CONTROL_ARM);
  const corrected = alpha / Math.max(1, challengers.length);
  const arms: ArmResult[] = counts.map((c) => {
    const rate = c.exposures > 0 ? c.conversions / c.exposures : 0;
    if (c.key === CONTROL_ARM || !control) {
      return { ...c, rate: round(rate), uplift: null, z: null, pValue: null, significant: false };
    }
    const controlRate = control.exposures > 0 ? control.conversions / control.exposures : 0;
    const test = twoProportionZ(control, c);
    return {
      ...c,
      rate: round(rate),
      uplift: controlRate > 0 ? round((rate - controlRate) / controlRate) : null,
      z: test ? round(test.z, 3) : null,
      pValue: test ? round(test.pValue, 6) : null,
      significant: test !== null && test.pValue < corrected,
    };
  });
  const totals = counts.reduce((t, c) => ({ exposures: t.exposures + c.exposures, conversions: t.conversions + c.conversions }), { exposures: 0, conversions: 0 });
  const sampleReached = counts.length > 1 && counts.every((c) => c.exposures >= opts.minSampleSize);

  let recommendation: ExperimentReport['recommendation'] = null;
  if (control && sampleReached) {
    const better = arms.filter((a) => a.key !== CONTROL_ARM && a.significant && (a.z ?? 0) > 0).sort((x, y) => y.rate - x.rate);
    const worse = arms.filter((a) => a.key !== CONTROL_ARM).every((a) => a.significant && (a.z ?? 0) < 0);
    if (better[0]) {
      const b = better[0];
      recommendation = {
        arm: b.key,
        reason: `"${b.key}" converts at ${(b.rate * 100).toFixed(2)}% vs control's ${(arms.find((a) => a.key === CONTROL_ARM)!.rate * 100).toFixed(2)}% (p=${b.pValue}, alpha ${round(corrected, 4)}).`,
      };
    } else if (challengers.length > 0 && worse) {
      recommendation = { arm: CONTROL_ARM, reason: 'Every challenger converts significantly worse than control.' };
    }
  }
  return { arms, totals, sampleReached, recommendation };
}
