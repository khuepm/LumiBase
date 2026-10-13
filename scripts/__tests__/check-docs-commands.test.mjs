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
  collectPackages,
  extractCommands,
} from '../check-docs-commands.mjs';

const rootScripts = new Set(['db:migrate', 'db:generate', 'lumibase', 'test']);
const packages = new Map([
  ['@lumibase/database', new Set(['migrate', 'generate', 'studio'])],
  ['@lumibase/sdk', new Set(['build', 'test', 'typecheck', 'clean'])],
  ['@lumibase/cms', new Set(['dev', 'typegen', 'test'])],
]);
const check = (text, rel = 'docs/en/x.md') =>
  checkDocument({ rel, text, rootScripts, packages });
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
  assert.deepEqual(
    check(fence('pnpm -F @lumibase/cms exec tsx scripts/x.ts', 'pnpm --filter @lumibase/cms run dev')),
    [],
  );
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
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
