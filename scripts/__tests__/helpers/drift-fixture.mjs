// Fixture git repository for the doc/code drift tooling (#756).
//
// Copies scripts/docs-i18n into a throwaway repo (the scripts resolve REPO_ROOT
// from their own location), seeds a tiny source tree plus the golden EN/VI
// docs, stamps the pair --verified and commits that as the base. Tests then
// mutate the source, commit a head, and run the real CLIs against it. Nothing
// ever writes into the real docs tree.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

export const FIXTURES = new URL('../fixtures/self-heal/', import.meta.url);
export const readFixture = (name) => fs.readFileSync(new URL(name, FIXTURES), 'utf8');

export const BASE_SOURCE = {
  'apps/cms/src/services/gizmo-service.ts':
    'export function createGizmo(siteId: string) {\n' +
    '  const limit = Number(process.env.LUMIBASE_GIZMO_LIMIT ?? 100);\n' +
    '  return { siteId, limit };\n' +
    '}\n',
  'apps/cms/src/index.ts':
    "import { gizmoRoutes } from './routes/gizmo-routes';\n" +
    "app.route('/gizmos', gizmoRoutes);\n",
  'apps/cms/src/routes/gizmo-routes.ts': "export const gizmoRoutes = new Hono().get('/:id', (c) => c.json({ data: null }));\n",
};

export function createFixtureRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-drift-'));
  fs.cpSync(new URL('../../docs-i18n/', import.meta.url), path.join(root, 'scripts/docs-i18n'), { recursive: true });
  const env = { ...process.env };
  delete env.DOCS_ROOT;
  delete env.GITHUB_STEP_SUMMARY;
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const run = (script, ...args) =>
    spawnSync(process.execPath, [path.join(root, 'scripts/docs-i18n', script), ...args], {
      cwd: root,
      env,
      encoding: 'utf8',
    });
  const commit = (msg) => {
    git('add', '-A');
    git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', msg);
    return git('rev-parse', 'HEAD').trim();
  };

  git('init', '-q', '-b', 'main');
  for (const [rel, text] of Object.entries(BASE_SOURCE)) write(rel, text);
  write('docs/en/guide.md', readFixture('before.en.md'));
  write('docs/vi/guide.md', readFixture('before.vi.md'));
  const stamp = run('stamp-pair.mjs', 'guide.md', 'en', '--verified');
  if (stamp.status !== 0) throw new Error(`fixture stamp failed: ${stamp.stderr}${stamp.stdout}`);
  const base = commit('base');

  return {
    root,
    base,
    git,
    write,
    read,
    run,
    commit,
    remove: (rel) => fs.rmSync(path.join(root, rel)),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/** Body of a doc with its front matter removed. */
export function bodyOf(raw) {
  return raw.replace(/^---\n[\s\S]*?\n---\n\n?/, '');
}
