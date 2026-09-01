/**
 * LandingPage — the locale landing page at /:locale/ (and, for the default
 * locale, the site root /).
 *
 * This route replaces the previous `<Navigate to="docs/README">` redirect plus
 * the hand-built link list that scripts/prerender.mjs injected straight into
 * `<div id="root">`. Those two disagreed: the prerendered HTML was an unstyled
 * `<h1>` + `<ul>` that the route tree would never produce, so React hydrated
 * against foreign markup and the router immediately redirected away — the list
 * flashed unstyled (full-bleed, no layout container) and vanished.
 *
 * Rendering the landing page through the real route tree means prerender and
 * client agree on what `/` is: one styled page, crawlable without JS (every
 * entry is a plain <Link> → <a href> in the static HTML) and stable after
 * hydration.
 *
 * The category grouping comes from docs.config.json via
 * buildSidebarTreeFromConfig, so the landing page lists the same curated set
 * as the sidebar — internal specs and audits stay out by construction.
 */
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { defaultLocale, docIndexByLocale } from 'virtual:docs-registry';
import { siteConfig, buildSidebarTreeFromConfig } from '../lib/site-config';
import { useLocale } from '../hooks/useLocale';
import { useT } from '../hooks/useT';
import { pathFor } from '../lib/url';

export function LandingPage() {
  const { locale } = useLocale();
  const t = useT();

  // Same curated tree the sidebar renders, so the two never drift apart.
  const categories = buildSidebarTreeFromConfig(
    docIndexByLocale,
    defaultLocale,
    locale,
  );

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-12 md:px-10 md:py-16">
      {/* Hero */}
      <header>
        <h1 className="text-[32px] font-bold tracking-[-0.5px] text-foreground md:text-[40px]">
          {t('landing.title')}
        </h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-muted-foreground md:text-base">
          {t('landing.tagline')}
        </p>
        <Link
          to={pathFor(locale, 'README')}
          className="mt-6 inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
        >
          {t('landing.get-started')}
          <ArrowRight className="h-4 w-4" />
        </Link>
      </header>

      {/* Curated doc index, grouped by category */}
      <div className="mt-14 grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3">
        {categories.map((category) => (
          <section key={category.name}>
            <h2 className="mb-3 text-[12px] font-semibold uppercase tracking-[0.6px] text-muted-foreground">
              {category.name}
            </h2>
            <ul className="space-y-2">
              {(category.children ?? []).map((doc) =>
                doc.slug ? (
                  <li key={doc.slug}>
                    <Link
                      to={pathFor(locale, doc.slug)}
                      className="text-[14px] font-medium text-foreground/90 underline-offset-4 transition-colors hover:text-primary hover:underline"
                    >
                      {doc.name}
                    </Link>
                  </li>
                ) : null,
              )}
            </ul>
          </section>
        ))}
      </div>

      <p className="mt-14 text-[13px] text-muted-foreground">
        {siteConfig.tagline}
      </p>
    </div>
  );
}
