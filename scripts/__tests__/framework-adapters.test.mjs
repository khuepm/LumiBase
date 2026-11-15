/**
 * Release wiring for the framework adapters (#752).
 *
 * `sync-version.mjs` and the release workflow's publish step both discover
 * packages by scanning `packages/*` for non-private manifests, so the adapters
 * ride along without a hand-kept list. These checks pin the properties that
 * discovery relies on — and that a careless edit to one adapter manifest would
 * silently break at publish time rather than in CI.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..', '..');
const read = (rel) => JSON.parse(readFileSync(path.join(root, rel), 'utf8'));
const rootVersion = read('package.json').version;

const ADAPTERS = {
  vue: { name: '@lumibase/vue', peer: 'vue', subpaths: ['.', './nuxt', './nuxt-plugin'] },
  svelte: { name: '@lumibase/svelte', peer: 'svelte', subpaths: ['.', './kit'] },
  astro: { name: '@lumibase/astro', peer: null, subpaths: ['.', './loader', './client'] },
};

for (const [dir, spec] of Object.entries(ADAPTERS)) {
  test(`${spec.name} is published and versioned with the release`, () => {
    const manifest = read(`packages/${dir}/package.json`);
    assert.equal(manifest.name, spec.name);
    assert.notEqual(manifest.private, true, 'must be public so the publish loop picks it up');
    assert.equal(manifest.version, rootVersion, 'run `pnpm version:sync`');
    assert.equal(manifest.publishConfig?.access, 'public');
    assert.deepEqual(manifest.files, ['dist']);
    assert.equal(manifest.dependencies?.['@lumibase/sdk'], 'workspace:*', 'wraps the SDK, never re-implements it');
    assert.equal(manifest.scripts?.build, 'tsup');
  });

  test(`${spec.name} exposes every source subpath in dist`, () => {
    const manifest = read(`packages/${dir}/package.json`);
    assert.deepEqual(Object.keys(manifest.exports), spec.subpaths);
    assert.deepEqual(Object.keys(manifest.publishConfig.exports), spec.subpaths);
    const tsup = readFileSync(path.join(root, `packages/${dir}/tsup.config.ts`), 'utf8');
    for (const sub of spec.subpaths) {
      const src = manifest.exports[sub];
      assert.ok(existsSync(path.join(root, 'packages', dir, src)), `${src} exists`);
      assert.ok(tsup.includes(src.replace('./', '')), `${src} is a tsup entry`);
      const out = manifest.publishConfig.exports[sub];
      assert.equal(out.import, src.replace('./src/', './dist/').replace(/\.ts$/, '.js'));
      assert.equal(out.types, src.replace('./src/', './dist/').replace(/\.ts$/, '.d.ts'));
    }
  });

  if (spec.peer) {
    test(`${spec.name} keeps ${spec.peer} as a peer dependency`, () => {
      const manifest = read(`packages/${dir}/package.json`);
      assert.ok(manifest.peerDependencies?.[spec.peer], 'framework must be a peer, not a dependency');
      assert.equal(manifest.dependencies?.[spec.peer], undefined);
    });
  }
}
