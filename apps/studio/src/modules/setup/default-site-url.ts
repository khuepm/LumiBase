/** Used only when the Studio is not served over http(s) (e.g. a Tauri shell). */
const FALLBACK_SITE_URL = 'http://localhost:2026';

/**
 * Pre-fill for the wizard's Site URL: the origin the Studio is actually
 * served from. A hardcoded `http://localhost:*` here ends up persisted on
 * production sites whose operator never edits the field (the simple wizard
 * does not even show it).
 */
export function defaultSiteUrl(origin: string | undefined = globalThis.location?.origin): string {
  if (origin && /^https?:\/\//i.test(origin)) return origin.replace(/\/+$/, '');
  return FALLBACK_SITE_URL;
}
