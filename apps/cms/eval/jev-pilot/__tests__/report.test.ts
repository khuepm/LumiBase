import { describe, expect, it } from 'vitest';
import { computeReviewMetrics, PILOT_PROTOCOL, type MetricsRun, type MetricsSession } from '../../../src/services/review-metrics';
import { buildPilotReport, parseMetricsJson, PilotReportError, renderPilotReportMarkdown } from '../report';

/** The versioned pilot report (#516): template, decision rules, protocol guard. */

const window = { from: new Date('2026-11-01T00:00:00Z'), to: new Date('2026-12-01T00:00:00Z') };
const now = new Date('2026-12-02T00:00:00Z');

function passingMetrics() {
  const n = PILOT_PROTOCOL.minimums.sessionsPerMode;
  const runs: MetricsRun[] = Array.from({ length: n }, (_, i) => ({
    id: `r${i}`,
    status: 'success',
    provider: 'typesafe',
    profileKey: 'taxonomy',
    profileVersion: 1,
    latencyMs: 1_500,
    usage: { inputTokens: 10, outputTokens: 2 },
  }));
  const base: MetricsSession = { mode: 'baseline', durationMs: 100_000, locale: 'vi', runId: null, viewedQuestions: [], principalId: 'u' };
  const sessions: MetricsSession[] = [
    ...Array.from({ length: n }, () => base),
    ...runs.map((r) => ({ ...base, mode: 'assisted', durationMs: 60_000, runId: r.id, viewedQuestions: ['category'] })),
  ];
  const feedback = runs.map((r) => ({ runId: r.id, questionKey: 'category', verdict: 'accept', principalId: 'u' }));
  return computeReviewMetrics({ sessions, runs, feedback, window, now });
}

describe('pilot report', () => {
  it('is an empty template without metrics: nothing measured, no go', () => {
    const report = buildPilotReport(null, { now, window });
    expect(report).toMatchObject({ status: 'template', decision: 'insufficient_data', metrics: null, reportVersion: 1 });
    expect(report.sampleCounts).toEqual({
      baselineSessions: 0,
      assistedSessions: 0,
      idleSessionsExcluded: 0,
      viewedSuggestions: 0,
      completedRuns: 0,
    });
    expect(report.criteria.every((c) => c.status === 'insufficient_sample' && c.observed === null)).toBe(true);
    expect(renderPilotReportMarkdown(report)).toContain('Template — no measured results');
  });

  it('never decides go without human adjudication, even when every metric passes', () => {
    const metrics = passingMetrics();
    expect(metrics.criteria.every((c) => c.status === 'pass')).toBe(true);
    const report = buildPilotReport(metrics, { now });
    expect(report.adjudication).toEqual({ id: 'adjudicated_error_rate', status: 'not_collected' });
    expect(report.decision).toBe('insufficient_data');
  });

  it('decides go only when the adjudication passes too, and no_go when it fails', () => {
    const metrics = passingMetrics();
    expect(buildPilotReport(metrics, { now, adjudication: { sampled: 100, errors: 2 } }).decision).toBe('go');
    expect(buildPilotReport(metrics, { now, adjudication: { sampled: 100, errors: 30 } }).decision).toBe('no_go');
    expect(buildPilotReport(metrics, { now, adjudication: { sampled: 10, errors: 0 } }).decision).toBe('insufficient_data');
    expect(() => buildPilotReport(metrics, { now, adjudication: { sampled: 5, errors: 6 } })).toThrow(PilotReportError);
  });

  it('does not decide go on truncated metrics', () => {
    const metrics = { ...passingMetrics(), truncated: true };
    expect(buildPilotReport(metrics, { now, adjudication: { sampled: 100, errors: 0 } }).decision).toBe('insufficient_data');
  });

  it('reads the endpoint body and refuses another protocol version', () => {
    const metrics = passingMetrics();
    expect(parseMetricsJson({ data: metrics }).protocolVersion).toBe(PILOT_PROTOCOL.version);
    expect(() => parseMetricsJson({ data: { ...metrics, protocolVersion: 'jev-pilot-v0' } })).toThrow(/different pilot/);
    expect(() => parseMetricsJson({ protocolVersion: PILOT_PROTOCOL.version })).toThrow(/missing/);
  });
});
