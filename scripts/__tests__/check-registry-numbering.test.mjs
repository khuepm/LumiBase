/**
 * Tripwire for the registry-id guard (`pnpm registry:check`).
 *
 * The real incident: the guard only scanned the table under `## Registry`, up
 * to the next H2. Parallel epic PRs appended rows after a blank line and below
 * `## Lưu ý backfill`, so ids 268 and 279 were each used twice on
 * 2026-11-15/16 without the check noticing. The fixtures reproduce that shape.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkRegistrySource,
  collectRowIds,
  registries,
} from '../check-registry-numbering.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) =>
  readFileSync(join(here, 'fixtures', 'registry-numbering', name), 'utf8');
const setupImpact = registries.find((r) => r.label === 'Setup Impact Registry');
const backlog = registries.find((r) => r.label === 'Out-of-scope backlog');

test('collects rows after blank lines and after later H2 sections', () => {
  const ids = collectRowIds(fixture('clean-after-blank.md'), setupImpact.row);
  assert.deepEqual([...ids.keys()], ['1', '2', '3', '4']);
  assert.deepEqual(ids.get('3'), [10]);
  assert.deepEqual(ids.get('4'), [14]);
});

test('ignores header, separator and numbered prose lines', () => {
  const ids = collectRowIds(fixture('duplicate-after-blank.md'), setupImpact.row);
  assert.deepEqual([...ids.keys()].sort(), ['1', '2', '28b', '3']);
});

test('clean fixture passes and counts every row', () => {
  const result = checkRegistrySource(setupImpact, fixture('clean-after-blank.md'), 'clean.md');
  assert.equal(result.ok, true);
  assert.match(result.summary, /4 rows, all ids unique/);
});

test('duplicate after a blank line fails, naming the id and every line', () => {
  const result = checkRegistrySource(setupImpact, fixture('duplicate-after-blank.md'), 'dup.md');
  assert.equal(result.ok, false);
  const text = result.failures.join('\n');
  assert.match(text, /Setup Impact Registry \(dup\.md\) has duplicate row ids/);
  assert.match(text, /#2 used 2 times, on lines 12, 20/);
  assert.match(text, /#3 used 2 times, on lines 15, 21/);
  assert.doesNotMatch(text, /#1 used/);
  assert.match(text, /new id starting at #29/);
});

test('backlog ids are checked across the whole file too', () => {
  const src = '## Registry\n\n| ID | x |\n|---|---|\n| B1 | a |\n\n## Done\n\n| B1 | b |\n';
  const result = checkRegistrySource(backlog, src, 'backlog.md');
  assert.equal(result.ok, false);
  assert.match(result.failures.join('\n'), /B1 used 2 times, on lines 5, 9/);
});

test('a file with no rows fails instead of passing vacuously', () => {
  const result = checkRegistrySource(setupImpact, '# Empty\n\n## Registry\n', 'empty.md');
  assert.equal(result.ok, false);
  assert.match(result.failures[0], /parsed 0 rows in empty\.md/);
});

test('the CLI passes on the repository as committed', () => {
  const root = join(here, '..', '..');
  const out = execFileSync(process.execPath, ['scripts/check-registry-numbering.mjs'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.match(out, /Registry ids OK/);
});
