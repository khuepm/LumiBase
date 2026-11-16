/**
 * Pure metric functions for the Jev benchmark (J06, #513). No I/O, no clock,
 * no randomness: the same observations always give the same numbers.
 *
 * Definitions (also in docs/en/features/jev-benchmark.md):
 *   - A sample is *decided* when the call succeeded, the answer clears the
 *     threshold, and (for choice questions) the answer is not an abstain
 *     option such as `unknown`. Everything else is *abstained*, failures
 *     included.
 *   - coverage = decided / all samples.
 *   - selective precision = correct decided / decided. Thresholds are chosen
 *     on this number.
 *   - per-label precision = TP / predicted-as-label; recall = TP / gold-label,
 *     where an abstained or failed sample counts as a miss.
 *   - Brier and ECE use every answered sample (failures excluded). They show
 *     how the reported probabilities line up with the labels on this dataset.
 *     A probability or confidence is not a correctness probability.
 *   - Intervals are Wilson score 95% intervals; percentiles are nearest-rank.
 */

/** Two-sided 95% normal quantile. */
const Z_95 = 1.959963984540054;

export interface Interval {
  low: number;
  high: number;
}

export interface Rate {
  k: number;
  n: number;
  /** k / n, or null when n = 0 (no evidence is not zero). */
  value: number | null;
  /** Wilson 95% interval, or null when n = 0. */
  interval: Interval | null;
}

export function wilsonInterval(k: number, n: number, z: number = Z_95): Interval | null {
  if (!Number.isInteger(k) || !Number.isInteger(n) || k < 0 || n < 0 || k > n) {
    throw new RangeError(`wilsonInterval needs integers 0 <= k <= n, got k=${k} n=${n}`);
  }
  if (n === 0) return null;
  const p = k / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const half = (z / denominator) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  // The bounds are exactly 0 / 1 at k = 0 / k = n; avoid printing 0.9999999999999999.
  return {
    low: k === 0 ? 0 : Math.max(0, centre - half),
    high: k === n ? 1 : Math.min(1, centre + half),
  };
}

export function rate(k: number, n: number): Rate {
  return { k, n, value: n === 0 ? null : k / n, interval: wilsonInterval(k, n) };
}

/** Nearest-rank percentile (p in 0..100). Null for an empty list. */
export function percentile(values: readonly number[], p: number): number | null {
  if (p < 0 || p > 100) throw new RangeError(`percentile p must be in 0..100, got ${p}`);
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1]!;
}

/** Mean squared error of P(true) against a boolean label. */
export function brierBinary(items: ReadonlyArray<{ p: number; gold: boolean }>): number | null {
  if (items.length === 0) return null;
  let sum = 0;
  for (const { p, gold } of items) sum += (p - (gold ? 1 : 0)) ** 2;
  return sum / items.length;
}

/** Multi-class Brier score: mean over samples of Σ_k (p_k − y_k)². Range 0..2. */
export function brierMulticlass(
  items: ReadonlyArray<{ probabilities: Record<string, number>; gold: string }>,
  options: readonly string[],
): number | null {
  if (items.length === 0) return null;
  let sum = 0;
  for (const { probabilities, gold } of items) {
    for (const option of options) sum += ((probabilities[option] ?? 0) - (option === gold ? 1 : 0)) ** 2;
  }
  return sum / items.length;
}

/**
 * Expected calibration error with equal-width bins over [0, 1]:
 * Σ_b (n_b / N) · |observed_b − mean confidence_b|. `hit` is the event the
 * confidence is compared with (the chosen label being right, or the label
 * being `true` for P(true)).
 */
export function expectedCalibrationError(
  items: ReadonlyArray<{ confidence: number; hit: boolean }>,
  bins: number,
): number | null {
  if (!Number.isInteger(bins) || bins < 1) throw new RangeError(`bins must be a positive integer, got ${bins}`);
  if (items.length === 0) return null;
  const count = new Array<number>(bins).fill(0);
  const confidence = new Array<number>(bins).fill(0);
  const hits = new Array<number>(bins).fill(0);
  for (const item of items) {
    const bin = Math.min(bins - 1, Math.max(0, Math.floor(item.confidence * bins)));
    count[bin]! += 1;
    confidence[bin]! += item.confidence;
    if (item.hit) hits[bin]! += 1;
  }
  let ece = 0;
  for (let b = 0; b < bins; b += 1) {
    const n = count[b]!;
    if (n === 0) continue;
    ece += (n / items.length) * Math.abs(hits[b]! / n - confidence[b]! / n);
  }
  return ece;
}

export interface LabelMetrics {
  gold: number;
  predicted: number;
  precision: Rate;
  recall: Rate;
}

export interface CalibrationMetrics {
  /** Answered samples the scores are computed on. */
  n: number;
  brier: number | null;
  ece: number | null;
  note: typeof CALIBRATION_NOTE;
}

export const CALIBRATION_NOTE =
  'Brier/ECE describe how reported probabilities line up with these labels; not a correctness probability.';

export interface QuestionMetrics {
  n: number;
  /** Threshold the predictions were cut at (null = no confidence cut). */
  threshold: number | null;
  answered: number;
  decided: number;
  coverage: Rate;
  abstention: Rate;
  selectivePrecision: Rate;
  perLabel: Record<string, LabelMetrics>;
  calibration: CalibrationMetrics;
}

function labelMetrics(pairs: ReadonlyArray<{ gold: string; prediction: string | null }>, labels: readonly string[]) {
  const out: Record<string, LabelMetrics> = {};
  for (const label of labels) {
    let tp = 0;
    let predicted = 0;
    let gold = 0;
    for (const pair of pairs) {
      if (pair.gold === label) gold += 1;
      if (pair.prediction === label) {
        predicted += 1;
        if (pair.gold === label) tp += 1;
      }
    }
    out[label] = { gold, predicted, precision: rate(tp, predicted), recall: rate(tp, gold) };
  }
  return out;
}

export interface ChoiceObservation {
  gold: string;
  /** null when the call failed or timed out. */
  answer: { choice: string; confidence: number; probabilities: Record<string, number> } | null;
}

export interface ChoiceSpec {
  options: readonly string[];
  /** Options that count as abstention (for the taxonomy preset: `unknown`). */
  abstain: readonly string[];
}

/**
 * Choice question: the prediction is the answered option, dropped when its
 * confidence is below `threshold`. An abstain option is still a prediction
 * for per-label metrics (so `unknown` on thin content counts as right) but is
 * not a decision for coverage and selective precision.
 */
export function evaluateChoice(
  observations: readonly ChoiceObservation[],
  spec: ChoiceSpec,
  threshold: number | null,
  eceBins: number,
): QuestionMetrics {
  const predictions = observations.map((o) => {
    if (o.answer === null) return null;
    if (threshold !== null && o.answer.confidence < threshold) return null;
    return o.answer.choice;
  });
  const decidedIdx = predictions
    .map((prediction, i) => (prediction !== null && !spec.abstain.includes(prediction) ? i : -1))
    .filter((i) => i >= 0);
  const correct = decidedIdx.filter((i) => predictions[i] === observations[i]!.gold).length;
  const answered = observations.filter((o) => o.answer !== null);
  const n = observations.length;
  return {
    n,
    threshold,
    answered: answered.length,
    decided: decidedIdx.length,
    coverage: rate(decidedIdx.length, n),
    abstention: rate(n - decidedIdx.length, n),
    selectivePrecision: rate(correct, decidedIdx.length),
    perLabel: labelMetrics(observations.map((o, i) => ({ gold: o.gold, prediction: predictions[i]! })), spec.options),
    calibration: {
      n: answered.length,
      brier: brierMulticlass(answered.map((o) => ({ probabilities: o.answer!.probabilities, gold: o.gold })), spec.options),
      ece: expectedCalibrationError(
        answered.map((o) => ({ confidence: o.answer!.confidence, hit: o.answer!.choice === o.gold })),
        eceBins,
      ),
      note: CALIBRATION_NOTE,
    },
  };
}

export interface NoulObservation {
  gold: boolean;
  /** P(true) as reported, or null when the call failed. */
  p: number | null;
}

/**
 * Noul question with a symmetric threshold t in [0.5, 1): true when
 * p >= t, false when p <= 1 − t, abstained in between.
 */
export function noulPrediction(p: number | null, threshold: number): boolean | null {
  if (p === null) return null;
  if (p >= threshold) return true;
  if (p <= 1 - threshold) return false;
  return null;
}

export function evaluateNoul(observations: readonly NoulObservation[], threshold: number, eceBins: number): QuestionMetrics {
  if (threshold < 0.5 || threshold > 1) throw new RangeError(`noul threshold must be in 0.5..1, got ${threshold}`);
  const predictions = observations.map((o) => noulPrediction(o.p, threshold));
  const decided = predictions.filter((p) => p !== null).length;
  const correct = predictions.filter((p, i) => p !== null && p === observations[i]!.gold).length;
  const answered = observations.filter((o) => o.p !== null);
  const n = observations.length;
  return {
    n,
    threshold,
    answered: answered.length,
    decided,
    coverage: rate(decided, n),
    abstention: rate(n - decided, n),
    selectivePrecision: rate(correct, decided),
    perLabel: labelMetrics(
      observations.map((o, i) => ({
        gold: String(o.gold),
        prediction: predictions[i] === null ? null : String(predictions[i]),
      })),
      ['true', 'false'],
    ),
    calibration: {
      n: answered.length,
      brier: brierBinary(answered.map((o) => ({ p: o.p!, gold: o.gold }))),
      ece: expectedCalibrationError(answered.map((o) => ({ confidence: o.p!, hit: o.gold })), eceBins),
      note: CALIBRATION_NOTE,
    },
  };
}

export interface CallRecord {
  latencyMs: number;
  /** Decision error code, or null on success. */
  error: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null } | null;
}

export interface Prices {
  /** USD per million input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
}

export interface CallSummary {
  calls: number;
  failures: Rate;
  timeouts: Rate;
  failuresByCode: Record<string, number>;
  latencyMs: { p50: number | null; p95: number | null; n: number };
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    /** Successful calls that reported each count. */
    reportedInput: number;
    reportedOutput: number;
  };
  /** Only when prices are given and every successful call reported both counts. */
  costUsd: number | null;
  costNote: string;
}

export function summarizeCalls(records: readonly CallRecord[], prices: Prices | null): CallSummary {
  const failuresByCode: Record<string, number> = {};
  for (const record of records) {
    if (record.error !== null) failuresByCode[record.error] = (failuresByCode[record.error] ?? 0) + 1;
  }
  const failures = records.filter((r) => r.error !== null).length;
  const successes = records.filter((r) => r.error === null);
  const inputs = successes.map((r) => r.usage?.inputTokens ?? null).filter((v): v is number => v !== null);
  const outputs = successes.map((r) => r.usage?.outputTokens ?? null).filter((v): v is number => v !== null);
  const sum = (values: number[]) => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0));
  const latencies = records.map((r) => r.latencyMs);

  let costUsd: number | null = null;
  let costNote: string;
  if (prices === null) {
    costNote = 'No prices given (--price-input-per-mtok / --price-output-per-mtok); cost not computed.';
  } else if (inputs.length !== successes.length || outputs.length !== successes.length) {
    costNote = `Usage not reported for ${successes.length - Math.min(inputs.length, outputs.length)} successful call(s); cost not computed.`;
  } else {
    costUsd = ((sum(inputs) ?? 0) * prices.inputPerMTok + (sum(outputs) ?? 0) * prices.outputPerMTok) / 1_000_000;
    costNote = 'Computed from reported token counts and the given prices; failed calls may also be billed.';
  }

  return {
    calls: records.length,
    failures: rate(failures, records.length),
    timeouts: rate(failuresByCode.DECISION_TIMEOUT ?? 0, records.length),
    failuresByCode,
    latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), n: latencies.length },
    usage: {
      inputTokens: sum(inputs),
      outputTokens: sum(outputs),
      reportedInput: inputs.length,
      reportedOutput: outputs.length,
    },
    costUsd,
    costNote,
  };
}
