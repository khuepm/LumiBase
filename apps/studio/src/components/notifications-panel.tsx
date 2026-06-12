/**
 * NotificationsPanel — realtime notification feed showing item mutations
 * on collections the user is watching, plus Content OS exceptions.
 *
 * Two sources:
 *  - WebSocket item-mutation events (create/update/delete) as before.
 *  - NEW exception inbox entries (content-os-ui Req 14): the shared
 *    `useInboxData` poll is diffed between cycles; each fresh entry becomes
 *    a notification deep-linking to /mission-control/inbox?entry=<id>.
 *    The first completed load counts as "seen" so opening the app never
 *    floods the bell. A decided/committed entry vanishing from the inbox
 *    does not retract its notification — it is history.
 *
 * Notifications are stored in local state (most recent 50).
 * A bell icon in the header shows the unread count badge.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import {
  Bell,
  X,
  CheckCheck,
  AlertCircle,
  AlertTriangle,
  Clock,
  PlusCircle,
  Pencil,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import { FillIcon } from '@/components/fill-icon';
import { getAdminBase } from '@/lib/admin-base';
import { cn } from '@/lib/cn';
import {
  diffNewEntries,
  entryLabel,
  useInboxData,
  type InboxEntry,
} from '@/modules/mission-control/use-inbox';
import type { RealtimeEvent } from '@/types/realtime';

type Notification =
  | {
      source: 'item';
      id: string;
      collection: string;
      action: 'create' | 'update' | 'delete';
      itemId: string;
      timestamp: Date;
      read: boolean;
    }
  | {
      source: 'exception';
      id: string;
      entryId: string;
      kind: InboxEntry['kind'];
      label: string;
      timestamp: Date;
      read: boolean;
    };

const MAX_NOTIFICATIONS = 50;

const EXCEPTION_ICONS = {
  veto: { icon: Clock, cls: 'text-amber-600' },
  approval: { icon: ShieldAlert, cls: 'text-sky-600' },
  incident: { icon: AlertTriangle, cls: 'text-destructive' },
  intent_error: { icon: AlertTriangle, cls: 'text-destructive' },
} as const;

function actionIcon(action: 'create' | 'update' | 'delete') {
  switch (action) {
    case 'create': return <PlusCircle className="h-3.5 w-3.5 text-emerald-500" />;
    case 'update': return <Pencil className="h-3.5 w-3.5 text-blue-500" />;
    case 'delete': return <Trash2 className="h-3.5 w-3.5 text-rose-500" />;
    default: return <AlertCircle className="h-3.5 w-3.5 text-muted-foreground" />;
  }
}

function actionLabel(action: 'create' | 'update' | 'delete'): string {
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
  const { location } = useRouterState();
  const adminBase = getAdminBase(location.pathname);

  const unreadCount = notifications.filter((n) => !n.read).length;

  // ── Exception inbox source (content-os-ui Req 14) ────────────────────────
  // Shares the inbox query cache with the AppShell badge and Mission
  // Control — no extra requests. `null` seen-set means "first load not
  // completed yet"; that load initializes the set without notifying.
  const { entries, isLoading: inboxLoading } = useInboxData();
  const seenRef = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (inboxLoading) return;
    if (seenRef.current === null) {
      seenRef.current = new Set(entries.map((e) => e.id));
      return;
    }
    const fresh = diffNewEntries(seenRef.current, entries);
    if (fresh.length === 0) return;
    for (const e of fresh) seenRef.current.add(e.id);
    setNotifications((prev) =>
      [
        ...fresh.map((e): Notification => ({
          source: 'exception',
          id: `exc-${e.id}-${Date.now()}`,
          entryId: e.id,
          kind: e.kind,
          label: entryLabel(e),
          timestamp: new Date(),
          read: false,
        })),
        ...prev,
      ].slice(0, MAX_NOTIFICATIONS),
    );
  }, [entries, inboxLoading]);

  // ── WebSocket subscription ────────────────────────────────────────────────

  const handleEvent = useCallback((event: RealtimeEvent) => {
    setNotifications((prev) => {
      const next: Notification = {
        source: 'item',
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
    const storage = typeof localStorage !== 'undefined' ? localStorage : null;
    const token = storage?.getItem('lumibase_dev_token') ?? '';
    const siteId = storage?.getItem('lumibase_site_id') ?? '';
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
                  {n.source === 'item' ? (
                    <>
                      <span className="mt-0.5 flex-shrink-0">{actionIcon(n.action)}</span>
                      <span className="flex-1 leading-relaxed">
                        Item{' '}
                        <code className="rounded bg-muted px-1 font-mono text-[10px]">
                          {n.itemId.slice(0, 8)}
                        </code>{' '}
                        {actionLabel(n.action)} in{' '}
                        <span className="font-medium">{n.collection}</span>
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="mt-0.5 flex-shrink-0">
                        <FillIcon
                          icon={EXCEPTION_ICONS[n.kind].icon}
                          className={cn('h-3.5 w-3.5', EXCEPTION_ICONS[n.kind].cls)}
                        />
                      </span>
                      <span className="flex-1 leading-relaxed">
                        {n.label}{' '}
                        <Link
                          to={`${adminBase}/mission-control/inbox` as never}
                          search={{ entry: n.entryId } as never}
                          onClick={() => setOpen(false)}
                          className="font-medium text-primary hover:underline"
                        >
                          Open →
                        </Link>
                      </span>
                    </>
                  )}
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
