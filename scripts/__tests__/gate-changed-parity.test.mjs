/**
 * Tripwire for the changed-pair parity gate.
 *
 * The gate's own failure mode is being *too quiet*: it exits 0 when it has
 * nothing to check, which is correct for a PR that touched no docs and wrong
 * for a PR that deleted one locale. Those two look identical from inside the
 * script — the difference is whether the workflow put the deleted path in the
 * list at all.
 *
 * So this file tests both halves:
 *
 * - `relsFromChangedFiles` / `classifyPairs` — the pure decisions, including
 *   add, edit, delete-one-side, delete-both and rename.
 * - a real `git diff` in a throwaway repo — proof that the workflow's command
 *   actually reports deletions and renames. That is where the bug lived: the
 *   script always had orphan handling, but `--diff-filter=d` meant the path
 *   never reached it.
 *
 * Uses `node --test` to match the other guards in this directory: a check on
 * docs tooling must not depend on a workspace install.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  relsFromChangedFiles,
  classifyPairs,
} from '../docs-i18n/gate-changed-parity.mjs';

/** A tree described as the set of paths that exist, as `locale/rel`. */
const treeOf = (...present) => {
  const set = new Set(present);
  return (locale, rel) => set.has(`${locale}/${rel}`);
};

// Git hooks export GIT_DIR/GIT_INDEX_FILE and other repository selectors.
// A cwd alone does not isolate a fixture: inherited selectors can reinitialize
// or change the parent checkout. Remove every Git override in child processes.
const fixtureEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
);

test('maps both locales of a doc to one rel', () => {
  const rels = relsFromChangedFiles('docs/en/features/x.md\ndocs/vi/features/x.md\n');
  assert.deepEqual(rels, ['features/x.md']);
});

test('ignores paths outside docs/en and docs/vi', () => {
  const rels = relsFromChangedFiles(
    ['README.md', 'apps/cms/src/index.ts', 'docs/.i18n/last-report.json', 'docs/en/a.md'].join('\n'),
  );
  assert.deepEqual(rels, ['a.md']);
});

test('a doc edited in both locales is checkable', () => {
  const { checkable, halfDeleted, fullyDeleted } = classifyPairs(
    ['features/x.md'],
    treeOf('en/features/x.md', 'vi/features/x.md'),
  );
  assert.deepEqual(checkable, ['features/x.md']);
  assert.deepEqual(halfDeleted, []);
  assert.deepEqual(fullyDeleted, []);
});

test('adding only the EN side fails as half-deleted', () => {
  // The most common CLAUDE.md §7 violation: new doc, one locale.
  const { checkable, halfDeleted } = classifyPairs(
    ['features/new.md'],
    treeOf('en/features/new.md'),
  );
  assert.deepEqual(checkable, []);
  assert.equal(halfDeleted.length, 1);
  assert.deepEqual(halfDeleted[0].missing, ['vi']);
});

test('deleting only the VI side fails, leaving EN orphaned', () => {
  // The reviewed hole. Before the fix this pair never reached the gate at all.
  const { halfDeleted } = classifyPairs(['features/x.md'], treeOf('en/features/x.md'));
  assert.equal(halfDeleted.length, 1);
  assert.deepEqual(halfDeleted[0].present, ['en']);
  assert.deepEqual(halfDeleted[0].missing, ['vi']);
});

test('deleting only the EN side fails too — neither locale is privileged', () => {
  const { halfDeleted } = classifyPairs(['features/x.md'], treeOf('vi/features/x.md'));
  assert.equal(halfDeleted.length, 1);
  assert.deepEqual(halfDeleted[0].missing, ['en']);
});

test('deleting BOTH locales passes — retiring a doc needs no override', () => {
  const { checkable, halfDeleted, fullyDeleted } = classifyPairs(
    ['features/gone.md'],
    treeOf(),
  );
  assert.deepEqual(checkable, []);
  assert.deepEqual(halfDeleted, []);
  assert.deepEqual(fullyDeleted, ['features/gone.md']);
});

test('a rename in both locales checks the new pair and clears the old', () => {
  // Renaming touches four paths: two vanished, two new.
  const rels = relsFromChangedFiles(
    [
      'docs/en/features/old.md',
      'docs/vi/features/old.md',
      'docs/en/features/new.md',
      'docs/vi/features/new.md',
    ].join('\n'),
  );
  const { checkable, halfDeleted, fullyDeleted } = classifyPairs(
    rels,
    treeOf('en/features/new.md', 'vi/features/new.md'),
  );
  assert.deepEqual(checkable, ['features/new.md']);
  assert.deepEqual(fullyDeleted, ['features/old.md']);
  assert.deepEqual(halfDeleted, []);
});

test('a one-sided rename fails on the orphaned old path', () => {
  // EN moved, VI left behind at the old name: both pairs are now half-present.
  const rels = relsFromChangedFiles('docs/en/features/old.md\ndocs/en/features/new.md');
  const { halfDeleted } = classifyPairs(
    rels,
    treeOf('en/features/new.md', 'vi/features/old.md'),
  );
  assert.deepEqual(
    halfDeleted.map((h) => h.rel).sort(),
    ['features/new.md', 'features/old.md'],
  );
});

test('real rename output retains the old orphan when the destination pair already exists', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-parity-rename-'));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: fixtureEnv });
  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    for (const file of ['en/old.md', 'vi/old.md', 'vi/new.md']) {
      const full = path.join(repo, 'docs', file);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, '# Same document\n');
    }
    git('add', '-A');
    git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD').trim();
    git('mv', 'docs/en/old.md', 'docs/en/new.md');
    git('commit', '-qm', 'move EN');
    const exists = (locale, rel) => fs.existsSync(path.join(repo, 'docs', locale, rel));
    // Rename detection reports only the destination, which is a valid pair.
    const missed = classifyPairs(relsFromChangedFiles(git('diff', '--name-only', '-M', base, 'HEAD')), exists);
    assert.equal(missed.halfDeleted.length, 0);
    // Execute the workflow's actual diff command rather than inventing a list.
    const workflow = fs.readFileSync(new URL('../../.github/workflows/docs-i18n-sync.yml', import.meta.url), 'utf8');
    const flags = workflow.match(/git diff (--name-only[^\n\\]*)/)[1].trim().split(/\s+/);
    const seen = classifyPairs(relsFromChangedFiles(git('diff', ...flags, base, 'HEAD')), exists);
    assert.deepEqual(seen.halfDeleted.map(({ rel }) => rel), ['old.md']);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("git diff without --diff-filter=d reports deletions and renames", () => {
  // The workflow's own command, against a real repo. This is the assertion
  // that would have caught the bug: with --diff-filter=d the deleted path is
  // absent from this list, the gate receives nothing, and it exits 0.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-parity-git-'));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: fixtureEnv });

  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');

    fs.mkdirSync(path.join(repo, 'docs/en/features'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'docs/vi/features'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'docs/en/features/x.md'), '# x\n');
    fs.writeFileSync(path.join(repo, 'docs/vi/features/x.md'), '# x\n');
    git('add', '-A');
    git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD').trim();

    // Delete one locale, exactly the reviewed scenario.
    fs.rmSync(path.join(repo, 'docs/vi/features/x.md'));
    git('add', '-A');
    git('commit', '-qm', 'drop the VI side');

    const withDeletions = git('diff', '--name-only', base, 'HEAD');
    const excludingDeletions = git('diff', '--name-only', '--diff-filter=d', base, 'HEAD');

    // What the workflow now runs: the pair is visible and fails.
    const seen = classifyPairs(relsFromChangedFiles(withDeletions), (locale, rel) =>
      fs.existsSync(path.join(repo, 'docs', locale, rel)),
    );
    assert.equal(seen.halfDeleted.length, 1, 'the orphaned pair must reach the gate');
    assert.deepEqual(seen.halfDeleted[0].missing, ['vi']);

    // What it used to run: nothing to check, so the gate passed.
    assert.deepEqual(
      relsFromChangedFiles(excludingDeletions),
      [],
      '--diff-filter=d hides the deletion — this is the bug being fixed',
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
