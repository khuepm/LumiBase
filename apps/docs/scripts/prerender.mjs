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

/** Build the per-page <head> tags injected before </head>. */
function buildHead({ title, description, url, lastModified }) {
  const fullTitle = `${title} — Lumibase Docs`;
  const canonical = `${SITE_ORIGIN}${url}`;
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
      name: 'Lumibase Docs',
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

async function main() {
  if (!fs.existsSync(ssrEntry)) {
    throw new Error(
      `SSR bundle not found at ${ssrEntry}. Run "vite build --ssr src/entry-server.tsx --outDir dist-ssr" first.`,
    );
  }

  const { render, getAllPaths } = await import(pathToFileURL(ssrEntry).href);

  const templatePath = path.join(distDir, 'index.html');
  const template = fs.readFileSync(templatePath, 'utf-8');

  const paths = getAllPaths();
  let written = 0;

  for (const page of paths) {
    const appHtml = await render(page.url);

    const fullTitle = `${page.title} — Lumibase Docs`;
    let html = template
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

    // page.url = /en/docs/features/ai-copilot → dist/en/docs/features/ai-copilot/index.html
    const outDir = path.join(distDir, page.url.replace(/^\//, ''));
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'index.html'), html, 'utf-8');
    written++;
  }

  console.log(
    `[prerender] Wrote ${written} static HTML pages across locales to dist/`,
  );
}

main().catch((err) => {
  console.error('[prerender] Failed:', err);
  process.exit(1);
});