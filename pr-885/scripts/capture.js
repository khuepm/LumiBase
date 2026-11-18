// Visual captures for storybook vs iridescent landing variants.
const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'evidence');
const VARIANTS = { storybook: 'http://127.0.0.1:4101/', iridescent: 'http://127.0.0.1:4102/' };
const CHAPTERS = ['top', 'content-os', 'ai-harness', 'studio', 'mcp', 'provenance', 'runtime'];
const NO_WEBGL_INIT = `(() => {
  const orig = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    if (/^(webgl|webgl2|experimental-webgl)$/.test(type)) return null;
    return orig.call(this, type, ...rest);
  };
})();`;

const log = { runs: [] };

async function settle(page, variant, ms) {
  if (variant === 'storybook') {
    await page.waitForSelector('canvas[data-live="true"], [class*="fallback"]', { timeout: 30000 }).catch(() => {});
  }
  await page.waitForTimeout(ms);
}

async function scrollToChapter(page, id) {
  await page.evaluate((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const y = r.top + window.scrollY + Math.max(0, r.height / 2 - window.innerHeight / 2);
    window.scrollTo({ top: id === 'top' ? 0 : y, behavior: 'instant' });
  }, id);
}

async function run({ variant, name, ctxOpts = {}, launchArgs = [], init = null, chapters = CHAPTERS, wait = 1800 }) {
  const browser = await chromium.launch({ args: launchArgs });
  const context = await browser.newContext({ deviceScaleFactor: 1, ...ctxOpts });
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) => errors.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));
  await page.goto(VARIANTS[variant], { waitUntil: 'load' });
  await settle(page, variant, 2500);
  const state = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    const fb = document.querySelector('[class*="fallback"]');
    return {
      canvasLive: c ? c.getAttribute('data-live') : null,
      fallbackPresent: !!fb,
      fallbackVisible: fb ? getComputedStyle(fb).display !== 'none' : false,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      ua: navigator.userAgent,
      viewport: [innerWidth, innerHeight],
      docHeight: document.documentElement.scrollHeight,
      overflowX: document.documentElement.scrollWidth > innerWidth,
    };
  });
  const files = [];
  let i = 1;
  for (const id of chapters) {
    await scrollToChapter(page, id);
    await page.waitForTimeout(id === 'top' ? 300 : wait);
    const label = id === 'top' ? 'hero' : id;
    const f = `${variant}-${name}-${String(i).padStart(2, '0')}-${label}.jpg`;
    await page.screenshot({ path: path.join(OUT, f), type: 'jpeg', quality: 80 });
    files.push(f);
    i++;
  }
  log.runs.push({ variant, name, state, errors, files });
  console.log(variant, name, JSON.stringify(state), 'errors:', errors.length);
  await browser.close();
}

(async () => {
  const only = process.argv[2];
  const mobileCh = ['top', 'content-os', 'ai-harness', 'studio', 'provenance', 'runtime'];
  const jobs = [];
  for (const v of Object.keys(VARIANTS)) {
    jobs.push({ variant: v, name: 'desktop', ctxOpts: { viewport: { width: 1440, height: 900 } } });
    jobs.push({ variant: v, name: 'iphone13', ctxOpts: { ...devices['iPhone 13'], deviceScaleFactor: 1 }, chapters: mobileCh });
    jobs.push({ variant: v, name: 'pixel7', ctxOpts: { ...devices['Pixel 7'], deviceScaleFactor: 1 }, chapters: mobileCh });
    jobs.push({ variant: v, name: 'desktop-reduced-motion', ctxOpts: { viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' }, chapters: ['top', 'ai-harness', 'mcp'], wait: 800 });
    jobs.push({ variant: v, name: 'iphone13-reduced-motion', ctxOpts: { ...devices['iPhone 13'], deviceScaleFactor: 1, reducedMotion: 'reduce' }, chapters: ['top', 'ai-harness'], wait: 800 });
  }
  const noGl = ['--disable-webgl', '--disable-webgl2', '--disable-gpu'];
  jobs.push({ variant: 'storybook', name: 'nowebgl-desktop', launchArgs: noGl, init: NO_WEBGL_INIT, ctxOpts: { viewport: { width: 1440, height: 900 } }, chapters: ['top', 'ai-harness', 'studio', 'runtime'], wait: 800 });
  jobs.push({ variant: 'storybook', name: 'nowebgl-iphone13', launchArgs: noGl, init: NO_WEBGL_INIT, ctxOpts: { ...devices['iPhone 13'], deviceScaleFactor: 1 }, chapters: ['top', 'ai-harness', 'runtime'], wait: 800 });
  for (const j of jobs) {
    if (only && !`${j.variant}-${j.name}`.includes(only)) continue;
    try { await run(j); } catch (e) { console.error('FAILED', j.variant, j.name, e.message); log.runs.push({ variant: j.variant, name: j.name, failed: e.message }); }
  }
  fs.writeFileSync(path.join(OUT, only ? `capture-log-${only}.json` : 'capture-log.json'), JSON.stringify(log, null, 2));
})();
