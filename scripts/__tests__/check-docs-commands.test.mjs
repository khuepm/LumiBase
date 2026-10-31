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
  binLookup,
  checkDocument,
  collectPackageDirs,
  collectPackageDirsByName,
  collectPackages,
  extractCommands,
  fencedLines,
  resolveFilterName,
} from '../check-docs-commands.mjs';

const rootScripts = new Set(['db:migrate', 'db:generate', 'lumibase', 'test', 'dev']);
const cmsScripts = new Set(['dev', 'typegen', 'test', 'deploy', 'deploy:dev', 'deploy:production']);
const packages = new Map([
  ['@lumibase/database', new Set(['migrate', 'generate', 'studio'])],
  ['@lumibase/sdk', new Set(['build', 'test', 'typecheck', 'clean'])],
  ['@lumibase/cms', cmsScripts],
]);
const packageDirs = new Map([['apps/cms', cmsScripts]]);
const packageDirsByName = new Map([['@lumibase/cms', 'apps/cms']]);
const check = (text, rel = 'docs/en/x.md', options = {}) =>
  checkDocument({ rel, text, rootScripts, packages, packageDirs, packageDirsByName, ...options });
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

// ─── Follow-ups from the review of PR #535 (B168) ────────────────────────────
// Each fix has a failing twin: the assertion marked "twin" fails on the guard
// as it was before B168, which is how these cases were proven to test the fix.

// N6 — fences follow CommonMark, and only shell-like fences are scanned.

test('a four-backtick fence showing a three-backtick block does not invert the fence state', () => {
  const text = [
    '````md',
    '```bash',
    'pnpm nosuch1',
    '```',
    'pnpm nosuch2 is prose inside the outer example',
    '````',
    'The pnpm workspace is prose.',
  ].join('\n');
  // twin: the old toggle closed the outer fence at the inner ``` and checked
  // `pnpm nosuch2` as a command.
  assert.deepEqual(check(text), []);
});

test('a shell fence after a four-backtick fence is still checked', () => {
  const text = ['````md', '```bash', 'x', '```', '````', '```bash', 'pnpm typegen', '```'].join('\n');
  assert.equal(check(text).length, 1);
});

test('a closer shorter than the opener does not close the fence', () => {
  const text = ['````bash', '```', 'pnpm typegen', '````'].join('\n');
  // twin: the old toggle closed at the inner ``` and never saw pnpm typegen.
  assert.equal(check(text).length, 1);
});

test('a closer must use the same character as the opener', () => {
  const text = ['~~~bash', '```', 'pnpm typegen', '~~~'].join('\n');
  assert.equal(check(text).length, 1);
});

test('a SQL comment that mentions pnpm is not a command', () => {
  // twin: the old guard parsed `-- then pnpm picks it up` and reported "picks".
  assert.deepEqual(check(['```sql', '-- then pnpm picks it up', 'SELECT 1;', '```'].join('\n')), []);
});

test('non-shell fences are skipped, shell-like ones are checked', () => {
  for (const lang of ['ts', 'json', 'text', 'md', 'sql'])
    assert.deepEqual(check([`\`\`\`${lang}`, 'pnpm typegen', '```'].join('\n')), [], lang);
  for (const lang of ['', 'bash', 'sh', 'shell', 'zsh', 'console', 'Bash', 'dockerfile'])
    assert.equal(check([`\`\`\`${lang}`, 'pnpm typegen', '```'].join('\n')).length, 1, lang || 'untagged');
});

test('a CI run: step in a yaml fence is still checked', () => {
  assert.equal(check(['```yaml', '- run: pnpm typegen', '```'].join('\n')).length, 1);
});

test('fencedLines numbers fences and reports physical line numbers', () => {
  assert.deepEqual(fencedLines(['```bash', 'a', '```', 'p', '```sh', 'b', '```'].join('\n')), [
    { text: 'a', lineNumber: 2, fence: 1 },
    { text: 'b', lineNumber: 6, fence: 2 },
  ]);
});

// N5 — `\` continuation joins lines before parsing.

test('a backslash-continued command is checked as one command', () => {
  const problems = check(fence('pnpm -F @lumibase/cms \\', '  nosuch'));
  // twin: each physical line was parsed alone, so `nosuch` was never seen.
  assert.equal(problems.length, 1);
  assert.match(problems[0], /x\.md:2 .*@lumibase\/cms has no "nosuch"/);
});

test('a continuation between pnpm and its filter is joined too', () => {
  assert.equal(check(fence('pnpm \\', '  -F @lumibase/database db:migrate')).length, 1);
});

test('a continued command with real arguments keeps passing', () => {
  // The shape of features/typegen.md.
  assert.deepEqual(check(fence('pnpm -F @lumibase/cms typegen \\', '  --site x')), []);
});

test('a continuation does not run past the fence closer', () => {
  assert.deepEqual(check([fence('echo x \\'), 'pnpm typegen in prose'].join('\n')), []);
});

// N4 — scope-less filter names resolve like pnpm 9.

test('a scope-less filter name resolves to its unique scoped package', () => {
  assert.deepEqual(check(fence('pnpm --filter cms dev')), []);
  const problems = check(fence('pnpm --filter cms nosuch'));
  // twin: the old guard said "no workspace package is named cms".
  assert.equal(problems.length, 1);
  assert.match(problems[0], /@lumibase\/cms has no "nosuch"/);
});

test('a scope-less name shared by two scopes is ambiguous', () => {
  const two = new Map([...packages, ['@other/cms', new Set(['dev'])]]);
  const problems = checkDocument({
    rel: 'docs/en/x.md',
    text: fence('pnpm --filter cms dev'),
    rootScripts,
    packages: two,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /cms is ambiguous \(matches @lumibase\/cms, @other\/cms\)/);
});

test('a scope-less name with no match is still unknown', () => {
  const problems = check(fence('pnpm --filter nope build'));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no workspace package is named nope/);
});

test('resolveFilterName prefers an exact name and never strips a given scope', () => {
  const names = ['create-lumibase', '@lumibase/cms', '@x/create-lumibase'];
  assert.deepEqual(resolveFilterName('create-lumibase', names), { pkg: 'create-lumibase' });
  assert.deepEqual(resolveFilterName('cms', names), { pkg: '@lumibase/cms' });
  assert.deepEqual(resolveFilterName('@other/cms', names), { missing: true });
  assert.deepEqual(resolveFilterName('apps/cms', names), { missing: true });
});

// N2 — a builtin that shadows a script runs the builtin.

test('a builtin named like a package script is reported with the run fix', () => {
  const problems = check(fence('pnpm -F @lumibase/cms deploy'));
  // twin: builtins returned null, so this passed while pnpm ran its own deploy.
  assert.equal(problems.length, 1);
  assert.match(problems[0], /builtin "deploy"/);
  assert.match(problems[0], /pnpm -F @lumibase\/cms run deploy/);
  assert.deepEqual(check(fence('pnpm -F @lumibase/cms run deploy')), []);
});

test('the same shadowing is reported from a package directory', () => {
  assert.equal(check(fence('cd apps/cms', 'pnpm deploy')).length, 1);
  assert.equal(check(fence('pnpm --if-present -F @lumibase/cms deploy')).length, 1, '--if-present still runs the builtin');
});

test('a builtin that shadows nothing is still a builtin', () => {
  assert.deepEqual(check(fence('pnpm --filter @lumibase/database deploy out/')), []);
  assert.deepEqual(check(fence('pnpm install')), []);
  assert.deepEqual(check(fence('pnpm --filter @lumibase/enterprise deploy')), [], 'optional package');
});

// N3 — pnpm 9 falls back to a binary in root and directory form only.

test('a root command that is an installed binary is not a missing script', () => {
  const tsxAtRoot = (dir, name) => dir === '.' && name === 'tsx';
  assert.deepEqual(check(fence('pnpm tsx scripts/x.ts'), 'docs/en/x.md', { binExists: tsxAtRoot }), []);
  // twin: with nothing installed (the old behaviour for every binary) it is reported.
  assert.equal(check(fence('pnpm tsx scripts/x.ts')).length, 1);
});

test('a directory command resolves binaries of that directory', () => {
  const wrangler = (dir, name) => dir === 'apps/cms' && name === 'wrangler';
  assert.deepEqual(check(fence('cd apps/cms', 'pnpm wrangler --version'), 'docs/en/x.md', { binExists: wrangler }), []);
  assert.equal(check(fence('pnpm wrangler --version'), 'docs/en/x.md', { binExists: wrangler }).length, 1);
});

test('pnpm node runs node', () => {
  assert.deepEqual(check(fence('pnpm node -e "console.log(1)"')), []);
});

test('--filter does not fall back to binaries, and the message says so', () => {
  const wrangler = (dir, name) => dir === 'apps/cms' && name === 'wrangler';
  const problems = check(fence('pnpm -F @lumibase/cms wrangler deploy'), 'docs/en/x.md', { binExists: wrangler });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /pnpm --filter @lumibase\/cms exec wrangler/);
});

test('binLookup finds a package or root node_modules/.bin entry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-cmd-bin-'));
  try {
    fs.mkdirSync(path.join(root, 'apps', 'a', 'node_modules', '.bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'apps', 'a', 'node_modules', '.bin', 'foo'), '');
    fs.mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', '.bin', 'bar'), '');
    const exists = binLookup(root);
    assert.equal(exists('apps/a', 'foo'), true);
    assert.equal(exists('apps/a', 'bar'), true, 'root bins are on the path too');
    assert.equal(exists('.', 'foo'), false);
    assert.equal(exists('.', 'baz'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('collectPackageDirsByName maps names to directories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-cmd-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'root' }));
    fs.mkdirSync(path.join(root, 'apps', 'cms'), { recursive: true });
    fs.writeFileSync(path.join(root, 'apps', 'cms', 'package.json'), JSON.stringify({ name: '@x/cms' }));
    assert.deepEqual([...collectPackageDirsByName(root)], [['@x/cms', 'apps/cms']]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
