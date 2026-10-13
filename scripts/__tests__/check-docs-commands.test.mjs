/**
 * Tripwire for the docs-command guard.
 *
 * The cases below are the real wrong commands this guard was written for, so a
 * future refactor that quietly stops matching one of them fails here instead of
 * going unnoticed (B69):
 *
 *  - `pnpm -F @lumibase/database db:migrate` — printed 22 times across the docs
 *    and AGENTS.md; the package defines `migrate`, and `db:` is a root prefix.
 *  - `pnpm lumibase typegen` — the root `lumibase` script is `turbo run dev`, so
 *    this started two dev servers and ignored the argument.
 *  - `pnpm -F @lumibase/sdk typegen` — that package has build/test/typecheck/clean.
 *  - `pnpm typegen` in a CI snippet — not a root script either.
 *
 * And the false positives that have to stay quiet: prose ("the pnpm
 * workspace"), pnpm's own subcommands after a filter, and commands for a
 * project the reader generates.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkDocument,
  collectPackageDirs,
  collectPackages,
  extractCommands,
} from '../check-docs-commands.mjs';

const rootScripts = new Set(['db:migrate', 'db:generate', 'lumibase', 'test', 'dev']);
const cmsScripts = new Set(['dev', 'typegen', 'test', 'deploy:dev', 'deploy:production']);
const packages = new Map([
  ['@lumibase/database', new Set(['migrate', 'generate', 'studio'])],
  ['@lumibase/sdk', new Set(['build', 'test', 'typecheck', 'clean'])],
  ['@lumibase/cms', cmsScripts],
]);
const packageDirs = new Map([['apps/cms', cmsScripts]]);
const check = (text, rel = 'docs/en/x.md') =>
  checkDocument({ rel, text, rootScripts, packages, packageDirs });
const fence = (...lines) => ['```bash', ...lines, '```'].join('\n');

test('catches the incident: -F @lumibase/database db:migrate', () => {
  const problems = check(fence('pnpm -F @lumibase/database db:migrate'));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /has no "db:migrate" script/);
  // The message lists what the package does have, so the fix is obvious.
  assert.match(problems[0], /generate, migrate, studio/);
});

test('the same command passes once it names the root script', () => {
  assert.deepEqual(check(fence('pnpm db:migrate')), []);
});

test('catches a script missing from a package that exists', () => {
  const problems = check(fence('pnpm -F @lumibase/sdk typegen'));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /@lumibase\/sdk has no "typegen"/);
});

test('catches a filter naming a package that does not exist', () => {
  const problems = check(fence('pnpm --filter @lumibase/nope build'));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no workspace package is named @lumibase\/nope/);
});

test('catches a root command that is not a script — the pnpm typegen case', () => {
  const problems = check(fence('pnpm typegen'));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /root package\.json has no "typegen"/);
});

test('a root script that exists but is handed a bogus subcommand is NOT reported', () => {
  // `pnpm lumibase typegen` resolves (lumibase is a root script) — the guard
  // checks existence, not arguments. Recorded so the limitation is explicit.
  assert.deepEqual(check(fence('pnpm lumibase typegen')), []);
});

test("pnpm's own subcommands after a filter are not scripts", () => {
  assert.deepEqual(check(fence('pnpm -F @lumibase/cms exec tsx scripts/x.ts')), []);
});

// ─── `run` is resolved, not skipped (review R2) ─────────────────────────────
// `run` used to sit in the builtin list, so the script after it was never
// examined and `pnpm run nosuch` passed. A passing `run dev` case alone cannot
// tell "resolved" from "skipped", so every passing case here has a failing twin.

test('pnpm run <missing> is reported against the root', () => {
  const problems = check(fence('pnpm run nosuch'));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /root package\.json has no "nosuch"/);
  assert.deepEqual(check(fence('pnpm run db:migrate')), []);
});

test('pnpm -F <pkg> run <missing> is reported against that package', () => {
  const problems = check(fence('pnpm -F @lumibase/cms run nosuch'));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /@lumibase\/cms has no "nosuch"/);
  assert.deepEqual(check(fence('pnpm --filter @lumibase/cms run dev')), []);
});

test('a placeholder script matches when some script fits the pattern', () => {
  assert.deepEqual(check(fence('pnpm --filter @lumibase/cms run deploy:<env>')), []);
  const problems = check(fence('pnpm --filter @lumibase/cms run release:<env>'));
  assert.equal(problems.length, 1);
});

test('cd into a workspace package moves root-form resolution there', () => {
  // features/async-agent-runs.md runs `pnpm run deploy:production` from apps/cms.
  assert.deepEqual(check(fence('cd apps/cms', 'pnpm run deploy:production')), []);
  assert.equal(check(fence('pnpm run deploy:production')).length, 1, 'from the root it is missing');
  assert.equal(check(fence('cd apps/cms', 'pnpm db:migrate')).length, 1, 'apps/cms has no db:migrate');
  assert.deepEqual(check(fence('cd apps/cms && pnpm dev')), []);
  assert.deepEqual(check(fence('cd apps/cms', 'cd ../..', 'pnpm db:migrate')), []);
});

test('a cd that is not a workspace package keeps resolving against the root', () => {
  // `cd lumibase` right after `git clone` is the repository root.
  const problems = check(fence('git clone https://github.com/khuepm/lumibase.git', 'cd lumibase', 'pnpm db-migrate'));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /root package\.json has no "db-migrate"/);
});

test('each fence starts at the repository root', () => {
  const text = [fence('cd apps/cms', 'pnpm dev'), fence('pnpm deploy:production')].join('\n');
  assert.equal(check(text).length, 1);
});

// ─── Option tokens and other shapes (review R3/R4) ──────────────────────────

test('pnpm create is a builtin', () => {
  assert.deepEqual(check(fence('pnpm create lumibase@next my-project')), []);
});

test('a flag before the script is not taken for the script', () => {
  assert.deepEqual(check(fence('pnpm -F @lumibase/cms --silent dev')), []);
  const problems = check(fence('pnpm -F @lumibase/cms --silent nosuch'));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /has no "nosuch"/);
});

test('--filter=<pkg> and -F<pkg> are parsed like -F <pkg>', () => {
  assert.equal(check(fence('pnpm --filter=@lumibase/database db:migrate')).length, 1);
  assert.equal(check(fence('pnpm -F@lumibase/database db:migrate')).length, 1);
  assert.deepEqual(check(fence('pnpm --filter=@lumibase/database migrate')), []);
});

test('-C <dir> resolves against that package', () => {
  assert.deepEqual(check(fence('pnpm -C apps/cms dev')), []);
  assert.equal(check(fence('pnpm --dir apps/cms db:migrate')).length, 1);
});

test('-r resolves against every workspace package', () => {
  assert.deepEqual(check(fence('pnpm -r typecheck')), []);
  assert.equal(check(fence('pnpm -r nosuch')).length, 1);
});

test('--if-present means a missing script is fine', () => {
  assert.deepEqual(check(fence('pnpm -r --if-present nosuch')), []);
});

test('a filter selector that is a pattern is left to pnpm', () => {
  assert.deepEqual(check(fence("pnpm --filter './apps/*' nosuch")), []);
});

test('a trailing comment is not part of the command', () => {
  assert.deepEqual(check(fence('pnpm db:migrate        # apply it')), []);
});

test('prose outside a fence is never a command', () => {
  assert.deepEqual(check('The pnpm workspace is configured so pnpm picks it up.'), []);
});

test('a comment inside a fence is not a command', () => {
  assert.deepEqual(check(fence('#   → apps/enterprise is populated; pnpm picks it up')), []);
});

test('tilde fences count too', () => {
  const problems = checkDocument({
    rel: 'docs/en/x.md',
    text: ['~~~bash', 'pnpm typegen', '~~~'].join('\n'),
    rootScripts,
    packages,
  });
  assert.equal(problems.length, 1);
});

test('the Next.js quickstart is checked: it documents this repository (review R1)', () => {
  // Step 1 clones LumiBase and runs root scripts; it is a B69 incident site.
  for (const rel of [
    'docs/en/tutorials/nextjs-quickstart.md',
    'docs/vi/tutorials/nextjs-quickstart.md',
    'README.md',
  ]) {
    const problems = check(fence('cd lumibase', 'pnpm db-migrate'), rel);
    assert.equal(problems.length, 1, rel);
  }
});

test('a user-project doc may show root commands this repo does not have', () => {
  // `pnpm dev` in a scaffolded Hono app is correct and must not fail the gate.
  assert.deepEqual(check(fence('pnpm dev'), 'docs/en/getting-started.md'), []);
});

test('but a user-project doc still cannot name a broken workspace script', () => {
  const problems = check(
    fence('pnpm -F @lumibase/database db:migrate'),
    'docs/en/getting-started.md',
  );
  assert.equal(problems.length, 1);
});

test('an optional submodule package is allowed to be absent', () => {
  assert.deepEqual(check(fence('pnpm --filter @lumibase/enterprise typecheck')), []);
});

test('extractCommands reports the line number inside the document', () => {
  const text = ['intro', '', '```bash', 'pnpm db:migrate', '```'].join('\n');
  assert.deepEqual(
    extractCommands(text).map((c) => [c.kind, c.script, c.lineNumber]),
    [['root', 'db:migrate', 4]],
  );
});

test('collectPackages reads names and scripts, and skips the root manifest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-cmd-'));
  try {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'root-pkg', scripts: { build: 'x' } }),
    );
    fs.mkdirSync(path.join(root, 'packages', 'a'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'packages', 'a', 'package.json'),
      JSON.stringify({ name: '@x/a', scripts: { test: 'y' } }),
    );
    const packages = collectPackages(root);
    assert.deepEqual([...packages.keys()], ['@x/a']);
    assert.deepEqual([...packages.get('@x/a')], ['test']);
    assert.deepEqual([...collectPackageDirs(root).keys()], ['packages/a']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
