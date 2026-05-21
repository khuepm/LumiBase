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
  /** Other users currently present (excludes self). */
  peers: PresenceEntry[];
  /** Whether the WS connection for presence is active. */
  connected: boolean;
}

export function usePresence(options: UsePresenceOptions = {}): UsePresenceResult {
  const { collection, itemId, meta } = options;
  const wsRef = useRef<WebSocket | null>(null);
  const [peers, setPeers] = useState<PresenceEntry[]>([]);
  const [connected, setConnected] = useState(false);

  // Obtain the current userId from localStorage dev token (or auth context).
  const userId = (() => {
    try {
      const token = localStorage.getItem('lumibase_dev_token') ?? '';
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
    const siteId = localStorage.getItem('lumibase_site_id') ?? '';
    const token = localStorage.getItem('lumibase_dev_token') ?? '';
    const baseUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:8787';
    const wsUrl = `${baseUrl.replace(/^http/, 'ws')}/api/v1/realtime?token=${encodeURIComponent(token)}&userId=${encodeURIComponent(userId)}&siteId=${encodeURIComponent(siteId)}`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      return;
    }
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      sendPresence(ws);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as { type: string; users?: PresenceEntry[] };
        if (msg.type === 'presence' && Array.isArray(msg.users)) {
          // Filter out self from the peer list.
          setPeers(msg.users.filter((u) => u.userId !== userId));
        }
      } catch {
        /* ignore malformed */
      }
    };

    ws.onclose = () => {
      setConnected(false);
      setPeers([]);
    };

    return () => {
      // Send empty presence on unmount so the server drops us from the list.
      if (ws.readyState === WebSocket.OPEN) {
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

  return { peers, connected };
}
