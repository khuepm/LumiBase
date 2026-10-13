import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Copy the CLI into an isolated repository: stamp-pair resolves paths from its
// own location. No fixture may write into the real docs tree.
function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-drift-'));
  fs.cpSync(new URL('../docs-i18n/', import.meta.url), path.join(root, 'scripts/docs-i18n'), { recursive: true });
  const en = path.join(root, 'docs/en/example.md');
  const vi = path.join(root, 'docs/vi/example.md');
  fs.mkdirSync(path.dirname(en), { recursive: true });
  fs.mkdirSync(path.dirname(vi), { recursive: true });
  fs.writeFileSync(en, '# Example\n\n## Extra section\n');
  fs.writeFileSync(vi, '# Ví dụ\n');
  const env = { ...process.env, DOCS_ROOT: path.join(root, 'docs') };
  const run = (script, ...args) => spawnSync(process.execPath,
    [path.join(root, 'scripts/docs-i18n', script), ...args], { env, encoding: 'utf8' });
  try { fn({ en, vi, run }); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('drift opt-in survives later parity and normal stamps without duplicate waivers', () => fixture(({ vi, run }) => {
  assert.equal(run('stamp-pair.mjs', 'example.md', 'en', '--allow-structure-drift').status, 0);
  const stamped = fs.readFileSync(vi, 'utf8');
  assert.match(stamped, /<!-- check-parity: allow headings -->/);
  assert.match(stamped, /Recorded by stamp-pair --allow-structure-drift on /);
  assert.equal(run('check-parity.mjs', 'example.md').status, 0);
  assert.equal(run('stamp-pair.mjs', 'example.md', 'en', '--allow-structure-drift').status, 0);
  assert.equal(run('stamp-pair.mjs', 'example.md', 'en').status, 0);
  assert.equal(fs.readFileSync(vi, 'utf8'), stamped);
  fs.appendFileSync(vi, '\n[unexpected](./other.md)\n');
  assert.equal(run('check-parity.mjs', 'example.md').status, 1, 'new link drift must still fail');
}));

test('refusals never persist a waiver or partially stamp a pair', () => fixture(({ en, vi, run }) => {
  const before = [en, vi].map(p => fs.readFileSync(p, 'utf8'));
  assert.equal(run('stamp-pair.mjs', 'example.md', 'en').status, 6);
  assert.notEqual(run('stamp-pair.mjs', 'example.md', 'en', '--allow-structure-drift', '--verified').status, 0);
  assert.deepEqual([en, vi].map(p => fs.readFileSync(p, 'utf8')), before);
}));
