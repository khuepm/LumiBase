import { describe, expect, it } from 'vitest';
import { parseAutomationSettings, resolveAutomationMode } from '../ai-automation';
import { AUTOMATION_METRICS_PROTOCOL, computeAutomationMetrics } from '../ai-automation-metrics';
import type { AutomationActionRecord, AutomationFeedbackRecord } from '../ai-automation-store';

/**
 * Shadow metrics (J11, #518): precision and coverage in the auto-action zone,
 * using the configured (J06-derived) thresholds and user feedback only.
 */

const THRESHOLD = { provider: 'typesafe', model: 'jev-1.13', profileVersion: 1, minConfidence: 0.8 };
const settings = parseAutomationSettings({ automation: { mode: 'shadow', thresholds: { vi: { tag: THRESHOLD } } } });
const window = { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-11-01T00:00:00Z') };

let seq = 0;
function row(overrides: Partial<AutomationActionRecord> = {}): AutomationActionRecord {
  seq += 1;
  const at = new Date('2026-10-02T00:00:00Z');
  return {
    id: `act_${seq}`,
    siteId: 'site_1',
    flowRunId: `fr_${seq}`,
    nodeId: 'tag',
    reviewRunId: `rr_${seq}`,
    collection: 'posts',
    itemId: `itm_${seq}`,
    revisionId: null,
    contentHash: null,
    action: 'tag',
    mode: 'shadow',
    status: 'recorded',
    reason: 'mode_shadow',
    questionKey: 'category',
    locale: 'vi',
    provider: 'typesafe',
    model: 'jev-1.13',
    profileKey: 'taxonomy',
    profileVersion: 1,
    confidence: 0.9,
    inZone: true,
    proposed: { field: 'tags', value: ['news'], target: 'news' },
    applied: false,
    previous: { field: 'tags', value: [] },
    approvalId: null,
    agentRunId: null,
    principalType: 'user',
    principalId: 'usr_editor',
    revertedAt: null,
    revertedBy: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function verdict(r: AutomationActionRecord, v: string, overrides: Partial<AutomationFeedbackRecord> = {}): AutomationFeedbackRecord {
  return {
    runId: r.reviewRunId!,
    questionKey: r.questionKey!,
    verdict: v,
    editedValue: null,
    principalType: 'user',
    principalId: 'usr_reviewer',
    createdAt: new Date('2026-10-03T00:00:00Z'),
    ...overrides,
  };
}

describe('precision and coverage in the auto-action zone', () => {
  it('counts accept and same-value edits as right, rejects and other edits as wrong', () => {
    const rows = [row(), row(), row(), row()];
    const feedback = [
      verdict(rows[0]!, 'accept'),
      verdict(rows[1]!, 'edit', { editedValue: 'news' }),
      verdict(rows[2]!, 'edit', { editedValue: 'promo' }),
      verdict(rows[3]!, 'reject'),
    ];
    const m = computeAutomationMetrics({ rows, feedback, settings, window });
    expect(m.splits).toHaveLength(1);
    expect(m.splits[0]).toMatchObject({ inZone: 4, reviewedInZone: 4, threshold: 0.8 });
    expect(m.splits[0]!.precision).toMatchObject({ k: 2, n: 4, value: 0.5 });
  });

  it('coverage is in-zone proposals over decided items, abstentions included', () => {
    const rows = [
      row(),
      row({ confidence: 0.7 }),
      row({ status: 'skipped', reason: 'decision_unknown', proposed: null, confidence: 0.5 }),
      // Skips for other reasons are not model coverage.
      row({ status: 'skipped', reason: 'pinned', proposed: null }),
      row({ status: 'skipped', reason: 'stale:content_changed', proposed: null }),
    ];
    const m = computeAutomationMetrics({ rows, feedback: [], settings, window });
    expect(m.splits[0]).toMatchObject({ decided: 3, proposals: 2, inZone: 1 });
    expect(m.splits[0]!.coverage).toMatchObject({ k: 1, n: 3 });
    expect(m.statusCounts).toEqual({ recorded: 2, skipped: 3 });
  });

  it('ignores API-key verdicts and uses the latest user verdict', () => {
    const r = row();
    const m = computeAutomationMetrics({
      rows: [r],
      feedback: [
        verdict(r, 'accept', { principalType: 'api_key', principalId: 'key_1' }),
        verdict(r, 'reject', { createdAt: new Date('2026-10-03T00:00:00Z') }),
        verdict(r, 'accept', { principalId: 'usr_other', createdAt: new Date('2026-10-04T00:00:00Z') }),
      ],
      settings,
      window,
    });
    expect(m.splits[0]!.precision).toMatchObject({ k: 1, n: 1 });
  });

  it('excludes rows from a model the threshold was not measured for', () => {
    const m = computeAutomationMetrics({ rows: [row({ model: 'jev-2' }), row()], feedback: [], settings, window });
    expect(m.excludedMismatch).toBe(1);
    expect(m.splits[0]!.proposals).toBe(1);
  });

  it('evaluates the zone against the current thresholds, not the stored flag', () => {
    const strict = parseAutomationSettings({
      automation: { mode: 'shadow', thresholds: { vi: { tag: { ...THRESHOLD, minConfidence: 0.95 } } } },
    });
    const m = computeAutomationMetrics({ rows: [row({ inZone: true })], feedback: [], settings: strict, window });
    expect(m.splits[0]!.inZone).toBe(0);
  });
});

describe('insufficient sample keeps shadow on', () => {
  it('flags every split and the overall without thresholds', () => {
    const m = computeAutomationMetrics({ rows: [row()], feedback: [], settings: parseAutomationSettings({}), window });
    expect(m.splits[0]).toMatchObject({ threshold: null, insufficientSample: true });
    expect(m.shadowRequired).toBe(true);
  });

  it('a split can be sufficient while the overall is not', () => {
    const rows = Array.from({ length: AUTOMATION_METRICS_PROTOCOL.minimums.reviewedInZonePerSplit }, () => row());
    const m = computeAutomationMetrics({ rows, feedback: rows.map((r) => verdict(r, 'accept')), settings, window });
    expect(m.splits[0]!.insufficientSample).toBe(false);
    expect(m.overall.insufficientSample).toBe(true);
    expect(m.shadowRequired).toBe(true);
  });

  it('enough reviewed samples clear the flag, and the metrics still switch nothing on', () => {
    const rows = Array.from({ length: AUTOMATION_METRICS_PROTOCOL.minimums.reviewedInZone }, () => row());
    const m = computeAutomationMetrics({ rows, feedback: rows.map((r) => verdict(r, 'accept')), settings, window });
    expect(m.shadowRequired).toBe(false);
    // Going live is a separate admin decision: the same settings still resolve shadow.
    expect(
      resolveAutomationMode(settings, { action: 'tag', locale: 'vi', provider: 'typesafe', model: 'jev-1.13', profileVersion: 1 }),
    ).toMatchObject({ mode: 'shadow', reason: 'mode_shadow' });
  });

  it('an empty window requires shadow', () => {
    const m = computeAutomationMetrics({ rows: [], feedback: [], settings, window });
    expect(m).toMatchObject({ shadowRequired: true, splits: [], overall: { reviewedInZone: 0 } });
  });
});

describe('settings parsing', () => {
  it('reads absent, malformed and partial blocks as shadow', () => {
    expect(parseAutomationSettings({}).mode).toBe('shadow');
    expect(parseAutomationSettings({ automation: { mode: 'live', gate: { approvedBy: '' } } })).toMatchObject({
      mode: 'shadow',
      malformed: true,
    });
    const live = parseAutomationSettings({ automation: { mode: 'live', thresholds: { vi: { tag: THRESHOLD } } } });
    expect(resolveAutomationMode(live, { action: 'tag', locale: 'vi', provider: 'typesafe', model: 'jev-1.13', profileVersion: 1 })).toMatchObject({
      mode: 'shadow',
      reason: 'gate_missing',
    });
  });
});
