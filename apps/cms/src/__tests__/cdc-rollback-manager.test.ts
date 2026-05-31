import { describe, it, expect } from 'vitest';

import {
  RollbackManager,
  InMemoryStepUndoer,
  classifyError,
  ROLLBACK_BUDGET_MS,
  type RollbackableStep,
  type FailedStep,
  type StepUndoer,
} from '../modules/cdc/ai-flow/rollback-manager';

// ── helpers ──────────────────────────────────────────────────────────────

/** Build a completed step with a single resource and a recording undo hook. */
function step(name: string, order: string[]): RollbackableStep {
  return {
    name,
    resources: [{ type: 'resource', id: name }],
    undo: () => {
      order.push(name);
    },
  };
}

/** A clock that advances by a fixed amount on each read. */
function steppingClock(stepMs: number, start = 0): () => number {
  let t = start;
  return () => {
    const current = t;
    t += stepMs;
    return current;
  };
}

describe('classifyError', () => {
  it('reports the constructor name and message for Error instances', () => {
    expect(classifyError(new TypeError('boom'))).toEqual({
      errorType: 'TypeError',
      description: 'boom',
    });
  });

  it('classifies string, null, and undefined throwables', () => {
    expect(classifyError('oops')).toEqual({ errorType: 'string', description: 'oops' });
    expect(classifyError(null)).toEqual({ errorType: 'null', description: 'null' });
    expect(classifyError(undefined)).toEqual({ errorType: 'undefined', description: 'undefined' });
  });
});

describe('RollbackManager.rollback', () => {
  it('undoes completed steps in reverse completion order', async () => {
    const order: string[] = [];
    const undoer = new InMemoryStepUndoer();
    const manager = new RollbackManager({ undoer });

    const completedSteps = [step('s1', order), step('s2', order), step('s3', order)];
    const failedStep: FailedStep = { name: 's4', error: new Error('step 4 failed') };

    const result = await manager.rollback({ completedSteps, failedStep });

    // Reverse completion order: s3, then s2, then s1.
    expect(order).toEqual(['s3', 's2', 's1']);
    expect(undoer.teardownOrder).toEqual(['s3', 's2', 's1']);
    expect(result.rolledBackSteps.map((s) => s.stepName)).toEqual(['s3', 's2', 's1']);
    expect(result.rolledBackSteps.every((s) => s.status === 'undone')).toBe(true);
  });

  it('reports the failed step name, error type, and description (Req 7.6)', async () => {
    const manager = new RollbackManager();
    const failedStep: FailedStep = {
      name: 'provision_kafka',
      error: new RangeError('port out of range'),
    };

    const result = await manager.rollback({ completedSteps: [], failedStep });

    expect(result.failure).toEqual({
      stepName: 'provision_kafka',
      errorType: 'RangeError',
      description: 'port out of range',
    });
  });

  it('leaves no remaining resources on a fully-successful rollback', async () => {
    const order: string[] = [];
    const manager = new RollbackManager();
    const completedSteps = [step('a', order), step('b', order)];
    const failedStep: FailedStep = {
      name: 'c',
      error: new Error('fail'),
      resources: [{ type: 'resource', id: 'c-partial' }],
      undo: () => order.push('c'),
    };

    const result = await manager.rollback({ completedSteps, failedStep });

    // Failed step's partial resources are cleaned up first (full reverse order).
    expect(order).toEqual(['c', 'b', 'a']);
    expect(result.failedStepCleanup?.status).toBe('undone');
    expect(result.remainingResources).toEqual([]);
    expect(result.success).toBe(true);
    expect(result.withinBudget).toBe(true);
  });

  it('keeps a step\'s resources in remainingResources when its teardown fails', async () => {
    const failingUndoer: StepUndoer = {
      async undo(s) {
        if (s.name === 'b') throw new Error('teardown b failed');
      },
    };
    const manager = new RollbackManager({ undoer: failingUndoer });
    const completedSteps: RollbackableStep[] = [
      { name: 'a', resources: [{ type: 'resource', id: 'a' }] },
      { name: 'b', resources: [{ type: 'resource', id: 'b' }] },
    ];
    const failedStep: FailedStep = { name: 'c', error: new Error('fail') };

    const result = await manager.rollback({ completedSteps, failedStep });

    expect(result.success).toBe(false);
    expect(result.remainingResources).toEqual([{ type: 'resource', id: 'b' }]);
    const bOutcome = result.rolledBackSteps.find((s) => s.stepName === 'b');
    expect(bOutcome?.status).toBe('failed');
    expect(bOutcome?.errorType).toBe('Error');
  });

  it('exposes a 60-second default budget', () => {
    expect(ROLLBACK_BUDGET_MS).toBe(60_000);
  });

  it('skips remaining steps and reports them once the budget is exhausted', async () => {
    // Each clock read advances 40s: start=0, deadline=60s. First step sees
    // remainingMs > 0; subsequent reads cross the deadline.
    const manager = new RollbackManager({
      clock: steppingClock(40_000),
      budgetMs: ROLLBACK_BUDGET_MS,
    });
    const completedSteps: RollbackableStep[] = [
      { name: 's1', resources: [{ type: 'resource', id: 's1' }] },
      { name: 's2', resources: [{ type: 'resource', id: 's2' }] },
    ];
    const failedStep: FailedStep = { name: 's3', error: new Error('fail') };

    const result = await manager.rollback({ completedSteps, failedStep });

    expect(result.withinBudget).toBe(false);
    expect(result.success).toBe(false);
    // At least one step is skipped due to the exhausted budget.
    expect(result.rolledBackSteps.some((s) => s.status === 'skipped')).toBe(true);
    // Skipped steps' resources are reported as remaining.
    expect(result.remainingResources.length).toBeGreaterThan(0);
  });
});
