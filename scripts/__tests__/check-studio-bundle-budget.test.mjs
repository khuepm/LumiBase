/**
 * Studio bundle budget (#757): the initial-graph walk, the budget verdict and
 * the end-to-end CLI against a synthetic `dist/` with a Vite manifest.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  collectAllJsFiles,
  collectInitialFiles,
  evaluateBudget,
  formatTable,
  measure,
  run,
} from '../check-studio-bundle-budget.mjs';

const MANIFEST = {
  'index.html': {
    file: 'assets/index-a.js',
    isEntry: true,
    imports: ['_vendor-b.js', '_shared-c.js'],
    dynamicImports: ['src/heavy.tsx'],
    css: ['assets/index-a.css'],
  },
  '_vendor-b.js': { file: 'assets/vendor-b.js', imports: ['_shared-c.js'] },
  '_shared-c.js': { file: 'assets/shared-c.js' },
  'src/heavy.tsx': {
    file: 'assets/heavy-d.js',
    isDynamicEntry: true,
    imports: ['_shared-c.js', '_monaco-e.js'],
    css: ['assets/heavy-d.css'],
  },
  '_monaco-e.js': { file: 'assets/monaco-e.js' },
};

test('initial graph = entry + transitive static imports, never dynamic imports', () => {
  const { js, css } = collectInitialFiles(MANIFEST);
  assert.deepEqual(js, ['assets/index-a.js', 'assets/shared-c.js', 'assets/vendor-b.js']);
  assert.deepEqual(css, ['assets/index-a.css']);
});

test('a chunk that is only reachable dynamically stays lazy even when it imports shared chunks', () => {
  const { js } = collectInitialFiles(MANIFEST);
  assert.ok(!js.includes('assets/heavy-d.js'));
  assert.ok(!js.includes('assets/monaco-e.js'));
});

test('static import cycles terminate', () => {
  const cyclic = {
    'index.html': { file: 'assets/a.js', isEntry: true, imports: ['_b.js'] },
    '_b.js': { file: 'assets/b.js', imports: ['index.html'] },
  };
  assert.deepEqual(collectInitialFiles(cyclic).js, ['assets/a.js', 'assets/b.js']);
});

test('a manifest without an entry, or with a dangling import, fails loudly', () => {
  assert.throws(() => collectInitialFiles({ x: { file: 'a.js' } }), /no entry chunk/);
  assert.throws(
    () => collectInitialFiles({ 'index.html': { file: 'a.js', isEntry: true, imports: ['_gone.js'] } }),
    /unknown chunk "_gone.js"/,
  );
});

test('collectAllJsFiles lists every JS chunk once', () => {
  assert.deepEqual(collectAllJsFiles(MANIFEST), [
    'assets/heavy-d.js',
    'assets/index-a.js',
    'assets/monaco-e.js',
    'assets/shared-c.js',
    'assets/vendor-b.js',
  ]);
});

test('measure reports raw, gzip and brotli sizes; compressible input shrinks', () => {
  const s = measure('a'.repeat(10_000));
  assert.equal(s.raw, 10_000);
  assert.ok(s.gzip < 200 && s.brotli < 200);
});

test('evaluateBudget passes at the limit and flags each metric over it', () => {
  const budget = { initialJsGzipBytes: 100, initialCssGzipBytes: 10 };
  assert.deepEqual(evaluateBudget({ js: { gzip: 100 }, css: { gzip: 10 } }, budget), []);
  assert.deepEqual(evaluateBudget({ js: { gzip: 101 }, css: { gzip: 11 } }, budget), [
    { metric: 'initialJsGzipBytes', actual: 101, limit: 100 },
    { metric: 'initialCssGzipBytes', actual: 11, limit: 10 },
  ]);
});

test('evaluateBudget fails closed on a missing or non-positive limit', () => {
  assert.throws(() => evaluateBudget({ js: { gzip: 1 }, css: { gzip: 1 } }, { initialCssGzipBytes: 10 }), /initialJsGzipBytes/);
  assert.throws(
    () => evaluateBudget({ js: { gzip: 1 }, css: { gzip: 1 } }, { initialJsGzipBytes: 0, initialCssGzipBytes: 10 }),
    /initialJsGzipBytes/,
  );
});

test('formatTable sorts by gzip size, labels initial/lazy and honours top', () => {
  const table = formatTable(
    [
      { file: 'small.js', initial: true, raw: 10, gzip: 5, brotli: 4 },
      { file: 'big.js', initial: false, raw: 9000, gzip: 3000, brotli: 2500 },
      { file: 'mid.js', initial: true, raw: 900, gzip: 300, brotli: 250 },
    ],
    2,
  );
  const lines = table.split('\n');
  assert.equal(lines.length, 4); // header + rule + 2 rows
  assert.match(lines[2], /^big\.js\s+lazy/);
  assert.match(lines[3], /^mid\.js\s+initial/);
});

function fixture(budget) {
  const dir = mkdtempSync(path.join(tmpdir(), 'studio-budget-'));
  const dist = path.join(dir, 'dist');
  mkdirSync(path.join(dist, '.vite'), { recursive: true });
  mkdirSync(path.join(dist, 'assets'), { recursive: true });
  writeFileSync(path.join(dist, '.vite/manifest.json'), JSON.stringify(MANIFEST));
  const pseudoRandom = (n) => Array.from({ length: n }, (_, i) => ((i * 7919) % 251).toString(36)).join('');
  for (const f of ['index-a.js', 'vendor-b.js', 'shared-c.js', 'heavy-d.js', 'monaco-e.js']) {
    writeFileSync(path.join(dist, 'assets', f), f === 'monaco-e.js' ? pseudoRandom(50_000) : pseudoRandom(500));
  }
  writeFileSync(path.join(dist, 'assets/index-a.css'), 'body{color:red}');
  writeFileSync(path.join(dist, 'assets/heavy-d.css'), 'p{}');
  writeFileSync(path.join(dir, 'budget.json'), JSON.stringify(budget));
  return dir;
}

function capture(fn) {
  const out = [];
  const err = [];
  const code = fn((l) => out.push(l), (l) => err.push(l));
  return { code, out: out.join('\n'), err: err.join('\n') };
}

test('CLI passes when the initial graph fits, even though a lazy chunk is huge', () => {
  const dir = fixture({ initialJsGzipBytes: 50_000, initialCssGzipBytes: 1_000 });
  try {
    const r = capture((log, err) => run(['--dist', 'dist', '--budget', 'budget.json'], dir, log, err));
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /assets\/monaco-e\.js\s+lazy/);
    assert.match(r.out, /initial JS\s+\(3 files\)/);
    assert.match(r.out, /Studio bundle budget: OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI fails with a non-zero exit when the initial JS exceeds the budget', () => {
  const dir = fixture({ initialJsGzipBytes: 10, initialCssGzipBytes: 1_000 });
  try {
    const r = capture((log, err) => run(['--dist', 'dist', '--budget', 'budget.json'], dir, log, err));
    assert.equal(r.code, 1);
    assert.match(r.err, /initialJsGzipBytes: \d+ bytes > 10 bytes/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI fails when the build has no manifest', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'studio-budget-'));
  try {
    const r = capture((log, err) => run(['--dist', 'dist'], dir, log, err));
    assert.equal(r.code, 1);
    assert.match(r.err, /vite build --manifest/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
