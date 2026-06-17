/**
 * Structured SEO/AIO delivery (Req 14).
 *
 * Builds a normalised `_seo` block — `title`, `description`, `canonical`,
 * `openGraph`, and a schema.org `jsonLd` object — from an item's `seo`/`aio`
 * interface fields plus sensible fallbacks. The JSON-LD `@type` is configurable
 * (default `WebPage`) and never hard-codes a domain-specific type (Req 14.2).
 *
 * Values that are masked (`***`) or look like a ciphertext envelope are skipped
 * so a classification/permission-masked field can never leak through SEO
 * (Req 14.3). The builder operates on already-projected delivery data and pulls
 * only well-known SEO keys, so sensitive fields are not surfaced.
 */

export interface SeoBlock {
  title?: string;
  description?: string;
  canonical?: string;
  openGraph?: Record<string, unknown>;
  jsonLd?: Record<string, unknown>;
}

export interface SeoBuilderOptions {
  /** schema.org type for the JSON-LD block. Defaults to `WebPage`. */
  jsonLdType?: string;
}

/** True for values that must never appear in public SEO output. */
function isLeaky(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value === '***') return true;
  // Ciphertext envelope `v{n}:...` (see crypto/envelope-codec).
  return /^v[A-Za-z0-9_.-]+:/.test(value);
}

function pickString(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim() !== '' && !isLeaky(c)) return c;
  }
  return undefined;
}

/**
 * Build the `_seo` block for an item, or `undefined` when no usable SEO data
 * is present.
 */
export function buildSeo(
  data: Record<string, unknown>,
  options: SeoBuilderOptions = {},
): SeoBlock | undefined {
  const seo = (data.seo && typeof data.seo === 'object' ? data.seo : {}) as Record<string, unknown>;
  const aio = (data.aio && typeof data.aio === 'object' ? data.aio : {}) as Record<string, unknown>;

  const title = pickString(seo.title, aio.title, data.title, data.name);
  const description = pickString(
    seo.description,
    aio.description,
    data.description,
    data.excerpt,
    data.summary,
  );
  const canonical = pickString(seo.canonical, data.canonical, data.url);
  const image = pickString(seo.ogImage, seo.image, data.ogImage, data.image, data.cover);

  if (!title && !description && !canonical && !image) return undefined;

  const openGraph: Record<string, unknown> = {};
  if (title) openGraph.title = title;
  if (description) openGraph.description = description;
  if (canonical) openGraph.url = canonical;
  if (image) openGraph.image = image;
  openGraph.type = pickString(seo.ogType) ?? 'website';

  const jsonLd: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': options.jsonLdType ?? 'WebPage',
  };
  if (title) jsonLd.headline = title;
  if (description) jsonLd.description = description;
  if (canonical) jsonLd.url = canonical;
  if (image) jsonLd.image = image;

  const block: SeoBlock = { openGraph, jsonLd };
  if (title) block.title = title;
  if (description) block.description = description;
  if (canonical) block.canonical = canonical;
  return block;
}
