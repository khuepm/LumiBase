import { describe, expect, it, vi } from 'vitest';
import { emitAgentNotification, type EmitNotificationDeps } from '../agent-notifications';

/**
 * Broadcaster unit tests (push-noti feature). The two transports are exercised
 * in isolation: in-app via a fake DO stub, Web Push lookup gated on VAPID.
 */

function fakeDb(rows: unknown[] = []) {
  // Minimal chainable stub matching the `select().from().where()` shape used by
  // the broadcaster's subscription lookup.
  const builder = {
    from: () => builder,
    where: () => Promise.resolve(rows),
  };
  return {
    select: vi.fn(() => builder),
    delete: vi.fn(() => ({ where: () => Promise.resolve() })),
  } as unknown as EmitNotificationDeps['db'];
}

describe('emitAgentNotification', () => {
  it('is a no-op (no throw, no db) without a DO namespace or VAPID keys', async () => {
    const db = fakeDb();
    await emitAgentNotification(
      { db, siteId: 'site_1' },
      { kind: 'approval', severity: 'info', title: 't', body: 'b', entityId: 'a1' },
    );
    expect((db as unknown as { select: ReturnType<typeof vi.fn> }).select).not.toHaveBeenCalled();
  });

  it('publishes an in-app frame to the SiteRoom DO with a stamped id + ts', async () => {
    let captured: Request | undefined;
    const fetchSpy = vi.fn(async (req: Request) => {
      captured = req;
      return new Response(null, { status: 204 });
    });
    const doNamespace = {
      idFromName: vi.fn(() => 'do-id'),
      get: vi.fn(() => ({ fetch: fetchSpy })),
    } as unknown as DurableObjectNamespace;

    await emitAgentNotification(
      { db: fakeDb(), siteId: 'site_1', doNamespace },
      { kind: 'incident', severity: 'critical', title: 'Incident', body: 'boom', entityId: 'i1' },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const req = captured!;
    expect(req.url).toContain('/publish-notification');
    const sent = (await req.json()) as { type: string; notification: Record<string, unknown> };
    expect(sent.type).toBe('notification');
    expect(sent.notification.kind).toBe('incident');
    expect(sent.notification.entityId).toBe('i1');
    expect(typeof sent.notification.id).toBe('string');
    expect(typeof sent.notification.ts).toBe('string');
  });

  it('queries subscriptions when VAPID is configured', async () => {
    const db = fakeDb([]); // no subscriptions → no sends
    await emitAgentNotification(
      { db, siteId: 'site_1', vapid: { publicKey: 'p', privateKey: 'd', subject: 'mailto:x' } },
      { kind: 'run', severity: 'info', title: 'run', body: 'done', entityId: 'r1' },
    );
    expect((db as unknown as { select: ReturnType<typeof vi.fn> }).select).toHaveBeenCalledTimes(1);
  });
});
