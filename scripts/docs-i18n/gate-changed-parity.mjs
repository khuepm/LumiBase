#!/usr/bin/env node
// Fail a PR when a doc pair it CHANGED is out of EN/VI parity.
//
// WHY THIS EXISTS
// ---------------
// `check-parity.mjs` run over the whole repo cannot gate a PR today: a backlog
// of legacy pairs still fails, so enforcing it would block contributors for
// other people's debt. Report-only, though, means nothing stops the backlog
// from growing.
//
// This narrows the same check to the pairs the PR actually touched. A
// contributor is answerable for what they edited, and nothing new lands broken,
// while the inherited backlog is retired on its own schedule. When that backlog
// reaches zero, this wrapper can be dropped and the repo-wide run enforced
// directly.
//
// Both locales are versioned together (CLAUDE.md), so either side counts:
// editing only `docs/vi/x.md` must still leave the pair consistent.
//
// DELETIONS AND RENAMES COUNT AS CHANGES
// --------------------------------------
// The workflow feeds this list from `git diff --name-only` WITHOUT
// `--diff-filter=d`. Excluding deletions opened a hole big enough to drive the
// whole gate through: a PR deleting only `docs/vi/x.md` orphans the EN side and
// supplies no changed doc at all, so the gate saw an empty list and exited 0.
// A rename does the same to the old path.
//
// So a pair is checked whenever EITHER locale appears in the diff, whether that
// path still exists or not, and the outcome depends on what survives:
//
//   both sides exist   -> parity is checked as usual
//   one side survives  -> FAIL, the pair is half-deleted
//   neither survives   -> pass, a deliberate removal of both locales
//
// That last row is the reason this cannot simply be "fail on a missing file":
// retiring a doc in both locales is legitimate and must not need an override.
//
// Usage:
//   node scripts/docs-i18n/gate-changed-parity.mjs <changed-files.txt>
//
// The input is a newline-separated list of repo-relative paths, as produced by
// `git diff --name-only`. Paths outside docs/en and docs/vi are ignored.
//
// Exit code: 0 = nothing to check or all clean, 1 = a changed pair drifted,
// 2 = bad usage.

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCALES, DOCS_ROOT } from './config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** `docs/en/features/x.md` and `docs/vi/features/x.md` both map to `features/x.md`. */
const DOC_PATH = /^docs\/(?:en|vi)\/(.+\.md)$/;

/**
 * Locale-relative rels for every doc pair touched by a changed-file list.
 *
 * Pure so the deletion and rename cases are testable without a git repo.
 * De-duplicates the two sides of a pair: editing both locales of one doc is
 * one pair to check, not two.
 */
export function relsFromChangedFiles(text) {
  return [
    ...new Set(
      text
        .split('\n')
        .map((line) => line.trim())
        .map((line) => DOC_PATH.exec(line)?.[1])
        .filter(Boolean),
    ),
  ].sort();
}

/**
 * Split changed pairs by what still exists on disk.
 *
 * `exists(locale, rel)` is injected so tests can describe a tree instead of
 * building one.
 *
 * - `checkable` — both locales present; hand these to check-parity.
 * - `halfDeleted` — exactly one locale left. The failure this function exists
 *   for: deleting or renaming one side silently orphans the other.
 * - `fullyDeleted` — neither locale left. A deliberate retirement of the doc,
 *   which must pass without an override.
 */
export function classifyPairs(rels, exists) {
  const checkable = [];
  const halfDeleted = [];
  const fullyDeleted = [];

  for (const rel of rels) {
    const present = LOCALES.filter((locale) => exists(locale, rel));
    if (present.length === LOCALES.length) checkable.push(rel);
    else if (present.length === 0) fullyDeleted.push(rel);
    else halfDeleted.push({ rel, present, missing: LOCALES.filter((l) => !present.includes(l)) });
  }

  return { checkable, halfDeleted, fullyDeleted };
}

const onDisk = (locale, rel) => fs.existsSync(path.join(DOCS_ROOT, locale, rel));

function main() {
  const listFile = process.argv[2];

  if (!listFile) {
    console.error('usage: gate-changed-parity.mjs <changed-files.txt>');
    process.exit(2);
  }
  if (!fs.existsSync(listFile)) {
    console.error(`gate-changed-parity: no such file: ${listFile}`);
    process.exit(2);
  }

  const rels = relsFromChangedFiles(fs.readFileSync(listFile, 'utf8'));

  if (rels.length === 0) {
    console.log('gate-changed-parity: no docs/en or docs/vi markdown changed — nothing to enforce.');
    process.exit(0);
  }

  console.log(`gate-changed-parity: checking ${rels.length} changed pair(s):`);
  for (const rel of rels) console.log(`  ${rel}`);
  console.log('');

  const { checkable, halfDeleted, fullyDeleted } = classifyPairs(rels, onDisk);

  for (const rel of fullyDeleted) {
    console.log(`  ${rel} — removed in both locales, nothing to compare.`);
  }

  // A pair with exactly one surviving locale. `check-parity.mjs` compares
  // PAIRS and counts a one-sided doc as single-sided, skipping it and exiting
  // 0 — so this has to be caught here, whether the missing side was never
  // added, deleted, or renamed away.
  if (halfDeleted.length > 0) {
    console.error(`EN/VI counterpart missing for ${halfDeleted.length} changed doc(s):\n`);
    for (const { rel, present, missing } of halfDeleted) {
      console.error(`  ${rel}  — has: ${present.join(', ')}; missing: ${missing.join(', ')}`);
    }
    console.error(
      '\nEvery user-facing doc change lands in BOTH docs/en and docs/vi in the same' +
        '\ncommit (CLAUDE.md §7). Add the missing side, then stamp the pair.' +
        '\nRetiring a doc is fine — delete BOTH locales, and this gate passes.',
    );
    process.exit(1);
  }

  if (checkable.length === 0) {
    console.log('gate-changed-parity: no surviving pair to compare — nothing to enforce.');
    process.exit(0);
  }

  // Delegate to the real checker rather than reimplementing any of it, so the
  // gate can never drift from the report the same PR uploads.
  const result = spawnSync(
    process.execPath,
    [path.join(HERE, 'check-parity.mjs'), ...checkable],
    { stdio: 'inherit' },
  );

  if (result.error) {
    console.error(`gate-changed-parity: could not run check-parity.mjs: ${result.error.message}`);
    process.exit(2);
  }
  if (result.status === 0) {
    process.exit(0);
  }

  console.error(`
Both locales are versioned together (CLAUDE.md §7): a change to one side must
land with the other in the same commit. To fix:

  pnpm docs:i18n:parity <rel>     # what drifted
  pnpm docs:i18n:verify <rel>     # do the claims still match the source tree?
  node scripts/docs-i18n/stamp-pair.mjs <rel> <en|vi> --verified

Check the front matter for which side is the source (\`sourceLang\`) — some docs
are VI-source. A deliberate divergence needs --allow-structure-drift and a
stated reason.`);
  process.exit(1);
}

// Only run when invoked directly, so the pure helpers above can be imported
// by the tripwire in scripts/__tests__/.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
