/**
 * Bridges the per-site SiteRoom Durable Object realtime channel into an
 * async iterator suitable for a GraphQL subscription `subscribe` function.
 *
 * All item mutations fan out to the SiteRoom DO (one instance per site) via
 * `ItemService.publishRealtimeEvent`, so connecting an internal WebSocket to
 * that DO and forwarding its events gives cross-isolate-correct delivery on
 * Cloudflare. When no realtime namespace is bound (e.g. Docker dev without a
 * Durable Object), the source yields nothing rather than failing.
 */

export interface ItemEvent {
  collection: string;
  action: 'create' | 'update' | 'delete';
  itemId: string;
  item: unknown;
}

interface RealtimeNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

export async function* createSiteEventSource(
  realtimeNamespace: RealtimeNamespaceLike | undefined,
  siteId: string,
  userId: string | null,
  collection: string,
): AsyncGenerator<ItemEvent> {
  if (!realtimeNamespace) return;

  const stub = realtimeNamespace.get(realtimeNamespace.idFromName(siteId));
  const res = await stub.fetch(
    new Request(`https://internal/subscribe?userId=${encodeURIComponent(userId ?? '__gql_sub__')}`, {
      headers: { Upgrade: 'websocket' },
    }),
  );

  // `webSocket` is the Cloudflare Workers client side of the 101 response.
  const ws = (res as unknown as { webSocket?: WebSocket }).webSocket;
  if (!ws) return;

  ws.accept();
  ws.send(JSON.stringify({ type: 'subscribe', collection }));

  const queue: ItemEvent[] = [];
  let notify: (() => void) | null = null;
  let closed = false;
  const wake = () => {
    notify?.();
    notify = null;
  };

  ws.addEventListener('message', (ev: MessageEvent) => {
    try {
      const raw = typeof ev.data === 'string' ? ev.data : '';
      const data = JSON.parse(raw) as Partial<ItemEvent> & { type?: string; payload?: unknown };
      if (data?.type === 'event' && data.collection === collection) {
        queue.push({
          collection: data.collection,
          action: data.action as ItemEvent['action'],
          itemId: data.itemId as string,
          item: data.payload,
        });
        wake();
      }
    } catch {
      /* ignore malformed frames */
    }
  });
  ws.addEventListener('close', () => {
    closed = true;
    wake();
  });
  ws.addEventListener('error', () => {
    closed = true;
    wake();
  });

  try {
    while (!closed) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
        continue;
      }
      yield queue.shift()!;
    }
  } finally {
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }
}
