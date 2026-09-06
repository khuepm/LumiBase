import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regression guard for the "a skipped DB test reports as passed" class (#427).
 *
 * ## Background
 *
 * Every `*.db.integration.test.ts` suite used to gate itself with a boolean and
 * an early return:
 *
 * ```ts
 * beforeAll(async () => {
 *   if (!TEST_DATABASE_URL) { console.warn('Skipping: DATABASE_URL not set.'); return; }
 *   try { db = createDb(TEST_DATABASE_URL); await db.execute(sql`SELECT 1`); canConnect = true; }
 *   catch { console.warn('Skipping: database not reachable.'); }
 * });
 *
 * it('...', async () => {
 *   if (!canConnect) return;   // an early return is a PASS
 *   ...
 * });
 * ```
 *
 * A body that returns before asserting anything is a **passing** test. So a run
 * against a database that was not there was byte-for-byte indistinguishable
 * from a real one — measured at 20 files / 76 tests / exit 0 against a closed
 * port, with no `skipped` line to give it away. It really did mislead: three
 * consecutive "3/3 pass" runs during #401/#425 had in fact executed nothing.
 *
 * `apps/cms/src/__tests__/helpers/db-harness.ts` replaces that with two
 * distinguishable outcomes — `describe.skipIf` when no database was asked for,
 * a throw when one was asked for and did not answer.
 *
 * ## Why a source scan
 *
 * The failure mode is a suite *forgetting* the harness, not the harness being
 * wrong — the "forgot, not wrong" shape that DoD §2c/§6 call out. A behavioural
 * test cannot observe a file that never opted in, so enforcement has to be a
 * scan over every suite. The harness's own behaviour is covered by
 * `db-harness.test.ts`.
 */

const SRC_ROOT = resolve(__dirname, '..');
const HARNESS_IMPORT = 'helpers/db-harness';
const SUITE_SUFFIX = '.db.integration.test.ts';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const suites = walk(SRC_ROOT)
  .filter((f) => f.endsWith(SUITE_SUFFIX))
  .map((f) => ({ rel: relative(SRC_ROOT, f).split(sep).join('/'), source: readFileSync(f, 'utf8') }))
  .sort((a, b) => a.rel.localeCompare(b.rel));

interface TopLevelBlock {
  title: string;
  gated: boolean;
  body: string;
}

/**
 * Split a suite file into its top-level `describe` blocks.
 *
 * Column-0 anchoring is the whole trick: a nested `describe` is indented, so
 * `^describe` finds only the outermost ones and each block runs to the next such
 * line. Cheap, and enough to tell a gated block from an ungated one without
 * pulling in a parser.
 */
function topLevelBlocks(source: string): TopLevelBlock[] {
  const starts = [
    ...source.matchAll(/^describe(?<gate>\.skipIf\([^)]*\))?\(\s*(?<q>['"`])(?<title>[^'"`]*)\k<q>/gm),
  ];
  return starts.map((match, index) => {
    const groups = match.groups ?? {};
    const nextIndex = starts[index + 1]?.index;
    return {
      title: groups.title ?? '<unnamed>',
      gated: (groups.gate ?? '').includes('!hasDbIntegrationUrl'),
      body: source.slice(match.index ?? 0, nextIndex ?? source.length),
    };
  });
}

describe('DB integration suites cannot silently pass without a database (#427)', () => {
  it('finds the suites at all, so the checks below cannot pass vacuously', () => {
    // A broken glob would make every other assertion in this file trivially
    // true. 20 suites existed when this guard was written; assert a floor
    // rather than an exact count so adding a suite does not fail the build.
    expect(suites.length).toBeGreaterThanOrEqual(20);
  });

  it.each(suites.map((s) => s.rel))(
    '%s gates the top-level describe with skipIf(!hasDbIntegrationUrl)',
    (rel) => {
      const { source } = suites.find((s) => s.rel === rel)!;
      // Gating at the suite level is what makes vitest report `skipped`
      // instead of `passed`. Anything narrower (per-test guards) reintroduces
      // the bug for whichever test forgets it.
      expect(source).toMatch(/^describe\.skipIf\(!hasDbIntegrationUrl\)\(/m);
    },
  );

  it.each(suites.map((s) => s.rel))('%s keeps every db-touching block behind the gate', (rel) => {
    const { source } = suites.find((s) => s.rel === rel)!;
    // A file may hold an extra ungated top-level `describe` for pure helpers
    // that need no database — `release-service.db.integration.test.ts` does,
    // and those two tests genuinely execute and genuinely assert, which is why
    // a no-database run reports "2 passed | 74 skipped" rather than 0 passed.
    // That is only honest as long as an ungated block never touches `db`:
    // otherwise it would run without a connection and we are back to tests
    // passing on nothing.
    const ungated = topLevelBlocks(source).filter((b) => !b.gated);
    for (const block of ungated) {
      expect(
        /\bdb\b/.test(block.body),
        `ungated describe "${block.title}" in ${rel} references db; ` +
          'move it behind describe.skipIf(!hasDbIntegrationUrl)',
      ).toBe(false);
    }
  });

  it.each(suites.map((s) => s.rel))('%s connects through the shared harness', (rel) => {
    const { source } = suites.find((s) => s.rel === rel)!;
    expect(source).toContain(HARNESS_IMPORT);
    expect(source).toMatch(/await connectDbIntegration\(/);
    // A suite that builds its own client bypasses the unreachable-means-fail
    // rule the harness enforces.
    expect(source).not.toMatch(/\bcreateDb\(/);
  });

  it.each(suites.map((s) => s.rel))('%s carries no connection-gate boolean', (rel) => {
    const { source } = suites.find((s) => s.rel === rel)!;
    // `canConnect` is the specific variable the old pattern used;
    // `TEST_DATABASE_URL` is how suites read the env directly. Both are how a
    // revert would look.
    expect(source).not.toContain('canConnect');
    expect(source).not.toContain('TEST_DATABASE_URL');
  });

  it.each(suites.map((s) => s.rel))('%s has no early-return skip inside a test or hook', (rel) => {
    const { source } = suites.find((s) => s.rel === rel)!;
    // The precise shape of the bug: a guard clause whose body is a bare
    // `return`, which vitest counts as a completed, passing test. The one
    // legitimate exception is `if (!db) return;` in `afterAll`, where
    // `beforeAll` may have thrown before assigning `db` and cleanup has
    // nothing to clean.
    const offenders = [...source.matchAll(/^[ \t]*if \((?<cond>[^)\n]*)\) return;$/gm)]
      .map((m) => (m.groups?.cond ?? '').trim())
      .filter((cond) => cond !== '!db');
    expect(offenders).toEqual([]);
  });

  it.each(suites.map((s) => s.rel))('%s does not warn-and-continue about skipping', (rel) => {
    const { source } = suites.find((s) => s.rel === rel)!;
    // A `console.warn('Skipping …')` was the only trace the old runs left, and
    // it was in stderr next to a green summary. Skipping is now expressed to
    // the runner, not to a log reader.
    expect(source).not.toMatch(/console\.warn\(\s*['"`]Skipping/);
  });
});
