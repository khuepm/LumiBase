import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const distDir = path.join(appRoot, 'dist');
const ssrEntry = path.join(appRoot, 'dist-ssr', 'entry-server.js');

const SITE_ORIGIN = 'https://docs.lumibase.dev';

/** Escape a string for safe insertion into an HTML attribute. */
function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Cloudflare Pages 308-redirects every route to its trailing-slash form
 * (e.g. /en/docs/getting-started → /en/docs/getting-started/). Canonical,
 * og:url, JSON-LD url and sitemap <loc> must all point at that final URL,
 * not the redirecting one, or crawlers see a canonical that 308s away.
 */
function withTrailingSlash(urlPath) {
  return urlPath.endsWith('/') ? urlPath : `${urlPath}/`;
}

/** Escape a string for safe insertion into XML text content. */
function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Build the per-page <head> tags injected before </head>. */
function buildHead({ title, description, url, lastModified }) {
  const fullTitle = `${title} — LumiBase Docs`;
  const canonical = `${SITE_ORIGIN}${withTrailingSlash(url)}`;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: title,
    description,
    url: canonical,
    ...(lastModified ? { dateModified: lastModified } : {}),
    publisher: {
      '@type': 'Organization',
      name: 'LumiBase',
      url: 'https://lumibase.dev',
    },
    isPartOf: {
      '@type': 'WebSite',
      name: 'LumiBase Docs',
      url: SITE_ORIGIN,
    },
  };

  return [
    `<meta name="description" content="${escapeAttr(description)}" />`,
    `<link rel="canonical" href="${escapeAttr(canonical)}" />`,
    `<meta property="og:type" content="article" />`,
    `<meta property="og:title" content="${escapeAttr(fullTitle)}" />`,
    `<meta property="og:description" content="${escapeAttr(description)}" />`,
    `<meta property="og:url" content="${escapeAttr(canonical)}" />`,
    `<meta name="twitter:card" content="summary" />`,
    `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`,
  ].join('\n    ');
}

/** Write a prerendered file to dist/, creating parent dirs. urlPath is the
 * route (e.g. /en/docs/foo/ or /); "" / "/" map to dist/index.html. */
function writeHtml(urlPath, html) {
  const rel = urlPath.replace(/^\//, '');
  const outDir = rel === '' ? distDir : path.join(distDir, rel);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'index.html'), html, 'utf-8');
}

/**
 * Inline "visually hidden but accessible" style — keeps content in the DOM
 * (and accessibility tree) for crawlers and screen readers, while never
 * painting it for sighted users. Inline (not a CSS class) so it applies
 * immediately at first paint, before the stylesheet or JS bundle loads —
 * this is required here because the client route for `/` and `/:locale`
 * is an immediate <Navigate> redirect (see src/routes.tsx), so this static
 * markup never matches the hydrated tree and would otherwise flash as
 * unstyled visible content until hydration replaces it.
 */
const VISUALLY_HIDDEN_STYLE =
  'position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;';

/**
 * Build a crawlable landing page: a plain <a> link list to every doc in the
 * locale. No client JS is needed for a bot to follow these into the
 * prerendered doc pages — this is the link graph the SPA <Navigate> hid.
 * Visually hidden for sighted users (see VISUALLY_HIDDEN_STYLE) since the
 * client immediately redirects away from this route.
 */
function buildIndexBody({ locale, pages }) {
  const heading = locale === 'en' ? 'LumiBase Documentation' : 'Tài liệu LumiBase';
  const items = pages
    .map(
      (p) =>
        `<li><a href="${escapeAttr(withTrailingSlash(p.url))}">${escapeAttr(p.title)}</a></li>`,
    )
    .join('\n      ');
  return `<main style="${VISUALLY_HIDDEN_STYLE}">
    <h1>${escapeAttr(heading)}</h1>
    <ul>
      ${items}
    </ul>
  </main>`;
}

/** Head tags for a locale landing page (self-canonical, index type). */
function buildIndexHead({ locale, url }) {
  const canonical = `${SITE_ORIGIN}${withTrailingSlash(url)}`;
  const title =
    locale === 'en' ? 'LumiBase Documentation' : 'Tài liệu LumiBase';
  const description =
    locale === 'en'
      ? 'Complete documentation for LumiBase — the edge-native, multi-tenant headless CMS built on Cloudflare Workers.'
      : 'Tài liệu đầy đủ cho LumiBase — headless CMS đa tenant, edge-native trên Cloudflare Workers.';
  return [
    `<meta name="description" content="${escapeAttr(description)}" />`,
    `<link rel="canonical" href="${escapeAttr(canonical)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:title" content="${escapeAttr(title)}" />`,
    `<meta property="og:description" content="${escapeAttr(description)}" />`,
    `<meta property="og:url" content="${escapeAttr(canonical)}" />`,
    `<meta name="twitter:card" content="summary" />`,
  ].join('\n    ');
}

/** Serialize all prerendered routes into a sitemap.xml string. */
function buildSitemap(entries) {
  const urls = entries
    .map(({ url, lastModified }) => {
      const loc = `${SITE_ORIGIN}${withTrailingSlash(url)}`;
      const lastmod = lastModified
        ? `\n    <lastmod>${escapeXml(lastModified)}</lastmod>`
        : '';
      return `  <url>\n    <loc>${escapeXml(loc)}</loc>${lastmod}\n  </url>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

async function main() {
  if (!fs.existsSync(ssrEntry)) {
    throw new Error(
      `SSR bundle not found at ${ssrEntry}. Run "vite build --ssr src/entry-server.tsx --outDir dist-ssr" first.`,
    );
  }

  const { render, getAllPaths, getLocaleIndexes, defaultLocale } = await import(
    pathToFileURL(ssrEntry).href
  );

  const templatePath = path.join(distDir, 'index.html');
  const template = fs.readFileSync(templatePath, 'utf-8');

  const paths = getAllPaths();
  const sitemapEntries = [];
  let written = 0;

  for (const page of paths) {
    const appHtml = await render(page.url);

    const fullTitle = `${page.title} — LumiBase Docs`;
    const html = template
      // <html lang="en"> → correct locale
      .replace(/<html lang="[^"]*">/, `<html lang="${escapeAttr(page.locale)}">`)
      // Replace placeholder title
      .replace(
        /<title>[^<]*<\/title>/,
        `<title>${escapeAttr(fullTitle)}</title>`,
      )
      // Inject per-page head tags
      .replace('</head>', `    ${buildHead(page)}\n  </head>`)
      // Inject server-rendered markup into the root container
      .replace('<div id="root"></div>', `<div id="root">${appHtml}</div>`);

    writeHtml(page.url, html);
    sitemapEntries.push({ url: page.url, lastModified: page.lastModified });
    written++;
  }

  // Locale landing pages + site root. Crawlers hit these first; each carries a
  // plain <a> link list into every prerendered doc so the corpus is reachable
  // without executing the SPA router.
  const indexes = getLocaleIndexes();
  for (const idx of indexes) {
    const fullTitle =
      idx.locale === 'en'
        ? 'LumiBase Documentation'
        : 'Tài liệu LumiBase';
    const body = buildIndexBody(idx);
    const html = template
      .replace(/<html lang="[^"]*">/, `<html lang="${escapeAttr(idx.locale)}">`)
      .replace(/<title>[^<]*<\/title>/, `<title>${escapeAttr(fullTitle)}</title>`)
      .replace('</head>', `    ${buildIndexHead(idx)}\n  </head>`)
      .replace('<div id="root"></div>', `<div id="root">${body}</div>`);

    writeHtml(idx.url, html);
    sitemapEntries.push({ url: idx.url, lastModified: idx.lastModified });
    written++;

    // The site root (/) mirrors the default locale's landing page so bots and
    // link shares hitting docs.lumibase.dev see real HTML, not the SPA shell.
    // Its canonical points at itself (/) rather than the locale page.
    if (idx.locale === defaultLocale) {
      const rootHtml = html.replace(
        /<link rel="canonical" href="[^"]*" \/>/,
        `<link rel="canonical" href="${escapeAttr(`${SITE_ORIGIN}/`)}" />`,
      );
      writeHtml('/', rootHtml);
      sitemapEntries.push({ url: '/', lastModified: idx.lastModified });
      written++;
    }
  }

  // 404.html — Cloudflare Pages serves this (with a 404 status) for any request
  // that does not match a prerendered static asset. It carries the unmodified
  // SPA shell (empty #root) so the client router boots, resolves the requested
  // URL, and renders either the real doc (client-side) or the NotFoundPage.
  //
  // This replaces the previous `/* /index.html 200` catch-all in _redirects,
  // which rewrote EVERY request to the empty index shell and thereby shadowed
  // the prerendered pages — breaking hard navigation / F5 on every doc URL.
  fs.writeFileSync(path.join(distDir, '404.html'), template, 'utf-8');
  written++;

  // sitemap.xml at the dist root, listing every prerendered HTML route.
  fs.writeFileSync(
    path.join(distDir, 'sitemap.xml'),
    buildSitemap(sitemapEntries),
    'utf-8',
  );

  console.log(
    `[prerender] Wrote ${written} static HTML pages (incl. 404.html) + sitemap.xml (${sitemapEntries.length} urls) to dist/`,
  );
}

main().catch((err) => {
  console.error('[prerender] Failed:', err);
  process.exit(1);
});
