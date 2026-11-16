import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkWorkspaceImports } from '../check-workspace-imports.mjs';

async function workspace(files) {
  const root = await mkdtemp(path.join(tmpdir(), 'workspace-imports-'));
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

const core = { name: '@lumibase/core', dependencies: {} };

test('this repository passes', async () => {
  const { problems, files } = await checkWorkspaceImports();
  assert.deepEqual(problems, []);
  assert.ok(files > 500, 'the scan should cover the real source tree');
});

test('accepts imports of workspace packages, including subpaths', async (t) => {
  const root = await workspace({
    'packages/core/package.json': core,
    'apps/web/package.json': { name: '@lumibase/web', dependencies: { '@lumibase/core': 'workspace:*' } },
    'apps/web/src/a.ts': "import { x } from '@lumibase/core';\nconst y = await import('@lumibase/core/sub/path');\nimport 'hono';\n",
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual((await checkWorkspaceImports(root)).problems, []);
});

test('rejects an import of a package that is not in the workspace', async (t) => {
  const root = await workspace({
    'packages/core/package.json': core,
    'packages/core/src/a.ts': "export {};\n\nimport { y } from '@lumibase/elsewhere/thing';\n",
    'packages/core/src/b.cjs': "const z = require('@lumibase/elsewhere');\n",
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const { problems } = await checkWorkspaceImports(root);
  assert.equal(problems.length, 2);
  assert.match(problems.join('\n'), /packages\/core\/src\/a\.ts:3: imports "@lumibase\/elsewhere"/);
});

test('rejects a scoped dependency that is absent or not on the workspace protocol', async (t) => {
  const root = await workspace({
    'packages/core/package.json': core,
    'apps/web/package.json': {
      name: '@lumibase/web',
      dependencies: { '@lumibase/core': '^2.0.0' },
      devDependencies: { '@lumibase/elsewhere': 'workspace:*' },
    },
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const { problems } = await checkWorkspaceImports(root);
  assert.equal(problems.length, 2);
  assert.match(problems.join('\n'), /must use the workspace: protocol/);
  assert.match(problems.join('\n'), /"@lumibase\/elsewhere"\] is not a package in this workspace/);
});

test('skips directories the workspace file excludes, and build output', async (t) => {
  const root = await workspace({
    'pnpm-workspace.yaml': 'packages:\n  - "apps/*"\n  - "!apps/standalone"\n  - "packages/*"\n',
    'packages/core/package.json': core,
    'packages/core/dist/a.js': "require('@lumibase/elsewhere');\n",
    'apps/standalone/package.json': { name: 'standalone' },
    'apps/standalone/src/a.ts': "import '@lumibase/elsewhere';\n",
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual((await checkWorkspaceImports(root)).problems, []);
});
