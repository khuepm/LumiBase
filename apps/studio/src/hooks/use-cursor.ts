/**
 * useCursor — POST-GA2 collaborative cursor hook.
 *
 * Wraps the existing realtime SDK channel to send/receive cursor messages
 * for a given item + field. Returns a list of remote peers and an `emit()`
 * callback for the editor component to push local position changes.
 *
 * Rate limiting: cursor moves are throttled to 30 ms to avoid flooding the
 * websocket with sub-pixel updates.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface PeerCursor {
  userId: string;
  itemId: string;
  fieldKey: string;
  anchor: number;
  head: number;
  color: string;
  name: string;
  ts: number;
}

interface UseCursorOptions {
  itemId: string;
  fieldKey: string;
  /** Display name & color sent on join. */
  identity: { name: string; color: string };
  /** WebSocket-like transport. Pass the existing realtime client. */
  transport: {
    send: (data: string) => void;
    addEventListener: (type: 'message', cb: (e: MessageEvent) => void) => void;
    removeEventListener: (type: 'message', cb: (e: MessageEvent) => void) => void;
  };
}

export function useCursor({ itemId, fieldKey, identity, transport }: UseCursorOptions) {
  const [peers, setPeers] = useState<PeerCursor[]>([]);
  const lastSent = useRef<number>(0);

  // Wire up join/leave + message listener.
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data) as
          | { type: 'cursor.peer'; payload: PeerCursor }
          | { type: 'cursor.peers'; payload: PeerCursor[] }
          | { type: 'cursor.leave'; payload: { userId: string; itemId: string; fieldKey: string } };

        if (msg.type === 'cursor.peer') {
          const incoming = msg.payload;
          if (incoming.itemId !== itemId || incoming.fieldKey !== fieldKey) return;
          setPeers((prev) => {
            const next = prev.filter((p) => p.userId !== incoming.userId);
            next.push(incoming);
            return next;
          });
        } else if (msg.type === 'cursor.peers') {
          const list = msg.payload.filter(
            (p) => p.itemId === itemId && p.fieldKey === fieldKey,
          );
          setPeers(list);
        } else if (msg.type === 'cursor.leave') {
          if (msg.payload.itemId !== itemId || msg.payload.fieldKey !== fieldKey) return;
          setPeers((prev) => prev.filter((p) => p.userId !== msg.payload.userId));
        }
      } catch {
        // ignore non-JSON / unrelated frames
      }
    };

    transport.addEventListener('message', handler);

    transport.send(
      JSON.stringify({
        type: 'cursor.join',
        itemId,
        fieldKey,
        color: identity.color,
        name: identity.name,
      }),
    );

    return () => {
      transport.removeEventListener('message', handler);
      transport.send(JSON.stringify({ type: 'cursor.leave', itemId, fieldKey }));
    };
  }, [itemId, fieldKey, identity.color, identity.name, transport]);

  /** Push the local cursor position. Throttled to 30 ms. */
  const emit = useCallback(
    (anchor: number, head: number) => {
      const now = Date.now();
      if (now - lastSent.current < 30) return;
      lastSent.current = now;
      transport.send(
        JSON.stringify({ type: 'cursor.move', itemId, fieldKey, anchor, head }),
      );
    },
    [itemId, fieldKey, transport],
  );

  return { peers, emit };
}
