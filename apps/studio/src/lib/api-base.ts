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
 *
 * Always returns an origin with no trailing slash, or `''` for same-origin
 * so callers can safely build `` `${getApiBaseUrl()}/api/v1/...` ``.
 */
export function getApiBaseUrl(): string {
  const raw = import.meta.env?.VITE_API_URL;
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  return trimmed.replace(/\/+$/, '');
}
