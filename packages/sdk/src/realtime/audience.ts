/**
 * AudienceClient — realtime client for FRONTEND end-users (the public plane).
 *
 * End-users are addressed by a `subjectId` (mapped server-side from e.g. a
 * citizenID) and by channels they are granted at ticket time. This client:
 *   - fetches a short-lived audience ticket from `/api/v1/realtime/audience-ticket`;
 *   - opens the WebSocket and (re)joins channels;
 *   - surfaces per-channel events and personal notifications;
 *   - reconnects with exponential backoff and re-joins open channels.
 *
 * The Studio (admin) plane uses the separate `RealtimeClient` in `./index`.
 */

export interface AudienceEvent {
  type: 'event';
  channel?: string;
  collection?: string;
  action?: 'create' | 'update' | 'delete';
  itemId?: string;
  payload: unknown;
}

export interface AudienceNotification {
  type: 'notification';
  payload: Record<string, unknown>;
}

export type ChannelEventCallback = (event: AudienceEvent) => void;
export type NotificationCallback = (notification: AudienceNotification) => void;
export type ConnectionStatus = 'connecting' | 'open' | 'closed';
export type StatusCallback = (status: ConnectionStatus) => void;

/** Minimal structural WebSocket — lets tests inject a fake. */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', handler: (ev: any) => void): void;
}
export type WebSocketFactory = (url: string) => WebSocketLike;

const WS_OPEN = 1;

export interface AudienceClientOptions {
  /** Base HTTP URL of the CMS. `wss://` is derived automatically. */
  baseUrl: string;
  /**
   * Bearer token for the authenticated FRONTEND end-user. Exchanged for a
   * short-lived audience ticket; never sent over the socket.
   */
  token: string;
  siteId: string;
  /** Channels to request access to (subject to the server-side allowlist). */
  channels?: string[];
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  /** Injectable WebSocket factory (defaults to the global `WebSocket`). */
  webSocketFactory?: WebSocketFactory;
  /** Injectable fetch (defaults to the global `fetch`). */
  fetchImpl?: typeof fetch;
}

export class AudienceClient {
  private ws: WebSocketLike | null = null;
  private readonly channels = new Set<string>();
  private readonly channelListeners = new Set<ChannelEventCallback>();
  private readonly notificationListeners = new Set<NotificationCallback>();
  private readonly statusListeners = new Set<StatusCallback>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs: number;
  private stopped = false;
  private _status: ConnectionStatus = 'closed';

  constructor(private readonly opts: AudienceClientOptions) {
    this.backoffMs = opts.initialBackoffMs ?? 1000;
    for (const c of opts.channels ?? []) this.channels.add(c);
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  get status(): ConnectionStatus {
    return this._status;
  }

  connect(): this {
    this.stopped = false;
    void this._connect();
    return this;
  }

  disconnect(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close(1000, 'client disconnect');
      } catch {
        /* already closed */
      }
      this.ws = null;
    }
    this.setStatus('closed');
  }

  /** Join a channel. Remembered and re-joined across reconnects. */
  join(channel: string): void {
    this.channels.add(channel);
    this.sendIfOpen({ type: 'join', channel });
  }

  /** Leave a channel and stop re-joining it. */
  leave(channel: string): void {
    this.channels.delete(channel);
    this.sendIfOpen({ type: 'leave', channel });
  }

  onChannelEvent(cb: ChannelEventCallback): () => void {
    this.channelListeners.add(cb);
    return () => this.channelListeners.delete(cb);
  }

  onNotification(cb: NotificationCallback): () => void {
    this.notificationListeners.add(cb);
    return () => this.notificationListeners.delete(cb);
  }

  onStatus(cb: StatusCallback): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  // ─── Internal ────────────────────────────────────────────────────────────────

  private async _connect(): Promise<void> {
    if (this.ws) return;
    this.setStatus('connecting');

    const doFetch = this.opts.fetchImpl ?? fetch;
    let ticket: string;
    try {
      const res = await doFetch(`${this.opts.baseUrl}/api/v1/realtime/audience-ticket`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.opts.token}`,
          'X-Lumi-Site': this.opts.siteId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ channels: Array.from(this.channels) }),
      });
      if (!res.ok) throw new Error(`audience-ticket failed: ${res.status}`);
      const body = (await res.json()) as { data?: { ticket?: string } };
      if (!body.data?.ticket) throw new Error('ticket missing');
      ticket = body.data.ticket;
    } catch {
      this.scheduleReconnect();
      return;
    }

    if (this.stopped) return;

    const wsBase = this.opts.baseUrl.replace(/^http/, 'ws');
    const url = `${wsBase}/api/v1/realtime?ticket=${encodeURIComponent(ticket)}`;
    const factory = this.opts.webSocketFactory ?? ((u: string) => new WebSocket(u) as unknown as WebSocketLike);

    let ws: WebSocketLike;
    try {
      ws = factory(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.backoffMs = this.opts.initialBackoffMs ?? 1000;
      this.setStatus('open');
      // Re-join all remembered channels.
      for (const channel of this.channels) this.sendRaw({ type: 'join', channel });
    });

    ws.addEventListener('message', (ev: { data: string }) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.handleMessage(msg);
    });

    ws.addEventListener('close', () => {
      this.ws = null;
      this.setStatus('closed');
      if (!this.stopped) this.scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      /* close fires after error — reconnect handled there */
    });
  }

  private handleMessage(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'ping':
        this.sendRaw({ type: 'pong' });
        break;
      case 'event':
        for (const cb of this.channelListeners) cb(msg as unknown as AudienceEvent);
        break;
      case 'notification':
        for (const cb of this.notificationListeners) cb(msg as unknown as AudienceNotification);
        break;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this._connect();
      this.backoffMs = Math.min(this.backoffMs * 2, this.opts.maxBackoffMs ?? 30_000);
    }, this.backoffMs);
  }

  private setStatus(status: ConnectionStatus): void {
    if (this._status === status) return;
    this._status = status;
    for (const cb of this.statusListeners) cb(status);
  }

  private sendIfOpen(data: unknown): void {
    if (this.ws && this.ws.readyState === WS_OPEN) this.sendRaw(data);
  }

  private sendRaw(data: unknown): void {
    try {
      this.ws?.send(JSON.stringify(data));
    } catch {
      /* closed mid-send */
    }
  }
}
