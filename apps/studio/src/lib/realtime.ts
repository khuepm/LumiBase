/**
 * App-wide realtime singleton (realtime-subscriptions Req 5.x). Wraps ONE
 * `RealtimeClient` for the active site so every component shares a single
 * WebSocket instead of each `useRealtime*` hook opening its own. Handles lazy
 * connect, collection multiplexing (delegated to the SDK client), and a simple
 * connection-status broadcast for the app-shell status dot.
 */

import { RealtimeClient, type RealtimeEvent } from '@lumibase/sdk';
import { getActiveSite, getActiveToken } from '@/lib/api';
import { getApiBaseUrl } from '@/lib/api-base';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';
type StatusListener = (status: ConnectionStatus) => void;

let client: RealtimeClient | null = null;
let clientSite: string | null = null;
let statusPoll: ReturnType<typeof setInterval> | null = null;
let lastStatus: ConnectionStatus = 'disconnected';
const statusListeners = new Set<StatusListener>();

function emitStatus(next: ConnectionStatus) {
  if (next === lastStatus) return;
  lastStatus = next;
  for (const l of statusListeners) l(next);
}

/** Lazily create + connect the shared client for the active site. */
function ensureClient(): RealtimeClient | null {
  const site = getActiveSite();
  const token = getActiveToken();
  if (!site || !token) return null;

  // Recreate if the active site changed (e.g. site switcher).
  if (client && clientSite !== site) {
    client.disconnect();
    client = null;
  }
  if (!client) {
    client = new RealtimeClient({ baseUrl: getApiBaseUrl(), token, siteId: site });
    clientSite = site;
    client.connect();
    emitStatus('connecting');
    // The SDK client has no status event; poll its `isConnected` getter and
    // fan the transition out to listeners. Cheap (1s) and stops when idle.
    if (statusPoll) clearInterval(statusPoll);
    statusPoll = setInterval(() => {
      emitStatus(client?.isConnected ? 'connected' : 'connecting');
    }, 1000);
  }
  return client;
}

/**
 * Subscribe to a collection's realtime events via the shared client. Returns an
 * unsubscribe function. No-op (returns a noop unsubscribe) when unauthenticated.
 */
export function subscribeCollection(
  collection: string,
  cb: (event: RealtimeEvent) => void,
): () => void {
  const c = ensureClient();
  if (!c) return () => {};
  return c.subscribe(collection, cb);
}

/** Listen for connection-status changes; fires immediately with the current status. */
export function onConnectionStatus(cb: StatusListener): () => void {
  statusListeners.add(cb);
  cb(lastStatus);
  return () => {
    statusListeners.delete(cb);
  };
}

/** Current connection status (for a one-shot read). */
export function connectionStatus(): ConnectionStatus {
  return lastStatus;
}

/** Tear down the shared client (e.g. on logout). Test + lifecycle helper. */
export function resetRealtime(): void {
  if (statusPoll) {
    clearInterval(statusPoll);
    statusPoll = null;
  }
  client?.disconnect();
  client = null;
  clientSite = null;
  emitStatus('disconnected');
}
