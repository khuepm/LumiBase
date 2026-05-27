/**
 * DocPage component — displays a single documentation page with i18n support.
 *
 * Responsibilities:
 * - Load doc content via `resolveDoc(locale, slug)` with fallback to default locale
 * - Pass content to MarkdownRenderer with `currentLocale` for link rewriting
 * - Display document title as H1 at top of content area
 * - Display last-modified date below title in DD/MM/YYYY format (if available)
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
 */
export function formatDate(isoDate: string | undefined): string | undefined {
  if (!isoDate) return undefined;
  const date = new Date(isoDate);
  if (isNaN(date.getTime())) return undefined;
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
}

export function DocPage() {
  const { '*': slug } = useParams();
  const { locale } = useLocale();

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
    <article className="p-8 max-w-4xl mx-auto">
      <header className="mb-8">
        <h1 className="text-3xl font-bold text-foreground">{entry!.title}</h1>
        {formattedDate && (
          <p className="mt-2 text-sm text-muted-foreground">
            Last modified: {formattedDate}
          </p>
        )}
      </header>
      {isFallback && <TranslationBanner filePath={entry!.filePath} />}
      <MarkdownRenderer
        content={entry!.content}
        currentSlug={entry!.slug}
        knownSlugs={knownSlugs}
        currentLocale={locale}
      />
    </article>
  );
}
