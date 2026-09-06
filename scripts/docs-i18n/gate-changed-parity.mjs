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
const listFile = process.argv[2];

if (!listFile) {
  console.error('usage: gate-changed-parity.mjs <changed-files.txt>');
  process.exit(2);
}
if (!fs.existsSync(listFile)) {
  console.error(`gate-changed-parity: no such file: ${listFile}`);
  process.exit(2);
}

/** `docs/en/features/x.md` and `docs/vi/features/x.md` both map to `features/x.md`. */
const DOC_PATH = /^docs\/(?:en|vi)\/(.+\.md)$/;

const rels = [
  ...new Set(
    fs
      .readFileSync(listFile, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .map((line) => DOC_PATH.exec(line)?.[1])
      .filter(Boolean),
  ),
].sort();

if (rels.length === 0) {
  console.log('gate-changed-parity: no docs/en or docs/vi markdown changed — nothing to enforce.');
  process.exit(0);
}

console.log(`gate-changed-parity: checking ${rels.length} changed pair(s):`);
for (const rel of rels) console.log(`  ${rel}`);
console.log('');

// Missing counterpart. `check-parity.mjs` compares PAIRS, so a doc that exists
// in only one locale is counted as single-sided and skipped — it exits 0. That
// is the most common way CLAUDE.md §7 gets violated (adding `docs/en/new.md`
// and forgetting `docs/vi/new.md`), so the gate has to catch it here.
const orphans = rels.filter((rel) =>
  LOCALES.some((locale) => !fs.existsSync(path.join(DOCS_ROOT, locale, rel))),
);

if (orphans.length > 0) {
  console.error(`EN/VI counterpart missing for ${orphans.length} changed doc(s):\n`);
  for (const rel of orphans) {
    const present = LOCALES.filter((l) => fs.existsSync(path.join(DOCS_ROOT, l, rel)));
    const missing = LOCALES.filter((l) => !present.includes(l));
    console.error(`  ${rel}  — has: ${present.join(', ') || 'none'}; missing: ${missing.join(', ')}`);
  }
  console.error(
    '\nEvery user-facing doc change lands in BOTH docs/en and docs/vi in the same' +
      '\ncommit (CLAUDE.md §7). Add the missing side, then stamp the pair.',
  );
  process.exit(1);
}

// Delegate to the real checker rather than reimplementing any of it, so the
// gate can never drift from the report the same PR uploads.
const result = spawnSync(
  process.execPath,
  [path.join(HERE, 'check-parity.mjs'), ...rels],
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
