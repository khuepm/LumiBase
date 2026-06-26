/**
 * SEO helpers for consuming the Delivery API's `_seo` block (Req 14.4).
 *
 * Use {@link toNextMetadata} inside a Next.js `generateMetadata` to map a
 * delivery item's `_seo` into the framework's Metadata shape without
 * re-deriving anything client-side.
 */

export interface DeliverySeo {
  title?: string;
  description?: string;
  canonical?: string;
  openGraph?: Record<string, unknown>;
  jsonLd?: Record<string, unknown>;
}

/** Extract the `_seo` block from a delivery item, if present. */
export function extractSeo(item: unknown): DeliverySeo | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const seo = (item as { _seo?: unknown })._seo;
  return seo && typeof seo === 'object' ? (seo as DeliverySeo) : undefined;
}

/**
 * Map a delivery item's `_seo` to a Next.js `generateMetadata` return value.
 * The shape is intentionally framework-agnostic (a plain object) so it does
 * not create a hard dependency on `next`.
 */
export function toNextMetadata(item: unknown): Record<string, unknown> {
  const seo = extractSeo(item);
  if (!seo) return {};
  const metadata: Record<string, unknown> = {};
  if (seo.title) metadata.title = seo.title;
  if (seo.description) metadata.description = seo.description;
  if (seo.canonical) metadata.alternates = { canonical: seo.canonical };
  if (seo.openGraph) metadata.openGraph = seo.openGraph;
  return metadata;
}

/**
 * Render the JSON-LD block as a string suitable for a
 * `<script type="application/ld+json">` tag.
 */
export function jsonLdScript(item: unknown): string | undefined {
  const seo = extractSeo(item);
  if (!seo?.jsonLd) return undefined;
  return JSON.stringify(seo.jsonLd);
}
