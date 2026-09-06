import { describe, expect, it, vi } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { agentApprovals, agentGoals, agentRuns, settings } from '@lumibase/database';
import { ReviewerService } from '../reviewer-service';
import { createFakeDb, type Row } from './g1-approval-fake-db';

/**
 * G1 (#453) — the agent-reviewer decision path has the same execution gap as
 * the human one: a confident approve set `agent_approvals.status = 'approved'`
 * and returned `decided` without ever running the parked action.
 *
 * The escalation semantics (reject / low confidence / no self-review / veto is
 * human-only) are deliberately preserved: only the finalize branch changes.
 */

const APPROVALS = getTableName(agentApprovals);
const RUNS = getTableName(agentRuns);
const GOALS = getTableName(agentGoals);
const SETTINGS = getTableName(settings);

vi.mock('../feature-flags', () => ({
  getContentOsFlags: vi.fn().mockResolvedValue({ agentReview: true }),
}));

function scenario(approvalOverrides: Row = {}) {
  const fake = createFakeDb({
    [APPROVALS]: [{
      id: 'appr_1',
      siteId: 'site_a',
      runId: 'run_subject',
      legacyApprovalId: 'legacy_1',
      subjectType: 'tool_call',
      subjectId: 'tc_1',
      kind: 'approval',
      status: 'pending',
      ...approvalOverrides,
    }],
    // Disjoint goal trees: the reviewer is not inside the subject's tree.
    [RUNS]: [
      { id: 'run_subject', siteId: 'site_a', goalId: 'goal_subject' },
      { id: 'run_reviewer', siteId: 'site_a', goalId: 'goal_reviewer' },
    ],
    [GOALS]: [
      { id: 'goal_subject', siteId: 'site_a', parentGoalId: null },
      { id: 'goal_reviewer', siteId: 'site_a', parentGoalId: null },
    ],
    [SETTINGS]: [{ siteId: 'site_a', key: 'contentOs', value: { agentReviewMinConfidence: 0.8 } }],
  });

  // The stub does not parse `where`; each table answers only its own row set.
  fake.tables[SETTINGS]!.match = () => true;
  return fake;
}

const baseInput = {
  approvalId: 'appr_1',
  reviewerRunId: 'run_reviewer',
  decision: 'approved' as const,
  confidence: 0.95,
  capabilities: ['review:items'],
};

describe('G1 — agent reviewer decision executes the parked action', () => {
  it('executes the stored action before finalizing a confident approve', async () => {
    const fake = scenario();
    const execute = vi.fn().mockResolvedValue({ executed: true });
    const service = new ReviewerService({ db: fake.db, siteId: 'site_a', execute });
    const outcome = await service.decide(baseInput);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toMatchObject({ legacyApprovalId: 'legacy_1' });
    expect(outcome).toMatchObject({ outcome: 'decided', status: 'approved' });
    expect(fake.tables[APPROVALS]!.rows[0]!['status']).toBe('approved');
  });

  it('does not finalize when execution fails — escalates and stays pending', async () => {
    const fake = scenario();
    const execute = vi.fn().mockResolvedValue({ executed: false, message: 'ITEM_SERVICE_NOT_CONFIGURED' });
    const service = new ReviewerService({ db: fake.db, siteId: 'site_a', execute });
    const outcome = await service.decide(baseInput);

    expect(outcome.outcome).toBe('escalated');
    expect(fake.tables[APPROVALS]!.rows[0]!['status']).toBe('pending');
  });

  it('does not finalize when no executor is wired', async () => {
    const fake = scenario();
    const service = new ReviewerService({ db: fake.db, siteId: 'site_a' });
    const outcome = await service.decide(baseInput);

    expect(outcome.outcome).toBe('escalated');
    expect(fake.tables[APPROVALS]!.rows[0]!['status']).toBe('pending');
  });

  it('never executes on a rejection (escalation semantics preserved)', async () => {
    const fake = scenario();
    const execute = vi.fn();
    const service = new ReviewerService({ db: fake.db, siteId: 'site_a', execute });
    const outcome = await service.decide({ ...baseInput, decision: 'rejected' });

    expect(execute).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ outcome: 'escalated', reason: 'rejected' });
    expect(fake.tables[APPROVALS]!.rows[0]!['status']).toBe('pending');
  });

  it('never executes below the confidence threshold', async () => {
    const fake = scenario();
    const execute = vi.fn();
    const service = new ReviewerService({ db: fake.db, siteId: 'site_a', execute });
    const outcome = await service.decide({ ...baseInput, confidence: 0.4 });

    expect(execute).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ outcome: 'escalated', reason: 'low_confidence' });
  });

  it('never executes a veto-window approval (human-only)', async () => {
    const fake = scenario({ kind: 'veto' });
    const execute = vi.fn();

    const service = new ReviewerService({ db: fake.db, siteId: 'site_a', execute });
    await expect(service.decide(baseInput)).rejects.toThrow(/HUMAN_ONLY|human/i);
    expect(execute).not.toHaveBeenCalled();
  });
});
