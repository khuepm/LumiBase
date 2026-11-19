/**
 * usePresence — track and broadcast the current user's presence.
 *
 * Sends a `presence` message whenever the calling component mounts/unmounts
 * or the collection/itemId changes. Listens to incoming presence events
 * to maintain a live list of peer users.
 *
 * Usage:
 *   const { peers } = usePresence({ collection: 'posts', itemId: 'abc123' });
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { toWebSocketBase } from '@lumibase/sdk';
import { getActiveSite, getActiveToken } from '@/lib/api';
import { getApiBaseUrl } from '@/lib/api-base';
import type { PresenceEntry } from '@/types/realtime';

interface UsePresenceOptions {
  /** Collection the user is currently viewing. */
  collection?: string;
  /** Item id the user is currently editing (for item-level presence). */
  itemId?: string;
  /** Optional extra metadata (e.g. cursor position, avatar). */
  meta?: Record<string, unknown>;
}

interface UsePresenceResult {
  /** Other sessions currently present (excludes this session). */
  peers: PresenceEntry[];
  /** Every session, this one included (field locks are ordered across all). */
  everyone: PresenceEntry[];
  /** This session's id, from the server's `welcome` (null until connected). */
  selfSessionId: string | null;
  /** Whether the WS connection for presence is active. */
  connected: boolean;
  /** Announce the focused field (`null` on blur) — #685. */
  setFocus: (field: string | null) => void;
  /** Take (`field`) or release (`null`) the soft lock on a field — #685. */
  setLock: (field: string | null) => void;
}

export function usePresence(options: UsePresenceOptions = {}): UsePresenceResult {
  const { collection, itemId, meta } = options;
  const wsRef = useRef<WebSocket | null>(null);
  const [everyone, setEveryone] = useState<PresenceEntry[]>([]);
  const [selfSessionId, setSelfSessionId] = useState<string | null>(null);
  const selfRef = useRef<string | null>(null);
  const [connected, setConnected] = useState(false);

  // Obtain the current userId from localStorage dev token (or auth context).
  const userId = (() => {
    try {
      const token = getActiveToken();
      // dev token format: "dev:<logtoId>"
      return token.startsWith('dev:') ? token.slice(4) : 'anon';
    } catch {
      return 'anon';
    }
  })();

  const sendPresence = useCallback(
    (ws: WebSocket) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(
        JSON.stringify({
          type: 'presence',
          collection,
          itemId,
          meta,
        }),
      );
    },
    [collection, itemId, meta],
  );

  useEffect(() => {
    let isMounted = true;
    // Through the shared accessors, not raw localStorage keys: the old
    // `lumibase_site_id` / `lumibase_dev_token` keys are never written, so the
    // ticket request went out with an empty site and token (400) and presence
    // never connected. The accessors also honour the shell's OS keychain (C1).
    const siteId = getActiveSite();
    const token = getActiveToken();
    const baseUrl = getApiBaseUrl();

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

        const wsUrl = `${toWebSocketBase(baseUrl)}/api/v1/realtime?ticket=${encodeURIComponent(ticket)}&siteId=${encodeURIComponent(siteId)}`;
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          setConnected(true);
          sendPresence(ws);
        };

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data as string) as {
              type: string;
              users?: PresenceEntry[];
              sessionId?: string;
            };
            if (msg.type === 'welcome' && typeof msg.sessionId === 'string') {
              selfRef.current = msg.sessionId;
              setSelfSessionId(msg.sessionId);
            }
            if (msg.type === 'presence' && Array.isArray(msg.users)) {
              setEveryone(msg.users);
            }
          } catch {
            /* ignore malformed */
          }
        };

        ws.onclose = () => {
          setConnected(false);
          setEveryone([]);
          selfRef.current = null;
          setSelfSessionId(null);
        };
      } catch (err) {
        console.warn('Presence connection failed', err);
      }
    };

    connect();

    return () => {
      isMounted = false;
      const ws = wsRef.current;
      // Send empty presence on unmount so the server drops us from the list.
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'presence' }));
        ws.close(1000, 'component unmount');
      }
      wsRef.current = null;
    };
  }, [userId]); // Only reconnect when userId changes.

  // Re-send presence when collection/itemId changes without reconnecting.
  useEffect(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      sendPresence(ws);
    }
  }, [sendPresence]);

  const sendField = useCallback(
    (key: 'focus' | 'lock', field: string | null) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'presence', collection, itemId, meta, [key]: field }));
    },
    [collection, itemId, meta],
  );
  const setFocus = useCallback((field: string | null) => sendField('focus', field), [sendField]);
  const setLock = useCallback((field: string | null) => sendField('lock', field), [sendField]);

  // Without a welcome yet, fall back to excluding our own user id.
  const peers = everyone.filter((u) =>
    selfSessionId ? u.sessionId !== selfSessionId : u.userId !== userId,
  );

  return { peers, everyone, selfSessionId, connected, setFocus, setLock };
}

/**
 * useCoEditors — peers who have the *same item* open, not merely the same
 * collection. Powers the "multiple people are working on this item" warning.
 *
 * `usePresence` returns every peer in the collection; here we narrow to those
 * whose `itemId` matches, then de-duplicate by `userId` (one person may have
 * the item open in several tabs, i.e. several sessions).
 */
export function useCoEditors(collection: string, itemId: string): {
  coEditors: PresenceEntry[];
  connected: boolean;
  /** Every session on this item, this one included (for field presence). */
  sessionsOnItem: PresenceEntry[];
  selfSessionId: string | null;
  setFocus: (field: string | null) => void;
  setLock: (field: string | null) => void;
} {
  const { peers, everyone, selfSessionId, connected, setFocus, setLock } = usePresence({ collection, itemId });
  const sessionsOnItem = everyone.filter((u) => u.collection === collection && u.itemId === itemId);

  const coEditors = (() => {
    const seen = new Set<string>();
    const out: PresenceEntry[] = [];
    // Your own other tabs are not "someone else" for the banner/avatar stack.
    const selfUser = everyone.find((u) => u.sessionId === selfSessionId)?.userId;
    for (const peer of peers) {
      if (peer.itemId !== itemId) continue;
      if (selfUser && peer.userId === selfUser) continue;
      if (seen.has(peer.userId)) continue;
      seen.add(peer.userId);
      out.push(peer);
    }
    return out;
  })();

  return { coEditors, connected, sessionsOnItem, selfSessionId, setFocus, setLock };
}
