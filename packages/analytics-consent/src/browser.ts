import { CONSENT_CHANGE_EVENT, type ConsentStorage } from './consent';

/**
 * `window.localStorage` when it is reachable, `null` otherwise.
 *
 * Accessing the property itself throws in some privacy modes, so the access is
 * inside the `try` rather than just the read.
 */
export function safeLocalStorage(): ConsentStorage | null {
  if (typeof window === 'undefined') return null;

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Tells every mounted consent listener that the stored decision changed, so the
 * privacy page's "cookie preferences" control can re-open the banner without a
 * reload.
 */
export function notifyConsentChanged(): void {
  if (typeof window === 'undefined') return;

  window.dispatchEvent(new Event(CONSENT_CHANGE_EVENT));
}

/** Cookie name prefixes GA4 writes (`_ga` plus one `_ga_<container>` per property). */
const GA_COOKIE_PREFIX = '_ga';

/**
 * Withdraws a grant that was already acted on.
 *
 * Un-mounting the tag script does not unload a tag that has already run, so
 * withdrawal has to do two things: flip Consent Mode back to `denied` (which
 * stops GA from writing storage) and drop the cookies it already wrote. Deleting
 * a cookie requires re-setting it with an expiry in the past, on both the exact
 * host and the registrable domain, because GA sets it on the latter.
 */
export function revokeAnalyticsStorage(): void {
  if (typeof window === 'undefined') return;

  const gtag = (window as { gtag?: (...args: unknown[]) => void }).gtag;
  gtag?.('consent', 'update', { analytics_storage: 'denied' });

  const host = window.location.hostname;
  // e.g. "app.lumibase.dev" -> ["app.lumibase.dev", "lumibase.dev"]
  const parts = host.split('.');
  const domains = new Set([host, parts.slice(-2).join('.')]);

  for (const entry of document.cookie.split(';')) {
    const name = entry.split('=')[0]?.trim();
    if (!name || !name.startsWith(GA_COOKIE_PREFIX)) continue;

    for (const domain of domains) {
      document.cookie = `${name}=; Max-Age=0; path=/; domain=${domain}`;
      document.cookie = `${name}=; Max-Age=0; path=/; domain=.${domain}`;
    }
    document.cookie = `${name}=; Max-Age=0; path=/`;
  }
}
