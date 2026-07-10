import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Registry-numbering tripwire.
 *
 * The `#` column of the Setup Impact Registry
 * (`.kiro/specs/admin-setup-wizard/setup-impact.md`) is a unique row id.
 * Parallel feature branches kept picking "the next number" independently and
 * collided — at one point the table carried two #20/#31/#32 rows (and many
 * more). Until now the only fence was a manual `grep` in the Definition of
 * Done (§2), i.e. a checklist a reviewer had to remember to run.
 *
 * Per DoD §6 ("cơ giới hóa" — mechanize the fence, don't rely on human
 * recall), this script fails CI when the `#` column contains a duplicate, so
 * the collision is caught at PR time instead of during a later cleanup.
 *
 * It parses ONLY the table under the `## Registry` heading, so the numbered
 * prose list above it and the notes below it never register as rows.
 */

const repoRoot = process.cwd();
const registryPath = path.join(
  repoRoot,
  '.kiro/specs/admin-setup-wizard/setup-impact.md',
);

const source = await readFile(registryPath, 'utf8');
const lines = source.split('\n');

// Bound the scan to the "## Registry" section (up to the next H2 heading).
const start = lines.findIndex((l) => /^##\s+Registry\s*$/.test(l));
if (start === -1) {
  console.error(`Registry numbering check failed:
- could not find the "## Registry" heading in ${path.relative(repoRoot, registryPath)}`);
  process.exit(1);
}
let end = lines.findIndex((l, i) => i > start && /^##\s+/.test(l));
if (end === -1) end = lines.length;

// A registry data row looks like `| 42 | ... |` or `| 28b | ... |`.
// The header (`| # | ... |`) and separator (`|---|`) rows never match.
const ROW = /^\|\s*(\d+[a-z]?)\s*\|/;

const seen = new Map(); // token -> [lineNumbers]
for (let i = start + 1; i < end; i++) {
  const m = lines[i].match(ROW);
  if (!m) continue;
  const token = m[1];
  if (!seen.has(token)) seen.set(token, []);
  seen.get(token).push(i + 1);
}

if (seen.size === 0) {
  console.error(`Registry numbering check failed:
- parsed 0 rows under "## Registry" — the table shape may have changed`);
  process.exit(1);
}

const duplicates = [...seen.entries()].filter(([, ls]) => ls.length > 1);

if (duplicates.length > 0) {
  console.error('Registry numbering check failed — duplicate row numbers:');
  for (const [token, ls] of duplicates) {
    console.error(`- #${token} used on lines ${ls.join(', ')}`);
  }
  const max = Math.max(
    ...[...seen.keys()].map((t) => parseInt(t, 10)).filter((n) => !Number.isNaN(n)),
  );
  console.error(
    `\nThe # column is a unique row id. Give each colliding row a new number ` +
      `greater than the current max (${max}); keep the occurrence that other ` +
      `rows cite by number so cross-references stay valid. See DoD §2 and §6.`,
  );
  process.exit(1);
}

console.log(`Registry numbering OK: ${seen.size} rows, all # values unique.`);
