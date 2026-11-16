/**
 * Minimal Portal API client. Dependency-free (no SDK) so the script-tag build
 * stays small; every call resolves to `{ ok, data | error }` and never throws,
 * so a network failure, an HTML error page or a malformed body cannot crash
 * the host page.
 */

import type { ResolvedSignupCopy } from '@lumibase/contracts/members';

export interface PortalNewsletter {
  id: string;
  key: string;
  name: string;
  description: string | null;
  audience: 'members' | 'paid';
}

export interface PortalTier {
  key: string;
  name: string;
  description: string | null;
  kind: 'free' | 'paid';
  monthlyPriceCents: number | null;
  yearlyPriceCents: number | null;
  currency: string | null;
  benefits: string[];
}

export interface PortalConfig {
  allowSelfSignup: boolean;
  newsletters: PortalNewsletter[];
  tiers: PortalTier[];
  copy: ResolvedSignupCopy;
}

export interface PortalMember {
  id: string;
  email: string;
  name: string | null;
  status: 'free' | 'paid' | 'comped';
  tier: { key: string; name: string; kind: string } | null;
  newsletters: Array<{ id: string; key: string; name: string }>;
}

export interface PortalSession {
  token: string;
  refreshToken?: string;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string; message: string };

export interface PortalApiOptions {
  /** CMS origin, e.g. `https://cms.example.com`. */
  url: string;
  siteId: string;
  fetcher?: typeof fetch;
  getToken?: () => string | null;
}

export function normalizeBaseUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin + u.pathname.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export class PortalApi {
  private readonly base: string;
  private readonly fetcher: typeof fetch;

  constructor(private readonly opts: PortalApiOptions) {
    const base = normalizeBaseUrl(opts.url);
    if (!base) throw new Error('LumiBase Portal: "url" must be an absolute http(s) URL.');
    if (!opts.siteId) throw new Error('LumiBase Portal: "siteId" is required.');
    this.base = base;
    this.fetcher = opts.fetcher ?? ((...args) => globalThis.fetch(...args));
  }

  private async call<T>(path: string, init: RequestInit = {}, auth = false): Promise<ApiResult<T>> {
    const headers: Record<string, string> = { 'x-lumi-site': this.opts.siteId, accept: 'application/json' };
    if (init.body) headers['content-type'] = 'application/json';
    const token = auth ? this.opts.getToken?.() : null;
    if (token) headers.authorization = `Bearer ${token}`;
    let res: Response;
    try {
      res = await this.fetcher(`${this.base}${path}`, { ...init, headers, credentials: 'omit' });
    } catch {
      return { ok: false, status: 0, code: 'NETWORK', message: 'Network error' };
    }
    let body: unknown = null;
    try {
      const text = await res.text();
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (res.ok) return { ok: true, data: ((body as { data?: T } | null)?.data ?? null) as T };
    const err = (body as { errors?: Array<{ code?: string; message?: string }> } | null)?.errors?.[0];
    return { ok: false, status: res.status, code: err?.code ?? 'HTTP_ERROR', message: err?.message ?? `Request failed (${res.status})` };
  }

  config(locale?: string) {
    const q = locale ? `?locale=${encodeURIComponent(locale)}` : '';
    return this.call<PortalConfig>(`/api/v1/portal/config${q}`);
  }

  requestLink(input: { email: string; name?: string; newsletters?: string[]; redirectUri?: string; intent?: 'signup' | 'signin'; locale?: string }) {
    return this.call<{ status: string }>(`/api/v1/portal/magic-link`, { method: 'POST', body: JSON.stringify(input) });
  }

  verify(token: string) {
    return this.call<PortalSession>(`/api/v1/portal/magic-link/verify`, { method: 'POST', body: JSON.stringify({ token }) });
  }

  me() {
    return this.call<PortalMember>(`/api/v1/portal/me`, {}, true);
  }

  update(patch: { name?: string | null; newsletters?: Record<string, boolean>; unsubscribeAll?: boolean }) {
    return this.call<PortalMember>(`/api/v1/portal/me`, { method: 'PATCH', body: JSON.stringify(patch) }, true);
  }

  switchTier(input: { tier: string; interval?: 'month' | 'year'; returnUrl?: string }) {
    return this.call<{ status: 'switched' } | { status: 'checkout'; checkoutUrl: string }>(`/api/v1/portal/me/tier`, { method: 'POST', body: JSON.stringify(input) }, true);
  }

  leave() {
    return this.call<null>(`/api/v1/portal/me`, { method: 'DELETE' }, true);
  }
}
