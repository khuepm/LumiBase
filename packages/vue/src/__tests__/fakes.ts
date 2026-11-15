import { vi } from "vitest";
import {
  createLumiClient,
  type ItemRow,
  type LumiClient,
  type PresenceCallback,
  type RealtimeClient,
  type RealtimeEvent,
  type RealtimeEventCallback,
} from "@lumibase/sdk";

export interface PostFields {
  title: string;
  views: number;
  [key: string]: unknown;
}
export type Schema = { posts: PostFields };

export function row(id: string, title: string): ItemRow<PostFields> {
  return { id, siteId: "site_1", collectionId: "c_posts", status: "published", data: { title, views: 1 }, sort: 0 } as ItemRow<PostFields>;
}

/** A real SDK client over a fake fetch — the adapter must go through the SDK. */
export function fakeClient(rows: () => ItemRow<PostFields>[] = () => [row("p1", "Hello")]): {
  client: LumiClient<Schema>;
  calls: string[];
} {
  const calls: string[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url.replace("https://cms.test", ""));
    const match = /\/api\/v1\/items\/posts\/([^?]+)/.exec(url);
    if (match) {
      const found = rows().find((r) => r.id === match[1]);
      return new Response(JSON.stringify({ data: found }), { status: 200 });
    }
    const data = rows();
    return new Response(JSON.stringify({ data, meta: { total: data.length, limit: 10, offset: 0 } }), {
      status: 200,
    });
  });
  const client = createLumiClient<Schema>({
    url: "https://cms.test",
    token: "t",
    siteId: "site_1",
    fetcher: fetcher as unknown as typeof fetch,
  });
  return { client, calls };
}

/** Records every subscription so a test can see what is still attached. */
export function fakeRealtime() {
  const handlers = new Map<string, Set<RealtimeEventCallback>>();
  const presenceListeners = new Set<PresenceCallback>();
  const presenceCalls: Array<Record<string, unknown>> = [];
  const fake = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    subscribe: vi.fn((collection: string, cb: RealtimeEventCallback) => {
      if (!handlers.has(collection)) handlers.set(collection, new Set());
      handlers.get(collection)!.add(cb);
      return () => {
        handlers.get(collection)?.delete(cb);
      };
    }),
    onPresence: vi.fn((cb: PresenceCallback) => {
      presenceListeners.add(cb);
      return () => presenceListeners.delete(cb);
    }),
    presence: vi.fn((opts: Record<string, unknown>) => {
      presenceCalls.push(opts);
    }),
  };
  return {
    realtime: fake as unknown as RealtimeClient,
    fake,
    presenceCalls,
    active: (collection: string) => handlers.get(collection)?.size ?? 0,
    presenceListenerCount: () => presenceListeners.size,
    emit(collection: string, itemId = "p1") {
      const event: RealtimeEvent = { type: "event", collection, action: "update", itemId, payload: null };
      for (const cb of handlers.get(collection) ?? []) cb(event);
    },
    emitPresence(users: Parameters<PresenceCallback>[0]) {
      for (const cb of presenceListeners) cb(users);
    },
  };
}

export const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
