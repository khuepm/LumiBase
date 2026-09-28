import { afterEach, describe, expect, it, vi } from 'vitest';
import { RealtimeClient } from '../index';
import { toWebSocketBase } from '../ws-url';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('toWebSocketBase', () => {
  it('maps absolute http(s) origins to ws(s)', () => {
    expect(toWebSocketBase('https://api.example.com')).toBe('wss://api.example.com');
    expect(toWebSocketBase('http://localhost:1989/')).toBe('ws://localhost:1989');
  });

  it('resolves a same-origin base against location (Studio inside the Docker image)', () => {
    vi.stubGlobal('location', { origin: 'http://localhost:1989' });
    expect(toWebSocketBase('')).toBe('ws://localhost:1989');
    expect(toWebSocketBase('/cms')).toBe('ws://localhost:1989/cms');
  });

  it('leaves a relative base alone when there is no location', () => {
    expect(toWebSocketBase('')).toBe('');
  });
});

describe('RealtimeClient with a same-origin baseUrl', () => {
  it('opens the socket on the page origin instead of throwing Invalid URL', async () => {
    vi.stubGlobal('location', { origin: 'https://cms.example.com' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ data: { ticket: 't_1' } }), { status: 200 })),
    );
    const opened: string[] = [];
    class FakeWebSocket {
      static OPEN = 1;
      static CONNECTING = 0;
      readyState = 0;
      constructor(url: string) {
        opened.push(url);
      }
      addEventListener() {}
      close() {}
      send() {}
      set onopen(_: unknown) {}
      set onmessage(_: unknown) {}
      set onclose(_: unknown) {}
      set onerror(_: unknown) {}
    }
    vi.stubGlobal('WebSocket', FakeWebSocket);

    const client = new RealtimeClient({ baseUrl: '', token: 'tok', siteId: 'site_a' });
    client.connect();
    await vi.waitFor(() => expect(opened).toHaveLength(1));

    const url = new URL(opened[0]!);
    expect(url.origin).toBe('wss://cms.example.com');
    expect(url.pathname).toBe('/api/v1/realtime');
    expect(url.searchParams.get('ticket')).toBe('t_1');
    client.disconnect();
  });
});
