#!/usr/bin/env node
/**
 * Guard against overrides silently overruling a manifest.
 *
 * `pnpm.overrides` apply to **direct** dependencies too, not just transitive
 * ones. So an override can quietly replace what a workspace package declares,
 * and nothing warns about it. That is not hypothetical: `overrides.vite` sat at
 * `^7.3.5` while `apps/studio` and `apps/docs` both declared `^8.1.3`, and the
 * lockfile importer recorded `specifier: ^7.3.5 → 7.3.6`. Both apps were built
 * with Vite 7 for as long as their manifests claimed Vite 8.
 *
 * `check-pnpm-settings-parity.mjs` cannot catch this: the two override copies
 * agreed with each other perfectly. They were only both wrong relative to the
 * manifests. This script closes that gap by requiring every override range to
 * intersect every directly declared range for the same package.
 *
 * Dependency-free on purpose, matching the parity script: a check on install
 * settings must not itself depend on a successful install.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── range handling ─────────────────────────────────────────────────────────
//
// Only the forms this repo actually uses in overrides and manifests: exact,
// `^`, `~`, `>=`/`>`, `*`, and `||` alternatives. Anything unrecognised is
// treated as "cannot reason about it" and skipped rather than guessed at — a
// guard that invents a verdict is worse than one that admits ignorance.

export function parseVersion(text) {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(text.trim());
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
  // How many components the author actually wrote. A partial version is a
  // range, not a point: `3` means 3.x, `3.3` means 3.3.x, only `3.3.0` is
  // exact. Override scope keys rely on this — `nanoid@3` is the 3.x branch.
  parts.specified = m[3] !== undefined ? 3 : m[2] !== undefined ? 2 : 1;
  return parts;
}

export function compare(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/** One comparator set: `{ floor, ceilExclusive | null }`. */
export function parseSimpleRange(raw) {
  const text = raw.trim();
  if (text === '' || text === '*' || text === 'x') return { floor: [0, 0, 0], ceil: null };

  const op = /^(\^|~|>=|>|=)?\s*v?(.+)$/.exec(text);
  if (!op) return null;
  const [, operator = '', rest] = op;
  const version = parseVersion(rest);
  if (!version) return null;

  const [maj, min] = version;
  switch (operator) {
    case '^':
      // ^0.x.y is minor-locked; ^X.y.z (X>0) is major-locked.
      return maj === 0
        ? { floor: version, ceil: [0, min + 1, 0] }
        : { floor: version, ceil: [maj + 1, 0, 0] };
    case '~':
      return { floor: version, ceil: [maj, min + 1, 0] };
    case '>=':
      return { floor: version, ceil: null };
    case '>':
      return { floor: [version[0], version[1], version[2] + 1], ceil: null };
    case '=':
    case '': {
      if (version.specified === 1) return { floor: version, ceil: [maj + 1, 0, 0] };
      if (version.specified === 2) return { floor: version, ceil: [maj, min + 1, 0] };
      return { floor: version, ceil: [version[0], version[1], version[2] + 1] };
    }
    default:
      return null;
  }
}

/** A range is a union of comparator sets joined by `||`. */
export function parseRange(raw) {
  if (typeof raw !== 'string') return null;
  // Skip non-registry protocols: workspace:, catalog:, link:, file:, npm:, git.
  if (/^[a-z]+:/i.test(raw.trim())) return null;
  const parts = raw.split('||').map(parseSimpleRange);
  if (parts.some((p) => p === null)) return null;
  return parts;
}

export function setsIntersect(a, b) {
  // Overlap when each set's floor sits below the other's ceiling.
  const aBelowB = b.ceil === null || compare(a.floor, b.ceil) < 0;
  const bBelowA = a.ceil === null || compare(b.floor, a.ceil) < 0;
  return aBelowB && bBelowA;
}

export function rangesIntersect(a, b) {
  return a.some((x) => b.some((y) => setsIntersect(x, y)));
}

// ── override keys ──────────────────────────────────────────────────────────

/** `nanoid@3` → name `nanoid`, scope `3`. `@types/react` → no scope. */
export function splitOverrideKey(key) {
  const at = key.startsWith('@') ? key.indexOf('@', 1) : key.indexOf('@');
  if (at === -1) return { name: key, scope: null };
  return { name: key.slice(0, at), scope: key.slice(at + 1) };
}

function main() {
  // ── workspace discovery ────────────────────────────────────────────────────

  function workspaceGlobs(text) {
    const include = [];
    const exclude = [];
    let inPackages = false;
    for (const rawLine of text.split('\n')) {
      const line = rawLine.replace(/\s+#.*$/, '');
      if (/^packages:\s*$/.test(line)) { inPackages = true; continue; }
      if (inPackages && /^\S/.test(line)) break;
      if (!inPackages) continue;
      const m = /^\s*-\s*["']?(.+?)["']?\s*$/.exec(line);
      if (!m) continue;
      const pattern = m[1];
      if (pattern.startsWith('!')) exclude.push(pattern.slice(1));
      else include.push(pattern);
    }
    return { include, exclude };
  }

  function expand(pattern) {
    if (!pattern.endsWith('/*')) return [pattern];
    const dir = pattern.slice(0, -2);
    const abs = join(root, dir);
    if (!existsSync(abs)) return [];
    return readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => `${dir}/${e.name}`);
  }

  const workspaceText = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
  const { include, exclude } = workspaceGlobs(workspaceText);
  const packageDirs = include
    .flatMap(expand)
    .filter((d) => !exclude.includes(d))
    .filter((d) => existsSync(join(root, d, 'package.json')));

  // ── the check ──────────────────────────────────────────────────────────────

  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const overrides = pkg.pnpm?.overrides ?? {};

  const DEP_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies'];

  /** name → [{ dir, section, range }] for every direct declaration. */
  const declarations = new Map();
  for (const dir of ['.', ...packageDirs]) {
    const manifest = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
    for (const section of DEP_SECTIONS) {
      for (const [name, range] of Object.entries(manifest[section] ?? {})) {
        if (!declarations.has(name)) declarations.set(name, []);
        declarations.get(name).push({ dir, section, range });
      }
    }
  }

  const problems = [];
  let checked = 0;
  let skipped = 0;

  for (const [key, overrideRange] of Object.entries(overrides)) {
    const { name, scope } = splitOverrideKey(key);
    const declared = declarations.get(name);
    if (!declared) continue; // transitive-only override — the intended use.

    const parsedOverride = parseRange(overrideRange);
    if (!parsedOverride) { skipped += 1; continue; }
    const parsedScope = scope === null ? null : parseRange(scope);

    const offenders = [];
    for (const site of declared) {
      const parsedSite = parseRange(site.range);
      if (!parsedSite) continue;
      // A scoped override only speaks for its own range.
      if (parsedScope && !rangesIntersect(parsedScope, parsedSite)) continue;
      checked += 1;
      if (!rangesIntersect(parsedOverride, parsedSite)) offenders.push(site);
    }

    if (offenders.length > 0) problems.push({ key, overrideRange, offenders });
  }

  if (problems.length > 0) {
    console.error('Override drift detected — an override contradicts what a manifest declares:\n');
    for (const { key, overrideRange, offenders } of problems) {
      console.error(`Override drift: ${key}`);
      console.error(`  override        ${overrideRange}   (package.json -> pnpm.overrides)`);
      for (const o of offenders) {
        console.error(`  declared        ${o.range}   ${o.dir} (${o.section})`);
      }
      console.error(
        '  Ranges do not intersect — the override silently wins and the installed\n' +
          '  version is NOT what these manifests declare.\n' +
          '  Fix: raise the override, or lower the manifests. Do not leave them apart.\n',
      );
    }
    process.exit(1);
  }

  console.log(
    `No override drift: ${checked} direct declaration(s) checked against ` +
      `${Object.keys(overrides).length} override(s)` +
      (skipped > 0 ? `, ${skipped} override(s) skipped as unparseable.` : '.'),
  );

}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
