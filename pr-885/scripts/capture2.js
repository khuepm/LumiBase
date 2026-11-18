// Supplementary captures: mobile headings at reading position, epilogue/hero over time.
const { chromium, devices } = require('playwright');
const path = require('path');
const OUT = path.join(__dirname, 'evidence');
const URL = 'http://127.0.0.1:4101/';

(async () => {
  const browser = await chromium.launch();
  // 1. Mobile: heading at 55% of viewport (where a reader would read it).
  {
    const ctx = await browser.newContext({ ...devices['iPhone 13'], deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'load' });
    await page.waitForSelector('canvas[data-live="true"]');
    await page.waitForTimeout(2500);
    for (const id of ['content-os', 'ai-harness', 'studio', 'mcp']) {
      await page.evaluate((id) => {
        const h = document.querySelector(`#${id} h2`);
        const r = h.getBoundingClientRect();
        window.scrollTo({ top: r.top + window.scrollY - innerHeight * 0.55, behavior: 'instant' });
      }, id);
      await page.waitForTimeout(1800);
      await page.screenshot({ path: path.join(OUT, `storybook-iphone13-reading-${id}.jpg`), type: 'jpeg', quality: 80 });
    }
    await ctx.close();
  }
  // 2. Desktop: hero over time from first frame, epilogue over time after jump.
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'load' });
    await page.waitForSelector('canvas[data-live="true"]');
    const t0 = Date.now();
    for (const t of [500, 3000, 7000]) {
      await page.waitForTimeout(Math.max(0, t - (Date.now() - t0)));
      await page.screenshot({ path: path.join(OUT, `storybook-desktop-hero-t${t}ms.jpg`), type: 'jpeg', quality: 80 });
    }
    await page.evaluate(() => {
      const el = document.getElementById('runtime');
      const r = el.getBoundingClientRect();
      window.scrollTo({ top: r.top + scrollY + Math.max(0, r.height / 2 - innerHeight / 2), behavior: 'instant' });
    });
    const t1 = Date.now();
    for (const t of [2000, 6000, 10000]) {
      await page.waitForTimeout(Math.max(0, t - (Date.now() - t1)));
      await page.screenshot({ path: path.join(OUT, `storybook-desktop-epilogue-t${t}ms.jpg`), type: 'jpeg', quality: 80 });
    }
    await ctx.close();
  }
  await browser.close();
})();
