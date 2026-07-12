import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { SignJWT } from 'jose';
import { WebSocket } from 'ws';
import { InProcessRealtimeHub } from '@lumibase/runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachNodeRealtime } from '../node-hub';

const JWT_SECRET = 'node-hub-test-secret';
const secretKey = new TextEncoder().encode(JWT_SECRET);

let server: Server;
let hub: InProcessRealtimeHub;
let close: () => void;
let port: number;

async function ticket(payload: Record<string, unknown>): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1m')
    .sign(secretKey);
}

function connect(t: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/realtime?ticket=${encodeURIComponent(t)}`);
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

/** Collect messages until a predicate matches or a timeout elapses. */
function waitFor(ws: WebSocket, match: (m: any) => boolean, ms = 1000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (match(msg)) {
        clearTimeout(timer);
        resolve(msg);
      }
    });
  });
}

async function startHub(maxConnectionsPerSubject = 0) {
  hub = new InProcessRealtimeHub();
  server = createServer();
  close = attachNodeRealtime({ server, hub, jwtSecret: JWT_SECRET, maxConnectionsPerSubject }).close;
  await new Promise<void>((r) => server.listen(0, r));
  port = (server.address() as AddressInfo).port;
}

beforeEach(async () => {
  await startHub();
});

afterEach(async () => {
  close();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('attachNodeRealtime', () => {
  it('rejects the upgrade without a ticket', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/realtime`);
    await expect(new Promise((_, rej) => ws.on('error', rej))).rejects.toBeTruthy();
  });

  it('delivers a subject-targeted notification to the matching end-user only', async () => {
    const t42 = await ticket({ plane: 'public', subjectId: 'citizen-42', channels: [], siteId: 'site-1' });
    const t99 = await ticket({ plane: 'public', subjectId: 'citizen-99', channels: [], siteId: 'site-1' });
    const ws42 = await connect(t42);
    const ws99 = await connect(t99);

    const got = waitFor(ws42, (m) => m.type === 'notification');
    let leaked = false;
    ws99.on('message', (d) => {
      if (JSON.parse(d.toString()).type === 'notification') leaked = true;
    });

    hub.publish('site-1', {
      type: 'notification',
      plane: 'public',
      target: { subjectId: 'citizen-42' },
      payload: { subject: 'Order shipped' },
    });

    const msg = await got;
    expect(msg.payload).toMatchObject({ subject: 'Order shipped' });
    expect(leaked).toBe(false);

    ws42.close();
    ws99.close();
  });

  it('enforces the channel allowlist on join', async () => {
    const t = await ticket({ plane: 'public', subjectId: 's1', channels: ['order:1'], siteId: 'site-1' });
    const ws = await connect(t);

    // Allowed channel → joined.
    ws.send(JSON.stringify({ type: 'join', channel: 'order:1' }));
    const joined = await waitFor(ws, (m) => m.type === 'joined');
    expect(joined.channel).toBe('order:1');

    // Forbidden channel → error, no join.
    ws.send(JSON.stringify({ type: 'join', channel: 'order:999' }));
    const err = await waitFor(ws, (m) => m.type === 'error');
    expect(err.code).toBe('CHANNEL_FORBIDDEN');

    ws.close();
  });

  it('isolates planes — a studio event never reaches a public session', async () => {
    const t = await ticket({ plane: 'public', subjectId: 's1', channels: ['c'], siteId: 'site-1' });
    const ws = await connect(t);
    ws.send(JSON.stringify({ type: 'join', channel: 'c' }));
    await waitFor(ws, (m) => m.type === 'joined');

    let received = false;
    ws.on('message', (d) => {
      if (JSON.parse(d.toString()).type === 'event') received = true;
    });

    hub.publish('site-1', {
      type: 'event',
      plane: 'studio',
      collection: 'posts',
      action: 'update',
      itemId: '1',
      payload: {},
    });

    await new Promise((r) => setTimeout(r, 150));
    expect(received).toBe(false);
    ws.close();
  });

  it('read-gates subscribe from the ticket collection allowlist (studio)', async () => {
    const t = await ticket({ plane: 'studio', userId: 'u1', collections: ['posts'], siteId: 'site-1' });
    const ws = await connect(t);

    // Allowed collection → events flow.
    ws.send(JSON.stringify({ type: 'subscribe', collection: 'posts' }));
    await new Promise((r) => setTimeout(r, 50));
    const got = waitFor(ws, (m) => m.type === 'event');
    hub.publish('site-1', { type: 'event', plane: 'studio', collection: 'posts', action: 'update', itemId: '1', payload: null });
    expect((await got).collection).toBe('posts');

    // Collection outside the allowlist → SUBSCRIBE_FORBIDDEN, no delivery.
    ws.send(JSON.stringify({ type: 'subscribe', collection: 'salaries' }));
    const err = await waitFor(ws, (m) => m.type === 'error');
    expect(err.code).toBe('SUBSCRIBE_FORBIDDEN');

    let leaked = false;
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === 'event' && m.collection === 'salaries') leaked = true;
    });
    hub.publish('site-1', { type: 'event', plane: 'studio', collection: 'salaries', action: 'update', itemId: '2', payload: null });
    await new Promise((r) => setTimeout(r, 150));
    expect(leaked).toBe(false);

    ws.close();
  });

  it('denies every subscribe when the ticket carries no collections claim (fail-closed)', async () => {
    const t = await ticket({ plane: 'studio', userId: 'u1', siteId: 'site-1' });
    const ws = await connect(t);
    ws.send(JSON.stringify({ type: 'subscribe', collection: 'posts' }));
    const err = await waitFor(ws, (m) => m.type === 'error');
    expect(err.code).toBe('SUBSCRIBE_FORBIDDEN');
    ws.close();
  });

  it('applies the per-subscription filter over the event envelope', async () => {
    const t = await ticket({ plane: 'studio', userId: 'u1', collections: ['*'], siteId: 'site-1' });
    const ws = await connect(t);
    ws.send(JSON.stringify({ type: 'subscribe', collection: 'posts', filter: { action: { _eq: 'delete' } } }));
    await new Promise((r) => setTimeout(r, 50));

    const events: string[] = [];
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === 'event') events.push(m.action);
    });
    hub.publish('site-1', { type: 'event', plane: 'studio', collection: 'posts', action: 'update', itemId: '1', payload: null });
    hub.publish('site-1', { type: 'event', plane: 'studio', collection: 'posts', action: 'delete', itemId: '1', payload: null });
    await new Promise((r) => setTimeout(r, 150));
    expect(events).toEqual(['delete']); // update filtered out, delete delivered

    ws.close();
  });

  it('enforces maxConnectionsPerSubject', async () => {
    // Restart the hub with a cap of 1 connection per subject.
    close();
    await new Promise<void>((r) => server.close(() => r()));
    await startHub(1);

    const t = await ticket({ plane: 'public', subjectId: 's-cap', channels: [], siteId: 'site-1' });
    const ws1 = await connect(t);
    // Let the first session register server-side before opening the second.
    await new Promise((r) => setTimeout(r, 50));

    // Second connection for the same subject is rejected.
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/api/v1/realtime?ticket=${encodeURIComponent(t)}`);
    const err = await new Promise<any>((resolve) => {
      ws2.on('message', (d) => {
        const m = JSON.parse(d.toString());
        if (m.type === 'error') resolve(m);
      });
    });
    expect(err.code).toBe('TOO_MANY_CONNECTIONS');
    ws1.close();
  });
});
