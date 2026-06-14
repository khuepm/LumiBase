import { createLumiClient, legacyRest } from '@lumibase/sdk';
import { getAdminBase } from '@/lib/admin-base';
import { getApiBaseUrl } from '@/lib/api-base';

/**
 * Studio API client. The base URL is resolved by `getApiBaseUrl()`:
 * same-origin in dev (Vite proxy) and Docker, or the absolute CMS origin
 * (`VITE_API_URL`) when the Studio is deployed standalone (Cloudflare
 * Pages). Token + site come from localStorage in dev; production wires
 * Logto's access token and the site switcher.
 */

const STORAGE_KEY = {
  token: 'lumibase.dev.token',
  site: 'lumibase.dev.site',
};

const DEFAULT_DEV_SITE = '__default__';

export function getActiveSite(): string {
  return localStorage.getItem(STORAGE_KEY.site) || DEFAULT_DEV_SITE;
}

export function setActiveSite(siteId: string): void {
  localStorage.setItem(STORAGE_KEY.site, siteId);
}

export function getActiveToken(): string {
  return localStorage.getItem(STORAGE_KEY.token) || '';
}

export function setActiveToken(token: string): void {
  localStorage.setItem(STORAGE_KEY.token, token);
  cached = null;
}

export function clearActiveToken(): void {
  localStorage.removeItem(STORAGE_KEY.token);
  cached = null;
}

export function hasActiveToken(): boolean {
  return getActiveToken().length > 0;
}

/**
 * Set once we have kicked off a redirect to the login screen so a burst of
 * parallel requests all 401-ing at the same time (e.g. the dashboard firing
 * collections + roles + flows together) only triggers a single navigation.
 * Reset implicitly by the full page load the redirect performs.
 */
let unauthorizedRedirectInFlight = false;

/**
 * Global `401 Unauthorized` handler. A stale/expired token in localStorage
 * is otherwise treated as "logged in" by the gate, letting the shell mount
 * and every API call 401 with a misleading "Failed to load…" message. On the
 * first 401 we clear the token and send the operator to the admin login page,
 * derived from the current URL's `/{adminPath}` prefix (the Zustand setup
 * store may be empty after a reload, so we do NOT rely on it here).
 */
function handleUnauthorized(): void {
  if (typeof window === 'undefined') return;
  if (unauthorizedRedirectInFlight) return;

  const { pathname } = window.location;
  // Already on a login/recovery page → clearing + redirecting would loop.
  const adminBase = getAdminBase(pathname);
  const rest = adminBase ? pathname.slice(adminBase.length) : pathname;
  if (rest.startsWith('/login') || rest.startsWith('/recovery')) {
    clearActiveToken();
    return;
  }

  unauthorizedRedirectInFlight = true;
  clearActiveToken();
  window.location.assign(adminBase ? `${adminBase}/login` : '/');
}

function createApiClient(token: string, site: string) {
  return createLumiClient({
    url: getApiBaseUrl(),
    token,
    siteId: site,
    headers: { 'X-Lumi-Client': 'studio' },
    onUnauthorized: handleUnauthorized,
  }).with(legacyRest());
}

export type StudioApiClient = ReturnType<typeof createApiClient>;

let cached: { client: StudioApiClient; site: string; token: string } | null = null;

export function getApiClient(): StudioApiClient {
  const site = getActiveSite();
  const token = getActiveToken();
  if (!cached || cached.site !== site || cached.token !== token) {
    cached = {
      site,
      token,
      client: createApiClient(token, site),
    };
  }
  return cached.client;
}
