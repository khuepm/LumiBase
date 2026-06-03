/**
 * SiteRoom — Cloudflare Durable Object implementing the per-site realtime hub.
 *
 * One SiteRoom instance per siteId. All Studio users on the same site share
 * a single DO instance, which:
 *   - Upgrades incoming HTTP requests to WebSocket connections.
 *   - Maintains a session registry (userId → WebSocket + subscriptions + presence).
 *   - Routes published item events to subscribed sessions (with permission IDs).
 *   - Sends heartbeat pings every 30 s and disconnects idle sessions.
 *   - Enforces per-session rate limiting (max 20 inbound messages / second).
 *
 * Protocol (client → server):
 *   { type: 'subscribe',   collection: string }
 *   { type: 'unsubscribe', collection: string }
 *   { type: 'presence',    collection?: string, itemId?: string, meta?: object }
 *   { type: 'pong' }
 *
 * Protocol (server → client):
 *   { type: 'ping' }
 *   { type: 'event',    collection, action, itemId, payload }
 *   { type: 'presence', users: PresenceEntry[] }
 *   { type: 'error',    code, message }
 *   { type: 'welcome',  sessionId }
 */

import { DurableObject } from 'cloudflare:workers';
import { nanoid } from 'nanoid';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RealtimeEvent {
  type: 'event';
  collection: string;
  action: 'create' | 'update' | 'delete';
  itemId: string;
  payload: unknown;
  /** userId that triggered the mutation — used to skip echo. */
  actorUserId?: string;
}

export interface PresenceEntry {
  sessionId: string;
  userId: string;
  collection?: string;
  itemId?: string;
  meta?: Record<string, unknown>;
  lastSeen: string; // ISO timestamp
}

interface SessionMeta {
  ws: WebSocket;
  sessionId: string;
  userId: string;
  subscriptions: Set<string>; // collection names
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

    // Internal publish path — called by ItemService to fan-out mutation events.
    if (url.pathname === '/publish' && request.method === 'POST') {
      try {
        const event = (await request.json()) as RealtimeEvent;
        await this.publish(event);
      } catch {
        /* malformed — ignore */
      }
      return new Response(null, { status: 204 });
    }

    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      return new Response('Expected Upgrade: websocket', { status: 426 });
    }

    const userId = url.searchParams.get('userId') ?? 'anon';

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    this.ctx.acceptWebSocket(server);

    const sessionId = nanoid(12);
    const now = Date.now();
    const session: SessionMeta = {
      ws: server,
      sessionId,
      userId,
      subscriptions: new Set(),
      presence: { userId },
      lastActivity: now,
      msgCount: 0,
      msgWindowStart: now,
      lastPong: now,
    };
    this.sessions.set(sessionId, session);

    this.send(server, { type: 'welcome', sessionId });

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
        this.broadcastPresence();
        continue;
      }

      // Send heartbeat ping.
      try {
        this.send(session.ws, { type: 'ping' });
      } catch {
        this.sessions.delete(sessionId);
        this.broadcastPresence();
      }
    }

    // Reschedule unless no sessions (DO will hibernate).
    if (this.sessions.size > 0) {
      this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_INTERVAL_MS);
    }
  }

  // ─── External publish ─────────────────────────────────────────────────────

  /**
   * Called by the CMS worker (via DO stub) to publish an item mutation event.
   * Broadcasts to all sessions subscribed to the given collection, except the
   * actor themselves (to avoid echo).
   */
  async publish(event: RealtimeEvent): Promise<void> {
    const payload = JSON.stringify(event);
    for (const session of this.sessions.values()) {
      if (!session.subscriptions.has(event.collection)) continue;
      if (session.userId === event.actorUserId) continue;
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

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(typeof event.data === 'string' ? event.data : '') as Record<string, unknown>;
    } catch {
      this.send(session.ws, { type: 'error', code: 'INVALID_JSON', message: 'Invalid JSON' });
      return;
    }

    switch (msg.type) {
      case 'subscribe': {
        const collection = msg.collection as string;
        if (collection) session.subscriptions.add(collection);
        break;
      }
      case 'unsubscribe': {
        const collection = msg.collection as string;
        if (collection) session.subscriptions.delete(collection);
        break;
      }
      case 'presence': {
        session.presence = {
          userId: session.userId,
          collection: msg.collection as string | undefined,
          itemId: msg.itemId as string | undefined,
          meta: msg.meta as Record<string, unknown> | undefined,
        };
        this.broadcastPresence();
        break;
      }
      case 'pong': {
        session.lastPong = now;
        break;
      }
    }
  }

  private onClose(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.broadcastPresence();
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private sessionIdForSocket(ws: WebSocket): string | null {
    for (const [sessionId, session] of this.sessions) {
      if (session.ws === ws) return sessionId;
    }
    return null;
  }

  private broadcastPresence(): void {
    const now = new Date().toISOString();
    const users: PresenceEntry[] = Array.from(this.sessions.values()).map((s) => ({
      sessionId: s.sessionId,
      ...s.presence,
      lastSeen: now,
    }));
    const payload = JSON.stringify({ type: 'presence', users });
    for (const session of this.sessions.values()) {
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
