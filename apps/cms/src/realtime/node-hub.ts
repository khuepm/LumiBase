/**
 * Node WebSocket hub — the Docker/self-hosted analog of the SiteRoom Durable
 * Object. It attaches a `ws` server to the existing Node HTTP server and drives
 * realtime sessions from the in-process realtime hub shared with the runtime's
 * `DockerRealtimeProvider` (so `runtime.realtime.publish()` reaches live WS
 * sessions on this process).
 *
 * Auth mirrors the Cloudflare route exactly: the client connects to
 * `/api/v1/realtime?ticket=<jwt>`, the ticket is verified here, and the session
 * principal (plane / userId / subjectId / channel allowlist) is derived from the
 * SIGNED ticket — never from the query string beyond the ticket itself.
 *
 * This module is Node-only (imports `ws` and `node:http`) and must never be
 * imported from the Cloudflare Workers bundle.
 */

import type { Server as HttpServer, IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { jwtVerify } from 'jose';
import { nanoid } from 'nanoid';
import { parseClientMessage, type RealtimeEvent } from '@lumibase/shared';
import type { InProcessRealtimeHub, RealtimeEventLike } from '@lumibase/runtime';
import { shouldDeliver, toWireMessage } from './fan-out';

const REALTIME_PATH = '/api/v1/realtime';
const HEARTBEAT_INTERVAL_MS = 30_000;
const IDLE_TIMEOUT_MS = 90_000;
const RATE_LIMIT_PER_SEC = 20;

interface NodeSession {
  ws: WebSocket;
  siteId: string;
  plane: 'studio' | 'public';
  userId?: string;
  subjectId?: string;
  subscriptions: Set<string>;
  channels: Set<string>;
  allowedChannels: Set<string>;
  unsubscribeHub: () => void;
  lastPong: number;
  msgCount: number;
  msgWindowStart: number;
}

export interface NodeHubOptions {
  server: HttpServer;
  hub: InProcessRealtimeHub;
  jwtSecret: string;
}

/**
 * Attach the realtime WebSocket server to a Node HTTP server. Returns a
 * `close()` to tear it down (used in tests).
 */
export function attachNodeRealtime(opts: NodeHubOptions): { close: () => void } {
  const { server, hub, jwtSecret } = opts;
  const secretKey = new TextEncoder().encode(jwtSecret);
  const wss = new WebSocketServer({ noServer: true });
  const sessions = new Set<NodeSession>();

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    if (url.pathname !== REALTIME_PATH) return; // not ours — leave for others

    const ticket = url.searchParams.get('ticket');
    if (!ticket) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    verifyTicket(ticket, secretKey)
      .then((principal) => {
        if (!principal) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          acceptSession(ws, principal);
        });
      })
      .catch(() => {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
      });
  });

  function acceptSession(ws: WebSocket, principal: TicketPrincipal): void {
    const session: NodeSession = {
      ws,
      siteId: principal.siteId,
      plane: principal.plane,
      userId: principal.userId,
      subjectId: principal.subjectId,
      subscriptions: new Set(),
      channels: new Set(),
      allowedChannels: new Set(principal.channels),
      unsubscribeHub: () => {},
      lastPong: Date.now(),
      msgCount: 0,
      msgWindowStart: Date.now(),
    };

    // Deliver published events to this session via the shared in-process hub.
    session.unsubscribeHub = hub.subscribe(principal.siteId, (event: RealtimeEventLike) => {
      deliver(session, event as RealtimeEvent);
    });

    sessions.add(session);
    send(ws, { type: 'welcome', sessionId: nanoid(12), plane: principal.plane });

    ws.on('message', (data) => onMessage(session, data.toString()));
    ws.on('close', () => teardown(session));
    ws.on('error', () => teardown(session));
    ws.on('pong', () => {
      session.lastPong = Date.now();
    });
  }

  function deliver(session: NodeSession, event: RealtimeEvent): void {
    if (
      !shouldDeliver(event, {
        plane: session.plane,
        userId: session.userId,
        subjectId: session.subjectId,
        subscriptions: session.subscriptions,
        channels: session.channels,
      })
    ) {
      return;
    }
    send(session.ws, toWireMessage(event));
  }

  function onMessage(session: NodeSession, raw: string): void {
    const now = Date.now();
    if (now - session.msgWindowStart > 1000) {
      session.msgCount = 0;
      session.msgWindowStart = now;
    }
    if (++session.msgCount > RATE_LIMIT_PER_SEC) {
      send(session.ws, { type: 'error', code: 'RATE_LIMITED', message: 'Too many messages' });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      send(session.ws, { type: 'error', code: 'INVALID_JSON', message: 'Invalid JSON' });
      return;
    }
    const msg = parseClientMessage(parsed);
    if (!msg) {
      send(session.ws, { type: 'error', code: 'INVALID_MESSAGE', message: 'Unknown message' });
      return;
    }

    switch (msg.type) {
      case 'subscribe':
        session.subscriptions.add(msg.collection);
        break;
      case 'unsubscribe':
        session.subscriptions.delete(msg.collection);
        break;
      case 'join':
        if (!session.allowedChannels.has(msg.channel)) {
          send(session.ws, {
            type: 'error',
            code: 'CHANNEL_FORBIDDEN',
            message: `Not allowed to join channel: ${msg.channel}`,
          });
          break;
        }
        session.channels.add(msg.channel);
        send(session.ws, { type: 'joined', channel: msg.channel });
        break;
      case 'leave':
        session.channels.delete(msg.channel);
        send(session.ws, { type: 'left', channel: msg.channel });
        break;
      case 'pong':
        session.lastPong = now;
        break;
      // presence over the Node hub is out of scope for v1 (studio presence runs
      // on Cloudflare); ignore to keep the protocol forward-compatible.
      case 'presence':
        break;
    }
  }

  function teardown(session: NodeSession): void {
    session.unsubscribeHub();
    sessions.delete(session);
    try {
      session.ws.terminate();
    } catch {
      /* already closed */
    }
  }

  // Heartbeat: ping every 30 s, disconnect sessions silent for 90 s.
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const session of sessions) {
      if (now - session.lastPong > IDLE_TIMEOUT_MS) {
        teardown(session);
        continue;
      }
      try {
        session.ws.ping();
        send(session.ws, { type: 'ping' });
      } catch {
        teardown(session);
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  // Don't keep the process alive for the heartbeat alone.
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  return {
    close: () => {
      clearInterval(heartbeat);
      for (const session of sessions) teardown(session);
      wss.close();
    },
  };
}

// ─── Ticket verification ────────────────────────────────────────────────────

interface TicketPrincipal {
  siteId: string;
  plane: 'studio' | 'public';
  userId?: string;
  subjectId?: string;
  channels: string[];
}

async function verifyTicket(ticket: string, secretKey: Uint8Array): Promise<TicketPrincipal | null> {
  try {
    const { payload } = await jwtVerify(ticket, secretKey, { algorithms: ['HS256'] });
    const p = payload as Record<string, unknown>;
    const plane = p.plane === 'public' ? 'public' : 'studio';
    return {
      siteId: String(p.siteId ?? ''),
      plane,
      userId: plane === 'studio' ? String(p.userId ?? 'anon') : undefined,
      subjectId: plane === 'public' ? String(p.subjectId ?? '') : undefined,
      channels: Array.isArray(p.channels) ? (p.channels as string[]) : [],
    };
  } catch {
    return null;
  }
}

function send(ws: WebSocket, data: unknown): void {
  try {
    ws.send(JSON.stringify(data));
  } catch {
    /* already closed */
  }
}
