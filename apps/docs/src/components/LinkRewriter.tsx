import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from 'react';
import { pathFor } from '../lib/url';

/**
 * Props for the LinkRewriter component factory.
 * Provides context needed to resolve and classify links.
 */
export interface LinkRewriterContext {
  currentSlug: string;
  /** Set of slugs known across ALL locales (union) — used for broken-link detection */
  knownSlugs: Set<string>;
  /** Current active locale — used for link rewriting with locale prefix */
  currentLocale: string;
}

/**
 * Resolves a relative `.md` link to a slug, taking into account the current slug's
 * directory context.
 *
 * Examples:
 *   currentSlug: "features/auth", href: "./overview.md" → "features/overview"
 *   currentSlug: "features/auth", href: "../README.md" → "README"
 *   currentSlug: "README", href: "features/auth.md" → "features/auth"
 */
export function resolveRelativeSlug(currentSlug: string, href: string): string {
  // Strip .md extension
  const withoutMd = href.replace(/\.md$/, '');

  // Get the directory of the current slug
  const lastSlash = currentSlug.lastIndexOf('/');
  const currentDir = lastSlash >= 0 ? currentSlug.substring(0, lastSlash) : '';

  // Combine current directory with the relative path
  const parts = currentDir ? `${currentDir}/${withoutMd}`.split('/') : withoutMd.split('/');

  // Resolve . and .. segments
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '.' || part === '') {
      continue;
    } else if (part === '..') {
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }

  return resolved.join('/');
}

/**
 * Classifies a link href into one of three categories:
 * - 'internal': relative .md link that resolves to a slug known in ANY locale
 * - 'external': absolute URL (http:// or https://)
 * - 'broken': relative .md link that does NOT resolve to a slug in ANY locale
 * - 'passthrough': any other link (anchors, non-.md relative links, etc.)
 *
 * Broken-link logic: target slug ∉ ANY locale → broken.
 * If target slug exists in at least one locale (even just default), it's internal —
 * fallback will handle it at runtime.
 */
export function classifyLink(
  href: string,
  currentSlug: string,
  knownSlugs: Set<string>,
): { type: 'internal'; slug: string } | { type: 'external' } | { type: 'broken' } | { type: 'passthrough' } {
  // Absolute URLs
  if (/^https?:\/\//.test(href)) {
    return { type: 'external' };
  }

  // Relative .md links
  if (href.endsWith('.md') || href.includes('.md#')) {
    // Strip any anchor fragment for slug resolution
    const hrefWithoutFragment = href.split('#')[0] ?? href;
    const slug = resolveRelativeSlug(currentSlug, hrefWithoutFragment);

    if (knownSlugs.has(slug)) {
      return { type: 'internal', slug };
    }
    return { type: 'broken' };
  }

  // Everything else (anchors, non-.md relative links, etc.)
  return { type: 'passthrough' };
}

/**
 * Creates a custom `<a>` component override for react-markdown that:
 * - Rewrites relative .md links to /{currentLocale}/docs/{slug} using pathFor()
 *   and uses React Router navigation
 * - Opens absolute URLs in a new tab with rel="noopener noreferrer"
 * - Renders broken links (slug not in ANY locale) with strikethrough and prevents navigation
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4
 */
export function LinkRewriter({
  currentSlug,
  knownSlugs,
  currentLocale,
  href,
  children,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & LinkRewriterContext & { children?: ReactNode }) {
  const navigate = useNavigate();

  const handleInternalClick = useCallback(
    (e: MouseEvent<HTMLAnchorElement>, targetPath: string) => {
      e.preventDefault();
      navigate(targetPath);
    },
    [navigate],
  );

  const handleBrokenClick = useCallback((e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
  }, []);

  if (!href) {
    return (
      <a className="text-[#a99bff] underline underline-offset-2 transition-colors hover:text-white" {...props}>
        {children}
      </a>
    );
  }

  const classification = classifyLink(href, currentSlug, knownSlugs);

  switch (classification.type) {
    case 'internal': {
      // Preserve any fragment from the original href
      const fragment = href.includes('#') ? `#${href.split('#')[1]}` : '';
      const targetPath = pathFor(currentLocale, classification.slug) + fragment;
      return (
        <a
          href={targetPath}
          onClick={(e) => handleInternalClick(e, targetPath)}
          className="text-[#a99bff] underline underline-offset-2 transition-colors hover:text-white"
          {...props}
        >
          {children}
        </a>
      );
    }

    case 'external':
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[#a99bff] underline underline-offset-2 transition-colors hover:text-white"
          {...props}
        >
          {children}
        </a>
      );

    case 'broken':
      return (
        <a
          href={href}
          onClick={handleBrokenClick}
          className="line-through text-muted-foreground cursor-not-allowed"
          aria-disabled="true"
          {...props}
        >
          {children}
        </a>
      );

    case 'passthrough':
    default:
      return (
        <a
          href={href}
          className="text-[#a99bff] underline underline-offset-2 transition-colors hover:text-white"
          {...props}
        >
          {children}
        </a>
      );
  }
}
