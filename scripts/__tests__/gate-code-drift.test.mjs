// Doc/code drift PR gate (#756). Acceptance: a stale claim introduced in a PR
// fails CI with a pointer (doc path:line, the claim, what changed) rendered as a
// GitHub annotation; pre-existing drift warns but does not fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createFixtureRepo, BASE_SOURCE } from './helpers/drift-fixture.mjs';
import { annotation, escapeData, escapeProperty } from '../docs-i18n/gate-code-drift.mjs';

const lineOf = (text, needle) => text.split('\n').findIndex((l) => l.includes(needle)) + 1;

test('a route removed by the PR fails with an ::error pointing at every doc line, in both locales', () => {
  const fx = createFixtureRepo();
  try {
    fx.write('apps/cms/src/index.ts', "import { gizmoRoutes } from './routes/gizmo-routes';\n");
    const head = fx.commit('drop route');
    const r = fx.run('gate-code-drift.mjs', '--base', fx.base, '--head', head);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    for (const locale of ['en', 'vi']) {
      const doc = fx.read(`docs/${locale}/guide.md`);
      const line = lineOf(doc, 'GET /api/v1/gizmos/:id');
      assert.ok(
        r.stdout.includes(
          `::error file=docs/${locale}/guide.md,line=${line},title=Stale doc claim (route)::` +
            '[route] /api/v1/gizmos/:id — no mount found for "gizmos"',
        ),
        r.stdout,
      );
    }
    assert.match(r.stdout, /Cause: route `ROUTE \/gizmos` removed from apps\/cms\/src\/index\.ts\. No mechanical fix/);
    assert.match(r.stderr, /docs\/en\/guide\.md:\d+ +\[route\]/);
  } finally {
    fx.cleanup();
  }
});

test('a stale claim introduced by editing a doc fails even with no code change', () => {
  const fx = createFixtureRepo();
  try {
    for (const locale of ['en', 'vi']) {
      fx.write(`docs/${locale}/guide.md`, fx.read(`docs/${locale}/guide.md`) + '\nSee `apps/cms/src/services/nope.ts`.\n');
    }
    const head = fx.commit('doc typo');
    const r = fx.run('gate-code-drift.mjs', '--base', fx.base, '--head', head);
    assert.equal(r.status, 1);
    const line = lineOf(fx.read('docs/en/guide.md'), 'nope.ts');
    assert.match(r.stdout, new RegExp(`::error file=docs/en/guide\\.md,line=${line},.*\\[file\\] apps/cms/src/services/nope\\.ts — file does not exist\\. Cause: file does not exist`));
  } finally {
    fx.cleanup();
  }
});

test('a mechanical rename fails with the cause and the exact replacement', () => {
  const fx = createFixtureRepo();
  try {
    const svc = 'apps/cms/src/services/gizmo-service.ts';
    fx.write(svc, BASE_SOURCE[svc].replace('LUMIBASE_GIZMO_LIMIT', 'LUMIBASE_GIZMO_MAX'));
    const head = fx.commit('rename env');
    const r = fx.run('gate-code-drift.mjs', '--base', fx.base, '--head', head, '--json', 'gate.json');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /Cause: env var renamed to `LUMIBASE_GIZMO_MAX` in apps\/cms\/src\/services\/gizmo-service\.ts\. Mechanical fix available/);
    const json = JSON.parse(fx.read('gate.json'));
    assert.ok(json.affected['guide.md'].some((w) => w.includes('LUMIBASE_GIZMO_LIMIT')));
    // The verifier asserts env names written as code spans; the pointer is that line.
    const en = json.introduced.find((e) => e.file === 'docs/en/guide.md' && e.kind === 'env');
    assert.equal(en.line, lineOf(fx.read('docs/en/guide.md'), '`LUMIBASE_GIZMO_LIMIT`'));
    assert.equal(en.fixTo, 'LUMIBASE_GIZMO_MAX');
  } finally {
    fx.cleanup();
  }
});

test('a symbol renamed in a file the doc cites is caught; a file move is followed', () => {
  const fx = createFixtureRepo();
  try {
    const svc = 'apps/cms/src/services/gizmo-service.ts';
    fx.write(svc, BASE_SOURCE[svc].replace('createGizmo', 'makeGizmo'));
    const head = fx.commit('rename export');
    const r = fx.run('gate-code-drift.mjs', '--base', fx.base, '--head', head);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /\[symbol\] createGizmo — export renamed to `makeGizmo`/);
  } finally {
    fx.cleanup();
  }
  const fx2 = createFixtureRepo();
  try {
    const to = path.join(fx2.root, 'apps/cms/src/services/gizmos/service.ts');
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(path.join(fx2.root, 'apps/cms/src/services/gizmo-service.ts'), to);
    const head = fx2.commit('move');
    const r = fx2.run('gate-code-drift.mjs', '--base', fx2.base, '--head', head);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /Cause: file moved to `apps\/cms\/src\/services\/gizmos\/service\.ts` in this change/);
  } finally {
    fx2.cleanup();
  }
});

test('an unrelated change passes; drift already present at the base only warns', () => {
  const fx = createFixtureRepo();
  try {
    fx.write('apps/cms/src/other.ts', 'export const x = 1;\n');
    const clean = fx.run('gate-code-drift.mjs', '--base', fx.base, '--head', fx.commit('unrelated'));
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);
    assert.doesNotMatch(clean.stdout, /::error/);

    // Break the doc on "main", then make a PR that only touches the doc.
    fx.write('apps/cms/src/index.ts', "import { gizmoRoutes } from './routes/gizmo-routes';\n");
    const broken = fx.commit('main breaks it');
    for (const locale of ['en', 'vi']) fx.write(`docs/${locale}/guide.md`, fx.read(`docs/${locale}/guide.md`) + '\n<!-- touched -->\n');
    const r = fx.run('gate-code-drift.mjs', '--base', broken, '--head', fx.commit('doc touch'));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /::warning file=docs\/en\/guide\.md,line=\d+,title=Pre-existing stale doc claim \(route\)::/);
  } finally {
    fx.cleanup();
  }
});

test('self-heal follows a move made before --base through git rename history', () => {
  const fx = createFixtureRepo();
  try {
    const to = path.join(fx.root, 'apps/cms/src/services/gizmos/service.ts');
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(path.join(fx.root, 'apps/cms/src/services/gizmo-service.ts'), to);
    const moved = fx.commit('move, docs not updated');
    fx.write('apps/cms/src/other.ts', 'export const x = 1;\n');
    const head = fx.commit('later push');
    const r = fx.run('self-heal.mjs', '--base', moved, '--head', head, '--json', 'out.json');
    assert.equal(r.status, 0, r.stderr);
    const report = JSON.parse(fx.read('out.json'));
    assert.ok(report.fixes.some((f) => /git rename history/.test(f.cause)));
    assert.match(fx.read('docs/vi/guide.md'), /apps\/cms\/src\/services\/gizmos\/service\.ts/);
  } finally {
    fx.cleanup();
  }
});

test('annotation escaping follows the workflow-command spec', () => {
  assert.equal(escapeData('a%b\nc'), 'a%25b%0Ac');
  assert.equal(escapeProperty('a:b,c'), 'a%3Ab%2Cc');
  assert.equal(
    annotation('error', { file: 'docs/en/x.md', line: 3, title: 'T: x', message: 'm\n2' }),
    '::error file=docs/en/x.md,line=3,title=T%3A x::m%0A2',
  );
});
