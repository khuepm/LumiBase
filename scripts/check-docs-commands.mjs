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
// Fences follow CommonMark: a fence opens with three or more backticks or
// tildes, and only a line of the SAME character, at least as long as the
// opener, with nothing but whitespace after it, closes it. Anything else that
// looks like a fence while one is open is content. So a four-backtick fence
// that shows a three-backtick block does not flip the guard's in-fence state.
// (Leading indentation is accepted on both lines, as before, so fences inside
// list items stay covered; container indentation is not modelled further.)
//
// Only SHELL-LIKE fences are scanned: untagged, `bash`, `sh`, `shell`, `zsh`,
// `console`, `shell-session`, `sh-session`, `terminal`, plus `yaml`/`yml` (CI
// `run:` steps) and `dockerfile`/`docker` (`RUN pnpm …`). The info string's
// first word decides, case-insensitively. Skipping the other languages is
// simpler and more correct than teaching the parser every comment syntax: a
// SQL `-- then pnpm picks it up`, a `// pnpm …` in TypeScript, or a Markdown
// example of a code block are not commands. Every fenced `pnpm` line in the
// docs sits in one of the scanned languages, so no real command lost coverage
// when this rule was added (B168).
//
// A line ending in `\` is joined with the next one before it is parsed, the
// way the shell reads it, so `pnpm -F @lumibase/cms \` followed by `nosuch` is
// checked as one command. The reported line is the first physical line.
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
// A filter name without a scope (`--filter cms`) resolves the way pnpm 9 does:
// an exact package name first, otherwise the single `@<scope>/cms`. When two
// scopes have a `cms`, pnpm selects nothing, and the guard reports the filter
// as ambiguous.
//
// `run` is resolved, not skipped: `pnpm run nosuch` and `pnpm -F <pkg> run
// nosuch` are reported exactly like `pnpm nosuch`. pnpm's other subcommands
// (`install`, `exec`, `dlx`, `create`, …) are builtins, not missing scripts —
// UNLESS the target package defines a script with the builtin's name. Then
// pnpm silently runs its builtin, not the script: `pnpm -F @lumibase/cms
// deploy` is pnpm's `deploy` (which fails asking for a target directory), not
// the `deploy` script `apps/cms` defines. That is reported with the fix,
// `pnpm … run deploy` (B168).
//
// When no script matches, pnpm 9 runs a binary of that name instead, so
// `pnpm tsx scripts/x.ts` from a package that has `tsx` installed works. The
// guard models that fallback for the root and directory forms only, since
// pnpm does not fall back under `--filter`/`-r` (measured: "None of the
// selected packages has a "wrangler" script"); there the message suggests
// `pnpm … exec <bin>`. Only `node_modules/.bin` (of the directory and of the
// repository root) and `node` itself are modelled. Any other command on PATH
// (`pnpm git …`) is reported: write the command directly, or use `pnpm exec`.
// The lookup reads the checkout, so a tree without `pnpm install` reports
// implicit-exec lines — the loud direction. CI installs before `check:all`.
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
// - Prose and inline code: only fences are read. A wrong command in a table
//   cell or a sentence is invisible here.
// - Non-shell fences (`sql`, `ts`, `json`, `md`, `text`, …), see above.
// - Filter selectors that are patterns rather than names (`./apps/*`,
//   `@lumibase/cms...`, `{apps/**}`, `!x`): pnpm resolves those, not this guard.
// - Packages in OPTIONAL_PACKAGES: absent from the checkout, so neither their
//   scripts nor a builtin that shadows one can be verified.
// - `pnpm -C <dir> <bin>`: pnpm 9 mis-parses implicit exec after `-C`
//   (measured: `Command "apps/cms" not found`). The guard treats `-C` like
//   `cd` and does not model the quirk.
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

/**
 * pnpm's own subcommands and their aliases. A builtin is never a missing
 * script — but it shadows a script of the same name (see the header).
 */
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

/**
 * Fence languages whose lines are commands. Untagged fences (`''`) are
 * included: most command blocks in the docs are written that way.
 */
export const SHELL_FENCES = new Set([
  '', 'bash', 'sh', 'shell', 'zsh', 'console', 'shell-session', 'sh-session', 'terminal',
  'yaml', 'yml', 'dockerfile', 'docker',
]);

/** Commands pnpm 9 can fall back to that are not in any `node_modules/.bin`. */
const SYSTEM_COMMANDS = new Set(['node']);

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

/** name -> repo-relative dir for every package.json in the workspace. */
export function collectPackageDirsByName(root) {
  return new Map(walkPackages(root).map((p) => [p.name, p.dir]));
}

/**
 * `(dir, name) => boolean`: whether pnpm 9's implicit exec would find a binary
 * `name` when run from repo-relative `dir` — in that directory's
 * `node_modules/.bin` or in the repository root's.
 */
export function binLookup(root) {
  return (dir, name) =>
    fs.existsSync(path.join(root, dir, 'node_modules', '.bin', name)) ||
    fs.existsSync(path.join(root, 'node_modules', '.bin', name));
}

/**
 * A `--filter` name resolved the way pnpm 9 does: an exact package name, or —
 * when the name has no `@` and no `/` — the single `@<scope>/<name>`. Two or
 * more scoped matches select nothing in pnpm, so they are `ambiguous` here.
 */
export function resolveFilterName(name, names) {
  const all = [...names];
  if (all.includes(name)) return { pkg: name };
  if (!name.includes('@') && !name.includes('/')) {
    const scoped = all.filter((n) => /^@[^/]+\//.test(n) && n.slice(n.indexOf('/') + 1) === name);
    if (scoped.length === 1) return { pkg: scoped[0] };
    if (scoped.length > 1) return { ambiguous: scoped.sort() };
  }
  return { missing: true };
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
 * names nothing (bare `pnpm`, `pnpm run` with no name). A builtin subcommand
 * comes back with `builtin: true`, so the caller can tell whether it shadows a
 * script of the same name.
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
    const kind = filters.length > 0 ? 'filtered' : recursive ? 'recursive' : 'root';
    if (!sawRun && PNPM_SUBCOMMANDS.has(word))
      return { kind, pkg: filters[0], filters, script: word, cwd: dir, ifPresent, builtin: true };
    if (!/^[A-Za-z0-9_$<{][A-Za-z0-9:_.\-<>{}$*]*$/.test(word)) return null;
    return { kind, pkg: filters[0], filters, script: word, cwd: dir, ifPresent };
  }
  return null;
}

const COMMENT_LINE = /^\s*(#|\/\/)/;

/** A line that closes the fence `open` (same char, at least as long, nothing after). */
function closesFence(line, open) {
  const close = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
  return Boolean(close) && close[1][0] === open.char && close[1].length >= open.length;
}

/**
 * The logical lines inside shell-like fences: `{ text, lineNumber, fence }`,
 * where `fence` numbers the fence a line belongs to and `lineNumber` is the
 * first physical line of a `\`-continued command. See the header for the
 * fence rules. Pure, so it is testable on its own.
 */
export function fencedLines(text) {
  const out = [];
  const lines = text.split('\n');
  let open = null;
  let fences = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!open) {
      const opener = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
      if (!opener) continue;
      const info = opener[2].trim();
      // CommonMark: a backtick fence's info string cannot contain a backtick
      // (that line is inline code, e.g. ```` ```x``` ````).
      if (opener[1][0] === '`' && info.includes('`')) continue;
      fences += 1;
      open = {
        char: opener[1][0],
        length: opener[1].length,
        lang: info.split(/\s+/)[0].toLowerCase(),
        id: fences,
      };
      continue;
    }
    if (closesFence(line, open)) {
      open = null;
      continue;
    }
    if (!SHELL_FENCES.has(open.lang)) continue;
    const lineNumber = i + 1;
    let logical = line;
    // Join `\`-continued lines the way the shell does. A comment does not
    // continue, and a fence closer ends the command.
    while (
      !COMMENT_LINE.test(logical) &&
      /\\\s*$/.test(logical) &&
      i + 1 < lines.length &&
      !closesFence(lines[i + 1], open)
    ) {
      logical = `${logical.replace(/\\\s*$/, '')} ${lines[i + 1]}`;
      i += 1;
    }
    out.push({ text: logical, lineNumber, fence: open.id });
  }
  return out;
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
  let fence = 0;
  let cwd = '.';
  for (const { text: line, lineNumber, fence: id } of fencedLines(text)) {
    if (id !== fence) {
      fence = id;
      cwd = '.'; // every fence starts at the repository root
    }
    if (COMMENT_LINE.test(line)) continue; // a comment, not a command
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
  }
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

/**
 * Problems for one document, given the workspace's scripts.
 *
 * `binExists(dir, name)` answers pnpm 9's implicit-exec fallback (see the
 * header); it is injected so tests never depend on what is installed, and it
 * defaults to "nothing is installed". `packageDirsByName` maps a package name
 * to its directory for that lookup under `--filter`.
 */
export function checkDocument({
  rel,
  text,
  rootScripts,
  packages,
  packageDirs = new Map(),
  packageDirsByName = new Map(),
  binExists = () => false,
}) {
  const problems = [];
  const skipRootForm = USER_PROJECT_DOCS.has(rel);
  for (const command of extractCommands(text, { packageDirs })) {
    const where = `${rel}:${command.lineNumber}  \`${command.text}\``;
    const { script } = command;

    // Which packages a filtered command selects, with problems for the filters
    // that select nothing (unknown or ambiguous names).
    const selected = [];
    if (command.kind === 'filtered') {
      for (const filter of command.filters) {
        if (SELECTOR.test(filter)) continue;
        const resolved = resolveFilterName(filter, packages.keys());
        if (resolved.pkg) selected.push(resolved.pkg);
        else if (OPTIONAL_PACKAGES.has(filter)) continue;
        else if (resolved.ambiguous)
          problems.push(
            `${where} — ${filter} is ambiguous (matches ${resolved.ambiguous.join(', ')}); pnpm selects nothing — use the scoped name`,
          );
        else problems.push(`${where} — no workspace package is named ${filter}`);
      }
    }

    if (command.builtin) {
      // A builtin is fine unless a target defines a script with its name: pnpm
      // then runs the builtin and the script is silently never run (B168).
      let targets;
      if (command.kind === 'filtered') targets = selected.map((pkg) => [pkg, packages.get(pkg)]);
      else if (command.kind === 'recursive') targets = [...packages.entries()];
      else if (command.cwd === '.') targets = skipRootForm ? [] : [['the root package', rootScripts]];
      else targets = [[`${command.cwd}/package.json`, packageDirs.get(command.cwd) ?? new Set()]];
      const shadowed = targets.filter(([, scripts]) => scripts.has(script)).map(([name]) => name);
      if (shadowed.length > 0) {
        const fixed = command.text.replace(new RegExp(`\\s${script}$`), ` run ${script}`);
        problems.push(
          `${where} — pnpm runs its builtin "${script}" here, not the "${script}" script of ${shadowed.join(', ')}; use \`${fixed}\``,
        );
      }
      continue;
    }

    if (command.kind === 'filtered') {
      if (command.ifPresent || selected.length === 0) continue;
      if (!selected.some((pkg) => hasScript(packages.get(pkg), script))) {
        const bin = selected.some((pkg) => binExists(packageDirsByName.get(pkg) ?? '.', script))
          ? ` — pnpm does not fall back to binaries with --filter/-r; use \`pnpm --filter ${selected[0]} exec ${script}\``
          : '';
        problems.push(
          (selected.length === 1
            ? `${where} — ${selected[0]} has no "${script}" script (it has: ${listed(packages.get(selected[0]))})`
            : `${where} — none of ${selected.join(', ')} has a "${script}" script`) + bin,
        );
      }
    } else if (command.kind === 'recursive') {
      if (command.ifPresent) continue;
      if (![...packages.values()].some((scripts) => hasScript(scripts, script))) {
        const bin = binExists('.', script)
          ? ` — pnpm does not fall back to binaries with --filter/-r; use \`pnpm -r exec ${script}\``
          : '';
        problems.push(`${where} — no workspace package has a "${script}" script${bin}`);
      }
    } else if (command.cwd === '.') {
      if (skipRootForm || command.ifPresent) continue;
      if (hasScript(rootScripts, script)) continue;
      // pnpm 9 runs a binary when no script matches (root and dir form only).
      if (SYSTEM_COMMANDS.has(script) || binExists('.', script)) continue;
      problems.push(`${where} — the root package.json has no "${script}" script`);
    } else {
      const scripts = packageDirs.get(command.cwd);
      if (command.ifPresent || !scripts) continue;
      if (hasScript(scripts, script)) continue;
      if (SYSTEM_COMMANDS.has(script) || binExists(command.cwd, script)) continue;
      problems.push(
        `${where} — ${command.cwd}/package.json has no "${script}" script (it has: ${listed(scripts)})`,
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
  const packageDirsByName = collectPackageDirsByName(REPO_ROOT);
  const binExists = binLookup(REPO_ROOT);
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
        packageDirsByName,
        binExists,
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
