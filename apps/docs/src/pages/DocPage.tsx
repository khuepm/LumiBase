/**
 * DocPage component — displays a single documentation page with i18n support.
 *
 * Responsibilities:
 * - Load doc content via `resolveDoc(locale, slug)` with fallback to default locale
 * - Pass content to MarkdownRenderer with `currentLocale` for link rewriting
 *   (the markdown's own H1 is the visible page title — no duplicate header)
 * - Display last-modified date in a footer at the bottom of the page,
 *   in DD/MM/YYYY format (if available)
 * - Set browser <title> to `{document title} — Lumibase Docs`
 * - If slug not found in any locale, redirect to NotFoundPage
 * - Expose `isFallback` for TranslationBanner (task 6.5)
 *
 * Requirements: 4.1, 4.3
 */
import { useEffect, useMemo } from 'react';
import { useParams, Navigate } from 'react-router-dom';
import { docIndexByLocale } from 'virtual:docs-registry';
import { MarkdownRenderer } from '../components/MarkdownRenderer';
import { TranslationBanner } from '../components/TranslationBanner';
import { useLocale } from '../hooks/useLocale';
import { resolveDoc } from '../lib/resolveDoc';

/**
 * Formats an ISO date string to DD/MM/YYYY format.
 * Returns undefined if the input is not a valid date.
 *
 * Uses UTC getters rather than local-time ones: this value is baked into the
 * prerendered HTML at build time (in whatever timezone CI runs in) and must
 * render identically when the client hydrates in the visitor's own timezone.
 * Local-time getters shift the calendar day near midnight UTC depending on
 * the reader's offset, which diverges from the server-rendered string and
 * throws a hydration mismatch (React error #418).
 */
export function formatDate(isoDate: string | undefined): string | undefined {
  if (!isoDate) return undefined;
  const date = new Date(isoDate);
  if (isNaN(date.getTime())) return undefined;
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const year = date.getUTCFullYear();
  return `${day}/${month}/${year}`;
}

export function DocPage() {
  const { '*': rawSlug } = useParams();
  const { locale } = useLocale();

  // Cloudflare Pages 308-redirects every prerendered route to its
  // trailing-slash form (see scripts/prerender.mjs), so the URL the browser
  // actually loads is ".../slug/" — but SSR renders each page for the
  // no-trailing-slash slug from pathFor(), and the registry's slugs never
  // have one either. Without stripping it here, the splat param picked up
  // by the client router includes the trailing slash, resolveDoc() fails to
  // find a match, and the page falls back to /404 only on the client —
  // diverging from the prerendered HTML (React error #418).
  const slug = rawSlug?.replace(/\/+$/, '');

  // Resolve document with locale fallback
  const resolved = slug ? resolveDoc(locale, slug) : null;
  const entry = resolved?.entry;
  const isFallback = resolved?.isFallback ?? false;

  // Build the set of known slugs for link rewriting (union of all locales)
  const knownSlugs = useMemo(() => {
    const slugs = new Set<string>();
    for (const localeIndex of Object.values(docIndexByLocale)) {
      for (const s of Object.keys(localeIndex)) {
        slugs.add(s);
      }
    }
    return slugs;
  }, []);

  // Set browser title
  useEffect(() => {
    if (entry) {
      document.title = `${entry.title} — Lumibase Docs`;
    }
    return () => {
      document.title = 'Lumibase Docs';
    };
  }, [entry]);

  // If slug not found in any locale, redirect to 404
  if (!resolved) {
    return <Navigate to="/404" replace />;
  }

  const formattedDate = formatDate(entry!.lastModified);

  return (
    <article className="mx-auto w-full max-w-[768px] px-6 py-12 md:px-10">
      {isFallback && <TranslationBanner filePath={entry!.filePath} />}
      <MarkdownRenderer
        content={entry!.content}
        currentSlug={entry!.slug}
        knownSlugs={knownSlugs}
        currentLocale={locale}
      />
      {formattedDate && (
        <footer className="mt-12 border-t border-border pt-6 text-[13px] font-medium text-muted-foreground">
          Last modified: {formattedDate}
        </footer>
      )}
    </article>
  );
}
