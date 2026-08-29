#!/usr/bin/env node
/**
 * Guard the duplicated pnpm settings (#295).
 *
 * `pnpm.overrides`, `pnpm.patchedDependencies` and `pnpm.auditConfig` are
 * declared in **both** `package.json` and `pnpm-workspace.yaml` on purpose:
 *
 *  - pnpm 9 (the pinned version) reads them from `package.json` only.
 *  - pnpm 10+ reads them from `pnpm-workspace.yaml` only, and merely `[WARN]`s
 *    about the `package.json` field before ignoring it.
 *
 * Declaring both means a future pnpm bump keeps the security overrides, the
 * gray-matter patch and the audit ignore applied instead of silently dropping
 * them — the failure mode #295 describes, where a contributor sees a wall of
 * unrelated audit failures and a docs build crash explained by one warning
 * line.
 *
 * The cost of duplication is drift, so this script is the guard: it fails when
 * the two copies disagree. Wired into CI next to the other cheap consistency
 * checks. When pnpm 9 support is finally dropped, delete the `pnpm` key from
 * `package.json` and this script along with it.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Minimal YAML reader for the shapes this file actually uses: two levels of
 * `key: value` mappings and `- item` sequences. A dependency-free parser is
 * deliberate — this script runs before `pnpm install` can be trusted, which is
 * the whole point of checking the install settings.
 */
function parseYaml(text) {
  const root = {};
  /** @type {Array<{ indent: number, node: unknown }>} */
  const stack = [{ indent: -1, node: root }];

  for (const rawLine of text.split('\n')) {
    const withoutComment = rawLine.replace(/\s+#.*$/, '').replace(/^\s*#.*$/, '');
    if (withoutComment.trim() === '') continue;

    const indent = withoutComment.length - withoutComment.trimStart().length;
    const line = withoutComment.trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].node;

    if (line.startsWith('- ')) {
      const value = unquote(line.slice(2).trim());
      if (Array.isArray(parent)) parent.push(value);
      continue;
    }

    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = unquote(line.slice(0, colon).trim());
    const value = line.slice(colon + 1).trim();

    if (value === '') {
      // Container — the next line's indent decides map vs sequence.
      const container = {};
      parent[key] = container;
      stack.push({ indent, node: container, key, parent });
      continue;
    }

    parent[key] = unquote(value);
  }

  return root;
}

function unquote(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * A container parsed as `{}` that should have been a list: our sequence
 * handling only fills arrays, so re-read sequences straight from the text.
 */
function readSequence(text, path) {
  const lines = text.split('\n');
  const items = [];
  let depth = 0;
  let indentOfParent = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].replace(/\s+#.*$/, '');
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    if (depth < path.length && trimmed === `${path[depth]}:`) {
      if (depth === 0 || indent > indentOfParent) {
        indentOfParent = indent;
        depth += 1;
        continue;
      }
    }

    if (depth === path.length) {
      if (trimmed.startsWith('- ')) {
        items.push(unquote(trimmed.slice(2)));
        continue;
      }
      if (indent <= indentOfParent) break;
    }
  }

  return items;
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const workspaceText = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
const workspace = parseYaml(workspaceText);

const problems = [];

function compareMap(label, fromPkg = {}, fromWorkspace = {}) {
  const keys = new Set([...Object.keys(fromPkg), ...Object.keys(fromWorkspace)]);
  for (const key of [...keys].sort()) {
    const a = fromPkg[key];
    const b = fromWorkspace[key];
    if (a === undefined) {
      problems.push(`${label}: "${key}" is in pnpm-workspace.yaml but missing from package.json`);
    } else if (b === undefined) {
      problems.push(`${label}: "${key}" is in package.json but missing from pnpm-workspace.yaml`);
    } else if (String(a) !== String(b)) {
      problems.push(`${label}: "${key}" is "${a}" in package.json but "${b}" in pnpm-workspace.yaml`);
    }
  }
}

compareMap('overrides', pkg.pnpm?.overrides, workspace.overrides);
compareMap('patchedDependencies', pkg.pnpm?.patchedDependencies, workspace.patchedDependencies);

const pkgGhsas = pkg.pnpm?.auditConfig?.ignoreGhsas ?? [];
const workspaceGhsas = readSequence(workspaceText, ['auditConfig', 'ignoreGhsas']);
const pkgSorted = [...pkgGhsas].sort().join(',');
const workspaceSorted = [...workspaceGhsas].sort().join(',');
if (pkgSorted !== workspaceSorted) {
  problems.push(
    `auditConfig.ignoreGhsas differs — package.json has [${pkgSorted}], ` +
      `pnpm-workspace.yaml has [${workspaceSorted}]`,
  );
}

if (problems.length > 0) {
  console.error('pnpm settings are out of sync between package.json and pnpm-workspace.yaml:\n');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    '\nBoth copies are required until the pinned pnpm reaches 10 (see #295 and\n' +
      'docs/en/security/dependency-overrides.md). Update both, or drop the\n' +
      '`pnpm` key from package.json once pnpm 9 support ends.',
  );
  process.exit(1);
}

const counts = [
  `${Object.keys(pkg.pnpm?.overrides ?? {}).length} override(s)`,
  `${Object.keys(pkg.pnpm?.patchedDependencies ?? {}).length} patch(es)`,
  `${pkgGhsas.length} audit ignore(s)`,
];
console.log(`pnpm settings in sync: ${counts.join(', ')}.`);
