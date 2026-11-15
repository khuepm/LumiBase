/**
 * Reference-counted connection sharing for {@link RealtimeClient}.
 *
 * Framework adapters (`@lumibase/vue`, `@lumibase/svelte`, `@lumibase/astro`)
 * mount and unmount many components that each want "the realtime connection
 * to be open while I am alive". Calling `connect()` from each one is safe
 * (it is idempotent) but nothing would ever close the socket again. This
 * helper keeps one count per client: the first `retainRealtime()` opens the
 * connection, the release of the last holder closes it.
 *
 * The count lives in a WeakMap, so a client that is garbage-collected takes
 * its count with it, and two independent clients never share one.
 */

/** The part of `RealtimeClient` the retain counter drives. */
export interface RealtimeConnectable {
  connect(): unknown;
  disconnect(): void;
}

const holders = new WeakMap<RealtimeConnectable, number>();

/** Number of live holders for `client` (0 when nobody retains it). */
export function realtimeHolders(client: RealtimeConnectable): number {
  return holders.get(client) ?? 0;
}

/**
 * Mark `client` as in use. Connects on the first hold. Returns a release
 * function that is safe to call more than once — only the first call counts.
 */
export function retainRealtime(client: RealtimeConnectable): () => void {
  const count = realtimeHolders(client);
  holders.set(client, count + 1);
  if (count === 0) client.connect();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = realtimeHolders(client) - 1;
    if (next <= 0) {
      holders.delete(client);
      client.disconnect();
    } else {
      holders.set(client, next);
    }
  };
}
