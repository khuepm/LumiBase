/**
 * Build a URL path for a given locale and slug.
 * Example: pathFor('en', 'features/ai-copilot') → '/en/docs/features/ai-copilot'
 */
export function pathFor(locale: string, slug: string): string {
  return `/${locale}/docs/${slug}`;
}

/**
 * Parse a URL path to extract locale and slug.
 * Returns null if the path doesn't match the expected pattern.
 * Example: parseUrl('/en/docs/features/ai-copilot') → { locale: 'en', slug: 'features/ai-copilot' }
 *
 * Strips a trailing slash from the slug: Cloudflare Pages 308-redirects every
 * prerendered route to its trailing-slash form (see scripts/prerender.mjs),
 * so the URL actually loaded in the browser is ".../slug/" while registry
 * slugs and pathFor() never have one. Without stripping it, callers get a
 * slug that can't be found in the registry.
 */
export function parseUrl(path: string): { locale: string; slug: string } | null {
  const match = path.match(/^\/([^/]+)\/docs\/(.+)$/);
  if (!match || !match[1] || !match[2]) return null;
  const slug = match[2].replace(/\/+$/, '');
  if (!slug) return null;
  return { locale: match[1], slug };
}
