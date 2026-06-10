/**
 * NotificationsPanel — realtime notification feed showing item mutations
 * on collections the user is watching.
 *
 * Uses the useRealtimeSubscription hook (with a virtual "_notifications" key)
 * and an explicit RealtimeClient subscription for all watched collections.
 *
 * Notifications are stored in local state (most recent 50).
 * A bell icon in the header shows the unread count badge.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, X, CheckCheck, AlertCircle, PlusCircle, Pencil, Trash2 } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { RealtimeEvent } from '@/types/realtime';

interface Notification {
  id: string;
  collection: string;
  action: 'create' | 'update' | 'delete';
  itemId: string;
  timestamp: Date;
  read: boolean;
}

const MAX_NOTIFICATIONS = 50;

function actionIcon(action: Notification['action']) {
  switch (action) {
    case 'create': return <PlusCircle className="h-3.5 w-3.5 text-emerald-500" />;
    case 'update': return <Pencil className="h-3.5 w-3.5 text-blue-500" />;
    case 'delete': return <Trash2 className="h-3.5 w-3.5 text-rose-500" />;
    default: return <AlertCircle className="h-3.5 w-3.5 text-muted-foreground" />;
  }
}

function actionLabel(action: Notification['action']): string {
  switch (action) {
    case 'create': return 'created';
    case 'update': return 'updated';
    case 'delete': return 'deleted';
  }
}

export function NotificationsPanel() {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const unreadCount = notifications.filter((n) => !n.read).length;

  // ── WebSocket subscription ────────────────────────────────────────────────

  const handleEvent = useCallback((event: RealtimeEvent) => {
    setNotifications((prev) => {
      const next: Notification = {
        id: `${event.collection}-${event.itemId}-${Date.now()}`,
        collection: event.collection,
        action: event.action,
        itemId: event.itemId,
        timestamp: new Date(),
        read: false,
      };
      return [next, ...prev].slice(0, MAX_NOTIFICATIONS);
    });
  }, []);

  useEffect(() => {
    let isMounted = true;
    const token = localStorage.getItem('lumibase_dev_token') ?? '';
    const siteId = localStorage.getItem('lumibase_site_id') ?? '';
    const baseUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:1989';

    const connect = async () => {
      try {
        const res = await fetch(`${baseUrl}/api/v1/realtime/ticket`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'X-Lumi-Site': siteId,
          },
        });
        if (!res.ok) throw new Error('Ticket fetch failed');
        const body = await res.json() as { data?: { ticket: string } };
        const ticket = body.data?.ticket;
        if (!ticket) throw new Error('No ticket');

        if (!isMounted) return;

        const wsUrl = `${baseUrl.replace(/^http/, 'ws')}/api/v1/realtime?ticket=${encodeURIComponent(ticket)}&siteId=${encodeURIComponent(siteId)}`;
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          // Subscribe to all collections by using a wildcard subscription.
          // The SiteRoom will deliver events for any collection the user is allowed to see.
          ws.send(JSON.stringify({ type: 'subscribe', collection: '*' }));
        };

        ws.onmessage = (evt) => {
          try {
            const msg = JSON.parse(evt.data as string) as { type: string; collection?: string; action?: string; itemId?: string; payload?: unknown };
            if (msg.type === 'event' && msg.collection && msg.action && msg.itemId) {
              handleEvent(msg as unknown as RealtimeEvent);
            }
            if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
          } catch {
            /* ignore */
          }
        };

        ws.onclose = () => {
          wsRef.current = null;
        };
      } catch (err) {
        console.warn('Notifications connection failed', err);
      }
    };

    connect();

    return () => {
      isMounted = false;
      const ws = wsRef.current;
      if (ws) {
        ws.close(1000, 'notifications panel unmount');
      }
    };
  }, [handleEvent]);

  // ── Close on outside click ────────────────────────────────────────────────

  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const markAllRead = () =>
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));

  const clearAll = () => setNotifications([]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="relative" ref={panelRef}>
      {/* Bell trigger */}
      <button
        id="notifications-bell"
        type="button"
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => {
          setOpen((o) => !o);
          if (!open) {
            // Mark all as read when opening
            setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
          }
        }}
        className="relative inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Bell className="h-4 w-4" />
        {unreadCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[9px] font-bold text-primary-foreground">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown panel */}
      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className={cn(
            'absolute right-0 top-full z-50 mt-2 w-80 rounded-lg border bg-background shadow-lg',
            'animate-in fade-in-0 zoom-in-95',
          )}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="text-sm font-semibold">Notifications</span>
            <div className="flex items-center gap-1">
              {notifications.length > 0 && (
                <>
                  <button
                    type="button"
                    onClick={markAllRead}
                    title="Mark all read"
                    className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <CheckCheck className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={clearAll}
                    title="Clear all"
                    className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </>
              )}
            </div>
          </div>

          {/* List */}
          <ul className="max-h-80 overflow-y-auto divide-y">
            {notifications.length === 0 ? (
              <li className="flex flex-col items-center gap-2 py-8 text-center text-sm text-muted-foreground">
                <Bell className="h-6 w-6 opacity-30" />
                No notifications yet
              </li>
            ) : (
              notifications.map((n) => (
                <li
                  key={n.id}
                  className={cn(
                    'flex items-start gap-2.5 px-3 py-2 text-xs transition-colors',
                    !n.read && 'bg-primary/5',
                  )}
                >
                  <span className="mt-0.5 flex-shrink-0">{actionIcon(n.action)}</span>
                  <span className="flex-1 leading-relaxed">
                    Item{' '}
                    <code className="rounded bg-muted px-1 font-mono text-[10px]">
                      {n.itemId.slice(0, 8)}
                    </code>{' '}
                    {actionLabel(n.action)} in{' '}
                    <span className="font-medium">{n.collection}</span>
                  </span>
                  <time
                    dateTime={n.timestamp.toISOString()}
                    className="flex-shrink-0 text-[10px] text-muted-foreground"
                  >
                    {n.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </time>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
