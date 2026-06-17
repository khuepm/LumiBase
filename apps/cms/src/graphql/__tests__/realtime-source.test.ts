import { describe, expect, it, vi } from 'vitest';
import { createSiteEventSource } from '../realtime-source';

type Handler = (ev: { data: string }) => void;

function fakeWebSocket() {
  const handlers: Record<string, Handler> = {};
  return {
    accept: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: (type: string, h: Handler) => {
      handlers[type] = h;
    },
    emit: (type: string, data?: unknown) => handlers[type]?.({ data: JSON.stringify(data) }),
  };
}

function fakeNamespace(ws: ReturnType<typeof fakeWebSocket>) {
  const fetch = vi.fn(async () => ({ webSocket: ws }) as unknown as Response);
  return {
    ns: { idFromName: (n: string) => n, get: () => ({ fetch }) } as unknown as Parameters<
      typeof createSiteEventSource
    >[0],
    fetch,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('createSiteEventSource', () => {
  it('subscribes to the collection and forwards matching events', async () => {
    const ws = fakeWebSocket();
    const { ns } = fakeNamespace(ws);

    const gen = createSiteEventSource(ns, 'site-1', 'u1', 'articles');
    const next = gen.next();
    await flush();

    expect(ws.accept).toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'subscribe', collection: 'articles' }));

    ws.emit('message', { type: 'event', collection: 'articles', action: 'create', itemId: 'i1', payload: { title: 'x' } });
    const { value, done } = await next;

    expect(done).toBe(false);
    expect(value).toEqual({ collection: 'articles', action: 'create', itemId: 'i1', item: { title: 'x' } });
  });

  it('ignores events for other collections', async () => {
    const ws = fakeWebSocket();
    const { ns } = fakeNamespace(ws);

    const gen = createSiteEventSource(ns, 'site-1', 'u1', 'articles');
    const next = gen.next();
    await flush();

    ws.emit('message', { type: 'event', collection: 'comments', action: 'create', itemId: 'c1', payload: {} });
    ws.emit('message', { type: 'event', collection: 'articles', action: 'update', itemId: 'i2', payload: { title: 'y' } });

    const { value } = await next;
    expect(value).toMatchObject({ itemId: 'i2', action: 'update' });
  });

  it('completes when the websocket closes', async () => {
    const ws = fakeWebSocket();
    const { ns } = fakeNamespace(ws);

    const gen = createSiteEventSource(ns, 'site-1', 'u1', 'articles');
    const next = gen.next();
    await flush();

    ws.emit('close');
    const { done } = await next;
    expect(done).toBe(true);
    expect(ws.close).toHaveBeenCalled();
  });

  it('yields nothing when no realtime namespace is bound', async () => {
    const gen = createSiteEventSource(undefined, 'site-1', 'u1', 'articles');
    const { done } = await gen.next();
    expect(done).toBe(true);
  });
});
