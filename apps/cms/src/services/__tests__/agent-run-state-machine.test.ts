import { describe, expect, it } from 'vitest';
import type { Database } from '@lumibase/database';
import { AgentRunService } from '../agent-run-service';
import { processAgentRunJob, type AgentRunJobPayload } from '../agent-run-worker';

/**
 * Feature: content-os, Requirement 3 — queued agent runs.
 *
 * State machine: queued → running → awaiting_approval → succeeded | failed
 * | cancelled. Cancellation is honoured at tool-call boundaries and wins
 * over queued pickup; resuming from awaiting_approval never re-runs
 * completed tool calls (the approval path executes only the stored skill).
 *
 * **Validates: Requirements 3.1, 3.4, 3.5**
 */

interface RunRow extends Record<string, unknown> {
  id: string;
  siteId: string;
  goalId: string;
  agentName: string;
  status: string;
  metrics: Record<string, unknown>;
}

/**
 * Minimal drizzle stand-in for a single agent_runs row: select returns the
 * row, update merges the patch. `where` is thenable (awaitApproval awaits it
 * directly) and also exposes `returning` (cancelRun chains it).
 */
function fakeRunsDb(initial: RunRow | null): Database & { row: () => RunRow | null } {
  let current = initial;
  const db = {
    row: () => current,
    select: () => ({
      from: () => ({
        where: () => {
          const rows = current ? [{ ...current }] : [];
          return Object.assign(Promise.resolve(rows), {
            limit: async () => rows,
          });
        },
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => {
          if (current) Object.assign(current, patch);
          const rows = current ? [{ ...current }] : [];
          return Object.assign(Promise.resolve(undefined), {
            returning: async () => rows,
          });
        },
      }),
    }),
  };
  return db as unknown as Database & { row: () => RunRow | null };
}

function makeRun(status: string): RunRow {
  return {
    id: 'run_1',
    siteId: 'site_1',
    goalId: 'goal_1',
    agentName: 'lumibase-copilot',
    status,
    metrics: {},
  };
}

describe('Feature: content-os, Requirement 3: run state machine', () => {
  it('markRunning transitions queued → running', async () => {
    const db = fakeRunsDb(makeRun('queued'));
    const service = new AgentRunService(db, 'site_1');
    expect(await service.markRunning('run_1')).toBe(true);
    expect(db.row()!.status).toBe('running');
  });

  it('markRunning resumes awaiting_approval → running', async () => {
    const db = fakeRunsDb(makeRun('awaiting_approval'));
    const service = new AgentRunService(db, 'site_1');
    expect(await service.markRunning('run_1')).toBe(true);
    expect(db.row()!.status).toBe('running');
  });

  it('markRunning refuses cancelled and terminal runs', async () => {
    for (const status of ['cancelled', 'succeeded', 'failed']) {
      const db = fakeRunsDb(makeRun(status));
      const service = new AgentRunService(db, 'site_1');
      expect(await service.markRunning('run_1')).toBe(false);
      expect(db.row()!.status).toBe(status);
    }
  });

  it('awaitApproval parks a run as awaiting_approval', async () => {
    const db = fakeRunsDb(makeRun('running'));
    const service = new AgentRunService(db, 'site_1');
    await service.awaitApproval('run_1');
    expect(db.row()!.status).toBe('awaiting_approval');
  });

  it('cancelRun cancels queued/running/awaiting_approval runs with a stop reason', async () => {
    for (const status of ['queued', 'running', 'awaiting_approval']) {
      const db = fakeRunsDb(makeRun(status));
      const service = new AgentRunService(db, 'site_1');
      const cancelled = await service.cancelRun('run_1', 'cancelled_by_user');
      expect(cancelled?.status).toBe('cancelled');
      expect((db.row()!.metrics as Record<string, unknown>)['stopReason']).toBe('cancelled_by_user');
      expect(await service.isCancelled('run_1')).toBe(true);
    }
  });

  it('cancelRun refuses terminal runs (idempotent, no double-cancel)', async () => {
    for (const status of ['succeeded', 'failed', 'cancelled']) {
      const db = fakeRunsDb(makeRun(status));
      const service = new AgentRunService(db, 'site_1');
      expect(await service.cancelRun('run_1')).toBeNull();
      expect(db.row()!.status).toBe(status);
    }
  });

  it('cancelRun returns null for missing runs', async () => {
    const db = fakeRunsDb(null);
    const service = new AgentRunService(db, 'site_1');
    expect(await service.cancelRun('run_404')).toBeNull();
  });
});

describe('Feature: content-os, Requirement 3.5: worker honours cancellation', () => {
  const payload: AgentRunJobPayload = {
    siteId: 'site_1',
    goalId: 'goal_1',
    runId: 'run_1',
    skillName: 'listItems',
    arguments: { collection: 'products' },
    capabilities: ['items:read'],
  };

  it('skips execution when the run was cancelled while queued', async () => {
    const db = fakeRunsDb(makeRun('cancelled'));
    // A cancelled run must short-circuit before any service construction —
    // the fake db would throw on the insert the harness audit path performs.
    await processAgentRunJob({ db, env: {} }, payload);
    expect(db.row()!.status).toBe('cancelled');
  });

  it('skips execution when the run no longer exists', async () => {
    const db = fakeRunsDb(null);
    await expect(processAgentRunJob({ db, env: {} }, payload)).resolves.toBeUndefined();
  });
});
