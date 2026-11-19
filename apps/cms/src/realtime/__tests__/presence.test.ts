import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { SignJWT } from 'jose';
import { WebSocket } from 'ws';
import { InProcessRealtimeHub } from '@lumibase/runtime/docker';
import { PRESENCE_META_MAX_BYTES, parseClientMessage } from '@lumibase/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachNodeRealtime } from '../node-hub';
import { nextPresence, visiblePresence, type PresenceState } from '../presence';

/** Field focus + soft locks on the presence channel (#685). */

const studio = { userId: 'u1', plane: 'studio' as const };
const msg = (m: Record<string, unknown>) => {
  const parsed = parseClientMessage({ type: 'presence', ...m });
  if (!parsed || parsed.type !== 'presence') throw new Error('invalid presence message');
  return parsed;
};
const t0 = new Date('2026-11-19T10:00:00Z');
const t1 = new Date('2026-11-19T10:00:05Z');

describe('nextPresence', () => {
  it('takes identity from the ticket, never the message', () => {
    const p = nextPresence({}, msg({ collection: 'posts', itemId: 'a', meta: { userId: 'spoof' } }), studio, t0);
    expect(p.userId).toBe('u1');
  });

  it('records focus and stamps a lock with server time', () => {
    const p = nextPresence({}, msg({ collection: 'posts', itemId: 'a', focus: 'title', lock: 'title' }), studio, t0);
    expect(p).toMatchObject({ focus: 'title', lock: { field: 'title', since: t0.toISOString() } });
    // Re-sending the same lock keeps its original time; omitted fields are kept.
    const same = nextPresence(p, msg({ collection: 'posts', itemId: 'a', lock: 'title' }), studio, t1);
    expect(same.lock?.since).toBe(t0.toISOString());
    const kept = nextPresence(p, msg({ collection: 'posts', itemId: 'a' }), studio, t1);
    expect(kept).toMatchObject({ focus: 'title', lock: { field: 'title' } });
  });

  it('clears on null and when moving to another item', () => {
    const p: PresenceState = nextPresence({}, msg({ collection: 'posts', itemId: 'a', focus: 'title', lock: 'title' }), studio, t0);
    expect(nextPresence(p, msg({ collection: 'posts', itemId: 'a', focus: null, lock: null }), studio, t1)).not.toHaveProperty('lock');
    const moved = nextPresence(p, msg({ collection: 'posts', itemId: 'b' }), studio, t1);
    expect(moved.focus).toBeUndefined();
    expect(moved.lock).toBeUndefined();
  });

  it('ignores focus/lock on the public plane or without an item', () => {
    expect(nextPresence({}, msg({ focus: 'x', lock: 'x' }), studio, t0)).not.toHaveProperty('lock');
    expect(nextPresence({}, msg({ itemId: 'a', lock: 'x' }), { plane: 'public', subjectId: 's' }, t0)).not.toHaveProperty('lock');
  });

  it('drops oversized meta and rejects malformed field names', () => {
    const big = { blob: 'x'.repeat(PRESENCE_META_MAX_BYTES) };
    expect(nextPresence({}, msg({ itemId: 'a', meta: big }), studio, t0).meta).toBeUndefined();
    expect(parseClientMessage({ type: 'presence', itemId: 'a', focus: 'bad name!' })).toBeNull();
  });
});

describe('visiblePresence', () => {
  it('hides entries on collections the recipient cannot read', () => {
    const entries = [
      { sessionId: 'a', collection: 'posts', lastSeen: '' },
      { sessionId: 'b', collection: 'secret', lastSeen: '' },
      { sessionId: 'c', lastSeen: '' },
    ];
    expect(visiblePresence(entries, new Set(['posts'])).map((e) => e.sessionId)).toEqual(['a', 'c']);
    expect(visiblePresence(entries, new Set(['*']))).toHaveLength(3);
  });
});

// ── Node hub (Docker) presence over real WebSockets ───────────────────────
const JWT_SECRET = 'presence-test-secret';
let server: Server;
let close: () => void;
let port: number;

const ticket = (payload: Record<string, unknown>) =>
  new SignJWT(payload).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('1m').sign(new TextEncoder().encode(JWT_SECRET));

function connect(t: string): Promise<{ ws: WebSocket; messages: any[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/realtime?ticket=${encodeURIComponent(t)}`);
  const messages: any[] = [];
  ws.on('message', (d) => messages.push(JSON.parse(d.toString())));
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve({ ws, messages }));
    ws.on('error', reject);
  });
}

async function until<T>(fn: () => T | undefined, ms = 500): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() - start > ms) throw new Error(`not within ${ms}ms`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const lastPresence = (messages: any[]) => [...messages].reverse().find((m) => m.type === 'presence');

describe('Node hub presence', () => {
  beforeEach(async () => {
    server = createServer();
    close = attachNodeRealtime({ server, hub: new InProcessRealtimeHub(), jwtSecret: JWT_SECRET }).close;
    await new Promise<void>((r) => server.listen(0, r));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('two sessions see each other focus within 500 ms, and it clears on disconnect', async () => {
    const a = await connect(await ticket({ plane: 'studio', userId: 'alice', siteId: 'site-1', collections: ['*'] }));
    const b = await connect(await ticket({ plane: 'studio', userId: 'bob', siteId: 'site-1', collections: ['*'] }));
    a.ws.send(JSON.stringify({ type: 'presence', collection: 'posts', itemId: 'p1', focus: 'title', lock: 'title' }));
    const seen = await until(() => {
      const p = lastPresence(b.messages);
      return p?.users.find((u: any) => u.userId === 'alice' && u.focus === 'title' && u.lock?.field === 'title');
    });
    expect(seen.itemId).toBe('p1');

    a.ws.close();
    await until(() => {
      const p = lastPresence(b.messages);
      return p && !p.users.some((u: any) => u.userId === 'alice') ? true : undefined;
    });
    b.ws.close();
  });

  it('is scoped per site and by the collection allowlist', async () => {
    const a = await connect(await ticket({ plane: 'studio', userId: 'alice', siteId: 'site-1', collections: ['*'] }));
    const other = await connect(await ticket({ plane: 'studio', userId: 'eve', siteId: 'site-2', collections: ['*'] }));
    const limited = await connect(await ticket({ plane: 'studio', userId: 'carl', siteId: 'site-1', collections: ['pages'] }));
    a.ws.send(JSON.stringify({ type: 'presence', collection: 'posts', itemId: 'p1', focus: 'title' }));
    await until(() => (lastPresence(limited.messages) ? true : undefined));
    await new Promise((r) => setTimeout(r, 50));
    expect(other.messages.some((m) => m.type === 'presence' && m.users.some((u: any) => u.userId === 'alice'))).toBe(false);
    expect(lastPresence(limited.messages).users.some((u: any) => u.userId === 'alice')).toBe(false);
    for (const c of [a, other, limited]) c.ws.close();
  });
});
