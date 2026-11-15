#!/usr/bin/env node
// Visual regression for the Storybook (#755).
//
//   capture  --static <storybook-static> --out <dir>
//       Serve a built Storybook, screenshot every story in light AND dark
//       with a fixed viewport, locale, timezone and no animations.
//   compare  --base <dir> --head <dir> --out <dir> [--summary <file>]
//       Pixel-diff two capture runs; writes diff PNGs and a Markdown summary.
//       Exit 1 when a story changed or disappeared.
//
// CI captures the PR base and head on the SAME runner (.github/workflows/
// storybook.yml), so font rasterisation and GPU differences cancel out and no
// binary baselines live in git. `pnpm test:visual` = capture into
// visual-output/current for a local look.
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { compareDirs, snapshotName, storiesFromIndex, storyUrl, summaryMarkdown, THEMES } from './visual-lib.mjs';

const VIEWPORT = { width: 800, height: 600 };
const FREEZE_CSS = `*, *::before, *::after {
  animation: none !important; transition: none !important; caret-color: transparent !important;
}`;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
};

function serve(root) {
  const server = createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    let file = path.join(root, pathname);
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function capture(staticDir, outDir) {
  const root = path.resolve(staticDir);
  const ids = storiesFromIndex(JSON.parse(readFileSync(path.join(root, 'index.json'), 'utf8')));
  const server = await serve(root);
  const { port } = server.address();
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
    colorScheme: 'light',
  });
  mkdirSync(outDir, { recursive: true });
  let count = 0;
  try {
    for (const id of ids) {
      for (const theme of THEMES) {
        const page = await context.newPage();
        await page.goto(storyUrl(`http://127.0.0.1:${port}/`, id, theme), { waitUntil: 'networkidle' });
        await page.addStyleTag({ content: FREEZE_CSS });
        await page.waitForSelector('#storybook-root > *', { state: 'attached', timeout: 15_000 });
        await page.evaluate(() => document.fonts.ready);
        // Let play functions settle (they run right after the first render).
        await page.waitForTimeout(400);
        await page.screenshot({ path: path.join(outDir, snapshotName(id, theme)), animations: 'disabled' });
        await page.close();
        count += 1;
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`[visual] captured ${count} snapshots (${ids.length} stories × ${THEMES.length} themes) → ${outDir}`);
}

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: {
    static: { type: 'string', default: 'storybook-static' },
    out: { type: 'string', default: 'visual-output/current' },
    base: { type: 'string' },
    head: { type: 'string' },
    summary: { type: 'string' },
  },
});

if (command === 'compare') {
  if (!values.base || !values.head) {
    console.error('compare needs --base and --head');
    process.exit(2);
  }
  const result = compareDirs(values.base, values.head, values.out);
  const md = summaryMarkdown(result);
  if (values.summary) writeFileSync(values.summary, md, { flag: 'a' });
  console.log(md);
  process.exit(result.changed.length > 0 || result.removed.length > 0 ? 1 : 0);
} else if (command === 'capture' || command === undefined) {
  await capture(values.static, values.out);
} else {
  console.error(`unknown command: ${command} (capture | compare)`);
  process.exit(2);
}
