import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { RealtimeEvent } from '@lumibase/sdk';
import { type ConnectionStatus, onConnectionStatus, subscribeCollection } from '@/lib/realtime';

/**
 * Realtime hooks over the app-wide singleton (`lib/realtime.ts`). All
 * subscribers share one WebSocket; each hook just registers/unregisters its
 * callback. See `.kiro/specs/realtime-subscriptions` (task 5).
 */

/** Subscribe to a collection; invoke `onEvent` for each matching event. */
export function useRealtimeSubscription(
  collection: string,
  onEvent?: (event: RealtimeEvent) => void,
): void {
  useEffect(() => {
    if (!collection) return;
    const unsubscribe = subscribeCollection(collection, (event) => {
      if (event.collection === collection) onEvent?.(event);
    });
    return unsubscribe;
  }, [collection, onEvent]);
}

/**
 * Subscribe to a collection and keep its React Query list fresh: invalidates
 * the `['items', collection]` query on any mutation event. Callers that want
 * incremental cache patching can pass their own `onEvent` via
 * {@link useRealtimeSubscription} instead.
 */
export function useRealtimeCollection(collection: string): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!collection) return;
    return subscribeCollection(collection, (event) => {
      if (event.collection !== collection) return;
      void queryClient.invalidateQueries({ queryKey: ['items', collection] });
    });
  }, [collection, queryClient]);
}

/**
 * Fire `onItemUpdate` when the specific open item receives an `update`/`delete`
 * event — powers the "this item was updated" banner in the detail view.
 */
export function useRealtimeItem(
  collection: string,
  itemId: string | undefined,
  onItemUpdate?: (event: RealtimeEvent) => void,
): void {
  useEffect(() => {
    if (!collection || !itemId) return;
    return subscribeCollection(collection, (event) => {
      if (event.collection === collection && event.itemId === itemId && event.action !== 'create') {
        onItemUpdate?.(event);
      }
    });
  }, [collection, itemId, onItemUpdate]);
}

/** Reactive connection status for the app-shell status dot. */
export function useConnectionStatus(): ConnectionStatus {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  useEffect(() => onConnectionStatus(setStatus), []);
  return status;
}
