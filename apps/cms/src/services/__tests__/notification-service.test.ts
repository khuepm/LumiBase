import type { Database } from '@lumibase/database';
import type { RealtimeEventLike, RealtimeProvider } from '@lumibase/runtime';
import { describe, expect, it, vi } from 'vitest';
import { NotificationService } from '../notification-service';

const ROW = {
  id: 'ntf_1',
  siteId: 'site-1',
  recipient: 'r1',
  sender: null,
  subject: 'Hello',
  message: null,
  collection: null,
  item: null,
  status: 'unread',
  pushed: false,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

interface DbOpts {
  inserted?: Record<string, unknown>[];
  undelivered?: Record<string, unknown>[];
  onUpdate?: () => void;
}

function fakeDb(opts: DbOpts = {}): Database {
  const insertChain = {
    values: () => insertChain,
    returning: () => Promise.resolve(opts.inserted ?? [{ ...ROW }]),
  };
  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    orderBy: () => selectChain,
    limit: () => Promise.resolve(opts.undelivered ?? []),
  };
  const updateChain = {
    set: () => updateChain,
    where: () => {
      opts.onUpdate?.();
      return Promise.resolve();
    },
  };
  return {
    insert: () => insertChain,
    select: () => selectChain,
    update: () => updateChain,
  } as unknown as Database;
}

function fakeRealtime(fail = false): { provider: RealtimeProvider; calls: RealtimeEventLike[] } {
  const calls: RealtimeEventLike[] = [];
  return {
    calls,
    provider: {
      isAvailable: () => true,
      publish: vi.fn(async (_siteId: string, event: RealtimeEventLike) => {
        if (fail) throw new Error('boom');
        calls.push(event);
      }),
    },
  };
}

describe('NotificationService.create', () => {
  it('persists and targets an admin recipient on the studio plane', async () => {
    const rt = fakeRealtime();
    const updates: number[] = [];
    const svc = new NotificationService({
      db: fakeDb({ onUpdate: () => updates.push(1) }),
      siteId: 'site-1',
      realtime: rt.provider,
    });

    const row = await svc.create({ recipient: 'admin-1', plane: 'studio', subject: 'Hi' });

    expect(rt.calls[0]).toMatchObject({
      type: 'notification',
      plane: 'studio',
      target: { userId: 'admin-1' },
    });
    expect(row.pushed).toBe(true); // flipped after successful delivery
    expect(updates.length).toBe(1); // markPushed ran
  });

  it('targets an end-user by subjectId on the public plane', async () => {
    const rt = fakeRealtime();
    const svc = new NotificationService({ db: fakeDb(), siteId: 'site-1', realtime: rt.provider });

    await svc.create({ recipient: 'citizen-42', plane: 'public', subject: 'Order update' });

    expect(rt.calls[0]).toMatchObject({ plane: 'public', target: { subjectId: 'citizen-42' } });
  });

  it('keeps pushed=false when realtime is unavailable', async () => {
    const svc = new NotificationService({ db: fakeDb(), siteId: 'site-1' /* no realtime */ });
    const row = await svc.create({ recipient: 'r1', subject: 'Hi' });
    expect(row.pushed).toBe(false);
  });

  it('does not fail the write when realtime publish throws', async () => {
    const rt = fakeRealtime(true);
    const svc = new NotificationService({ db: fakeDb(), siteId: 'site-1', realtime: rt.provider });
    const row = await svc.create({ recipient: 'r1', subject: 'Hi' });
    expect(row.id).toBe('ntf_1');
    expect(row.pushed).toBe(false);
  });
});

describe('NotificationService.listUndelivered', () => {
  it('returns undelivered rows for replay', async () => {
    const svc = new NotificationService({
      db: fakeDb({ undelivered: [{ ...ROW, pushed: false }] }),
      siteId: 'site-1',
    });
    const rows = await svc.listUndelivered('r1');
    expect(rows).toHaveLength(1);
  });
});
