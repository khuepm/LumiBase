/**
 * SiteRoom — Cloudflare Durable Object implementing the per-site realtime hub.
 *
 * A room is addressed per site and per plane:
 *   - studio room  (`{siteId}` / `{siteId}:{region}`) — admin users (`users` table).
 *   - audience room (`{siteId}:aud[:bucket]`)         — end-users (app-owned table),
 *                                                       addressed by subject / channel.
 * Both planes reuse this one class; sessions carry a `principal.plane` and
 * fan-out is strictly isolated across planes.
 *
 * Responsibilities:
 *   - Upgrade incoming HTTP requests to WebSocket connections.
 *   - Maintain a session registry (principal + subscriptions + channels + presence).
 *   - Route published events to sessions by plane → target → collection.
 *   - Heartbeat pings every 30 s; disconnect idle sessions after 90 s.
 *   - Per-session rate limiting (max 20 inbound messages / second).
 *
 * Protocol — see `@lumibase/shared` (`realtime/protocol.ts`) for the canonical
 * Zod definitions shared with every client.
 *   client → server: subscribe | unsubscribe | presence | join | leave | pong
 *   server → client: welcome | ack | joined | left | event | notification |
 *                     presence | error | ping | pong
 */

import { DurableObject } from 'cloudflare:workers';
import { nanoid } from 'nanoid';
import { parseClientMessage, type RealtimeEvent } from '@lumibase/shared';
import { shouldDeliver, toWireMessage } from './fan-out';

// ─── Types ────────────────────────────────────────────────────────────────────

export type { RealtimeEvent } from '@lumibase/shared';

export interface PresenceEntry {
  sessionId: string;
  userId?: string;
  subjectId?: string;
  collection?: string;
  itemId?: string;
  meta?: Record<string, unknown>;
  lastSeen: string; // ISO timestamp
}

interface SessionPrincipal {
  plane: 'studio' | 'public';
  userId?: string;
  subjectId?: string;
}

interface SessionMeta {
  ws: WebSocket;
  sessionId: string;
  principal: SessionPrincipal;
  subscriptions: Set<string>; // collection names (studio)
  channels: Set<string>; // joined channels (audience)
  allowedChannels: Set<string>; // channel allowlist from the ticket
  presence: Omit<PresenceEntry, 'sessionId' | 'lastSeen'>;
  lastActivity: number; // Date.now()
  msgCount: number; // rolling 1-second counter
  msgWindowStart: number; // Date.now()
  lastPong: number; // Date.now()
}

const HEARTBEAT_INTERVAL_MS = 30_000; // 30 s
const IDLE_TIMEOUT_MS = 90_000; // disconnect after 90 s without pong
const RATE_LIMIT_PER_SEC = 20;

// ─── Durable Object ───────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class SiteRoom extends DurableObject<any> {
  private sessions = new Map<string, SessionMeta>();

  constructor(ctx: DurableObjectState, env: unknown) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    super(ctx, env as any);
    // Schedule recurring heartbeat alarm.
    this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Entry point — called for every incoming HTTP/WS request forwarded to this DO.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Internal publish path — called by the realtime provider to fan-out events.
    if (url.pathname === '/publish' && request.method === 'POST') {
      try {
        const event = (await request.json()) as RealtimeEvent;
        await this.publish(event);
      } catch {
        /* malformed — ignore */
      }
      return new Response(null, { status: 204 });
    }

    // Internal publish path — called by the notification broadcaster to fan-out
    // operational notifications (approvals, veto, incidents, goal/run status) to
    // every connected session for this site, regardless of collection subs.
    if (url.pathname === '/publish-notification' && request.method === 'POST') {
      try {
        const frame = (await request.json()) as { notification: unknown };
        this.publishNotification(frame.notification);
      } catch {
        /* malformed — ignore */
      }
      return new Response(null, { status: 204 });
    }

    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      return new Response('Expected Upgrade: websocket', { status: 426 });
    }

    // Principal is derived by the WS upgrade route from a verified ticket and
    // forwarded via query params. The DO trusts these — it never reads identity
    // from client messages.
    const plane = url.searchParams.get('plane') === 'public' ? 'public' : 'studio';
    const userId = url.searchParams.get('userId') ?? undefined;
    const subjectId = url.searchParams.get('subjectId') ?? undefined;
    const allowedChannels = parseChannelList(url.searchParams.get('channels'));

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    this.ctx.acceptWebSocket(server);

    const sessionId = nanoid(12);
    const now = Date.now();
    const session: SessionMeta = {
      ws: server,
      sessionId,
      principal: { plane, userId, subjectId },
      subscriptions: new Set(),
      channels: new Set(),
      allowedChannels,
      presence: { userId, subjectId },
      lastActivity: now,
      msgCount: 0,
      msgWindowStart: now,
      lastPong: now,
    };
    this.sessions.set(sessionId, session);

    this.send(server, { type: 'welcome', sessionId, plane });

    // These listeners are useful in non-hibernating runtimes. Cloudflare's
    // Durable Object WebSocket hibernation path dispatches to the
    // webSocketMessage/webSocketClose/webSocketError methods below.
    server.addEventListener('message', (event) => this.onMessage(sessionId, event));
    server.addEventListener('close', () => this.onClose(sessionId));
    server.addEventListener('error', () => this.onClose(sessionId));

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const sessionId = this.sessionIdForSocket(ws);
    if (!sessionId) return;
    this.onMessage(sessionId, { data: message } as MessageEvent);
  }

  webSocketClose(ws: WebSocket): void {
    const sessionId = this.sessionIdForSocket(ws);
    if (!sessionId) return;
    this.onClose(sessionId);
  }

  webSocketError(ws: WebSocket): void {
    const sessionId = this.sessionIdForSocket(ws);
    if (!sessionId) return;
    this.onClose(sessionId);
  }

  // ─── Heartbeat alarm ──────────────────────────────────────────────────────

  async alarm(): Promise<void> {
    const now = Date.now();

    for (const [sessionId, session] of this.sessions) {
      // Disconnect idle sessions.
      if (now - session.lastPong > IDLE_TIMEOUT_MS) {
        try {
          session.ws.close(1001, 'idle timeout');
        } catch {
          /* already closed */
        }
        this.sessions.delete(sessionId);
        this.broadcastPresence(session.principal.plane);
        continue;
      }

      // Send heartbeat ping.
      try {
        this.send(session.ws, { type: 'ping' });
      } catch {
        this.sessions.delete(sessionId);
        this.broadcastPresence(session.principal.plane);
      }
    }

    // Reschedule unless no sessions (DO will hibernate).
    if (this.sessions.size > 0) {
      this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_INTERVAL_MS);
    }
  }

  // ─── External publish ─────────────────────────────────────────────────────

  /**
   * Fan-out an event to matching sessions. Matching order:
   *   1. plane must match the event's plane (strict isolation);
   *   2. if the event has a `target`, match userId OR subjectId OR joined channel;
   *   3. otherwise (no target) match a collection subscription (legacy studio).
   * Skip-echo applies to the studio plane only.
   */
  async publish(event: RealtimeEvent): Promise<void> {
    const payload = JSON.stringify(toWireMessage(event));

    for (const session of this.sessions.values()) {
      if (
        !shouldDeliver(event, {
          plane: session.principal.plane,
          userId: session.principal.userId,
          subjectId: session.principal.subjectId,
          subscriptions: session.subscriptions,
          channels: session.channels,
        })
      ) {
        continue;
      }
      try {
        session.ws.send(payload);
      } catch {
        /* disconnected */
      }
    }
  }

  /**
   * Broadcast an operational (agent) notification to every STUDIO session for
   * this site. Unlike {@link publish}, these are not collection-scoped and not
   * echo-suppressed — they are site-wide signals for human operators.
   *
   * Scoped to the studio plane: these are admin ops alerts (approvals, veto,
   * incidents, goal/run status) and must never leak to public/audience
   * (end-user) sessions, which live on the same DO but a different plane.
   */
  publishNotification(notification: unknown): void {
    const payload = JSON.stringify({ type: 'notification', notification });
    for (const session of this.sessions.values()) {
      if (session.principal.plane !== 'studio') continue;
      try {
        session.ws.send(payload);
      } catch {
        /* disconnected */
      }
    }
  }

  // ─── Message handler ──────────────────────────────────────────────────────

  private onMessage(sessionId: string, event: MessageEvent): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Rate limiting (rolling window 1 s).
    const now = Date.now();
    if (now - session.msgWindowStart > 1000) {
      session.msgCount = 0;
      session.msgWindowStart = now;
    }
    session.msgCount += 1;
    if (session.msgCount > RATE_LIMIT_PER_SEC) {
      this.send(session.ws, { type: 'error', code: 'RATE_LIMITED', message: 'Too many messages' });
      return;
    }

    session.lastActivity = now;

    let raw: unknown;
    try {
      raw = JSON.parse(typeof event.data === 'string' ? event.data : '');
    } catch {
      this.send(session.ws, { type: 'error', code: 'INVALID_JSON', message: 'Invalid JSON' });
      return;
    }

    const msg = parseClientMessage(raw);
    if (!msg) {
      this.send(session.ws, { type: 'error', code: 'INVALID_MESSAGE', message: 'Unknown message' });
      return;
    }

    switch (msg.type) {
      case 'subscribe': {
        session.subscriptions.add(msg.collection);
        break;
      }
      case 'unsubscribe': {
        session.subscriptions.delete(msg.collection);
        break;
      }
      case 'join': {
        // Channel authz is enforced from the ticket allowlist, never trusted
        // from the client. A subject can only join channels it was granted.
        if (!session.allowedChannels.has(msg.channel)) {
          this.send(session.ws, {
            type: 'error',
            code: 'CHANNEL_FORBIDDEN',
            message: `Not allowed to join channel: ${msg.channel}`,
          });
          break;
        }
        session.channels.add(msg.channel);
        this.send(session.ws, { type: 'joined', channel: msg.channel });
        break;
      }
      case 'leave': {
        session.channels.delete(msg.channel);
        this.send(session.ws, { type: 'left', channel: msg.channel });
        break;
      }
      case 'presence': {
        session.presence = {
          userId: session.principal.userId,
          subjectId: session.principal.subjectId,
          collection: msg.collection,
          itemId: msg.itemId,
          meta: msg.meta,
        };
        this.broadcastPresence(session.principal.plane);
        break;
      }
      case 'pong': {
        session.lastPong = now;
        break;
      }
    }
  }

  private onClose(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    if (session) this.broadcastPresence(session.principal.plane);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private sessionIdForSocket(ws: WebSocket): string | null {
    for (const [sessionId, session] of this.sessions) {
      if (session.ws === ws) return sessionId;
    }
    return null;
  }

  /** Presence is scoped per plane — studio peers never see audience presence. */
  private broadcastPresence(plane: 'studio' | 'public'): void {
    const now = new Date().toISOString();
    const users: PresenceEntry[] = [];
    for (const s of this.sessions.values()) {
      if (s.principal.plane !== plane) continue;
      users.push({ sessionId: s.sessionId, ...s.presence, lastSeen: now });
    }
    const payload = JSON.stringify({ type: 'presence', users });
    for (const session of this.sessions.values()) {
      if (session.principal.plane !== plane) continue;
      try {
        session.ws.send(payload);
      } catch {
        /* disconnected */
      }
    }
  }

  private send(ws: WebSocket, data: unknown): void {
    try {
      ws.send(JSON.stringify(data));
    } catch {
      /* already closed */
    }
  }
}

// ─── Module helpers ───────────────────────────────────────────────────────────

/** Parse a comma-separated channel allowlist from a query param. */
function parseChannelList(value: string | null): Set<string> {
  if (!value) return new Set();
  return new Set(
    value
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean),
  );
}
