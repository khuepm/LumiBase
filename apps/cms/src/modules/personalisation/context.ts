/**
 * Request context for audience resolution (#762). Built from what a public,
 * unauthenticated delivery request carries:
 *
 * - country: the CDN's geo header (`CF-IPCountry` on Cloudflare,
 *   `X-Vercel-IP-Country`, `CloudFront-Viewer-Country`). Docker deployments
 *   behind such a proxy get it for free; without one, country rules never
 *   match.
 * - locale: `?locale=` (or `?lang=`), the parameter delivery already keys on.
 * - UTM: `utm_*` query parameters.
 * - custom attributes: one header, `X-Lumi-Attrs: tier=gold; plan=pro`, set
 *   by the site's own server (e.g. from its session). The CMS does not know
 *   members on the delivery path, so a member tier arrives this way.
 * - consent: `X-Lumi-Consent: personalization, analytics` from the site's
 *   consent banner. `DNT: 1` or `Sec-GPC: 1` withdraws both.
 */
import type { RequestContext } from './rules';

export const COUNTRY_HEADERS = ['cf-ipcountry', 'x-vercel-ip-country', 'cloudfront-viewer-country'] as const;
export const ATTRS_HEADER = 'x-lumi-attrs';
export const CONSENT_HEADER = 'x-lumi-consent';

/** Request headers the resolved audience can depend on (for `Vary`). */
export const PERSONALISATION_VARY = ['CF-IPCountry', 'X-Vercel-IP-Country', 'CloudFront-Viewer-Country', 'X-Lumi-Attrs', 'X-Lumi-Consent', 'DNT', 'Sec-GPC'];

const MAX_ATTRS = 20;
const ATTR_NAME = /^[a-z][a-z0-9_]{0,39}$/;

export function parseAttrsHeader(raw: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const part of raw.split(/[;,]/)) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim().toLowerCase();
    let value = part.slice(i + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      /* keep raw */
    }
    if (!ATTR_NAME.test(name) || value.length === 0 || value.length > 200) continue;
    out[name] = value;
    if (Object.keys(out).length >= MAX_ATTRS) break;
  }
  return out;
}

export function parseConsentHeader(raw: string | null | undefined): { personalization: boolean; analytics: boolean } {
  const tokens = new Set((raw ?? '').split(/[\s,;]+/).map((t) => t.trim().toLowerCase()).filter(Boolean));
  return {
    personalization: tokens.has('personalization') || tokens.has('personalisation'),
    analytics: tokens.has('analytics'),
  };
}

export function requestContext(headers: Headers, url: URL): RequestContext {
  let country: string | null = null;
  for (const h of COUNTRY_HEADERS) {
    const v = headers.get(h)?.trim().toUpperCase();
    // `XX` / `T1` are Cloudflare's "unknown" / Tor markers.
    if (v && /^[A-Z]{2}$/.test(v) && v !== 'XX') {
      country = v;
      break;
    }
  }
  const locale = (url.searchParams.get('locale') ?? url.searchParams.get('lang'))?.trim().toLowerCase() || null;
  const utm: RequestContext['utm'] = {};
  for (const k of ['source', 'medium', 'campaign', 'term', 'content'] as const) {
    const v = url.searchParams.get(`utm_${k}`)?.trim();
    if (v) utm[k] = v.slice(0, 200);
  }
  const optedOut = headers.get('dnt') === '1' || headers.get('sec-gpc') === '1';
  const consent = optedOut ? { personalization: false, analytics: false } : parseConsentHeader(headers.get(CONSENT_HEADER));
  return { country, locale, utm, attrs: parseAttrsHeader(headers.get(ATTRS_HEADER)), consent };
}
