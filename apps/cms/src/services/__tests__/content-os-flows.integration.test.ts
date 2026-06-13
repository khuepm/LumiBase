import { describe, expect, it } from 'vitest';
import {
  diffDrifts,
  driftFingerprint,
  evaluateRules,
  type DriftItemView,
} from '../drift-service';
import { planReconciliation, routeRole, type ReconcilableDrift } from '../reconciler-service';
import { decideVetoCommit, filterPinnedPatch } from '../veto-service';
import { LoadGuardService } from '../load-guard-service';
import type { IntentRule } from '../intent-service';

/**
 * Feature: content-os, task 20.3 — integration flows, end to end through
 * the in-memory orchestration layer:
 *
 * 1. Reconciliation cycle: seed intent → detect drift → plan goals →
 *    fix content → drift resolves and is never duplicated.
 * 2. Veto flow: stage → veto wins before the deadline; silence commits at
 *    the deadline; pins applied after staging survive the commit.
 * 3. Backpressure: a simulated anomaly signal pauses reconciler-origin
 *    work only, records one incident per activation, and resumes only
 *    after the hold-down of continuous calm.
 *
 * **Validates: Requirements 6.x, 7.x, 9.4, 13.x**
 */

describe('Integration: reconciliation cycle (seed intent → drift → goal → fix → resolved)', () => {
  const intentId = 'intent_blog';
  const rules: IntentRule[] = [
    { type: 'required_fields', fields: ['title', 'summary'] } as IntentRule,
  ];

  const brokenItem: DriftItemView = {
    id: 'item_1',
    data: { title: 'Hello', summary: '' },
    updatedAt: new Date(),
    pinnedFields: [],
  };

  it('runs the full cycle without ever duplicating a drift', () => {
    // Scan 1: detect the violation.
    const violations = evaluateRules(rules, brokenItem, {});
    expect(violations.length).toBeGreaterThan(0);

    const fingerprints = new Set(
      violations.map((v) => driftFingerprint(intentId, brokenItem.id, v.ruleType, v.ruleKey)),
    );
    const diff1 = diffDrifts(new Map(), fingerprints);
    expect(diff1.toOpen.length).toBe(fingerprints.size);

    // Reconciler: open drifts become goals within budget, routed by rule type.
    const drifts: ReconcilableDrift[] = diff1.toOpen.map((fingerprint, i) => ({
      id: `drift_${i}`,
      fingerprint,
      itemId: brokenItem.id,
      ruleType: violations[i]!.ruleType,
      ruleKey: violations[i]!.ruleKey,
      status: 'open',
      goalId: null,
    }));
    const plan = planReconciliation(drifts, 10);
    expect(plan.selected.length).toBe(drifts.length);
    for (const drift of plan.selected) {
      expect(routeRole(drift.ruleType)).toBeTruthy();
    }

    // Scan 2 while the goal is still working: drifts are open/assigned —
    // the same fingerprints never open twice (Property 4).
    const tracked = new Map(diff1.toOpen.map((f) => [f, { status: 'assigned' }]));
    const diff2 = diffDrifts(tracked, fingerprints);
    expect(diff2.toOpen).toEqual([]);
    expect(diff2.toReopen).toEqual([]);

    // The agent fixes the item; scan 3 detects nothing and resolves.
    const fixedItem: DriftItemView = { ...brokenItem, data: { title: 'Hello', summary: 'Now filled.' } };
    const after = evaluateRules(rules, fixedItem, {});
    expect(after).toEqual([]);
    const diff3 = diffDrifts(tracked, new Set());
    expect(new Set(diff3.toResolve)).toEqual(new Set(diff1.toOpen));
  });
});

describe('Integration: veto flow (stage → veto | silence → commit, pins win)', () => {
  const autoCommitAt = new Date('2026-06-12T12:00:00Z');

  it('a veto before the deadline always wins; silence commits at the deadline', () => {
    // Before the deadline, an undecided staging waits.
    expect(decideVetoCommit('pending', autoCommitAt, new Date('2026-06-12T11:00:00Z'))).toBe('wait');
    // Human vetoes → the staging is skipped forever, even past the deadline.
    expect(decideVetoCommit('rejected', autoCommitAt, new Date('2026-06-12T11:30:00Z'))).toBe('skip');
    expect(decideVetoCommit('rejected', autoCommitAt, new Date('2026-06-12T13:00:00Z'))).toBe('skip');
    // Silence means consent: at/after the deadline the staging commits.
    expect(decideVetoCommit('pending', autoCommitAt, autoCommitAt)).toBe('commit');
    expect(decideVetoCommit('pending', autoCommitAt, new Date('2026-06-12T13:00:00Z'))).toBe('commit');
  });

  it('fields pinned after staging are dropped from the commit (human value kept)', () => {
    const stagedPatch = { title: 'Agent title', summary: 'Agent summary', tags: ['a'] };
    // Human edited + pinned `title` while the staging waited.
    const { applied, dropped } = filterPinnedPatch(stagedPatch, ['title']);
    expect(dropped).toEqual(['title']);
    expect(applied).toEqual({ summary: 'Agent summary', tags: ['a'] });
    // Nothing pinned → the whole staging commits.
    const untouched = filterPinnedPatch(stagedPatch, []);
    expect(untouched.dropped).toEqual([]);
    expect(untouched.applied).toEqual(stagedPatch);
  });
});

describe('Integration: backpressure pause/resume with a simulated anomaly signal', () => {
  it('pauses reconciler work only, records one incident, resumes after hold-down', () => {
    const guard = new LoadGuardService({ holdDownMs: 10_000 });
    const t0 = 1_000_000;

    // Calm: nothing pauses.
    guard.signal({ overloaded: false }, t0);
    expect(guard.shouldPause('reconciler')).toBe(false);

    // Anomaly module reports overload → reconciler pauses, humans do not.
    guard.signal({ overloaded: true, reason: 'anomaly_spike' }, t0 + 1_000);
    expect(guard.shouldPause('reconciler')).toBe(true);
    expect(guard.shouldPause('user')).toBe(false);
    expect(guard.shouldPause(undefined)).toBe(false);

    // Exactly one incident per activation per site (Req 9.4).
    expect(guard.markIncidentOnce('site_a')).toBe(true);
    expect(guard.markIncidentOnce('site_a')).toBe(false);
    expect(guard.markIncidentOnce('site_b')).toBe(true);

    // Calm begins, but the hold-down keeps the pause until it elapses.
    guard.signal({ overloaded: false }, t0 + 2_000);
    guard.signal({ overloaded: false }, t0 + 6_000);
    expect(guard.shouldPause('reconciler')).toBe(true);

    // A flapping spike resets the hold-down.
    guard.signal({ overloaded: true, reason: 'anomaly_spike' }, t0 + 7_000);
    guard.signal({ overloaded: false }, t0 + 8_000);
    guard.signal({ overloaded: false }, t0 + 17_000);
    expect(guard.shouldPause('reconciler')).toBe(true); // only 9s of calm

    // Continuous calm for the full hold-down → resume.
    guard.signal({ overloaded: false }, t0 + 18_500);
    expect(guard.shouldPause('reconciler')).toBe(false);

    // A fresh overload is a NEW activation → a new incident may be recorded.
    guard.signal({ overloaded: true, reason: 'anomaly_spike' }, t0 + 20_000);
    expect(guard.markIncidentOnce('site_a')).toBe(true);
  });
});
