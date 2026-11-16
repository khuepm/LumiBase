// Self-heal fixers (#756): golden before/after for EN + VI per drift class,
// provenance re-stamped only when the pair verifies, and the unfixable class
// reported instead of guessed at.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createFixtureRepo, readFixture, bodyOf, BASE_SOURCE } from './helpers/drift-fixture.mjs';
import { applyFixes } from '../docs-i18n/self-heal.mjs';
import { contentHash, splitFrontMatter, readKey } from '../docs-i18n/frontmatter.mjs';

const SERVICE = 'apps/cms/src/services/gizmo-service.ts';

const CASES = {
  'file-move': (fx) => {
    const to = path.join(fx.root, 'apps/cms/src/services/gizmos/service.ts');
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(path.join(fx.root, SERVICE), to);
  },
  'env-rename': (fx) => fx.write(SERVICE, BASE_SOURCE[SERVICE].replace('LUMIBASE_GIZMO_LIMIT', 'LUMIBASE_GIZMO_MAX')),
  'route-rename': (fx) =>
    fx.write('apps/cms/src/index.ts', BASE_SOURCE['apps/cms/src/index.ts'].replace("'/gizmos'", "'/gadgets'")),
  'symbol-rename': (fx) => fx.write(SERVICE, BASE_SOURCE[SERVICE].replace('createGizmo', 'makeGizmo')),
};

for (const [name, mutate] of Object.entries(CASES)) {
  test(`${name}: both locales rewritten to the golden output and re-stamped --verified`, () => {
    const fx = createFixtureRepo();
    try {
      mutate(fx);
      const head = fx.commit(name);
      const r = fx.run('self-heal.mjs', '--base', fx.base, '--head', head, '--json', 'out.json');
      assert.equal(r.status, 0, r.stderr);

      for (const locale of ['en', 'vi']) {
        assert.equal(
          bodyOf(fx.read(`docs/${locale}/guide.md`)),
          readFixture(`${name}.after.${locale}.md`),
          `${locale} body must match the golden file`,
        );
      }
      const report = JSON.parse(fx.read('out.json'));
      assert.deepEqual(report.changedPairs, ['guide.md']);
      assert.equal(report.unfixed.length, 0, JSON.stringify(report.unfixed));
      assert.ok(report.fixes.some((f) => f.file === 'docs/en/guide.md'));
      assert.ok(report.fixes.some((f) => f.file === 'docs/vi/guide.md'));
      assert.equal(report.provenance[0].restamped, true, report.provenance[0].note);

      // Provenance points at the healed source body, and the pair still passes
      // the structural gate and the verifier.
      const en = splitFrontMatter(fx.read('docs/en/guide.md'));
      const vi = splitFrontMatter(fx.read('docs/vi/guide.md'));
      assert.equal(readKey(vi.fmRaw, 'sourceHash'), contentHash(en.body));
      assert.equal(readKey(en.fmRaw, 'codeVerifiedHash'), contentHash(en.body));
      assert.equal(fx.run('check-parity.mjs', 'guide.md').status, 0);
      assert.equal(fx.run('verify-code-refs.mjs', 'guide.md').status, 0);

      // Idempotent: a second run has nothing to do and changes nothing.
      const before = [fx.read('docs/en/guide.md'), fx.read('docs/vi/guide.md')];
      fx.run('self-heal.mjs', '--base', fx.base, '--head', head, '--json', 'out2.json');
      assert.deepEqual(JSON.parse(fx.read('out2.json')).changedPairs, []);
      assert.deepEqual([fx.read('docs/en/guide.md'), fx.read('docs/vi/guide.md')], before);
    } finally {
      fx.cleanup();
    }
  });
}

test('a removed route is reported for a human, never rewritten', () => {
  const fx = createFixtureRepo();
  try {
    fx.write('apps/cms/src/index.ts', "import { gizmoRoutes } from './routes/gizmo-routes';\n");
    const head = fx.commit('drop route');
    const before = [fx.read('docs/en/guide.md'), fx.read('docs/vi/guide.md')];
    const r = fx.run('self-heal.mjs', '--base', fx.base, '--head', head, '--json', 'out.json', '--report', 'out.md');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual([fx.read('docs/en/guide.md'), fx.read('docs/vi/guide.md')], before);
    const report = JSON.parse(fx.read('out.json'));
    assert.deepEqual(report.changedPairs, []);
    const routes = report.unfixed.filter((u) => u.kind === 'route');
    assert.ok(routes.some((u) => u.file === 'docs/en/guide.md' && u.claim === '/api/v1/gizmos/:id'));
    assert.ok(routes.some((u) => u.file === 'docs/vi/guide.md'));
    assert.match(routes[0].cause, /route `ROUTE \/gizmos` removed from apps\/cms\/src\/index\.ts/);
    const md = fx.read('out.md');
    assert.match(md, /### Needs a human \(\d+\)/);
    assert.match(md, /<!-- self-heal-base: [0-9a-f]{40} -->/);
  } finally {
    fx.cleanup();
  }
});

test('a fix on a pair that was not in sync rewrites both sides but leaves provenance alone', () => {
  const fx = createFixtureRepo();
  try {
    // Edit the EN source without re-translating: the pair is now stale.
    fx.write('docs/en/guide.md', fx.read('docs/en/guide.md').replace('Every gizmo', 'Each gizmo'));
    CASES['env-rename'](fx);
    const head = fx.commit('stale pair + env rename');
    const viBefore = splitFrontMatter(fx.read('docs/vi/guide.md')).fmRaw;
    fx.run('self-heal.mjs', '--base', fx.base, '--head', head, '--json', 'out.json');
    const report = JSON.parse(fx.read('out.json'));
    assert.equal(report.provenance[0].restamped, false);
    assert.match(report.provenance[0].note, /not in sync/);
    assert.equal(splitFrontMatter(fx.read('docs/vi/guide.md')).fmRaw, viBefore);
    assert.match(fx.read('docs/vi/guide.md'), /LUMIBASE_GIZMO_MAX/);
  } finally {
    fx.cleanup();
  }
});

test('applyFixes: boundaries, front matter untouched, spans only for symbols', () => {
  const raw =
    '---\nnote: apps/a.ts\n---\n\n' +
    'See `apps/a.ts`, not `apps/a.tsx` or `xapps/a.ts`; link [x](../../apps/a.ts).\n' +
    '`LUMIBASE_A` vs `LUMIBASE_AB`. Route `GET /items/:id` and `/items-x`.\n' +
    'Call `oldFn()` — but oldFn in prose stays.\n```ts\noldFn();\n```\n';
  const { text, applied } = applyFixes(raw, [
    { from: 'apps/a.ts', to: 'apps/b.ts', scope: 'path' },
    { from: 'LUMIBASE_A', to: 'LUMIBASE_Z', scope: 'word' },
    { from: '/items/:id', to: '/things/:id', scope: 'route' },
    { from: 'oldFn', to: 'newFn', scope: 'span' },
  ]);
  assert.match(text, /^---\nnote: apps\/a\.ts\n---/);
  assert.match(text, /See `apps\/b\.ts`, not `apps\/a\.tsx` or `xapps\/a\.ts`; link \[x\]\(\.\.\/\.\.\/apps\/b\.ts\)/);
  assert.match(text, /`LUMIBASE_Z` vs `LUMIBASE_AB`/);
  assert.match(text, /`GET \/things\/:id` and `\/items-x`/);
  assert.match(text, /Call `newFn\(\)` — but oldFn in prose stays\.\n```ts\noldFn\(\);/);
  assert.deepEqual(applied.map((a) => a.count).sort(), [1, 1, 1, 2]);
});
