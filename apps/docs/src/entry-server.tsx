import { StrictMode } from 'react';
import { renderToString } from 'react-dom/server';
import {
  createStaticHandler,
  createStaticRouter,
  StaticRouterProvider,
} from 'react-router-dom';
import { routes } from './routes';
import {
  locales,
  defaultLocale,
  docSlugsByLocale,
  docIndexByLocale,
} from 'virtual:docs-registry';
import { pathFor } from './lib/url';

const { query, dataRoutes } = createStaticHandler(routes);

export interface PrerenderPath {
  locale: string;
  slug: string;
  /** Canonical URL path, e.g. /en/docs/features/ai-copilot */
  url: string;
  title: string;
  description: string;
  lastModified?: string;
}

/**
 * Render the app for a given URL to a static HTML body string.
 * Returns both the markup and the hydration data script that the client
 * router (createBrowserRouter) reads from window.__staticRouterHydrationData.
 */
export async function render(url: string): Promise<string> {
  const request = new Request(`http://localhost${url}`);
  const context = await query(request);

  // A route returned a redirect Response — prerender only canonical doc URLs,
  // so this should not happen for the paths we feed in, but guard anyway.
  if (context instanceof Response) {
    throw new Error(`Unexpected redirect while prerendering ${url}`);
  }

  const router = createStaticRouter(dataRoutes, context);
  return renderToString(
    <StrictMode>
      <StaticRouterProvider router={router} context={context} />
    </StrictMode>,
  );
}

/** Strip markdown to a plain-text meta description (~155 chars). */
function deriveDescription(markdown: string): string {
  const text = markdown
    .replace(/```[\s\S]*?```/g, ' ') // code fences
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links → text
    .replace(/[#>*_`~|-]/g, ' ') // md punctuation
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= 155) return text;
  return `${text.slice(0, 152).trimEnd()}…`;
}

/**
 * Enumerate every (locale, slug) pair that should be prerendered to a static
 * HTML file, with the metadata needed to build each page's <head>.
 */
export function getAllPaths(): PrerenderPath[] {
  const paths: PrerenderPath[] = [];
  for (const locale of locales) {
    for (const slug of docSlugsByLocale[locale] ?? []) {
      const entry = docIndexByLocale[locale]?.[slug];
      if (!entry) continue;
      paths.push({
        locale,
        slug,
        url: pathFor(locale, slug),
        title: entry.title,
        description: deriveDescription(entry.content),
        lastModified: entry.lastModified,
      });
    }
  }
  return paths;
}

export interface LocaleIndex {
  locale: string;
  /** URL path of the locale landing page, e.g. /en/ (root uses /). */
  url: string;
  /** Every doc in this locale, sorted by slug, for a crawlable link list. */
  pages: { title: string; url: string; slug: string }[];
  /** Newest lastModified across the locale's pages, for sitemap lastmod. */
  lastModified?: string;
}

/**
 * Per-locale landing-page data. The default locale also owns the site root
 * (`/`). Each landing page renders a plain <a> link list so crawlers reach
 * every prerendered doc from the homepage — the SPA <Navigate> redirect that
 * the client uses is invisible to bots.
 */
export function getLocaleIndexes(): LocaleIndex[] {
  const indexes: LocaleIndex[] = [];
  for (const locale of locales) {
    const slugs = [...(docSlugsByLocale[locale] ?? [])].sort((a, b) =>
      a.localeCompare(b),
    );
    const pages = slugs
      .map((slug) => {
        const entry = docIndexByLocale[locale]?.[slug];
        if (!entry) return null;
        return { title: entry.title, url: pathFor(locale, slug), slug };
      })
      .filter((p): p is { title: string; url: string; slug: string } => p !== null);

    let lastModified: string | undefined;
    for (const slug of slugs) {
      const lm = docIndexByLocale[locale]?.[slug]?.lastModified;
      if (lm && (!lastModified || lm > lastModified)) lastModified = lm;
    }

    indexes.push({ locale, url: `/${locale}/`, pages, lastModified });
  }
  return indexes;
}

export { locales, defaultLocale };