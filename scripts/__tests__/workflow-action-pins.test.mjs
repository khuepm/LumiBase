/**
 * Tripwire: every third-party GitHub Action is pinned to a full commit SHA (#995).
 *
 * A tag (`@v7`) is a mutable pointer: whoever controls the action's repository
 * can move it, and the next CI run executes the new code with this repo's
 * tokens and release credentials. That is the supply-chain shape of the
 * October 2026 Rank Math SEO PRO incident (a malicious build shipped through
 * the vendor's own channel). A SHA cannot be moved. Write
 * `uses: owner/repo@<40-hex sha> # vX.Y.Z` — Dependabot (github-actions
 * ecosystem) keeps both the SHA and the version comment current.
 *
 * Local actions (`./…`) and `docker://` images are exempt; commented-out
 * examples are ignored.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflowsDir = join(root, '.github', 'workflows');

/** Every `uses:` reference outside comments, with its file and line. */
export function actionRefs(source) {
  const refs = [];
  source.split('\n').forEach((line, index) => {
    const code = line.replace(/^\s*#.*$/, '');
    const match = code.match(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/);
    if (match) refs.push({ ref: match[1].replace(/^['"]|['"]$/g, ''), line: index + 1 });
  });
  return refs;
}

export function isPinned(ref) {
  if (ref.startsWith('./') || ref.startsWith('docker://')) return true;
  return /@[0-9a-f]{40}$/.test(ref);
}

test('the matcher sees real references and skips comments', () => {
  const refs = actionRefs('steps:\n  - uses: actions/checkout@v7\n  #   uses: actions/setup-example@v1\n  - name: x\n    uses: "a/b@0123456789abcdef0123456789abcdef01234567" # v1\n');
  assert.deepEqual(refs.map((r) => r.ref), ['actions/checkout@v7', 'a/b@0123456789abcdef0123456789abcdef01234567']);
  assert.equal(isPinned('actions/checkout@v7'), false);
  assert.equal(isPinned('a/b@0123456789abcdef0123456789abcdef01234567'), true);
  assert.equal(isPinned('./.github/actions/local'), true);
});

test('every workflow action is pinned to a commit SHA', () => {
  const unpinned = [];
  for (const file of readdirSync(workflowsDir).filter((f) => /\.ya?ml$/.test(f))) {
    for (const { ref, line } of actionRefs(readFileSync(join(workflowsDir, file), 'utf8'))) {
      if (!isPinned(ref)) unpinned.push(`.github/workflows/${file}:${line} ${ref}`);
    }
  }
  assert.deepEqual(unpinned, [], `Pin these to a commit SHA (uses: owner/repo@<sha> # vX.Y.Z):\n${unpinned.join('\n')}`);
});
