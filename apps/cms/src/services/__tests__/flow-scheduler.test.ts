import type { Database } from '@lumibase/database';
import { describe, expect, it, vi } from 'vitest';
import { isValidCron, nextCron, runDueScheduledFlows } from '../flow-scheduler';

describe('cron validation', () => {
  it('accepts standard 5-field expressions', () => {
    expect(isValidCron('* * * * *')).toBe(true);
    expect(isValidCron('0 9 * * 1-5')).toBe(true);
    expect(isValidCron('*/15 * * * *')).toBe(true);
  });
  it('rejects malformed expressions', () => {
    expect(isValidCron('* * * *')).toBe(false); // 4 fields
    expect(isValidCron('60 * * * *')).toBe(false); // minute out of range
    expect(isValidCron('nonsense')).toBe(false);
  });
});

describe('nextCron', () => {
  it('computes the next matching minute (UTC), strictly after `from`', () => {
    // Every day at 09:00 UTC; from 08:59 → same-day 09:00.
    const from = new Date('2026-01-01T08:59:00Z');
    expect(nextCron('0 9 * * *', from).toISOString()).toBe('2026-01-01T09:00:00.000Z');
  });
  it('rolls to the next day when already past today’s time', () => {
    const from = new Date('2026-01-01T09:30:00Z');
    expect(nextCron('0 9 * * *', from).toISOString()).toBe('2026-01-02T09:00:00.000Z');
  });
  it('honors a step field', () => {
    const from = new Date('2026-01-01T00:04:00Z');
    expect(nextCron('*/15 * * * *', from).toISOString()).toBe('2026-01-01T00:15:00.000Z');
  });
});

function fakeDb(dueRows: { id: string; siteId: string; triggerOptions: unknown }[]) {
  const captured: { updates: Record<string, unknown>[] } = { updates: [] };
  const selectChain = { from: () => selectChain, where: () => Promise.resolve(dueRows) };
  const updateChain = {
    set: (v: Record<string, unknown>) => {
      captured.updates.push(v);
      return updateChain;
    },
    where: () => Promise.resolve([]),
  };
  const db = { select: () => selectChain, update: () => updateChain } as unknown as Database;
  return { db, captured };
}

describe('runDueScheduledFlows', () => {
  it('enqueues each due flow and advances nextRunAt from cron', async () => {
    const now = new Date('2026-01-01T09:00:00Z');
    const { db, captured } = fakeDb([{ id: 'f1', siteId: 's1', triggerOptions: { cron: '0 9 * * *' } }]);
    const enqueue = vi.fn(async () => 'job');
    const queue = { enqueue, process: vi.fn(), getStatus: vi.fn() } as never;
    const n = await runDueScheduledFlows({ db, queue }, now);
    expect(n).toBe(1);
    expect(enqueue).toHaveBeenCalledWith('flow-schedule', 'run-scheduled-flow', { siteId: 's1', flowId: 'f1' });
    // nextRunAt advanced to the following day at 09:00.
    expect((captured.updates[0]!.nextRunAt as Date).toISOString()).toBe('2026-01-02T09:00:00.000Z');
  });

  it('still advances nextRunAt when no queue is bound (no wedge)', async () => {
    const now = new Date('2026-01-01T09:00:00Z');
    const { db, captured } = fakeDb([{ id: 'f1', siteId: 's1', triggerOptions: { cron: '0 9 * * *' } }]);
    const n = await runDueScheduledFlows({ db }, now);
    expect(n).toBe(0);
    expect(captured.updates).toHaveLength(1);
  });
});
