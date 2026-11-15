/**
 * `@lumibase/astro/client` — realtime helper for client `<script>`s.
 *
 * ```astro
 * <script>
 *   import { RealtimeClient } from '@lumibase/sdk';
 *   import { watchCollection } from '@lumibase/astro/client';
 *   const rt = new RealtimeClient({ baseUrl, siteId, token: publicToken });
 *   watchCollection(rt, 'posts', () => location.reload());
 * </script>
 * ```
 *
 * The subscription is removed — and the shared connection released — on the
 * returned stop, on `pagehide`, and on Astro's `astro:before-swap` (view
 * transitions keep the document, so without it subscriptions would pile up
 * across navigations). Inside framework islands use `@lumibase/vue` or
 * `@lumibase/svelte` instead; they tie cleanup to the component.
 */
import { retainRealtime, type RealtimeClient, type RealtimeEvent } from "@lumibase/sdk";

export const CLEANUP_EVENTS = ["astro:before-swap", "pagehide"] as const;

export function watchCollection(
  realtime: RealtimeClient,
  collection: string,
  handler: (event: RealtimeEvent) => void,
  options: { filter?: Record<string, unknown> } = {},
): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};
  const release = retainRealtime(realtime);
  const off = realtime.subscribe(collection, handler, { filter: options.filter });
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const name of CLEANUP_EVENTS) {
      document.removeEventListener(name, stop);
      window.removeEventListener(name, stop);
    }
    off();
    release();
  };
  document.addEventListener("astro:before-swap", stop);
  window.addEventListener("pagehide", stop);
  return stop;
}
