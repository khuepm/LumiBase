#!/usr/bin/env node
/**
 * Cross-origin browser e2e for the preview bridge (epic #667 — V03 #681, V05 #683).
 *
 * Three real origins on localhost (different ports):
 *   STUDIO  frames FRONT in a sandboxed iframe and speaks the protocol;
 *   FRONT   runs `enableVisualEditing` with STUDIO as its only allowed origin;
 *   EVIL    also frames FRONT and tries to drive it.
 *
 * Asserts, per browser engine: handshake, field patch applied as text (never
 * HTML), click-to-focus reaches the Studio, and every message from EVIL is
 * dropped and reported. Runs Chromium, and WebKit when its Playwright build is
 * installed (`npx playwright install webkit`); a missing engine is reported as
 * skipped, never as passed.
 *
 * Usage: node packages/visual-editing/e2e/bridge.e2e.mjs
 */
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { build } = require('esbuild');
let playwright;
try {
  playwright = require('playwright');
} catch {
  console.error('playwright is not installed; cannot run the browser e2e.');
  process.exit(1);
}

const bundle = (
  await build({
    entryPoints: [resolve(here, '../src/index.ts')],
    bundle: true,
    format: 'iife',
    globalName: 'LumibaseVE',
    platform: 'browser',
    target: 'es2020',
    write: false,
    logLevel: 'silent',
  })
).outputFiles[0].text;

const PORTS = { studio: 4701, front: 4702, evil: 4703 };
const origin = (name) => `http://127.0.0.1:${PORTS[name]}`;

const pages = {
  studio: `<!doctype html><meta charset="utf-8"><script>${bundle}</script>
<iframe id="f" sandbox="allow-scripts allow-same-origin allow-forms" referrerpolicy="no-referrer"
  src="${origin('front')}/front.html?__preview=1" style="width:600px;height:400px"></iframe>
<script>
  const P = LumibaseVE; const frame = document.getElementById('f'); window.events = [];
  window.addEventListener('message', (e) => {
    const r = P.acceptPreviewMessage('to-studio', e, { allowedOrigins: ['${origin('front')}'], expectedSource: frame.contentWindow });
    if (!r.ok) { window.events.push({ rejected: r.reason }); return; }
    window.events.push(r.message);
    if (r.message.type === 'ready') frame.contentWindow.postMessage(P.previewMessage({ type: 'hello' }), '${origin('front')}');
  });
  window.sendPatch = (title) => frame.contentWindow.postMessage(
    P.previewMessage({ type: 'patch', seq: 1, collection: 'posts', itemId: 'itm_1', fields: { title } }), '${origin('front')}');
</script>`,
  front: `<!doctype html><meta charset="utf-8"><script>${bundle}</script>
<h1 id="t" data-lumibase-field="posts/itm_1/title" data-lumibase-live="text">Original</h1>
<script>
  window.rejections = []; window.reloads = 0;
  LumibaseVE.enableVisualEditing({
    studioOrigins: ['${origin('studio')}'],
    onReject: (reason, from) => window.rejections.push({ reason, from }),
    onReload: () => { window.reloads += 1; },
  });
</script>`,
  evil: `<!doctype html><meta charset="utf-8"><script>${bundle}</script>
<iframe id="f" src="${origin('front')}/front.html?__preview=1"></iframe>
<script>
  window.attack = () => {
    const w = document.getElementById('f').contentWindow; const P = LumibaseVE;
    w.postMessage(P.previewMessage({ type: 'hello' }), '*');
    w.postMessage(P.previewMessage({ type: 'reload' }), '*');
    w.postMessage(P.previewMessage({ type: 'patch', seq: 1, collection: 'posts', itemId: 'itm_1', fields: { title: 'pwned' } }), '*');
  };
</script>`,
};

const servers = Object.entries(PORTS).map(([name, port]) =>
  createServer((req, res) => {
    const headers = { 'content-type': 'text/html; charset=utf-8' };
    // The frontend allows only the Studio (and, for the attack test, the evil
    // page — a misconfigured site) to frame it; the bridge must still refuse.
    if (name === 'front') headers['content-security-policy'] = `frame-ancestors ${origin('studio')} ${origin('evil')}`;
    res.writeHead(200, headers);
    res.end(pages[name]);
  }).listen(port, '127.0.0.1'),
);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (engine, label, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} [${engine}] ${label}`);
  if (!ok) failures += 1;
};

for (const engine of ['chromium', 'webkit']) {
  let browser;
  try {
    browser = await playwright[engine].launch();
  } catch (err) {
    console.log(`skip [${engine}] browser not installed (${String(err.message).split('\n')[0]})`);
    continue;
  }
  try {
    const page = await browser.newPage();
    await page.goto(`${origin('studio')}/`);
    await page.waitForFunction(() => window.events.some((e) => e.type === 'ready'), null, { timeout: 10_000 });
    check(engine, 'frontend announces ready to the Studio origin', true);

    const front = page.frameLocator('#f');
    await page.evaluate(() => window.sendPatch('<b>Live</b> edit'));
    await front.locator('#t').filter({ hasText: '<b>Live</b> edit' }).waitFor({ timeout: 5_000 });
    const bold = await front.locator('#t b').count();
    check(engine, 'patch applied as text, not HTML', bold === 0);

    await front.locator('#t').click();
    await page.waitForFunction(() => window.events.some((e) => e.type === 'focus'), null, { timeout: 5_000 });
    const focus = await page.evaluate(() => window.events.find((e) => e.type === 'focus'));
    check(engine, 'click focuses the field in the Studio', focus?.target?.field === 'title' && focus?.target?.itemId === 'itm_1');

    const evil = await browser.newPage();
    await evil.goto(`${origin('evil')}/`);
    const evilFrame = evil.frames().find((f) => f.url().startsWith(origin('front')));
    await evilFrame.waitForFunction(() => typeof window.rejections !== 'undefined');
    await evil.evaluate(() => window.attack());
    await wait(500);
    const state = await evilFrame.evaluate(() => ({
      rejections: window.rejections,
      reloads: window.reloads,
      title: document.getElementById('t').textContent,
    }));
    check(engine, 'messages from a non-allowlisted origin are dropped', state.reloads === 0 && state.title === 'Original');
    check(
      engine,
      'dropped messages are reported (logged)',
      state.rejections.length >= 3 && state.rejections.every((r) => r.reason === 'origin' && r.from === origin('evil')),
    );
  } catch (err) {
    check(engine, `unexpected error: ${err.message}`, false);
  } finally {
    await browser.close();
  }
}

for (const s of servers) s.close();
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('bridge e2e passed');
