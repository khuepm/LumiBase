/**
 * RTL layout e2e (#761): renders key Studio screens with the UI language set
 * to Arabic and asserts the page is mirrored and nothing overflows or
 * overlaps. Saves a screenshot per screen as a CI artifact.
 *
 * No CMS is needed: the script serves the Studio with Vite and answers every
 * `/api/**` request from the fixtures below (Playwright `page.route`), so the
 * job runs on any runner with Chromium.
 *
 * Usage (from apps/studio):
 *   node e2e/rtl-layout.e2e.mjs                 # Arabic (default)
 *   RTL_E2E_LANG=he node e2e/rtl-layout.e2e.mjs
 *   RTL_E2E_OUT=/tmp/shots node e2e/rtl-layout.e2e.mjs
 *
 * Playwright is resolved with `require`, so a global install (NODE_PATH) or
 * a local one both work; this repo does not pin it as a dependency.
 */
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const studioRoot = path.resolve(here, '..');
const LANG = process.env.RTL_E2E_LANG ?? 'ar';
const OUT = path.resolve(process.env.RTL_E2E_OUT ?? path.join(studioRoot, 'e2e', 'artifacts'));
const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'mobile', width: 390, height: 844 },
];

// ── API fixtures ────────────────────────────────────────────────────────────
const now = '2026-01-01T00:00:00.000Z';
const FIELDS = [
  { id: 'f_title', collection: 'posts', name: 'title', label: 'العنوان', type: 'string', interface: 'input', sort: 1, required: true, meta: {} },
  { id: 'f_summary', collection: 'posts', name: 'summary', label: 'الملخص', type: 'json', interface: 'translatable-text', sort: 2, meta: {} },
  { id: 'f_body', collection: 'posts', name: 'body', label: 'المحتوى', type: 'text', interface: 'input-multiline', sort: 3, meta: {} },
  { id: 'f_featured', collection: 'posts', name: 'featured', label: 'مميز', type: 'boolean', interface: 'boolean', sort: 4, meta: {} },
];
const ITEM = {
  id: 'item_1',
  collection: 'posts',
  status: 'draft',
  data: {
    title: 'مرحبا بالعالم — Hello world',
    summary: { en: 'A short summary', ar: 'ملخص قصير للمقال' },
    body: 'هذا نص تجريبي طويل لاختبار اتجاه الكتابة من اليمين إلى اليسار في محرر المحتوى.',
    featured: true,
  },
  createdAt: now,
  updatedAt: now,
  version: 1,
};
const COLLECTIONS = [
  { name: 'posts', label: 'المقالات', icon: 'file-text', singleton: false, fields: FIELDS, meta: {}, createdAt: now, updatedAt: now },
  { name: 'authors', label: 'الكتّاب', icon: 'users', singleton: false, fields: [], meta: {}, createdAt: now, updatedAt: now },
];

function fakeJwt() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'user_1', siteId: 'site_e2e', exp: 4102444800 })}.sig`;
}

/** Answer for one API path; `null` → generic empty `{ data: [] }`. */
function fixture(pathname, method) {
  const p = pathname.replace(/\/+$/, '');
  if (p.endsWith('/me/preferences')) return { data: { language: LANG } };
  if (p.endsWith('/me/permissions') || p.endsWith('/permissions/me'))
    return { data: { admin: true, isAdmin: true, permissions: [], policies: [] } };
  if (/\/(auth\/)?me$/.test(p)) return { data: { id: 'user_1', email: 'e2e@example.test', name: 'مدير', role: 'admin', isAdmin: true } };
  if (/\/site(\/config)?$/.test(p)) return { data: { displayTitle: 'LumiBase', defaultLanguage: LANG } };
  if (p.endsWith('/settings/locales')) return { data: { key: 'locales', value: { supported: ['en', LANG] } } };
  if (p.endsWith('/translations')) return { data: [], meta: { total: 0 } };
  if (/\/collections$/.test(p)) return { data: COLLECTIONS, meta: { total: COLLECTIONS.length } };
  if (/\/collections\/posts$/.test(p)) return { data: COLLECTIONS[0] };
  if (/\/fields\/posts$|\/collections\/posts\/fields$/.test(p)) return { data: FIELDS };
  if (/\/items\/posts\/item_1$/.test(p)) return { data: ITEM };
  if (/\/items\/posts$/.test(p)) return method === 'GET' ? { data: [ITEM], meta: { total: 1, page: 1, limit: 25 } } : { data: ITEM };
  if (/\/setup\/state$/.test(p)) return { state: 'initialized', requiresSetupToken: false };
  return null;
}

// ── Layout assertions ───────────────────────────────────────────────────────
/** Runs in the page: returns a list of human-readable layout problems. */
function layoutProblems() {
  const problems = [];
  const doc = document.documentElement;
  if (doc.getAttribute('dir') !== 'rtl') problems.push(`<html dir> is "${doc.getAttribute('dir')}", expected "rtl"`);
  // 1. No horizontal page overflow (the classic RTL bug: content pushed off the left edge).
  const overflow = Math.max(doc.scrollWidth, document.body.scrollWidth) - doc.clientWidth;
  if (overflow > 1) problems.push(`page overflows horizontally by ${overflow}px`);

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0;
  };
  const label = (el) =>
    `${el.tagName.toLowerCase()}${el.getAttribute('aria-label') ? `[${el.getAttribute('aria-label')}]` : ''} "${(el.textContent ?? '').trim().slice(0, 30)}"`;

  // 2. Interactive controls sit inside the viewport horizontally (nothing clipped off-screen),
  //    unless they live in a horizontally scrollable container.
  const controls = [...document.querySelectorAll('button, a[href], input, select, textarea, [role="button"]')].filter(visible);
  const scrollsX = (el) => {
    for (let n = el.parentElement; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      if ((s.overflowX === 'auto' || s.overflowX === 'scroll' || s.overflowX === 'hidden') && n.scrollWidth > n.clientWidth) return true;
    }
    return false;
  };
  for (const el of controls) {
    const r = el.getBoundingClientRect();
    if ((r.left < -1 || r.right > doc.clientWidth + 1) && !scrollsX(el)) problems.push(`${label(el)} is outside the viewport (${Math.round(r.left)}→${Math.round(r.right)})`);
  }

  // 3. Sibling controls in the same row do not overlap each other.
  const byParent = new Map();
  for (const el of controls) {
    const parent = el.parentElement;
    if (!parent) continue;
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(el);
  }
  for (const siblings of byParent.values()) {
    for (let i = 0; i < siblings.length; i++) {
      for (let j = i + 1; j < siblings.length; j++) {
        const a = siblings[i].getBoundingClientRect();
        const b = siblings[j].getBoundingClientRect();
        const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (x > 2 && y > 2) problems.push(`${label(siblings[i])} overlaps ${label(siblings[j])} (${Math.round(x)}×${Math.round(y)}px)`);
      }
    }
  }

  // 4. Absolutely-positioned icons inside inputs (search, password toggle) do not cover the text:
  //    the input's inline-start padding must clear an icon placed at its start, and vice versa.
  for (const input of document.querySelectorAll('input')) {
    if (!visible(input)) continue;
    const wrap = input.parentElement;
    if (!wrap || getComputedStyle(wrap).position !== 'relative') continue;
    const ir = input.getBoundingClientRect();
    const cs = getComputedStyle(input);
    const padLeft = parseFloat(cs.paddingLeft);
    const padRight = parseFloat(cs.paddingRight);
    for (const icon of wrap.children) {
      if (icon === input || getComputedStyle(icon).position !== 'absolute' || !visible(icon)) continue;
      const r = icon.getBoundingClientRect();
      if (r.top > ir.bottom || r.bottom < ir.top) continue;
      const coversLeft = r.right > ir.left + padLeft + 1 && r.left < ir.left + ir.width / 2;
      const coversRight = r.left < ir.right - padRight - 1 && r.right > ir.left + ir.width / 2;
      if (coversLeft || coversRight) problems.push(`${label(icon)} covers the text area of input[${input.getAttribute('aria-label') ?? input.name ?? ''}]`);
    }
  }
  return problems;
}

// ── Screens ─────────────────────────────────────────────────────────────────
const SCREENS = [
  { name: 'login', path: '/admin/login', signedIn: false, ready: 'input' },
  { name: 'collections-list', path: '/content/posts', signedIn: true, ready: 'main' },
  { name: 'item-editor', path: '/content/posts/item_1', signedIn: true, ready: 'main textarea, main input' },
  { name: 'settings', path: '/settings/site', signedIn: true, ready: 'main form' },
];

async function startStudio() {
  const { createServer } = await import(require.resolve('vite', { paths: [studioRoot] }));
  const server = await createServer({
    root: studioRoot,
    configFile: path.join(studioRoot, 'vite.config.ts'),
    logLevel: 'warn',
    server: { port: 0, host: '127.0.0.1', strictPort: false, hmr: false },
  });
  await server.listen();
  const address = server.httpServer?.address();
  const port = typeof address === 'object' && address ? address.port : 2026;
  return { server, origin: `http://127.0.0.1:${port}` };
}

async function main() {
  const { chromium } = require('playwright');
  await mkdir(OUT, { recursive: true });
  const { server, origin } = await startStudio();
  const browser = await chromium.launch();
  const failures = [];
  const unknownApi = new Set();
  try {
    for (const viewport of VIEWPORTS) {
      for (const screen of SCREENS) {
        const context = await browser.newContext({ viewport, locale: LANG });
        const token = fakeJwt();
        await context.addInitScript(
          ({ lang, token, signedIn }) => {
            localStorage.setItem('lumibase.ui-language', lang);
            if (signedIn) localStorage.setItem('lumibase.dev.token', token);
          },
          { lang: LANG, token, signedIn: screen.signedIn },
        );
        await context.route('**/api/**', async (route) => {
          const url = new URL(route.request().url());
          const body = fixture(url.pathname, route.request().method());
          if (!body) unknownApi.add(`${route.request().method()} ${url.pathname}`);
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body ?? { data: [] }) });
        });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(`${origin}${screen.path}`, { waitUntil: 'load' });
        await page.waitForSelector(screen.ready, { timeout: 20_000 }).catch(() => errors.push(`"${screen.ready}" never rendered`));
        await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
        await page.waitForTimeout(300); // let late layout settle (fonts, lazy panels)
        const file = path.join(OUT, `${LANG}-${screen.name}-${viewport.name}.png`);
        await page.screenshot({ path: file, fullPage: true });
        const problems = [...errors, ...(await page.evaluate(layoutProblems))];
        const tag = `${screen.name} @ ${viewport.name}`;
        if (problems.length) failures.push({ tag, problems });
        console.log(`${problems.length ? 'FAIL' : 'ok  '} ${tag} → ${path.relative(process.cwd(), file)}`);
        for (const p of problems) console.log(`       - ${p}`);
        await context.close();
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }
  if ((process.env.RTL_E2E_DEBUG || failures.length) && unknownApi.size) console.log(`unmocked API calls:\n  ${[...unknownApi].join('\n  ')}`);
  if (failures.length) {
    console.error(`\nRTL layout e2e: ${failures.length} screen(s) with problems.`);
    process.exit(1);
  }
  console.log(`\nRTL layout e2e: ${SCREENS.length * VIEWPORTS.length} screen(s) clean in "${LANG}".`);
}

await main();
