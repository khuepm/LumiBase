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

const DEFAULT_DEV_TOKEN = 'dev:admin@lumibase.dev:admin';
const DEFAULT_DEV_SITE = 'site_demo';

export function getActiveSite(): string {
  return localStorage.getItem(STORAGE_KEY.site) || DEFAULT_DEV_SITE;
}

export function setActiveSite(siteId: string): void {
  localStorage.setItem(STORAGE_KEY.site, siteId);
}

export function getActiveToken(): string {
  const token = localStorage.getItem(STORAGE_KEY.token);
  if (token) return token;
  // In local dev, use mock admin token. In production, CF Access handles JWT via cookies.
  if (import.meta.env.DEV) {
    return DEFAULT_DEV_TOKEN;
  }
  return '';
}

function createApiClient(token: string, site: string) {
  return createLumiClient({ url: '', token, siteId: site }).with(legacyRest());
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
