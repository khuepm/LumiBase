// Changed source files -> the docs that cite them (#756), plus the pure
// extractors the drift classes are built from. No git needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapChangesToDocs,
  extractExports,
  extractRoutes,
  extractEnvNames,
  pairRenames,
  pairRouteRenames,
  spanIdentifier,
  followMoves,
} from '../docs-i18n/code-drift.mjs';
import { extractClaims } from '../docs-i18n/verify-code-refs.mjs';

const emptyChange = () => ({ changed: [], touched: new Set(), env: [], routes: [], symbols: [], moved: new Map(), deleted: new Set() });

function change(partial) {
  const cs = { ...emptyChange(), ...partial };
  for (const c of cs.changed) {
    cs.touched.add(c.path);
    if (c.from) cs.touched.add(c.from);
  }
  return cs;
}

const doc = (rel, raw, locale = 'en') => ({ rel, locale, raw });

test('a doc citing a changed file by repo-rooted path is affected; unrelated docs are not', () => {
  const cs = change({ changed: [{ status: 'M', path: 'apps/cms/src/middleware/auth.ts' }] });
  const got = mapChangesToDocs(
    [doc('a.md', 'See `apps/cms/src/middleware/auth.ts`.'), doc('b.md', 'See `apps/cms/src/middleware/cors.ts`.')],
    cs,
  );
  assert.deepEqual([...got.keys()], ['a.md']);
  assert.deepEqual(got.get('a.md'), ['cites changed file apps/cms/src/middleware/auth.ts']);
});

test('a relative file claim resolves through the verifier bases', () => {
  const cs = change({ changed: [{ status: 'D', path: 'apps/cms/src/middleware/auth.ts' }] });
  const got = mapChangesToDocs([doc('a.md', 'The `middleware/auth.ts` file.')], cs);
  assert.ok(got.has('a.md'));
});

test('renames count on the OLD path: a moved file still maps to the docs citing it', () => {
  const cs = change({ changed: [{ status: 'R', from: 'packages/x/src/old.ts', path: 'packages/x/src/new.ts' }] });
  assert.ok(mapChangesToDocs([doc('a.md', '`packages/x/src/old.ts`')], cs).has('a.md'));
});

test('changed docs map to their pair rel, from either locale', () => {
  const cs = change({ changed: [{ status: 'M', path: 'docs/vi/features/x.md' }, { status: 'A', path: 'README.md' }] });
  assert.deepEqual([...mapChangesToDocs([], cs).keys()], ['features/x.md']);
});

test('env vars, route segments and symbols removed by the change map to the docs naming them', () => {
  const cs = change({
    env: [{ file: 'apps/cms/src/env.ts', name: 'LUMIBASE_OLD', to: null }],
    routes: [{ file: 'apps/cms/src/index.ts', segment: 'gizmos', to: 'gadgets', fromRoute: 'ROUTE /gizmos', toRoute: 'ROUTE /gadgets' }],
    symbols: [{ file: 'apps/cms/src/s.ts', headFile: 'apps/cms/src/s.ts', name: 'parseThing', to: null }],
  });
  const got = mapChangesToDocs(
    [
      doc('env.md', 'Set `LUMIBASE_OLD`.'),
      doc('route.md', 'Call `GET /api/v1/gizmos/:id`.'),
      doc('sym.md', 'Use `parseThing()` from `apps/cms/src/s.ts`.'),
      // Names the symbol but does not cite the file: a bare identifier is too
      // generic to assert, so this doc is NOT mapped.
      doc('sym-uncited.md', 'Use `parseThing()`.'),
    ],
    cs,
  );
  assert.deepEqual([...got.keys()].sort(), ['env.md', 'route.md', 'sym.md']);
  assert.match(got.get('route.md')[0], /segment "gizmos" removed from apps\/cms\/src\/index\.ts/);
  assert.match(got.get('sym.md').at(-1), /names parseThing, an export removed from apps\/cms\/src\/s\.ts/);
});

test('claims carry every line they occur on, offsets survive stripped output fences', () => {
  const raw = '# T\n\n```text\n`apps/x.ts`\n```\n\nSee `apps/a.ts`.\n\nAgain `apps/a.ts`.\n';
  const [c] = extractClaims(raw);
  assert.equal(c.claim, 'apps/a.ts');
  assert.deepEqual(c.lines, [7, 9]);
});

test('extractors', () => {
  assert.deepEqual(
    [...extractExports('export const a = 1\nexport async function b() {}\nexport { c, d as e, type F }\nexport default 1\nexport class K {}')].sort(),
    ['F', 'K', 'a', 'b', 'c', 'e'],
  );
  assert.deepEqual([...extractRoutes("app.route('/hooks', h)\nr.get('/:id', x)\nr.post(\"/a/b\", y)")], ['ROUTE /hooks', 'GET /:id', 'POST /a/b']);
  assert.deepEqual([...extractEnvNames('process.env.LUMIBASE_FOO; env.JWT_SECRET; XLUMIBASE_BAR; HOME')], ['LUMIBASE_FOO', 'JWT_SECRET']);
  assert.equal(spanIdentifier('fooBar()'), 'fooBar');
  assert.equal(spanIdentifier('Foo<T>'), 'Foo');
  assert.equal(spanIdentifier('foo.bar'), null);
});

test('renames are only paired when unambiguous', () => {
  assert.deepEqual(pairRenames(['A'], ['B']), [['A', 'B']]);
  assert.deepEqual(pairRenames(['A', 'C'], ['B', 'D']), []);
  assert.deepEqual(pairRenames(['A'], []), []);
  assert.deepEqual(pairRouteRenames(['GET /a/x'], ['GET /a/y']).map((r) => [r.from, r.to]), [['x', 'y']]);
  assert.deepEqual(pairRouteRenames(['GET /a/x'], ['GET /a/y', 'GET /a/z']), [], 'two candidates: ambiguous');
  assert.deepEqual(pairRouteRenames(['GET /a/x'], ['POST /a/y']), [], 'method differs');
  assert.deepEqual(pairRouteRenames(['GET /a/:id'], ['GET /a/:key']), [], 'params are not literals');
});

test('followMoves chains renames to a path that exists', () => {
  const tree = { exists: (p) => p === 'c.ts' };
  assert.equal(followMoves('a.ts', [['a.ts', 'b.ts'], ['b.ts', 'c.ts']], tree), 'c.ts');
  assert.equal(followMoves('z.ts', [['a.ts', 'b.ts']], tree), null);
});
