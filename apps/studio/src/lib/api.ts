import { createLumiClient, legacyRest } from '@lumibase/sdk';

/**
 * Studio API client. In Phase 0/A we run against the Vite dev proxy so the
 * Worker URL is empty (same-origin). Token + site come from localStorage in
 * dev; production wires Logto's access token and the site switcher.
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

function createApiClient(token: string, site: string) {
  return createLumiClient({
    url: '',
    token,
    siteId: site,
    headers: { 'X-Lumi-Client': 'studio' },
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
