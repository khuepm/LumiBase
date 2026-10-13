/**
 * Tripwire for the docs-nav guard.
 *
 * A guard that is always green cannot be told apart from a guard that does not
 * work, so these cases are the real incidents it was written for (B66), all
 * measured on `main` at 6717182b:
 *
 *  - `tutorials/index` in the sidebar, dead since the loader started collapsing
 *    `index.md` to its parent slug — the Tutorials category rendered without
 *    its own index page and nobody noticed.
 *  - `guides/backup-recovery` + `guides/tooling-recommendations`, neither of
 *    which was ever written, leaving the whole "Guides" category empty.
 *  - navbar `/docs/api`, a plain 404 on docs.lumibase.dev.
 *
 * Uses `node --test` for the same reason as the other guards here: it runs from
 * `pnpm check:all` and must not depend on the app's toolchain.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  deriveSlug,
  discoverSlugs,
  findNavProblems,
} from '../check-docs-nav.mjs';

/** Config shaped like docs.config.json, with only the parts the guard reads. */
function config({ sidebar = [], navbar = [], footer = [] } = {}) {
  return {
    i18n: { defaultLocale: 'en', locales: ['en', 'vi'] },
    navbar: { items: navbar },
    sidebar: { docs: sidebar },
    footer: { links: footer },
  };
}

const present = (...slugs) => ({ en: new Set(slugs), vi: new Set() });

test('deriveSlug collapses a directory index the way the loader does', () => {
  assert.equal(deriveSlug('cli/index.md'), 'cli');
  assert.equal(deriveSlug('sdk/javascript.md'), 'sdk/javascript');
  assert.equal(deriveSlug('getting-started.md'), 'getting-started');
  // A top-level index.md would collapse to '' — it keeps a routable slug.
  assert.equal(deriveSlug('index.md'), 'index');
  // Case-sensitive on purpose: `Index.md` is served as its own page.
  assert.equal(deriveSlug('sdk/Index.md'), 'sdk/Index');
});

test('a sidebar entry written as <dir>/index is reported, not silently dropped', () => {
  const problems = findNavProblems(
    config({
      sidebar: [
        { label: 'Tutorials', items: ['tutorials/index', 'tutorials/nextjs-quickstart'] },
      ],
    }),
    present('tutorials', 'tutorials/nextjs-quickstart'),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /tutorials\/index/);
});

test('the same entry passes once it names the collapsed slug', () => {
  const problems = findNavProblems(
    config({ sidebar: [{ label: 'Tutorials', items: ['tutorials'] }] }),
    present('tutorials'),
  );
  assert.deepEqual(problems, []);
});

test('a category whose every item is missing is reported twice: items and emptiness', () => {
  const problems = findNavProblems(
    config({
      sidebar: [
        {
          label: 'Guides',
          items: ['guides/backup-recovery', 'guides/tooling-recommendations'],
        },
      ],
    }),
    present('getting-started'),
  );
  assert.equal(problems.length, 3);
  assert.ok(problems.some((p) => /renders empty/.test(p)));
});

test('a navbar link to a page that does not exist is reported as a 404', () => {
  const problems = findNavProblems(
    config({ navbar: [{ label: 'API', to: '/docs/api' }] }),
    present('api/hono-api-spec'),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /navbar link "API" points at \/docs\/api/);
});

test('footer links are checked too, and named by their column', () => {
  const problems = findNavProblems(
    config({
      footer: [
        { title: 'Docs', items: [{ label: 'Getting Started', to: '/docs/getting-startd' }] },
      ],
    }),
    present('getting-started'),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /footer "Docs"/);
});

test('external and non-docs links are left alone', () => {
  const problems = findNavProblems(
    config({
      navbar: [
        { label: 'GitHub', href: 'https://github.com/khuepm/lumibase' },
        { label: 'Home', to: '/' },
      ],
    }),
    present(),
  );
  assert.deepEqual(problems, []);
});

test('a page that exists in only one locale still resolves', () => {
  // The sidebar builder falls back to the default locale, so a VI-only or
  // EN-only page must not be reported as missing.
  const problems = findNavProblems(
    config({ sidebar: [{ label: 'Getting Started', items: ['getting-started'] }] }),
    { en: new Set(), vi: new Set(['getting-started']) },
  );
  assert.deepEqual(problems, []);
});

test('discoverSlugs walks a real tree and applies the index rule', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-nav-'));
  try {
    fs.mkdirSync(path.join(root, 'cli'), { recursive: true });
    fs.writeFileSync(path.join(root, 'getting-started.md'), '# x');
    fs.writeFileSync(path.join(root, 'cli', 'index.md'), '# x');
    fs.writeFileSync(path.join(root, 'cli', 'notes.txt'), 'ignored');
    const slugs = discoverSlugs(root);
    assert.deepEqual([...slugs].sort(), ['cli', 'getting-started']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a missing locale directory yields no slugs rather than throwing', () => {
  assert.equal(discoverSlugs(path.join(os.tmpdir(), 'docs-nav-absent-dir')).size, 0);
});
