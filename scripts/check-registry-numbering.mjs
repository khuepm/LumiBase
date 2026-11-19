import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Registry-id tripwire.
 *
 * Two tables in this repo use a hand-assigned unique row id, and both have been
 * bitten by the same thing: parallel branches independently pick "the next
 * number", and whichever merges second silently duplicates it.
 *
 *   1. Setup Impact Registry (`.kiro/specs/admin-setup-wizard/setup-impact.md`)
 *      — `#` column. At one point the table carried two #20/#31/#32 rows (and
 *      many more). That is what this script was originally written for.
 *
 *   2. Out-of-scope findings backlog (`.kiro/steering/out-of-scope-backlog.md`)
 *      — `ID` column (`B<n>`). Added after PR #434 and PR #436 both claimed
 *      `B30` for unrelated findings; the collision only surfaced as a rebase
 *      conflict, and resolving it by hand is exactly the manual step DoD §6
 *      says to mechanize. Backlog ids are cited by other rows ("Nối tiếp B13",
 *      "cùng class với B10") and by CHANGELOG entries, so a silent renumber
 *      breaks references that no test covers.
 *
 * Per DoD §6 ("cơ giới hóa" — mechanize the fence, don't rely on human recall),
 * this script fails CI when either id column contains a duplicate, so the
 * collision is caught at PR time instead of during a later cleanup.
 *
 * It scans EVERY table row in each file — not just the table under the
 * `## Registry` heading. An earlier version bounded the scan to that section
 * (up to the next H2), and rows that parallel PRs appended at the end of the
 * file — below `## Lưu ý backfill` — were never checked, so duplicate ids
 * merged unnoticed. Only lines that start with `| <id> |` count as rows, so
 * numbered prose, blank lines and headings anywhere in the file are ignored.
 */

import { fileURLToPath } from 'node:url';

const repoRoot = process.cwd();

/** @type {{label: string, file: string, row: RegExp, render: (t: string) => string, next: (tokens: string[]) => string}[]} */
const registries = [
  {
    label: 'Setup Impact Registry',
    file: '.kiro/specs/admin-setup-wizard/setup-impact.md',
    // A data row looks like `| 42 | ... |` or `| 28b | ... |`. The header
    // (`| # | ... |`) and separator (`|---|`) rows never match.
    row: /^\|\s*(\d+[a-z]?)\s*\|/,
    render: (token) => `#${token}`,
    next: (tokens) => `#${maxNumeric(tokens) + 1}`,
  },
  {
    label: 'Out-of-scope backlog',
    file: '.kiro/steering/out-of-scope-backlog.md',
    // A data row looks like `| B30 | ... |`. The header (`| ID | ... |`) and
    // separator rows never match.
    row: /^\|\s*B(\d+)\s*\|/,
    render: (token) => `B${token}`,
    next: (tokens) => `B${maxNumeric(tokens) + 1}`,
  },
];

/** Highest integer among the collected id tokens. */
function maxNumeric(tokens) {
  const numbers = tokens.map((t) => parseInt(t, 10)).filter((n) => !Number.isNaN(n));
  return numbers.length > 0 ? Math.max(...numbers) : 0;
}

/**
 * Collect every row id in `source`, wherever it sits in the file.
 * @returns {Map<string, number[]>} id token -> 1-based line numbers
 */
export function collectRowIds(source, row) {
  const seen = new Map();
  source.split('\n').forEach((line, i) => {
    const m = line.match(row);
    if (!m) return;
    const token = m[1];
    if (!seen.has(token)) seen.set(token, []);
    seen.get(token).push(i + 1);
  });
  return seen;
}

/**
 * Check one registry file's source text.
 * @returns {{ok: true, summary: string} | {ok: false, failures: string[]}}
 */
export function checkRegistrySource(registry, source, rel = registry.file) {
  const seen = collectRowIds(source, registry.row);

  // A table that suddenly parses as empty means the shape changed and this
  // guard stopped guarding — fail rather than report a cheerful zero.
  if (seen.size === 0) {
    return { ok: false, failures: [`- parsed 0 rows in ${rel} — the table shape may have changed`] };
  }

  const duplicates = [...seen.entries()].filter(([, ls]) => ls.length > 1);
  if (duplicates.length > 0) {
    const failures = [`- ${registry.label} (${rel}) has duplicate row ids:`];
    for (const [token, ls] of duplicates) {
      failures.push(`    ${registry.render(token)} used ${ls.length} times, on lines ${ls.join(', ')}`);
    }
    failures.push(
      `    Give each colliding row a new id starting at ${registry.next([...seen.keys()])}; ` +
      `keep the occurrence that other rows cite by id so cross-references stay valid.`,
    );
    return { ok: false, failures };
  }

  const rows = [...seen.values()].reduce((n, ls) => n + ls.length, 0);
  return { ok: true, summary: `${registry.label}: ${rows} rows, all ids unique` };
}

export { registries };

async function main() {
  const failures = [];
  const summaries = [];

  for (const registry of registries) {
    const file = path.join(repoRoot, registry.file);
    const rel = path.relative(repoRoot, file);

    let source;
    try {
      source = await readFile(file, 'utf8');
    } catch (error) {
      failures.push(`- could not read ${rel}: ${error.message}`);
      continue;
    }

    const result = checkRegistrySource(registry, source, rel);
    if (result.ok) summaries.push(result.summary);
    else failures.push(...result.failures);
  }

  if (failures.length > 0) {
    console.error('Registry id check failed:');
    for (const failure of failures) console.error(failure);
    console.error('\nSee DoD §2 and §6.');
    process.exit(1);
  }

  console.log(`Registry ids OK — ${summaries.join(' · ')}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
