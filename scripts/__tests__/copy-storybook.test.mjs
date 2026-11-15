/**
 * The docs build publishes the static Storybook at /storybook/ (#755).
 * A missing build is skipped locally but fails a release (STORYBOOK_REQUIRED=1),
 * so the navbar's Storybook link can never ship pointing at nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyStorybook } from '../../apps/docs/scripts/copy-storybook.mjs';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'copy-storybook-'));
}

test('copies a built Storybook into dist/storybook, replacing a stale copy', () => {
  const root = tmp();
  const from = path.join(root, 'storybook-static');
  const to = path.join(root, 'dist', 'storybook');
  fs.mkdirSync(path.join(from, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(from, 'index.html'), '<!doctype html>');
  fs.writeFileSync(path.join(from, 'assets', 'app.js'), '');
  fs.mkdirSync(to, { recursive: true });
  fs.writeFileSync(path.join(to, 'stale.js'), '');

  assert.equal(copyStorybook({ from, to, required: true }), true);
  assert.ok(fs.existsSync(path.join(to, 'index.html')));
  assert.ok(fs.existsSync(path.join(to, 'assets', 'app.js')));
  assert.equal(fs.existsSync(path.join(to, 'stale.js')), false);
});

test('skips without a build when not required', () => {
  const root = tmp();
  const to = path.join(root, 'dist', 'storybook');
  assert.equal(copyStorybook({ from: path.join(root, 'missing'), to, required: false }), false);
  assert.equal(fs.existsSync(to), false);
});

test('fails without a build when required (release builds)', () => {
  const root = tmp();
  assert.throws(
    () => copyStorybook({ from: path.join(root, 'missing'), to: path.join(root, 'out'), required: true }),
    /no Storybook build/,
  );
});
