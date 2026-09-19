import { describe, expect, it } from 'vitest';
import {
  decideGoalAction,
  draftVersionKey,
  repairArgumentsForDrift,
  type GoalDispatchState,
} from '../goal-dispatch-service';

/**
 * G3 (#455) — the dispatch state machine, isolated from queue/DB/LLM.
 *
 * The decision function is the part that has to be exhaustively right: every
 * wrong branch either duplicates a repair side effect or leaves a drift locked
 * to a goal nothing advances, which is the defect this work exists to fix.
 *
 * **Validates: #455 acceptance — repeated reconciliation/retries/duplicate
 * delivery do not duplicate side effects; failures surface as blocked state**
 */

function state(patch: Partial<GoalDispatchState> = {}): GoalDispatchState {
  return {
    latestRunStatus: null,
    repairPhase: null,
    draftExists: false,
    driftStatus: 'assigned',
    ...patch,
  };
}

describe('decideGoalAction', () => {
  it('dispatches the draft phase for a fresh reconciler goal', () => {
    expect(decideGoalAction(state())).toEqual({ action: 'dispatch_draft' });
  });

  it.each(['queued', 'running', 'awaiting_approval'])(
    'skips while a run is %s — never dispatches a second run for one goal',
    (latestRunStatus) => {
      expect(decideGoalAction(state({ latestRunStatus, repairPhase: 'drafting' }))).toEqual({
        action: 'skip',
        reason: 'RUN_ACTIVE',
      });
    },
  );

  it('an in-flight run wins over a resolved drift', () => {
    // Completing the goal here would leave a live run still mutating content
    // behind a goal already marked done.
    expect(
      decideGoalAction(state({ latestRunStatus: 'running', driftStatus: 'resolved' })),
    ).toEqual({ action: 'skip', reason: 'RUN_ACTIVE' });
  });

  it('completes when the drift is resolved, even mid-phase', () => {
    // A human fixing the content by hand is a legitimate way to get there.
    expect(
      decideGoalAction(state({ repairPhase: 'drafting', driftStatus: 'resolved', draftExists: true })),
    ).toEqual({ action: 'complete' });
  });

  it('blocks when the drift row is gone', () => {
    expect(decideGoalAction(state({ driftStatus: null }))).toEqual({
      action: 'block',
      reason: 'DRIFT_MISSING',
    });
  });

  it.each([
    ['failed', 'RUN_FAILED'],
    ['cancelled', 'RUN_CANCELLED'],
  ])('blocks after a %s run rather than re-dispatching', (latestRunStatus, reason) => {
    // A rejected approval surfaces as a failed run. Auto-retrying would re-ask a
    // human who already said no.
    expect(decideGoalAction(state({ latestRunStatus, repairPhase: 'promoting' }))).toEqual({
      action: 'block',
      reason,
    });
  });

  it('moves from draft to promote once the draft branch exists', () => {
    expect(
      decideGoalAction(
        state({ latestRunStatus: 'succeeded', repairPhase: 'drafting', draftExists: true }),
      ),
    ).toEqual({ action: 'dispatch_promote' });
  });

  it('blocks when a "succeeded" draft run left no draft behind', () => {
    // The success-shaped-placeholder guard: a skill reporting success without
    // producing the draft must not advance to promoting nothing.
    expect(
      decideGoalAction(
        state({ latestRunStatus: 'succeeded', repairPhase: 'drafting', draftExists: false }),
      ),
    ).toEqual({ action: 'block', reason: 'DRAFT_MISSING' });
  });

  it('verifies after a promote that consumed the draft branch', () => {
    expect(
      decideGoalAction(
        state({ latestRunStatus: 'succeeded', repairPhase: 'promoting', draftExists: false }),
      ),
    ).toEqual({ action: 'verify' });
  });

  it('blocks when promote reported success but the branch is still there', () => {
    expect(
      decideGoalAction(
        state({ latestRunStatus: 'succeeded', repairPhase: 'promoting', draftExists: true }),
      ),
    ).toEqual({ action: 'block', reason: 'PROMOTE_INCOMPLETE' });
  });
});

describe('draftVersionKey', () => {
  it('is deterministic per drift fingerprint', () => {
    const fingerprint = 'int_1:item_1:translations:translations:vi';
    expect(draftVersionKey(fingerprint)).toBe(draftVersionKey(fingerprint));
    expect(draftVersionKey(fingerprint)).not.toBe(draftVersionKey(`${fingerprint}x`));
  });
});

describe('repairArgumentsForDrift', () => {
  const base = {
    ruleType: 'translations',
    ruleKey: 'translations:vi',
    itemId: 'item_1',
    collection: 'articles',
    fingerprint: 'int_1:item_1:translations:translations:vi',
    detail: { locale: 'vi', reason: 'missing_translation' } as Record<string, unknown>,
  };

  it('derives field and locale for a translation drift', () => {
    expect(repairArgumentsForDrift(base)).toEqual({
      collection: 'articles',
      itemId: 'item_1',
      field: 'translations',
      locale: 'vi',
      versionKey: draftVersionKey(base.fingerprint),
    });
  });

  it('prefers detail.locale over parsing the rule key', () => {
    const result = repairArgumentsForDrift({ ...base, detail: { locale: 'fr' } });
    expect(result?.locale).toBe('fr');
  });

  it('recovers a field name containing a colon by splitting at the last one', () => {
    const result = repairArgumentsForDrift({
      ...base,
      ruleKey: 'meta:title:vi',
      detail: null,
    });
    expect(result?.field).toBe('meta:title');
    expect(result?.locale).toBe('vi');
  });

  it('returns null for rule types with no wired repair path', () => {
    // The dispatcher turns this into an explicit NO_REPAIR_SKILL block rather
    // than a silent skip, so freshness/link drift cannot sit assigned forever.
    expect(repairArgumentsForDrift({ ...base, ruleType: 'freshness', ruleKey: 'age' })).toBeNull();
  });

  it('returns null when the rule key carries no locale', () => {
    expect(repairArgumentsForDrift({ ...base, ruleKey: 'translations', detail: null })).toBeNull();
  });
});
