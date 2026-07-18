import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@lumibase/database';
import { isValidCron, nextCronRun, runDueScheduledFlows } from '../flow-scheduler';
import { FLOW_EVENTS_QUEUE } from '../flow-dispatch';

/**
 * Scheduled flow runner (visual-flow-builder task 4.4).
 *
 * **Validates: Requirements 2.1, 2.3**
 */

describe('isValidCron', () => {
  it('accepts standard 5-field expressions', () => {
    for (const expr of ['* * * * *', '*/5 * * * *', '0 3 * * *', '15,45 8-17 * * 1-5', '0 0 1 1 0']) {
      expect(isValidCron(expr), expr).toBe(true);
    }
  });

  it('rejects malformed expressions', () => {
    for (const expr of ['', '* * * *', '60 * * * *', '* 24 * * *', 'a * * * *', '* * 0 * *', '*/0 * * * *', 5, null]) {
      expect(isValidCron(expr), String(expr)).toBe(false);
    }
  });
});

describe('nextCronRun', () => {
  it('advances to the next matching minute', () => {
    const next = nextCronRun('*/5 * * * *', new Date('2026-07-06T12:02:10Z'));
    expect(next?.toISOString()).toBe('2026-07-06T12:05:00.000Z');
  });

  it('is strictly after `from` even when `from` matches', () => {
    const next = nextCronRun('*/5 * * * *', new Date('2026-07-06T12:05:00Z'));
    expect(next?.toISOString()).toBe('2026-07-06T12:10:00.000Z');
  });

  it('rolls over to the next day for a daily schedule', () => {
    const next = nextCronRun('0 3 * * *', new Date('2026-07-06T12:00:00Z'));
    expect(next?.toISOString()).toBe('2026-07-07T03:00:00.000Z');
  });

  it('respects day-of-week restrictions', () => {
    // 2026-07-06 is a Monday; next Friday is 2026-07-10.
    const next = nextCronRun('0 9 * * 5', new Date('2026-07-06T12:00:00Z'));
    expect(next?.toISOString()).toBe('2026-07-10T09:00:00.000Z');
  });

  it('returns null for an invalid expression', () => {
    expect(nextCronRun('not a cron', new Date())).toBeNull();
  });
});

function makeDb(dueFlows: Record<string, unknown>[]) {
  const updates: Record<string, unknown>[] = [];
  const db = {
    select() {
      const b: Record<string, unknown> = { from: () => b, where: () => Promise.resolve(dueFlows) };
      return b;
    },
    update() {
      return {
        set(set: Record<string, unknown>) {
          updates.push(set);
          return { where: () => Promise.resolve(undefined) };
        },
      };
    },
  };
  return { db: db as unknown as Database, updates };
}

const NOW = new Date('2026-07-06T12:02:00Z');

describe('runDueScheduledFlows (Req 2.1)', () => {
  it('enqueues due flows and advances next_run_at before the run', async () => {
    const { db, updates } = makeDb([
      { id: 'f1', siteId: 's1', triggerOptions: { cron: '*/5 * * * *' } },
    ]);
    const enqueue = vi.fn().mockResolvedValue('job_1');
    const queue = { enqueue, process: vi.fn(), getStatus: vi.fn() };

    const n = await runDueScheduledFlows({ db, queue }, NOW);
    expect(n).toBe(1);
    expect((updates[0]?.nextRunAt as Date).toISOString()).toBe('2026-07-06T12:05:00.000Z');
    expect(enqueue).toHaveBeenCalledWith(FLOW_EVENTS_QUEUE, 'flow:scheduled', {
      siteId: 's1',
      flowId: 'f1',
      input: { trigger: 'schedule', scheduledAt: NOW.toISOString() },
    });
  });

  it('clears next_run_at when the cron became invalid (stops re-sweeping)', async () => {
    const { db, updates } = makeDb([{ id: 'f1', siteId: 's1', triggerOptions: { cron: 'garbage' } }]);
    const queue = { enqueue: vi.fn().mockResolvedValue('job_1'), process: vi.fn(), getStatus: vi.fn() };
    await runDueScheduledFlows({ db, queue }, NOW);
    expect(updates[0]?.nextRunAt).toBeNull();
  });

  it('is a no-op without a queue', async () => {
    const { db, updates } = makeDb([{ id: 'f1', siteId: 's1', triggerOptions: { cron: '* * * * *' } }]);
    expect(await runDueScheduledFlows({ db }, NOW)).toBe(0);
    expect(updates).toHaveLength(0);
  });
});
