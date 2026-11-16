import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_RECEIPTS_ALERT_THRESHOLDS, agentReceiptsAlertThresholdsSchema } from '@lumibase/contracts';
import { evaluateReceiptAlerts, toCsv } from '../agent-receipts-service';

type Base = Parameters<typeof evaluateReceiptAlerts>[0];

function report(over: { failureRate?: number | null; vetoRate?: number | null; p90?: number | null; usd?: number; openDrift?: number }): Base {
  return {
    window: { since: '', until: '' },
    runs: { total: 0, byStatus: {}, byAgent: [], failureRate: over.failureRate ?? null },
    toolCalls: { total: 0, byTool: [] },
    approvals: { total: 0, byStatus: {}, byApprover: {}, latency: { count: 0, p50Minutes: null, p90Minutes: over.p90 ?? null, avgMinutes: null } },
    vetoes: { total: 0, vetoed: 0, committed: 0, pending: 0, vetoRate: over.vetoRate ?? null },
    questions: { asked: 0, answered: 0, expired: 0, cancelled: 0, pending: 0 },
    overrides: { rejectedApprovals: 0, vetoed: 0, total: 0, overrideRate: null },
    cost: { tokens: 0, usd: over.usd ?? 0, byTool: [] },
    drift: { opened: 0, resolved: 0, openNow: over.openDrift ?? 0, byRule: [] },
    incidents: { total: 0, bySource: {}, bySeverity: {} },
    autonomy: { grants: [], levelDistribution: {}, promotions: [], demotions: 0 },
    daily: [],
  };
}

describe('evaluateReceiptAlerts', () => {
  it('fires only above a set threshold, and never on a metric with no data', () => {
    expect(evaluateReceiptAlerts(report({ failureRate: 0.2 }), DEFAULT_AGENT_RECEIPTS_ALERT_THRESHOLDS)).toEqual([]);
    expect(evaluateReceiptAlerts(report({ failureRate: null, vetoRate: null, p90: null }), DEFAULT_AGENT_RECEIPTS_ALERT_THRESHOLDS)).toEqual([]);
    const alerts = evaluateReceiptAlerts(report({ failureRate: 0.5, p90: 2000 }), DEFAULT_AGENT_RECEIPTS_ALERT_THRESHOLDS);
    expect(alerts.map((a) => a.metric)).toEqual(['maxRunFailureRate', 'maxApprovalLatencyP90Minutes']);
    expect(alerts[0]!.message).toBe('Run failure rate 0.5 exceeds 0.2');
  });

  it('ignores thresholds that are not set', () => {
    expect(evaluateReceiptAlerts(report({ usd: 1000, openDrift: 99 }), {})).toEqual([]);
    expect(evaluateReceiptAlerts(report({ openDrift: 3 }), { maxOpenDrift: 2 })).toEqual([
      expect.objectContaining({ metric: 'maxOpenDrift', value: 3, threshold: 2 }),
    ]);
  });

  it('the threshold contract rejects rates outside 0..1 and unknown keys', () => {
    expect(agentReceiptsAlertThresholdsSchema.safeParse({ maxRunFailureRate: 1.5 }).success).toBe(false);
    expect(agentReceiptsAlertThresholdsSchema.safeParse({ nope: 1 }).success).toBe(false);
    expect(agentReceiptsAlertThresholdsSchema.safeParse({}).success).toBe(true);
  });
});

describe('toCsv', () => {
  it('quotes separators and neutralises spreadsheet formulas', () => {
    const csv = toCsv(['a', 'b', 'c', 'd'], [['x,y', 'say "hi"', '=HYPERLINK("x")', null], [new Date('2026-01-01T00:00:00Z'), -1, '-2', { k: 1 }]]);
    expect(csv).toBe(
      'a,b,c,d\n' +
        '"x,y","say ""hi""","\'=HYPERLINK(""x"")",\n' +
        '2026-01-01T00:00:00.000Z,-1,\'-2,"{""k"":1}"\n',
    );
  });
});
