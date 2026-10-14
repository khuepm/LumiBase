import { describe, expect, it } from 'vitest';
import {
  computeReviewMetrics,
  PILOT_PROTOCOL,
  percentile,
  wilson,
  type MetricsFeedback,
  type MetricsRun,
  type MetricsSession,
  type ReviewMetricsInput,
} from '../review-metrics';

/**
 * Pilot metrics (#516): aggregation math on fixed fixtures, viewed-only rates,
 * splits, and the pre-registered insufficient-sample flags. No database.
 */

const window = { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-11-01T00:00:00Z') };

function session(overrides: Partial<MetricsSession> = {}): MetricsSession {
  return {
    mode: 'baseline',
    durationMs: 60_000,
    locale: 'vi',
    runId: null,
    viewedQuestions: [],
    principalId: 'usr_a',
    ...overrides,
  };
}

function run(id: string, overrides: Partial<MetricsRun> = {}): MetricsRun {
  return {
    id,
    status: 'success',
    provider: 'typesafe',
    profileKey: 'taxonomy',
    profileVersion: 1,
    latencyMs: 1_000,
    usage: { inputTokens: 100, outputTokens: 20 },
    ...overrides,
  };
}

function metrics(input: Partial<ReviewMetricsInput>) {
  return computeReviewMetrics({ sessions: [], runs: [], feedback: [], window, ...input });
}

describe('statistics', () => {
  it('uses nearest-rank percentiles', () => {
    const values = [5, 1, 4, 2, 3, 10, 9, 8, 7, 6];
    expect(percentile(values, 0.5)).toBe(5);
    expect(percentile(values, 0.95)).toBe(10);
    expect(percentile([42], 0.95)).toBe(42);
    expect(percentile([], 0.5)).toBeNull();
  });

  it('computes a 95% Wilson interval', () => {
    const r = wilson(20, 100);
    expect(r.value).toBe(0.2);
    expect(r.ci95!.low).toBeCloseTo(0.1333, 3);
    expect(r.ci95!.high).toBeCloseTo(0.2888, 3);
    expect(wilson(0, 0)).toEqual({ k: 0, n: 0, value: null, ci95: null });
  });
});

describe('time per item', () => {
  it('computes baseline vs assisted p50/p95 and excludes idle sessions', () => {
    const m = metrics({
      sessions: [
        ...[10, 20, 30, 40].map((s) => session({ durationMs: s * 1_000 })),
        ...[5, 10, 15].map((s) => session({ mode: 'assisted', durationMs: s * 1_000 })),
        session({ durationMs: PILOT_PROTOCOL.idleSessionMs + 1 }),
      ],
    });
    expect(m.timePerItem.baseline).toMatchObject({ sessions: 4, p50Ms: 20_000, p95Ms: 40_000, meanMs: 25_000 });
    expect(m.timePerItem.assisted).toMatchObject({ sessions: 3, p50Ms: 10_000, p95Ms: 15_000 });
    expect(m.timePerItem.assistedToBaselineP50).toBe(0.5);
    expect(m.sampleCounts.idleSessionsExcluded).toBe(1);
  });
});

describe('viewed-only suggestion rates', () => {
  it('counts verdicts only for suggestions the viewing editor saw', () => {
    const runs = [run('r1'), run('r2')];
    const sessions = [
      session({ mode: 'assisted', runId: 'r1', viewedQuestions: ['category', 'tone'], principalId: 'usr_a' }),
      // The same suggestion viewed twice counts once.
      session({ mode: 'assisted', runId: 'r1', viewedQuestions: ['category'], principalId: 'usr_a' }),
      session({ mode: 'assisted', runId: 'r2', viewedQuestions: ['category'], principalId: 'usr_b' }),
    ];
    const feedback: MetricsFeedback[] = [
      { runId: 'r1', questionKey: 'category', verdict: 'accept', principalId: 'usr_a' },
      { runId: 'r1', questionKey: 'tone', verdict: 'edit', principalId: 'usr_a' },
      // Not viewed in any session (e.g. sent straight to the API): ignored.
      { runId: 'r1', questionKey: 'needs_review', verdict: 'reject', principalId: 'usr_a' },
      // Another principal's verdict on usr_b's viewed suggestion: ignored.
      { runId: 'r2', questionKey: 'category', verdict: 'reject', principalId: 'usr_x' },
    ];

    const m = metrics({ sessions, runs, feedback });

    expect(m.suggestions.viewed).toBe(3);
    expect(m.suggestions.accept).toMatchObject({ k: 1, n: 3 });
    expect(m.suggestions.edit).toMatchObject({ k: 1, n: 3 });
    expect(m.suggestions.reject).toMatchObject({ k: 0, n: 3 });
    expect(m.suggestions.noAction).toMatchObject({ k: 1, n: 3 });
  });

  it('ignores runs and feedback with no viewing session: API activity is not user value', () => {
    const runs = Array.from({ length: 500 }, (_, i) => run(`r${i}`));
    const feedback = runs.map((r) => ({ runId: r.id, questionKey: 'category', verdict: 'accept', principalId: 'usr_a' }));

    const m = metrics({ runs, feedback });

    expect(m.suggestions.viewed).toBe(0);
    expect(m.suggestions.accept.value).toBeNull();
    expect(m.timePerItem.assisted.sessions).toBe(0);
    expect(m.operations.runs).toBe(500);
    expect(m.criteria.find((c) => c.id === 'rejection_rate')?.status).toBe('insufficient_sample');
    expect(m.criteria.find((c) => c.id === 'time_reduction')?.status).toBe('insufficient_sample');
    expect(m.note).toMatch(/not|only/);
  });
});

describe('operations', () => {
  it('computes coverage, abstention, errors, latency and tokens per run', () => {
    const m = metrics({
      runs: [
        run('a', { latencyMs: 100 }),
        run('b', { latencyMs: 200, usage: { inputTokens: 50, outputTokens: null } }),
        run('c', { status: 'abstained', latencyMs: 300, usage: null }),
        run('d', { status: 'error', latencyMs: 9_000 }),
        run('e', { status: 'running', latencyMs: null }),
      ],
    });
    expect(m.operations).toMatchObject({ runs: 5, success: 2, abstained: 1, error: 1, running: 1 });
    expect(m.operations.coverage).toMatchObject({ k: 2, n: 3 });
    expect(m.operations.abstention).toMatchObject({ k: 1, n: 3 });
    expect(m.operations.errorRate).toMatchObject({ k: 1, n: 4 });
    // Errors are not completed runs: no latency from them.
    expect(m.operations.latencyP95Ms).toBe(300);
    expect(m.operations.tokensPerRun).toEqual({ mean: 120, p50: 120, runsWithUsage: 1, runsWithoutUsage: 2 });
  });
});

describe('splits', () => {
  it('splits by locale, provider and profile version, each with its own sample flag', () => {
    const runs = [
      run('r1', { provider: 'typesafe', profileVersion: 1 }),
      run('r2', { provider: 'openrouter', profileVersion: 2 }),
    ];
    const sessions = [
      session({ locale: 'vi' }),
      session({ locale: 'en', mode: 'assisted', runId: 'r2', viewedQuestions: ['category'] }),
      session({ locale: null }),
    ];
    const m = metrics({
      sessions,
      runs,
      feedback: [{ runId: 'r2', questionKey: 'category', verdict: 'reject', principalId: 'usr_a' }],
    });

    expect(Object.keys(m.splits.byLocale).sort()).toEqual(['en', 'unknown', 'vi']);
    expect(m.splits.byLocale.en!.suggestions.reject).toMatchObject({ k: 1, n: 1 });
    expect(m.splits.byLocale.vi!.timePerItem.baseline.sessions).toBe(1);
    expect(m.splits.byProvider.openrouter!.suggestions.reject).toMatchObject({ k: 1, n: 1 });
    expect(m.splits.byProvider.typesafe!.suggestions.viewed).toBe(0);
    expect(Object.keys(m.splits.byProfileVersion).sort()).toEqual(['taxonomy@v1', 'taxonomy@v2']);
    for (const split of Object.values(m.splits.byProvider)) expect(split.insufficientSample).toBe(true);
  });

  it('attributes a viewed run created before the window to its provider', () => {
    const m = metrics({
      sessions: [session({ mode: 'assisted', runId: 'old', viewedQuestions: ['category'] })],
      runs: [],
      referencedRuns: [run('old', { provider: 'openrouter' })],
      feedback: [],
    });
    expect(m.splits.byProvider.openrouter!.suggestions.viewed).toBe(1);
    expect(m.operations.runs).toBe(0);
  });
});

describe('pre-registered criteria', () => {
  function fullPilot({ assistedSeconds, rejects }: { assistedSeconds: number; rejects: number }) {
    const n = PILOT_PROTOCOL.minimums.sessionsPerMode;
    const runs = Array.from({ length: n }, (_, i) => run(`r${i}`, { latencyMs: 2_000 }));
    const sessions = [
      ...Array.from({ length: n }, () => session({ durationMs: 100_000 })),
      ...runs.map((r) =>
        session({ mode: 'assisted', durationMs: assistedSeconds * 1_000, runId: r.id, viewedQuestions: ['category'] }),
      ),
    ];
    const feedback = runs.map((r, i) => ({
      runId: r.id,
      questionKey: 'category',
      verdict: i < rejects ? 'reject' : 'accept',
      principalId: 'usr_a',
    }));
    return metrics({ sessions, runs, feedback });
  }

  it('flags every criterion insufficient below the minimums', () => {
    const m = metrics({ sessions: [session(), session({ mode: 'assisted' })], runs: [run('r1')] });
    expect(m.insufficientSample).toBe(true);
    expect(m.criteria.map((c) => c.status)).toEqual(Array(5).fill('insufficient_sample'));
    expect(m.timePerItem.baseline.insufficientSample).toBe(true);
  });

  it('passes when every criterion is met on the minimum sample', () => {
    const m = fullPilot({ assistedSeconds: 60, rejects: 10 });
    expect(m.insufficientSample).toBe(false);
    expect(Object.fromEntries(m.criteria.map((c) => [c.id, c.status]))).toEqual({
      time_reduction: 'pass',
      rejection_rate: 'pass',
      coverage: 'pass',
      error_rate: 'pass',
      latency_p95: 'pass',
    });
  });

  it('fails a clearly missed criterion and leaves a straddling one inconclusive', () => {
    const slow = fullPilot({ assistedSeconds: 95, rejects: 50 });
    expect(slow.criteria.find((c) => c.id === 'time_reduction')?.status).toBe('fail');
    expect(slow.criteria.find((c) => c.id === 'rejection_rate')?.status).toBe('fail');

    // 25% rejected: the point estimate meets 0.30, the upper bound (~0.34) does not.
    const borderline = fullPilot({ assistedSeconds: 60, rejects: 25 });
    expect(borderline.criteria.find((c) => c.id === 'rejection_rate')).toMatchObject({ status: 'inconclusive' });
  });
});
