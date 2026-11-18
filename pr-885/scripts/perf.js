// Performance measurements: storybook vs iridescent landing (static export, local server).
// Usage: node perf.js <config> <runs>   config: desktop | desktop-cpu4x | pixel7-cpu4x
const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'evidence');
const VARIANTS = {
  storybook: { url: 'http://127.0.0.1:4101/', dir: path.join(ROOT, 'storybook/apps/landing/out') },
  iridescent: { url: 'http://127.0.0.1:4102/', dir: path.join(ROOT, 'iridescent/apps/landing/out') },
};
const CONFIGS = {
  desktop: { ctx: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }, cpu: 1 },
  'desktop-cpu4x': { ctx: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }, cpu: 4 },
  'pixel7-cpu4x': { ctx: { ...devices['Pixel 7'] }, cpu: 4 },
  'desktop-reduced-motion': { ctx: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce' }, cpu: 1 },
};

const INIT = `(() => {
  const P = window.__perf = { lcp: 0, fcp: 0, longtasks: [], canvasLive: null };
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) P.lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') P.fcp = e.startTime; }).observe({ type: 'paint', buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) P.longtasks.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true });
  } catch (e) { P.err = String(e); }
  const watch = () => {
    const mo = new MutationObserver(() => {
      if (P.canvasLive === null && document.querySelector('canvas[data-live="true"]')) { P.canvasLive = performance.now(); mo.disconnect(); }
    });
    mo.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['data-live'], childList: true });
  };
  if (document.documentElement) watch(); else document.addEventListener('readystatechange', watch, { once: true });
  window.__frames = (ms) => new Promise((res) => {
    const out = []; let last = -1; const end = performance.now() + ms;
    const f = (t) => { if (last >= 0) out.push(t - last); last = t; if (t < end) requestAnimationFrame(f); else res(out); };
    requestAnimationFrame(f);
  });
  window.__scrollFrames = (ms) => new Promise((res) => {
    const out = []; let last = -1; let start = -1;
    const max = document.documentElement.scrollHeight - innerHeight;
    const f = (t) => {
      if (start < 0) start = t;
      if (last >= 0) out.push(t - last); last = t;
      const p = Math.min(1, (t - start) / ms);
      window.scrollTo(0, p * max);
      if (p < 1) requestAnimationFrame(f); else res(out);
    };
    requestAnimationFrame(f);
  });
})();`;

const gzCache = new Map();
function gzSize(dir, url) {
  if (gzCache.has(url)) return gzCache.get(url);
  let p = decodeURIComponent(new URL(url).pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(dir, p);
  let v = null;
  try { v = zlib.gzipSync(fs.readFileSync(f), { level: 6 }).length; } catch {}
  gzCache.set(url, v);
  return v;
}

const tbt = (tasks, from, to) => tasks.filter(([s]) => s >= from && s < to).reduce((a, [, d]) => a + Math.max(0, d - 50), 0);
const frameStats = (iv) => {
  const s = [...iv].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return {
    n: s.length,
    median: +q(0.5).toFixed(2),
    p95: +q(0.95).toFixed(2),
    max: +s[s.length - 1].toFixed(2),
    over16_7: +(100 * s.filter((x) => x > 17.5).length / s.length).toFixed(1), // 17.5 ms tolerates 60 Hz vsync jitter
    over33: +(100 * s.filter((x) => x > 34).length / s.length).toFixed(1),
    fps: +(1000 * s.length / s.reduce((a, b) => a + b, 0)).toFixed(1),
  };
};

async function once(variantName, cfgName) {
  const v = VARIANTS[variantName];
  const cfg = CONFIGS[cfgName];
  const browser = await chromium.launch();
  const ctx = await browser.newContext(cfg.ctx);
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  if (cfg.cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cfg.cpu });
  const reqs = new Map();
  const errors = [];
  cdp.on('Network.responseReceived', (e) => reqs.set(e.requestId, { url: e.response.url, type: e.type, bytes: 0, done: false }));
  cdp.on('Network.loadingFinished', (e) => { const r = reqs.get(e.requestId); if (r) { r.bytes = e.encodedDataLength; r.done = true; } });
  cdp.on('Network.loadingFailed', (e) => { const r = reqs.get(e.requestId); if (r) r.failed = e.errorText; });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  await page.goto(v.url, { waitUntil: 'load', timeout: 120000 });
  // Wait for the scene's first frame (storybook) or a fixed settle window.
  if (variantName === 'storybook') await page.waitForFunction(() => window.__perf.canvasLive !== null, null, { timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType('navigation')[0];
    return { ttfb: n.responseStart, dcl: n.domContentLoadedEventEnd, load: n.loadEventEnd, perf: JSON.parse(JSON.stringify(window.__perf)), now: performance.now() };
  });
  const loadWindowEnd = nav.now;
  const idle = await page.evaluate(() => window.__frames(5000));
  const scrollStart = await page.evaluate(() => performance.now());
  const scroll = await page.evaluate(() => window.__scrollFrames(10000));
  const after = await page.evaluate(() => ({ lt: window.__perf.longtasks, now: performance.now() }));
  await browser.close();

  const list = [...reqs.values()].filter((r) => !r.url.startsWith('data:'));
  const js = list.filter((r) => r.type === 'Script');
  const sum = (a) => a.reduce((x, r) => x + (r.bytes || 0), 0);
  const gz = (a) => a.reduce((x, r) => x + (gzSize(v.dir, r.url) ?? r.bytes ?? 0), 0);
  const external = list.filter((r) => !r.url.startsWith('http://127.0.0.1'));
  const p = nav.perf;
  return {
    ttfb: nav.ttfb, dcl: nav.dcl, load: nav.load, fcp: p.fcp, lcp: p.lcp,
    canvasLive: p.canvasLive,
    requests: list.length,
    bytesTransferred: sum(list), bytesGzipEst: gz(list),
    jsRequests: js.length, jsBytes: sum(js), jsGzipEst: gz(js),
    external: external.map((r) => ({ url: r.url, type: r.type, bytes: r.bytes, failed: r.failed })),
    longtasksLoad: after.lt.filter(([s]) => s < loadWindowEnd).length,
    tbtLoad: tbt(after.lt, 0, loadWindowEnd),
    longestTaskLoad: Math.max(0, ...after.lt.filter(([s]) => s < loadWindowEnd).map(([, d]) => d)),
    longtasksScroll: after.lt.filter(([s]) => s >= scrollStart).length,
    tbtScroll: tbt(after.lt, scrollStart, Infinity),
    idleFrames: frameStats(idle), scrollFrames: frameStats(scroll),
    rawIdle: idle.map((x) => +x.toFixed(2)), rawScroll: scroll.map((x) => +x.toFixed(2)),
    errors,
  };
}

const median = (a) => { const s = a.filter((x) => x != null).sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

(async () => {
  const cfgName = process.argv[2] || 'desktop';
  const runs = +(process.argv[3] || 5);
  const result = { config: cfgName, runs, startedAt: new Date().toISOString(), variants: {} };
  for (let i = 0; i < runs; i++) {
    for (const vn of Object.keys(VARIANTS)) { // interleave variants to spread machine noise
      const r = await once(vn, cfgName);
      (result.variants[vn] ??= { runs: [] }).runs.push(r);
      console.log(cfgName, vn, i, JSON.stringify({ fcp: r.fcp, lcp: r.lcp, live: r.canvasLive, tbt: r.tbtLoad, idle: r.idleFrames.median, scroll: r.scrollFrames.median, req: r.requests }));
    }
  }
  const keys = ['ttfb', 'dcl', 'load', 'fcp', 'lcp', 'canvasLive', 'requests', 'bytesTransferred', 'bytesGzipEst', 'jsRequests', 'jsBytes', 'jsGzipEst', 'longtasksLoad', 'tbtLoad', 'longestTaskLoad', 'longtasksScroll', 'tbtScroll'];
  const fkeys = ['median', 'p95', 'max', 'over16_7', 'over33', 'fps'];
  for (const [vn, v] of Object.entries(result.variants)) {
    v.median = {};
    for (const k of keys) v.median[k] = median(v.runs.map((r) => r[k]));
    for (const ph of ['idleFrames', 'scrollFrames']) { v.median[ph] = {}; for (const k of fkeys) v.median[ph][k] = median(v.runs.map((r) => r[ph][k])); }
  }
  fs.writeFileSync(path.join(OUT, `metrics-${cfgName}.json`), JSON.stringify(result, null, 1));
  console.log(JSON.stringify(Object.fromEntries(Object.entries(result.variants).map(([k, v]) => [k, v.median])), null, 1));
})();
