/**
 * Studio bundle budget (#757).
 *
 * Reads the Vite manifest of a Studio build and fails when the INITIAL payload
 * — the HTML entry chunk plus every chunk it reaches through static imports,
 * and the CSS those chunks pull in — exceeds the budget in
 * `apps/studio/bundle-budget.json`. Lazy chunks (anything reached only through
 * a dynamic `import()`) are not counted against the initial budget; they are
 * listed in the table so a regression that moves weight around is still
 * visible.
 *
 * The budget is compared against gzip bytes (what the browser actually
 * downloads from a CDN that compresses on the fly). Raw and brotli sizes are
 * printed for context.
 *
 * Usage:
 *   pnpm -F @lumibase/studio exec vite build --manifest
 *   node scripts/check-studio-bundle-budget.mjs [--dist apps/studio/dist] [--budget apps/studio/bundle-budget.json] [--top 15]
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';

/**
 * Walk the manifest from every `isEntry` chunk through static `imports` only.
 * Returns the set of output file names (JS + CSS) that load before first paint.
 *
 * @param {Record<string, { file: string; isEntry?: boolean; imports?: string[]; css?: string[] }>} manifest
 * @returns {{ js: string[]; css: string[] }}
 */
export function collectInitialFiles(manifest) {
  const js = new Set();
  const css = new Set();
  const seen = new Set();
  const stack = Object.keys(manifest).filter((k) => manifest[k]?.isEntry);
  if (stack.length === 0) throw new Error('manifest has no entry chunk (isEntry) — is this a Vite build manifest?');
  while (stack.length > 0) {
    const key = stack.pop();
    if (seen.has(key)) continue;
    seen.add(key);
    const chunk = manifest[key];
    if (!chunk) throw new Error(`manifest references unknown chunk "${key}"`);
    if (chunk.file.endsWith('.js')) js.add(chunk.file);
    else if (chunk.file.endsWith('.css')) css.add(chunk.file);
    for (const c of chunk.css ?? []) css.add(c);
    for (const imp of chunk.imports ?? []) stack.push(imp);
  }
  return { js: [...js].sort(), css: [...css].sort() };
}

/** All JS chunk files in the manifest, de-duplicated. */
export function collectAllJsFiles(manifest) {
  return [...new Set(Object.values(manifest).map((c) => c.file).filter((f) => f.endsWith('.js')))].sort();
}

/**
 * @param {Buffer | string} content
 * @returns {{ raw: number; gzip: number; brotli: number }}
 */
export function measure(content) {
  const buf = typeof content === 'string' ? Buffer.from(content) : content;
  return {
    raw: buf.length,
    gzip: gzipSync(buf, { level: 9 }).length,
    brotli: brotliCompressSync(buf, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 } }).length,
  };
}

/** @param {Array<{ raw: number; gzip: number; brotli: number }>} sizes */
export function sum(sizes) {
  return sizes.reduce((a, s) => ({ raw: a.raw + s.raw, gzip: a.gzip + s.gzip, brotli: a.brotli + s.brotli }), { raw: 0, gzip: 0, brotli: 0 });
}

/**
 * Compare totals with the budget. Every key present in the budget is enforced;
 * a missing or non-positive limit is a configuration error (fail closed).
 *
 * @param {{ js: { gzip: number }; css: { gzip: number } }} totals
 * @param {{ initialJsGzipBytes: number; initialCssGzipBytes: number }} budget
 * @returns {Array<{ metric: string; actual: number; limit: number }>} violations
 */
export function evaluateBudget(totals, budget) {
  const checks = [
    ['initialJsGzipBytes', totals.js.gzip],
    ['initialCssGzipBytes', totals.css.gzip],
  ];
  const violations = [];
  for (const [metric, actual] of checks) {
    const limit = budget?.[metric];
    if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
      throw new Error(`bundle budget is missing a positive "${metric}"`);
    }
    if (actual > limit) violations.push({ metric, actual, limit });
  }
  return violations;
}

export function kb(n) {
  return `${(n / 1024).toFixed(1)} kB`;
}

/**
 * @param {Array<{ file: string; initial: boolean; raw: number; gzip: number; brotli: number }>} rows
 * @param {number} top
 */
export function formatTable(rows, top) {
  const sorted = [...rows].sort((a, b) => b.gzip - a.gzip).slice(0, top);
  const header = ['chunk', 'load', 'raw', 'gzip', 'brotli'];
  const body = sorted.map((r) => [r.file, r.initial ? 'initial' : 'lazy', kb(r.raw), kb(r.gzip), kb(r.brotli)]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  const line = (cells) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
  return [line(header), widths.map((w) => '-'.repeat(w)).join('  '), ...body.map(line)].join('\n');
}

function parseArgs(argv) {
  const args = { dist: 'apps/studio/dist', budget: 'apps/studio/bundle-budget.json', top: 15 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dist') args.dist = argv[++i];
    else if (a === '--budget') args.budget = argv[++i];
    else if (a === '--top') args.top = Number(argv[++i]);
  }
  return args;
}

export function run(argv = process.argv.slice(2), cwd = process.cwd(), log = console.log, err = console.error) {
  const args = parseArgs(argv);
  const dist = path.resolve(cwd, args.dist);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path.join(dist, '.vite/manifest.json'), 'utf8'));
  } catch {
    err(`Studio bundle budget: ${path.join(args.dist, '.vite/manifest.json')} not found.\n  Build with a manifest first: pnpm -F @lumibase/studio exec vite build --manifest`);
    return 1;
  }
  const budget = JSON.parse(readFileSync(path.resolve(cwd, args.budget), 'utf8'));
  const initial = collectInitialFiles(manifest);
  const initialSet = new Set([...initial.js, ...initial.css]);
  const size = (f) => measure(readFileSync(path.join(dist, f)));

  const jsRows = collectAllJsFiles(manifest).map((file) => ({ file, initial: initialSet.has(file), ...size(file) }));
  const totals = {
    js: sum(jsRows.filter((r) => r.initial)),
    css: sum(initial.css.map(size)),
    lazyJs: sum(jsRows.filter((r) => !r.initial)),
  };

  log(formatTable(jsRows, args.top));
  log('');
  log(`initial JS  (${initial.js.length} files): raw ${kb(totals.js.raw)} | gzip ${kb(totals.js.gzip)} | brotli ${kb(totals.js.brotli)}  — budget gzip ${kb(budget.initialJsGzipBytes)}`);
  log(`initial CSS (${initial.css.length} files): raw ${kb(totals.css.raw)} | gzip ${kb(totals.css.gzip)} | brotli ${kb(totals.css.brotli)}  — budget gzip ${kb(budget.initialCssGzipBytes)}`);
  log(`lazy JS     (${jsRows.length - initial.js.length} files): raw ${kb(totals.lazyJs.raw)} | gzip ${kb(totals.lazyJs.gzip)}`);

  const violations = evaluateBudget(totals, budget);
  if (violations.length > 0) {
    err('\nStudio bundle budget exceeded:');
    for (const v of violations) err(`- ${v.metric}: ${v.actual} bytes > ${v.limit} bytes (+${v.actual - v.limit})`);
    err('\nMove the new weight behind a route/component boundary (React.lazy + Suspense), or raise the budget in\napps/studio/bundle-budget.json with a reason in the PR — see docs/en/contributing/studio-performance.md.');
    return 1;
  }
  log('\nStudio bundle budget: OK');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(run());
}
