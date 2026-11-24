/**
 * Desktop/mobile shell deep links → intent route (issue #759, DoD §2d).
 *
 * The Tauri shell registers the `lumibase://` scheme and forwards every opened
 * URL to the SPA as a `shell://deep-link` event (contract C8 in
 * `apps/studio/NATIVE_HOST_CONTRACT.md`). Until now nothing consumed it. This module maps
 * the intent form of those URLs onto the same `/intent/{action}?…` route the
 * browser uses:
 *
 *   lumibase://intent/edit?collection=posts&id=p1&field=title
 *   lumibase:///intent/edit?…                       (empty host form)
 *   https://studio.lumibase.dev/intent/edit?…       (mobile universal link)
 *
 * Anything else (auth callbacks, unknown hosts) is ignored and left to its
 * own consumer. The result is admin-relative; the intent route itself does
 * the full validation, so this only decides "is this an intent link?".
 */
import { STUDIO_INTENT_ACTIONS } from '@lumibase/contracts/intents';
import { isDesktopShell } from '@/lib/shell';
import { toSafeInternalPath } from './paths';

export const SHELL_DEEP_LINK_EVENT = 'shell://deep-link';
const UNIVERSAL_LINK_HOST = 'studio.lumibase.dev';

export function shellUrlToIntentPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  let segments: string[];
  if (url.protocol === 'lumibase:') {
    // `lumibase://intent/edit` parses with host `intent`; `lumibase:///intent/edit`
    // with an empty host and the action in the path.
    segments = [url.hostname, ...url.pathname.split('/')].filter(Boolean);
  } else if (url.protocol === 'https:' && url.hostname === UNIVERSAL_LINK_HOST && !url.port) {
    segments = url.pathname.split('/').filter(Boolean);
  } else {
    return null;
  }
  if (segments.length !== 2 || segments[0] !== 'intent') return null;
  const action = segments[1] ?? '';
  if (!(STUDIO_INTENT_ACTIONS as readonly string[]).includes(action)) return null;
  return toSafeInternalPath(`/intent/${action}${url.search}`);
}

/**
 * Subscribe to shell deep links (no-op in a browser). Returns an unsubscribe
 * function. `onIntent` receives the admin-relative intent path.
 */
export function listenForShellIntentLinks(onIntent: (path: string) => void): () => void {
  if (!isDesktopShell()) return () => {};
  let disposed = false;
  let unlisten: (() => void) | undefined;
  void import('@tauri-apps/api/event')
    .then(({ listen }) =>
      listen<unknown>(SHELL_DEEP_LINK_EVENT, (event) => {
        const urls = Array.isArray(event.payload) ? event.payload : [event.payload];
        for (const url of urls) {
          const path = shellUrlToIntentPath(url);
          if (path) {
            onIntent(path);
            return; // one navigation per event
          }
        }
      }),
    )
    .then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    })
    .catch(() => {
      /* event API unavailable (e.g. mobile without the plugin) — links stay inert */
    });
  return () => {
    disposed = true;
    unlisten?.();
  };
}
