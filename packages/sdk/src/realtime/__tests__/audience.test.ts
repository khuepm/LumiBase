import { describe, expect, it, vi } from 'vitest';
import { AudienceClient, type WebSocketLike } from '../audience';

/** A controllable fake WebSocket. */
class FakeWebSocket implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  private handlers: Record<string, ((ev: any) => void)[]> = {};

  constructor(public url: string) {}

  addEventListener(type: string, handler: (ev: any) => void): void {
    (this.handlers[type] ??= []).push(handler);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.emit('close', {});
  }
  // Test helpers
  emit(type: string, ev: any): void {
    for (const h of this.handlers[type] ?? []) h(ev);
  }
  open(): void {
    this.readyState = 1;
    this.emit('open', {});
  }
  message(obj: unknown): void {
    this.emit('message', { data: JSON.stringify(obj) });
  }
  parsedSends(): any[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

function fakeFetch(ticket = 'tkt') {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: { ticket } }),
  }) as unknown as typeof fetch;
}

/** Track every FakeWebSocket a single client opens (isolated per test). */
function makeClient(channels: string[] = []) {
  const sockets: FakeWebSocket[] = [];
  const fetchImpl = fakeFetch();
  const client = new AudienceClient({
    baseUrl: 'https://cms.example.com',
    token: 'user-token',
    siteId: 'site-1',
    channels,
    initialBackoffMs: 5,
    maxBackoffMs: 20,
    webSocketFactory: (url) => {
      const ws = new FakeWebSocket(url);
      sockets.push(ws);
      return ws;
    },
    fetchImpl,
  });
  const latest = (): FakeWebSocket => {
    const ws = sockets[sockets.length - 1];
    if (!ws) throw new Error('no socket opened yet');
    return ws;
  };
  return { client, fetchImpl, sockets, latest };
}

describe('AudienceClient', () => {
  it('fetches an audience ticket and opens a ws with it', async () => {
    const { client, fetchImpl, latest } = makeClient(['order:1']);
    client.connect();
    await vi.waitFor(() => expect(latest()).toBeTruthy());

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://cms.example.com/api/v1/realtime/audience-ticket',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(latest().url).toContain('wss://cms.example.com/api/v1/realtime');
    expect(latest().url).toContain('ticket=tkt');
    client.disconnect();
  });

  it('re-joins remembered channels on open', async () => {
    const { client, latest } = makeClient(['order:1', 'order:2']);
    client.connect();
    await vi.waitFor(() => expect(latest()).toBeTruthy());
    latest().open();

    const joins = latest().parsedSends().filter((m) => m.type === 'join');
    expect(joins.map((j) => j.channel).sort()).toEqual(['order:1', 'order:2']);
    expect(client.status).toBe('open');
    client.disconnect();
  });

  it('dispatches channel events and notifications', async () => {
    const { client, latest } = makeClient(['order:1']);
    const events: any[] = [];
    const notes: any[] = [];
    client.onChannelEvent((e) => events.push(e));
    client.onNotification((n) => notes.push(n));
    client.connect();
    await vi.waitFor(() => expect(latest()).toBeTruthy());
    latest().open();

    latest().message({ type: 'event', channel: 'order:1', payload: { status: 'shipped' } });
    latest().message({ type: 'notification', payload: { subject: 'hi' } });

    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ status: 'shipped' });
    expect(notes).toHaveLength(1);
    expect(notes[0].payload).toMatchObject({ subject: 'hi' });
    client.disconnect();
  });

  it('responds to server ping with pong', async () => {
    const { client, latest } = makeClient();
    client.connect();
    await vi.waitFor(() => expect(latest()).toBeTruthy());
    latest().open();
    latest().message({ type: 'ping' });
    expect(latest().parsedSends()).toContainEqual({ type: 'pong' });
    client.disconnect();
  });

  it('join() after open sends immediately and is remembered for reconnect', async () => {
    const { client, sockets, latest } = makeClient();
    client.connect();
    await vi.waitFor(() => expect(latest()).toBeTruthy());
    const first = latest();
    first.open();

    client.join('order:9');
    expect(first.parsedSends()).toContainEqual({ type: 'join', channel: 'order:9' });

    // Simulate a drop → reconnect re-joins order:9.
    first.close();
    await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(1));
    latest().open();
    const rejoins = latest().parsedSends().filter((m) => m.type === 'join');
    expect(rejoins.map((j) => j.channel)).toContain('order:9');
    client.disconnect();
  });
});
