/**
 * RealtimeClient — typed WebSocket client for the LumiBase realtime API.
 *
 * Features:
 * - subscribe/unsubscribe to collections
 * - presence tracking (send + receive)
 * - pong response to server heartbeat pings
 * - automatic exponential-backoff reconnection
 * - typed event callbacks
 *
 * Usage:
 *   const rt = new RealtimeClient({ baseUrl, token, siteId });
 *   rt.subscribe('posts', (event) => console.log(event));
 *   rt.presence({ collection: 'posts', itemId: '123' });
 *   rt.connect();
 *   // ... later
 *   rt.disconnect();
 */

export interface RealtimeEvent {
  type: 'event';
  collection: string;
  action: 'create' | 'update' | 'delete';
  itemId: string;
  payload: unknown;
}

export interface PresenceEntry {
  sessionId: string;
  userId: string;
  collection?: string;
  itemId?: string;
  meta?: Record<string, unknown>;
  lastSeen: string;
}

export type RealtimeEventCallback = (event: RealtimeEvent) => void;
export type PresenceCallback = (users: PresenceEntry[]) => void;

interface RealtimeClientOptions {
  /** Base HTTP URL of the CMS (e.g. https://cms.example.com). wss:// prefix is derived automatically. */
  baseUrl: string;
  /** Bearer token passed as ?token= query param (WS handshake cannot carry Authorization headers in browsers). */
  token: string;
  /** Site ID forwarded to the SiteRoom DO. */
  siteId: string;
  /** Optional user ID included in presence meta. */
  userId?: string;
  /** Initial backoff in milliseconds. Default: 1000. */
  initialBackoffMs?: number;
  /** Maximum backoff in milliseconds. Default: 30000. */
  maxBackoffMs?: number;
}

export class RealtimeClient {
  private ws: WebSocket | null = null;
  private readonly subscriptions = new Map<string, Set<RealtimeEventCallback>>();
  private presenceListeners = new Set<PresenceCallback>();
  private currentPresence: { collection?: string; itemId?: string; meta?: Record<string, unknown> } = {};
  private sessionId: string | null = null;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private backoffMs: number;
  private stopped = false;

  constructor(private readonly opts: RealtimeClientOptions) {
    this.backoffMs = opts.initialBackoffMs ?? 1000;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /** Open the WebSocket connection. Safe to call multiple times. */
  connect(): this {
    this.stopped = false;
    this._connect();
    return this;
  }

  /** Close the WebSocket and stop reconnect attempts. */
  disconnect(): void {
    this.stopped = true;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.ws) {
      try {
        this.ws.close(1000, 'client disconnect');
      } catch {
        /* already closed */
      }
      this.ws = null;
    }
  }

  /**
   * Subscribe to item mutation events for a specific collection.
   * Multiple handlers per collection are supported.
   *
   * @returns Unsubscribe function.
   */
  subscribe(collection: string, callback: RealtimeEventCallback): () => void {
    if (!this.subscriptions.has(collection)) {
      this.subscriptions.set(collection, new Set());
    }
    this.subscriptions.get(collection)!.add(callback);
    // Send subscribe message if already connected.
    this._send({ type: 'subscribe', collection });
    return () => this.unsubscribe(collection, callback);
  }

  /** Remove a specific handler from a collection subscription. */
  unsubscribe(collection: string, callback: RealtimeEventCallback): void {
    const set = this.subscriptions.get(collection);
    if (!set) return;
    set.delete(callback);
    if (set.size === 0) {
      this.subscriptions.delete(collection);
      this._send({ type: 'unsubscribe', collection });
    }
  }

  /** Update the current user's presence. Sent immediately and on reconnect. */
  presence(opts: { collection?: string; itemId?: string; meta?: Record<string, unknown> }): void {
    this.currentPresence = opts;
    this._send({ type: 'presence', ...opts });
  }

  /** Register a callback for peer presence updates. */
  onPresence(callback: PresenceCallback): () => void {
    this.presenceListeners.add(callback);
    return () => this.presenceListeners.delete(callback);
  }

  /** Returns the current session ID assigned by the server after connection. */
  get session(): string | null {
    return this.sessionId;
  }

  /** Whether the WebSocket is currently OPEN. */
  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // ─── Internal ────────────────────────────────────────────────────────────────

  private _connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) return;

    const { baseUrl, token, siteId, userId } = this.opts;
    const wsBase = baseUrl.replace(/^http/, 'ws');
    const url = new URL(`${wsBase}/api/v1/realtime`);
    url.searchParams.set('token', token);
    url.searchParams.set('siteId', siteId);
    if (userId) url.searchParams.set('userId', userId);

    let ws: WebSocket;
    try {
      ws = new WebSocket(url.toString());
    } catch {
      this._scheduleReconnect();
      return;
    }

    this.ws = ws;

    ws.onopen = () => {
      // Reset backoff on successful connection.
      this.backoffMs = this.opts.initialBackoffMs ?? 1000;
      // Re-subscribe to all active collections.
      for (const collection of this.subscriptions.keys()) {
        this._sendRaw({ type: 'subscribe', collection });
      }
      // Restore presence.
      if (Object.keys(this.currentPresence).length > 0) {
        this._sendRaw({ type: 'presence', ...this.currentPresence });
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as Record<string, unknown>;
        this._handleMessage(msg);
      } catch {
        /* ignore malformed */
      }
    };

    ws.onclose = () => {
      this.ws = null;
      if (!this.stopped) this._scheduleReconnect();
    };

    ws.onerror = () => {
      /* onclose fires after onerror — reconnect handled there */
    };
  }

  private _handleMessage(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'welcome':
        this.sessionId = msg.sessionId as string;
        break;

      case 'ping':
        this._sendRaw({ type: 'pong' });
        break;

      case 'event': {
        const event = msg as unknown as RealtimeEvent;
        const handlers = this.subscriptions.get(event.collection);
        if (handlers) {
          for (const cb of handlers) cb(event);
        }
        break;
      }

      case 'presence': {
        const users = (msg.users ?? []) as PresenceEntry[];
        for (const cb of this.presenceListeners) cb(users);
        break;
      }
    }
  }

  private _scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimeout) return;
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this._connect();
      // Exponential backoff capped at maxBackoffMs.
      this.backoffMs = Math.min(this.backoffMs * 2, this.opts.maxBackoffMs ?? 30_000);
    }, this.backoffMs);
  }

  private _send(data: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this._sendRaw(data);
    }
  }

  private _sendRaw(data: unknown): void {
    try {
      this.ws?.send(JSON.stringify(data));
    } catch {
      /* closed mid-send */
    }
  }
}
