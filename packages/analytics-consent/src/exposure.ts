/**
 * Variant exposure for GA4 (#762). The CMS delivery API tells the frontend
 * which audience it was served (`X-Lumi-Variant` header and
 * `personalisation.audience` in the payload). This turns that into one GA4
 * event, under the same rule as the tag itself: nothing is sent without an
 * explicit analytics grant.
 */
import type { ConsentDecision } from './consent';

export const VARIANT_EXPOSURE_EVENT = 'lumi_variant_exposure';

export interface VariantExposure {
  /** Page slug (or another stable id of what was shown). */
  subject: string;
  /** Audience key served; `null` or `_` mean the default content. */
  audience: string | null;
  /** Variant ids applied, as listed in the delivery payload. */
  variants?: string[];
}

export type GtagFn = (command: 'event', name: string, params: Record<string, unknown>) => void;

/** Read the audience from a delivery response's `X-Lumi-Variant` header. */
export function variantFromHeaders(headers: Pick<Headers, 'get'>): string | null {
  const v = headers.get('x-lumi-variant');
  return v && v !== '_' ? v : null;
}

/**
 * Send one `lumi_variant_exposure` event. Returns `false` (and sends
 * nothing) without a grant, without a `gtag` function, or when the visitor
 * got the default content of a site that personalises nothing.
 */
export function trackVariantExposure(
  gtag: GtagFn | null | undefined,
  consent: ConsentDecision | null,
  exposure: VariantExposure,
): boolean {
  if (consent !== 'granted' || typeof gtag !== 'function') return false;
  const audience = exposure.audience && exposure.audience !== '_' ? exposure.audience : 'default';
  gtag('event', VARIANT_EXPOSURE_EVENT, {
    lumi_subject: exposure.subject.slice(0, 100),
    lumi_audience: audience.slice(0, 100),
    ...(exposure.variants?.length ? { lumi_variants: exposure.variants.slice(0, 10).join(',') } : {}),
  });
  return true;
}
