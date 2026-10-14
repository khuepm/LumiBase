import { describe, expect, it } from 'vitest';
import {
  CALIBRATION_NOTE,
  brierBinary,
  brierMulticlass,
  evaluateChoice,
  evaluateNoul,
  expectedCalibrationError,
  noulPrediction,
  percentile,
  rate,
  summarizeCalls,
  wilsonInterval,
  type ChoiceObservation,
} from '../metrics';

describe('wilsonInterval', () => {
  it('matches the textbook 95% interval for 5/10 and 10/10', () => {
    const half = wilsonInterval(5, 10)!;
    expect(half.low).toBeCloseTo(0.2366, 4);
    expect(half.high).toBeCloseTo(0.7634, 4);
    const all = wilsonInterval(10, 10)!;
    expect(all.low).toBeCloseTo(0.7225, 4);
    expect(all.high).toBe(1);
    expect(wilsonInterval(0, 10)!.low).toBeCloseTo(0, 12);
  });

  it('has no interval without evidence and rejects impossible counts', () => {
    expect(wilsonInterval(0, 0)).toBeNull();
    expect(rate(0, 0)).toEqual({ k: 0, n: 0, value: null, interval: null });
    expect(() => wilsonInterval(3, 2)).toThrow(RangeError);
    expect(() => wilsonInterval(-1, 2)).toThrow(RangeError);
  });
});

describe('percentile (nearest rank)', () => {
  it('picks the nearest-rank value', () => {
    const values = [10, 1, 9, 2, 8, 3, 7, 4, 6, 5];
    expect(percentile(values, 50)).toBe(5);
    expect(percentile(values, 95)).toBe(10);
    expect(percentile([3, 1, 2], 95)).toBe(3);
    expect(percentile([42], 50)).toBe(42);
  });

  it('is null for no values', () => {
    expect(percentile([], 50)).toBeNull();
    expect(() => percentile([1], 101)).toThrow(RangeError);
  });
});

describe('Brier and ECE', () => {
  it('computes binary and multi-class Brier on fixed fixtures', () => {
    expect(brierBinary([{ p: 0.8, gold: true }, { p: 0.3, gold: false }])).toBeCloseTo(0.065, 10);
    expect(brierMulticlass(
      [
        { probabilities: { a: 0.7, b: 0.2, c: 0.1 }, gold: 'a' },
        { probabilities: { a: 0.2, b: 0.5, c: 0.3 }, gold: 'c' },
      ],
      ['a', 'b', 'c'],
    )).toBeCloseTo(0.46, 10);
    expect(brierBinary([])).toBeNull();
    expect(brierMulticlass([], ['a'])).toBeNull();
  });

  it('computes equal-width ECE, with confidence 1 in the last bin', () => {
    const items = [
      { confidence: 0.9, hit: true },
      { confidence: 0.9, hit: false },
      { confidence: 0.2, hit: false },
      { confidence: 0.2, hit: false },
    ];
    expect(expectedCalibrationError(items, 10)).toBeCloseTo(0.3, 10);
    expect(expectedCalibrationError([{ confidence: 1, hit: true }], 10)).toBeCloseTo(0, 10);
    expect(expectedCalibrationError([], 10)).toBeNull();
  });
});

const choiceSpec = { options: ['a', 'b', 'other', 'unknown'], abstain: ['unknown'] };
const choiceFixture: ChoiceObservation[] = [
  { gold: 'a', answer: { choice: 'a', confidence: 0.9, probabilities: { a: 0.9, b: 0.05, other: 0.03, unknown: 0.02 } } },
  { gold: 'a', answer: { choice: 'b', confidence: 0.6, probabilities: { a: 0.3, b: 0.6, other: 0.05, unknown: 0.05 } } },
  { gold: 'b', answer: { choice: 'b', confidence: 0.4, probabilities: { a: 0.3, b: 0.4, other: 0.2, unknown: 0.1 } } },
  { gold: 'unknown', answer: { choice: 'unknown', confidence: 0.8, probabilities: { a: 0.1, b: 0.05, other: 0.05, unknown: 0.8 } } },
  { gold: 'other', answer: null },
];

describe('evaluateChoice', () => {
  it('counts abstain options and failures against coverage, not as decisions', () => {
    const m = evaluateChoice(choiceFixture, choiceSpec, null, 10);
    expect(m.n).toBe(5);
    expect(m.answered).toBe(4);
    expect(m.decided).toBe(3);
    expect(m.coverage.value).toBeCloseTo(3 / 5);
    expect(m.abstention.value).toBeCloseTo(2 / 5);
    expect(m.selectivePrecision).toMatchObject({ k: 2, n: 3 });
  });

  it('reports per-label precision and recall, with misses for abstained samples', () => {
    const { perLabel } = evaluateChoice(choiceFixture, choiceSpec, null, 10);
    expect(perLabel.a).toMatchObject({ gold: 2, predicted: 1, precision: { k: 1, n: 1 }, recall: { k: 1, n: 2 } });
    expect(perLabel.b).toMatchObject({ gold: 1, predicted: 2, precision: { k: 1, n: 2 }, recall: { k: 1, n: 1 } });
    // `unknown` on thin content is a correct prediction even though it is not a decision.
    expect(perLabel.unknown).toMatchObject({ precision: { k: 1, n: 1 }, recall: { k: 1, n: 1 } });
    // A failed call is a miss, and no prediction is not a precision of zero.
    expect(perLabel.other).toMatchObject({ gold: 1, predicted: 0, recall: { k: 0, n: 1 } });
    expect(perLabel.other!.precision.value).toBeNull();
  });

  it('drops answers below the confidence threshold', () => {
    const m = evaluateChoice(choiceFixture, choiceSpec, 0.5, 10);
    expect(m.threshold).toBe(0.5);
    expect(m.decided).toBe(2);
    expect(m.selectivePrecision).toMatchObject({ k: 1, n: 2 });
    expect(m.coverage.value).toBeCloseTo(2 / 5);
  });

  it('labels calibration as not a correctness probability', () => {
    const m = evaluateChoice(choiceFixture, choiceSpec, null, 10);
    expect(m.calibration.n).toBe(4);
    expect(m.calibration.note).toBe(CALIBRATION_NOTE);
    expect(CALIBRATION_NOTE).toMatch(/not a correctness probability/);
  });
});

describe('evaluateNoul', () => {
  const fixture = [
    { gold: true, p: 0.9 },
    { gold: false, p: 0.1 },
    { gold: true, p: 0.55 },
    { gold: false, p: 0.7 },
    { gold: true, p: null },
  ];

  it('decides with a symmetric threshold and abstains in the middle band', () => {
    expect(noulPrediction(0.5, 0.5)).toBe(true);
    expect(noulPrediction(0.45, 0.6)).toBeNull();
    expect(noulPrediction(null, 0.5)).toBeNull();

    const loose = evaluateNoul(fixture, 0.5, 10);
    expect(loose.decided).toBe(4);
    expect(loose.selectivePrecision).toMatchObject({ k: 3, n: 4 });
    expect(loose.perLabel.true).toMatchObject({ gold: 3, predicted: 3, precision: { k: 2, n: 3 }, recall: { k: 2, n: 3 } });

    const strict = evaluateNoul(fixture, 0.8, 10);
    expect(strict.decided).toBe(2);
    expect(strict.selectivePrecision).toMatchObject({ k: 2, n: 2 });
    expect(strict.coverage.value).toBeCloseTo(2 / 5);
  });

  it('scores Brier on answered samples only', () => {
    const m = evaluateNoul(fixture, 0.5, 10);
    expect(m.calibration.n).toBe(4);
    expect(m.calibration.brier).toBeCloseTo((0.01 + 0.01 + 0.2025 + 0.49) / 4, 10);
    expect(() => evaluateNoul(fixture, 0.4, 10)).toThrow(RangeError);
  });
});

describe('summarizeCalls', () => {
  it('counts failures and timeouts, latency percentiles and partial usage', () => {
    const s = summarizeCalls(
      [
        { latencyMs: 10, error: null, usage: { inputTokens: 100, outputTokens: 20 } },
        { latencyMs: 20, error: 'DECISION_TIMEOUT', usage: null },
        { latencyMs: 30, error: null, usage: { inputTokens: 50, outputTokens: null } },
        { latencyMs: 40, error: 'DECISION_UNAVAILABLE', usage: null },
      ],
      { inputPerMTok: 1, outputPerMTok: 1 },
    );
    expect(s.failures).toMatchObject({ k: 2, n: 4 });
    expect(s.timeouts).toMatchObject({ k: 1, n: 4 });
    expect(s.failuresByCode).toEqual({ DECISION_TIMEOUT: 1, DECISION_UNAVAILABLE: 1 });
    expect(s.latencyMs).toEqual({ p50: 20, p95: 40, n: 4 });
    expect(s.usage).toEqual({ inputTokens: 150, outputTokens: 20, reportedInput: 2, reportedOutput: 1 });
    // Unknown usage is never priced as zero.
    expect(s.costUsd).toBeNull();
    expect(s.costNote).toMatch(/not reported for 1/);
  });

  it('prices usage only when every successful call reported it', () => {
    const s = summarizeCalls(
      [{ latencyMs: 5, error: null, usage: { inputTokens: 1_000_000, outputTokens: 500_000 } }],
      { inputPerMTok: 2, outputPerMTok: 10 },
    );
    expect(s.costUsd).toBeCloseTo(7, 10);
    expect(summarizeCalls([], null)).toMatchObject({ calls: 0, costUsd: null, latencyMs: { p50: null, p95: null, n: 0 } });
  });
});
