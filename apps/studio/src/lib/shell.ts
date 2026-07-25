/**
 * Detect whether the Studio SPA is running inside the native desktop/mobile
 * shell (Tauri) rather than a browser.
 *
 * Tauri injects `window.__TAURI_INTERNALS__` (and, when enabled, an
 * `isTauri` flag) into the webview. We treat the presence of either as the
 * signal. In a plain browser both are absent, so this returns `false` and no
 * shell-only behavior (like the server-connection gate) activates.
 */
export function isDesktopShell(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as typeof window & {
    __TAURI_INTERNALS__?: unknown;
    isTauri?: boolean;
  };
  return Boolean(w.__TAURI_INTERNALS__ || w.isTauri);
}
