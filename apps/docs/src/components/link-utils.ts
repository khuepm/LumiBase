/**
 * Link classification and rewriting utilities for the Markdown renderer.
 *
 * These pure functions handle:
 * - Classifying links as internal (.md), external (http/https), or broken
 * - Rewriting relative .md links to /docs/{slug} format
 * - Determining appropriate attributes for each link type
 *
 * Requirements: 8.1, 8.3, 8.4
 */

export type LinkType = 'internal' | 'external' | 'broken';

export interface ClassifiedLink {
  type: LinkType;
  href: string;
  target?: string;
  rel?: string;
}

/**
 * Resolves a relative .md link to a slug based on the current document's slug.
 *
 * For example, if currentSlug is "features/auth" and href is "../getting-started.md",
 * the resolved slug would be "getting-started".
 *
 * If href is "sub/page.md" and currentSlug is "features/auth",
 * the resolved slug would be "features/sub/page".
 */
export function resolveRelativeLink(href: string, currentSlug: string): string {
  // Remove .md extension
  const withoutMd = href.replace(/\.md$/, '');

  // Get the directory of the current slug
  const currentDir = currentSlug.includes('/')
    ? currentSlug.substring(0, currentSlug.lastIndexOf('/'))
    : '';

  // Split the relative path into segments
  const segments = withoutMd.split('/');
  const dirSegments = currentDir ? currentDir.split('/') : [];

  // Resolve relative path segments (../ and ./)
  const resolvedSegments = [...dirSegments];
  for (const segment of segments) {
    if (segment === '..') {
      resolvedSegments.pop();
    } else if (segment !== '.') {
      resolvedSegments.push(segment);
    }
  }

  // Collapse a trailing `index` segment to the parent path so links to an
  // `index.md` landing page resolve to the same slug `deriveSlug` produces
  // (e.g. `./sdk/index.md` → `sdk`). Keep the standalone value if collapsing
  // would empty the slug.
  const joined = resolvedSegments.join('/');
  const collapsed = joined.replace(/(^|\/)index$/, '');
  return collapsed === '' ? joined : collapsed;
}

/**
 * Determines if a URL is absolute (starts with http:// or https://).
 */
export function isAbsoluteUrl(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

/**
 * Determines if a link is a relative .md link.
 */
export function isRelativeMdLink(href: string): boolean {
  return !isAbsoluteUrl(href) && href.endsWith('.md');
}

/**
 * Classifies a link and returns the appropriate href and attributes.
 *
 * - Relative .md links to known slugs → rewritten to /docs/{slug} (internal)
 * - Absolute URLs (http/https) → unchanged, with target="_blank" and rel="noopener noreferrer" (external)
 * - Relative links to unknown slugs → broken link (no navigation)
 */
export function classifyLink(
  href: string,
  currentSlug: string,
  knownSlugs: Set<string>,
): ClassifiedLink {
  // Case 1: Absolute URL
  if (isAbsoluteUrl(href)) {
    return {
      type: 'external',
      href,
      target: '_blank',
      rel: 'noopener noreferrer',
    };
  }

  // Case 2: Relative .md link
  if (isRelativeMdLink(href)) {
    const resolvedSlug = resolveRelativeLink(href, currentSlug);

    if (knownSlugs.has(resolvedSlug)) {
      return {
        type: 'internal',
        href: `/docs/${resolvedSlug}`,
      };
    }

    // Relative .md link to unknown slug → broken
    return {
      type: 'broken',
      href,
    };
  }

  // Case 3: Relative link without .md extension → broken (doesn't resolve to known doc)
  return {
    type: 'broken',
    href,
  };
}
