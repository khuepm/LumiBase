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
 */
export function parseUrl(path: string): { locale: string; slug: string } | null {
  const match = path.match(/^\/([^/]+)\/docs\/(.+)$/);
  if (!match || !match[1] || !match[2]) return null;
  return { locale: match[1], slug: match[2] };
}
