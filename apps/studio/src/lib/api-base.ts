/**
 * Resolve the LumiBase CMS API origin for the Studio SPA.
 *
 * The Studio talks to the CMS over a single base URL. How that URL is
 * resolved depends on the deployment topology:
 *
 * - **Dev:** `VITE_API_URL` is unset, so this returns `''` (same-origin).
 *   The Vite dev server proxies `/api` to the local CMS (see
 *   `vite.config.ts` → `server.proxy`).
 * - **Docker single-origin:** the Studio bundle is served by the CMS, so
 *   same-origin (`''`) reaches `/api/*` directly.
 * - **Cloudflare Pages (studio.lumibase.dev):** the static SPA has no
 *   co-located backend. The production build sets `VITE_API_URL` to the
 *   CMS origin (e.g. `https://api.lumibase.dev`) so requests go
 *   cross-origin. The CMS must allow the Studio origin via
 *   `CORS_ALLOWED_ORIGINS`.
 * - **Desktop/mobile shell (bundled):** the app is served from
 *   `tauri://localhost`, which has no backend and no build-time
 *   `VITE_API_URL`. The user picks a CMS server at runtime and it is
 *   persisted as a *runtime override* (see below), which takes precedence
 *   over everything else.
 *
 * Always returns an origin with no trailing slash, or `''` for same-origin
 * so callers can safely build `` `${getApiBaseUrl()}/api/v1/...` ``.
 */

/** localStorage key holding the user-chosen CMS origin (shell deployments). */
export const RUNTIME_API_BASE_KEY = 'lumibase.apiBaseUrl';

/** Trim whitespace and strip trailing slashes; `''` means same-origin. */
function normalizeOrigin(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  return trimmed.replace(/\/+$/, '');
}

/**
 * The runtime override, if one has been persisted. Guarded so it is safe to
 * call where `localStorage` is unavailable (returns `null` instead of throwing).
 */
export function getRuntimeApiBaseUrl(): string | null {
  try {
    const stored = globalThis.localStorage?.getItem(RUNTIME_API_BASE_KEY);
    const normalized = normalizeOrigin(stored);
    return normalized ? normalized : null;
  } catch {
    return null;
  }
}

/** Persist a user-chosen CMS origin. Pass `''`/nullish to clear it. */
export function setRuntimeApiBaseUrl(url: string | null | undefined): void {
  try {
    const normalized = normalizeOrigin(url);
    if (normalized) {
      globalThis.localStorage?.setItem(RUNTIME_API_BASE_KEY, normalized);
    } else {
      globalThis.localStorage?.removeItem(RUNTIME_API_BASE_KEY);
    }
  } catch {
    // No persistent storage (e.g. private mode) — nothing to do.
  }
}

/** Remove any persisted runtime override. */
export function clearRuntimeApiBaseUrl(): void {
  setRuntimeApiBaseUrl(null);
}

export function getApiBaseUrl(): string {
  // A persisted runtime override wins over the build-time value so the same
  // bundled shell can point at any self-hosted or cloud CMS.
  const runtimeOverride = getRuntimeApiBaseUrl();
  if (runtimeOverride) return runtimeOverride;

  return normalizeOrigin(import.meta.env?.VITE_API_URL);
}
