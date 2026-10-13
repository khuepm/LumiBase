#!/usr/bin/env node
// Fail when a pnpm command inside a docs code fence names a script that does not exist.
//
// WHY THIS EXISTS
// ---------------
// `pnpm -F @lumibase/database db:migrate` was printed in 22 places across the
// docs and `AGENTS.md` — including step 5 of Local Development and step 1 of the
// Next.js quickstart, the first commands a new user runs. It never worked:
// `packages/database` defines `migrate` / `generate` / `studio`, and the `db:`
// prefix exists only on the root scripts, so pnpm answered
//
//     None of the selected packages has a "db:migrate" script
//
// `CLAUDE.md` had carried a warning that the form is invalid the whole time, and
// nothing checked the docs against it. The same shape turned up in a second
// family once this guard existed: `pnpm lumibase typegen` (the root `lumibase`
// script is `turbo run dev`, so it started two dev servers), `pnpm -F
// @lumibase/sdk typegen` (that package has four scripts, none of them typegen)
// and a CI snippet running `pnpm typegen`, which is not a root script either.
// Backlog entries B69 (this class) and B66 (the same shape in docs navigation).
//
// WHAT IT CHECKS
// --------------
// Only lines inside fenced code blocks, because prose says things like "the pnpm
// workspace" that are not commands. Comment lines inside a fence are skipped for
// the same reason, and so is a trailing `# comment` after a command.
//
// Each `pnpm` invocation is tokenised, so options are parsed rather than
// guessed at:
//   -F <pkg> / --filter <pkg> / --filter=<pkg> / -F<pkg>  -> that package.json
//   -r / --recursive                                      -> any workspace package
//   -C <dir> / --dir <dir> / -w                           -> that directory
//   --if-present                                          -> nothing to check
//   other flags (`--silent`, `--parallel`, …)             -> skipped, never a script
//   pnpm <script> / pnpm run <script>                     -> the directory's package.json
//
// `run` is resolved, not skipped: `pnpm run nosuch` and `pnpm -F <pkg> run
// nosuch` are reported exactly like `pnpm nosuch`. pnpm's other subcommands
// (`install`, `exec`, `dlx`, `create`, …) are builtins, not missing scripts.
//
// The directory a root-form command resolves against starts at the repository
// root for every fence. `cd <dir>` (or `-C <dir>`) moves it only when <dir> is a
// workspace package, e.g. `cd apps/cms`, and `cd ../..` from there moves it
// back. Any other `cd` — `cd lumibase` right after `git clone`, `cd my-blog` in
// a scaffolded project — leaves it where it was, because it does not name a
// directory this guard can read. A command that has to run from a package must
// say so with a `cd` inside its fence, which also makes the block copyable.
//
// A script token with a placeholder (`deploy:<env>`, `build:${target}`) passes
// when at least one script matches the pattern.
//
// WHAT IT DELIBERATELY DOES NOT CHECK
// -----------------------------------
// - Arguments: `pnpm lumibase typegen` resolves, because `lumibase` is a root
//   script. Existence only.
// - Filter selectors that are patterns rather than names (`./apps/*`,
//   `@lumibase/cms...`, `{apps/**}`, `!x`): pnpm resolves those, not this guard.
// - Root-form commands in USER_PROJECT_DOCS below. Docs that show commands for
//   a *scaffolded user project* (`pnpm dev` in a generated Hono app is not a
//   root script and must not fail this check) are listed there. The filtered
//   form still applies to them, since `-F @lumibase/...` can only mean this
//   repository.
//
// Usage:  node scripts/check-docs-commands.mjs
// Exit:   0 = every command resolves · 1 = at least one does not

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

/** Markdown outside `docs/` that documents this repository's commands. */
const EXTRA_DOCS = ['AGENTS.md', 'CLAUDE.md', 'README.md'];

/**
 * Docs whose fences show commands for a project the reader generates, not for
 * this monorepo. Only the root `pnpm <script>` form is skipped here.
 *
 * Keep this list to files that need it. A doc that begins with `git clone
 * …/lumibase` documents this repository, so its root commands are real root
 * scripts and must stay checked — README.md and the Next.js quickstart were on
 * this list once, which hid step 1 of the quickstart (a B69 incident site).
 */
const USER_PROJECT_DOCS = new Set([
  'docs/en/getting-started.md',
  'docs/vi/getting-started.md',
]);

/**
 * Workspace members that may legitimately be absent from a checkout.
 * `@lumibase/enterprise` lives in a private submodule; documenting its commands
 * must not require having access to it.
 */
const OPTIONAL_PACKAGES = new Set(['@lumibase/enterprise']);

/** pnpm's own subcommands and their aliases — never a package script. */
const PNPM_SUBCOMMANDS = new Set([
  'add', 'approve-builds', 'audit', 'bin', 'c', 'cat-file', 'cat-index', 'completion',
  'config', 'create', 'dedupe', 'deploy', 'deprecate', 'dist-tag', 'dlx', 'doctor', 'env',
  'exec', 'fetch', 'find-hash', 'help', 'i', 'ignored-builds', 'import', 'init', 'install',
  'install-test', 'it', 'licenses', 'link', 'list', 'll', 'ln', 'login', 'logout', 'ls',
  'outdated', 'owner', 'pack', 'patch', 'patch-commit', 'patch-remove', 'prune',
  'publish', 'rb', 'rebuild', 'remove', 'rm', 'root', 'sbom', 'search', 'self-update',
  'server', 'setup', 'store', 'un', 'undeprecate', 'uninstall', 'unlink', 'unpublish',
  'up', 'update', 'upgrade', 'version', 'why',
]);

/** Options whose value is the next token when it is not given with `=`. */
const VALUE_OPTIONS = new Set([
  '-F', '--filter', '--filter-prod', '-C', '--dir', '--reporter', '--loglevel',
  '--workspace-concurrency', '--test-pattern', '--changed-files-ignore-pattern',
  '--resume-from', '--config',
]);

/** A filter that pnpm expands as a selector, not a package name. */
const SELECTOR = /[*{}[\]!^]|\.\.\.|^\.{1,2}\//;

/** A script token containing a placeholder the reader substitutes. */
const PLACEHOLDER = /<[^>]*>|\$\{[^}]*\}|\$[A-Za-z_]\w*|\*/;

/** Every package.json in the workspace except the root manifest. */
function walkPackages(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'dist', '.turbo', 'templates'].includes(entry.name))
        continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'package.json' && full !== path.join(root, 'package.json')) {
        try {
          const json = JSON.parse(fs.readFileSync(full, 'utf8'));
          if (json.name)
            found.push({
              name: json.name,
              dir: path.relative(root, dir).split(path.sep).join('/'),
              scripts: new Set(Object.keys(json.scripts ?? {})),
            });
        } catch {
          // A fixture with intentionally broken JSON is not this guard's problem.
        }
      }
    }
  };
  walk(root);
  return found;
}

/** name -> Set(scripts) for every package.json in the workspace. */
export function collectPackages(root) {
  return new Map(walkPackages(root).map((p) => [p.name, p.scripts]));
}

/** repo-relative dir -> Set(scripts) for every package.json in the workspace. */
export function collectPackageDirs(root) {
  return new Map(walkPackages(root).map((p) => [p.dir, p.scripts]));
}

/**
 * The directory a `cd`/`-C` moves resolution to: `target` when it is the repo
 * root or a known package dir, otherwise `cwd` unchanged (see the header).
 */
function moveTo(cwd, dir, packageDirs) {
  if (!dir || dir.startsWith('/') || dir.startsWith('~') || dir === '-') return cwd;
  const candidate = path.posix.normalize(path.posix.join(cwd, dir)).replace(/\/$/, '');
  if (candidate === '.' || packageDirs.has(candidate)) return candidate;
  return cwd;
}

const unquote = (token) => token.replace(/^(['"])(.*)\1$/, '$2');

/** Shell words after `pnpm`, up to the end of the simple command. */
function wordsAfter(rest) {
  const cut = rest.search(/[|`)]/);
  const words = [];
  for (const raw of (cut === -1 ? rest : rest.slice(0, cut)).trim().split(/\s+/)) {
    if (!raw || raw === '\\') continue;
    if (raw.startsWith('#')) break; // trailing comment
    words.push(unquote(raw));
  }
  return words;
}

/**
 * One `pnpm` invocation reduced to what has to be resolved, or `null` when it
 * runs no script (a builtin subcommand, bare `pnpm`, `pnpm run` with no name).
 */
export function parsePnpm(words, { cwd = '.', packageDirs = new Map() } = {}) {
  const filters = [];
  let dir = cwd;
  let recursive = false;
  let ifPresent = false;
  let sawRun = false;
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (word.startsWith('-') && word !== '-') {
      if (word === '--') continue;
      const eq = word.indexOf('=');
      let name = eq === -1 ? word : word.slice(0, eq);
      let value = eq === -1 ? undefined : word.slice(eq + 1);
      if (value === undefined && /^-F./.test(name)) {
        value = name.slice(2);
        name = '-F';
      }
      if (value === undefined && VALUE_OPTIONS.has(name)) {
        i += 1;
        value = words[i];
      }
      if (name === '-F' || name === '--filter' || name === '--filter-prod') {
        if (value) filters.push(value);
      } else if (name === '-C' || name === '--dir') dir = moveTo(dir, value, packageDirs);
      else if (name === '-w' || name === '--workspace-root') dir = '.';
      else if (name === '-r' || name === '--recursive') recursive = true;
      else if (name === '--if-present') ifPresent = true;
      continue;
    }
    if (!sawRun && word === 'run') {
      sawRun = true;
      continue;
    }
    if (!sawRun && word === 'recursive') {
      recursive = true;
      continue;
    }
    if (!sawRun && PNPM_SUBCOMMANDS.has(word)) return null;
    if (!/^[A-Za-z0-9_$<{][A-Za-z0-9:_.\-<>{}$*]*$/.test(word)) return null;
    const kind = filters.length > 0 ? 'filtered' : recursive ? 'recursive' : 'root';
    return { kind, pkg: filters[0], filters, script: word, cwd: dir, ifPresent };
  }
  return null;
}

/**
 * Commands found in the fenced code blocks of one Markdown document.
 *
 * Pure (takes text, not a path) so the parsing rules are testable without a
 * repository on disk. `packageDirs` lets `cd apps/cms` move resolution to that
 * package; without it every `cd` is ignored.
 */
export function extractCommands(text, { packageDirs = new Map() } = {}) {
  const found = [];
  let inFence = false;
  let cwd = '.';
  text.split('\n').forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      cwd = '.'; // every fence starts at the repository root
      return;
    }
    if (!inFence) return;
    if (/^\s*(#|\/\/)/.test(line)) return; // a comment, not a command
    const lineNumber = index + 1;
    for (const segment of line.split(/&&|\|\||;/)) {
      const cd = /^\s*cd\s+(\S+)/.exec(segment);
      if (cd) {
        cwd = moveTo(cwd, unquote(cd[1]), packageDirs);
        continue;
      }
      for (const match of segment.matchAll(/(?:^|[\s`$(|])pnpm(?=\s|$)/g)) {
        const words = wordsAfter(segment.slice(match.index + match[0].length));
        const command = parsePnpm(words, { cwd, packageDirs });
        if (!command) continue;
        const shown = words.slice(0, words.indexOf(command.script) + 1).join(' ');
        found.push({ ...command, lineNumber, text: `pnpm ${shown}` });
      }
    }
  });
  return found;
}

/** Whether `scripts` has `script`, treating placeholders as wildcards. */
function hasScript(scripts, script) {
  if (!PLACEHOLDER.test(script)) return scripts.has(script);
  const pattern = new RegExp(
    `^${script
      .split(PLACEHOLDER)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.+')}$`,
  );
  return [...scripts].some((name) => pattern.test(name));
}

const listed = (scripts) => [...scripts].sort().join(', ');

/** Problems for one document, given the workspace's scripts. */
export function checkDocument({ rel, text, rootScripts, packages, packageDirs = new Map() }) {
  const problems = [];
  const skipRootForm = USER_PROJECT_DOCS.has(rel);
  for (const command of extractCommands(text, { packageDirs })) {
    const where = `${rel}:${command.lineNumber}  \`${command.text}\``;
    if (command.kind === 'filtered') {
      const named = command.filters.filter((f) => !SELECTOR.test(f) && !OPTIONAL_PACKAGES.has(f));
      for (const pkg of named)
        if (!packages.has(pkg)) problems.push(`${where} — no workspace package is named ${pkg}`);
      const existing = named.filter((pkg) => packages.has(pkg));
      if (command.ifPresent || existing.length === 0) continue;
      if (!existing.some((pkg) => hasScript(packages.get(pkg), command.script))) {
        problems.push(
          existing.length === 1
            ? `${where} — ${existing[0]} has no "${command.script}" script (it has: ${listed(packages.get(existing[0]))})`
            : `${where} — none of ${existing.join(', ')} has a "${command.script}" script`,
        );
      }
    } else if (command.kind === 'recursive') {
      if (command.ifPresent) continue;
      if (![...packages.values()].some((scripts) => hasScript(scripts, command.script)))
        problems.push(`${where} — no workspace package has a "${command.script}" script`);
    } else if (command.cwd === '.') {
      if (skipRootForm || command.ifPresent) continue;
      if (!hasScript(rootScripts, command.script))
        problems.push(`${where} — the root package.json has no "${command.script}" script`);
    } else {
      const scripts = packageDirs.get(command.cwd);
      if (command.ifPresent || !scripts) continue;
      if (!hasScript(scripts, command.script))
        problems.push(
          `${where} — ${command.cwd}/package.json has no "${command.script}" script (it has: ${listed(scripts)})`,
        );
    }
  }
  return problems;
}

function collectDocs(root) {
  const docs = [];
  const docsDir = path.join(root, 'docs');
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', '.i18n'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md')) docs.push(full);
    }
  };
  if (fs.existsSync(docsDir)) walk(docsDir);
  for (const extra of EXTRA_DOCS) {
    const full = path.join(root, extra);
    if (fs.existsSync(full)) docs.push(full);
  }
  return docs;
}

function main() {
  const rootScripts = new Set(
    Object.keys(
      JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).scripts ?? {},
    ),
  );
  const packages = collectPackages(REPO_ROOT);
  const packageDirs = collectPackageDirs(REPO_ROOT);
  const docs = collectDocs(REPO_ROOT);

  const problems = [];
  for (const file of docs) {
    const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
    problems.push(
      ...checkDocument({
        rel,
        text: fs.readFileSync(file, 'utf8'),
        rootScripts,
        packages,
        packageDirs,
      }),
    );
  }

  if (problems.length > 0) {
    console.error(
      `[check-docs-commands] ${problems.length} command(s) name a script that does not exist — ${docs.length} docs scanned`,
    );
    for (const problem of problems) console.error(`  ✖ ${problem}`);
    console.error(
      '\nFix the command, or add the script. A command a reader copies has to run:\n' +
        'this class cost 22 wrong lines in the docs, two of them the very first\n' +
        'command a new user types.',
    );
    process.exit(1);
  }

  console.log(
    `[check-docs-commands] every pnpm command resolves — ${docs.length} docs, ${packages.size} packages`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
)
  main();
