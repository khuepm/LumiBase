#!/usr/bin/env node
// Fail when the docs site navigation points at a page that does not exist.
//
// WHY THIS EXISTS
// ---------------
// `apps/docs/docs.config.json` curates the sidebar, navbar and footer by slug.
// The sidebar builder (`buildSidebarTreeFromConfig` in
// `apps/docs/src/lib/site-config.ts`) resolves each slug against the discovered
// doc set and, when it finds nothing, **drops the entry**:
//
//     const entry = localeIndex[slug] ?? defaultIndex[slug];
//     if (!entry) return files;          // ← silent
//
// So a typo, a renamed file or a page that was never written costs you a nav
// entry with no error, no warning and a green build. Measured on `main` at
// 6717182b: six sidebar entries resolved to nothing (three `architecture/*`,
// `api/openapi`, and both `guides/*`, which left the whole "Guides" category
// rendering empty), and `tutorials/index` had been dead since the loader
// started collapsing `index.md` to its parent slug. The navbar was worse than
// silent — its `to` values are hrefs, not slugs, so `/docs/api` shipped as a
// real 404 on docs.lumibase.dev (verified 2026-09-15) while `/docs/tutorials/index`
// only survived via a Cloudflare 308.
//
// This is the same class as the other guards in this directory (registry
// numbering, override drift, changed-doc parity): a declaration that reads
// correctly but produces nothing. Backlog entry B66.
//
// SLUG RULE — keep in sync with the loader
// ----------------------------------------
// `deriveSlug` below mirrors `apps/docs/src/plugins/vite-plugin-docs-loader.ts`.
// A trailing lowercase `index` segment collapses to the parent directory
// (`cli/index.md` → `cli`) because Cloudflare Pages 308-redirects
// `…/cli/index` to `…/cli/`. A top-level `index.md` keeps its literal slug.
//
// Usage:  node scripts/check-docs-nav.mjs
// Exit:   0 = every nav target resolves · 1 = at least one does not

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const CONFIG_PATH = path.join(REPO_ROOT, 'apps', 'docs', 'docs.config.json');
const DOCS_ROOT = path.join(REPO_ROOT, 'docs');

/** Mirror of the docs loader's slug derivation. */
export function deriveSlug(relativePath) {
  const withoutExt = relativePath.replace(/\.md$/, '').split(path.sep).join('/');
  const collapsed = withoutExt.replace(/(^|\/)index$/, '');
  return collapsed === '' ? withoutExt : collapsed;
}

/** Every slug discoverable under one locale directory. */
export function discoverSlugs(localeDir) {
  const slugs = new Set();
  if (!fs.existsSync(localeDir)) return slugs;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md'))
        slugs.add(deriveSlug(path.relative(localeDir, full)));
    }
  };
  walk(localeDir);
  return slugs;
}

/**
 * Problems in a config, given the slugs available per locale.
 *
 * Resolution mirrors the sidebar builder: a slug counts as present when ANY
 * configured locale has it, because the builder falls back to the default
 * locale for pages that are not translated yet.
 *
 * Pure, so the negative cases are testable without touching the real tree.
 */
export function findNavProblems(config, slugsByLocale) {
  const problems = [];
  const known = new Set();
  for (const slugs of Object.values(slugsByLocale))
    for (const slug of slugs) known.add(slug);

  for (const category of config.sidebar?.docs ?? []) {
    const resolved = (category.items ?? []).filter((slug) => {
      if (known.has(slug)) return true;
      problems.push(
        `sidebar category "${category.label}" lists "${slug}" — no docs/<locale>/${slug}.md (or ${slug}/index.md) exists, so the entry is dropped from the nav`,
      );
      return false;
    });
    if ((category.items ?? []).length > 0 && resolved.length === 0)
      problems.push(
        `sidebar category "${category.label}" renders empty — every item it lists is missing`,
      );
  }

  const linkTargets = [
    ...(config.navbar?.items ?? []).map((item) => ['navbar', item]),
    ...(config.footer?.links ?? []).flatMap((column) =>
      (column.items ?? []).map((item) => [`footer "${column.title}"`, item]),
    ),
  ];
  for (const [where, item] of linkTargets) {
    const to = item?.to;
    if (typeof to !== 'string' || !to.startsWith('/docs/')) continue;
    const slug = to.slice('/docs/'.length);
    if (!known.has(slug))
      problems.push(
        `${where} link "${typeof item.label === 'string' ? item.label : slug}" points at ${to} — no such page, so it is a 404 on the deployed site`,
      );
  }

  return problems;
}

function main() {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const locales = config.i18n?.locales ?? ['en'];
  const slugsByLocale = Object.fromEntries(
    locales.map((locale) => [locale, discoverSlugs(path.join(DOCS_ROOT, locale))]),
  );

  const counts = locales
    .map((locale) => `${locale}=${slugsByLocale[locale].size}`)
    .join(' ');
  const problems = findNavProblems(config, slugsByLocale);

  if (problems.length > 0) {
    console.error(`[check-docs-nav] ${problems.length} problem(s) — pages ${counts}`);
    for (const problem of problems) console.error(`  ✖ ${problem}`);
    console.error(
      '\nFix the slug, write the missing page, or remove the entry. Do not leave it:\n' +
        'the nav drops unresolved sidebar entries silently, and navbar/footer links 404.',
    );
    process.exit(1);
  }

  console.log(`[check-docs-nav] every nav target resolves — pages ${counts}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)))
  main();
