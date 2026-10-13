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
// WHAT IT CHECKS, AND WHAT IT DELIBERATELY DOES NOT
// -------------------------------------------------
// Only lines inside fenced code blocks, because prose says things like "the pnpm
// workspace" that are not commands. Comment lines inside a fence are skipped for
// the same reason.
//
// Two command shapes are resolved:
//   pnpm -F <pkg> <script> / pnpm --filter <pkg> <script>  -> that package.json
//   pnpm <script>                                          -> the root package.json
//
// pnpm's own subcommands (`install`, `exec`, `dlx`, `config`, …) are skipped in
// the script position: `pnpm -F @lumibase/cms exec tsx x.ts` is a builtin, not a
// missing script.
//
// The root form is the risky one to enforce, because docs legitimately show
// commands for a *scaffolded user project* (`pnpm dev` in a generated Hono app
// is not a root script and must not fail this check). Those live in files listed
// in USER_PROJECT_DOCS below, which are skipped for the root form only — the
// filtered form still applies there, since `-F @lumibase/...` can only mean this
// repository.
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
 */
const USER_PROJECT_DOCS = new Set([
  'docs/en/getting-started.md',
  'docs/vi/getting-started.md',
  'docs/en/tutorials/nextjs-quickstart.md',
  'docs/vi/tutorials/nextjs-quickstart.md',
  'docs/en/sdk/typegen.md',
  'docs/vi/sdk/typegen.md',
  'README.md',
]);

/**
 * Workspace members that may legitimately be absent from a checkout.
 * `@lumibase/enterprise` lives in a private submodule; documenting its commands
 * must not require having access to it.
 */
const OPTIONAL_PACKAGES = new Set(['@lumibase/enterprise']);

/** pnpm's own subcommands — never a package script. */
const PNPM_SUBCOMMANDS = new Set([
  'add', 'approve-builds', 'audit', 'bin', 'config', 'dedupe', 'deploy', 'dlx',
  'doctor', 'env', 'exec', 'fetch', 'i', 'import', 'init', 'install', 'licenses',
  'link', 'list', 'ls', 'outdated', 'pack', 'patch', 'patch-commit', 'prune',
  'publish', 'rebuild', 'recursive', 'remove', 'rm', 'root', 'run', 'self-update',
  'server', 'setup', 'store', 'unlink', 'up', 'update', 'version', 'why',
]);

/** name -> Set(scripts) for every package.json in the workspace. */
export function collectPackages(root) {
  const packages = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'dist', '.turbo', 'templates'].includes(entry.name))
        continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'package.json' && full !== path.join(root, 'package.json')) {
        try {
          const json = JSON.parse(fs.readFileSync(full, 'utf8'));
          if (json.name) packages.set(json.name, new Set(Object.keys(json.scripts ?? {})));
        } catch {
          // A fixture with intentionally broken JSON is not this guard's problem.
        }
      }
    }
  };
  walk(root);
  return packages;
}

/**
 * Commands found in the fenced code blocks of one Markdown document.
 *
 * Pure (takes text, not a path) so the parsing rules are testable without a
 * repository on disk.
 */
export function extractCommands(text) {
  const found = [];
  let inFence = false;
  text.split('\n').forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (!inFence) return;
    if (/^\s*(#|\/\/)/.test(line)) return; // a comment, not a command
    const lineNumber = index + 1;
    for (const match of line.matchAll(/pnpm\s+(?:-F|--filter)\s+(\S+)\s+([A-Za-z0-9:_.-]+)/g))
      found.push({ kind: 'filtered', pkg: match[1], script: match[2], lineNumber, text: match[0] });
    for (const match of line.matchAll(/(?:^|[`$\s(&|;])pnpm\s+(?!-)([A-Za-z][A-Za-z0-9:_.-]*)/g))
      found.push({ kind: 'root', script: match[1], lineNumber, text: match[0].trim() });
  });
  return found;
}

/** Problems for one document, given the workspace's scripts. */
export function checkDocument({ rel, text, rootScripts, packages }) {
  const problems = [];
  const skipRootForm = USER_PROJECT_DOCS.has(rel);
  for (const command of extractCommands(text)) {
    if (PNPM_SUBCOMMANDS.has(command.script)) continue;
    if (command.kind === 'filtered') {
      if (OPTIONAL_PACKAGES.has(command.pkg)) continue;
      const scripts = packages.get(command.pkg);
      if (!scripts)
        problems.push(
          `${rel}:${command.lineNumber}  \`${command.text}\` — no workspace package is named ${command.pkg}`,
        );
      else if (!scripts.has(command.script))
        problems.push(
          `${rel}:${command.lineNumber}  \`${command.text}\` — ${command.pkg} has no "${command.script}" script (it has: ${[...scripts].sort().join(', ')})`,
        );
    } else if (!skipRootForm && !rootScripts.has(command.script)) {
      problems.push(
        `${rel}:${command.lineNumber}  \`${command.text}\` — the root package.json has no "${command.script}" script`,
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
  const docs = collectDocs(REPO_ROOT);

  const problems = [];
  for (const file of docs) {
    const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
    problems.push(
      ...checkDocument({ rel, text: fs.readFileSync(file, 'utf8'), rootScripts, packages }),
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
