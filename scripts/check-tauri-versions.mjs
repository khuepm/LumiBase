#!/usr/bin/env node
/**
 * Guard against the Tauri shell's NPM packages and Rust crates drifting apart.
 *
 * `tauri build` refuses to run when an `@tauri-apps/*` package and its crate
 * are on different major/minor releases. Dependabot only watches the npm side,
 * so a grouped bump moved `@tauri-apps/plugin-updater` to 2.12.0 while
 * `Cargo.lock` stayed on `tauri-plugin-updater` 2.10.1 — and every desktop job
 * in release-apps.yml failed from v0.26.0 to v1.0.0-rc.3. Nothing on the PR
 * side noticed: `tauri info` prints the mismatch but exits 0, and the only
 * build that runs `tauri build` is the release itself.
 *
 * This script applies the same rule to the two lockfiles at PR time:
 *   @tauri-apps/api            ↔ tauri
 *   @tauri-apps/plugin-<name>  ↔ tauri-plugin-<name>
 * Packages present on only one side are skipped (a Rust-only plugin such as
 * tauri-plugin-log has no JS binding to agree with).
 *
 * Dependency-free on purpose: it reads the lockfiles as text, so it runs
 * before (and without) an install, like the other repo guards.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHELL_IMPORTER = 'apps/shell';
const CARGO_LOCK = 'apps/shell/src-tauri/Cargo.lock';

/** Resolved versions of one importer's direct deps, from pnpm-lock.yaml. */
export function readPnpmImporter(lockText, importer) {
  const lines = lockText.split('\n');
  const start = lines.findIndex((l) => l === `  ${importer}:`);
  if (start === -1) return new Map();

  const versions = new Map();
  let current = null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    // Next importer (two-space indent) or next top-level key ends the block.
    if (/^ {0,2}\S/.test(line)) break;
    const dep = /^ {6}'?([^':]+)'?:\s*$/.exec(line);
    if (dep) {
      current = dep[1];
      continue;
    }
    const version = /^ {8}version:\s*(\S+)/.exec(line);
    if (version && current) {
      // Strip peer suffixes: `1.2.3(react@19.0.0)` → `1.2.3`.
      versions.set(current, version[1].replace(/\(.*$/, ''));
      current = null;
    }
  }
  return versions;
}

/** Every locked version of every crate, from Cargo.lock. */
export function readCargoLock(lockText) {
  const crates = new Map();
  for (const block of lockText.split('[[package]]').slice(1)) {
    const name = /^name = "([^"]+)"/m.exec(block)?.[1];
    const version = /^version = "([^"]+)"/m.exec(block)?.[1];
    if (!name || !version) continue;
    if (!crates.has(name)) crates.set(name, []);
    crates.get(name).push(version);
  }
  return crates;
}

/** `@tauri-apps/api` → `tauri`, `@tauri-apps/plugin-x` → `tauri-plugin-x`. */
export function crateFor(npmName) {
  if (npmName === '@tauri-apps/api') return 'tauri';
  const plugin = /^@tauri-apps\/plugin-(.+)$/.exec(npmName);
  return plugin ? `tauri-plugin-${plugin[1]}` : null;
}

export function majorMinor(version) {
  const m = /^(\d+)\.(\d+)\./.exec(version);
  return m ? `${m[1]}.${m[2]}` : null;
}

/** Pairs whose major/minor disagree, as `tauri build` would report them. */
export function findMismatches(npmVersions, crates) {
  const mismatches = [];
  let checked = 0;
  for (const [npmName, npmVersion] of npmVersions) {
    const crate = crateFor(npmName);
    if (!crate || !crates.has(crate)) continue;
    checked += 1;
    for (const crateVersion of crates.get(crate)) {
      if (majorMinor(crateVersion) !== majorMinor(npmVersion)) {
        mismatches.push({ npmName, npmVersion, crate, crateVersion });
      }
    }
  }
  return { checked, mismatches };
}

function main() {
  const npmVersions = readPnpmImporter(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'), SHELL_IMPORTER);
  const crates = readCargoLock(readFileSync(join(root, CARGO_LOCK), 'utf8'));

  if (npmVersions.size === 0) {
    console.error(`No "${SHELL_IMPORTER}" importer found in pnpm-lock.yaml — cannot check Tauri versions.`);
    process.exit(1);
  }

  const { checked, mismatches } = findMismatches(npmVersions, crates);
  if (mismatches.length > 0) {
    console.error('Tauri version mismatch — `tauri build` will refuse to run:\n');
    for (const m of mismatches) {
      console.error(`  ${m.crate} (v${m.crateVersion}) : ${m.npmName} (v${m.npmVersion})`);
    }
    console.error(
      '\nThe NPM package and Rust crate must share major.minor.\n' +
        `Fix: cd apps/shell/src-tauri && cargo update -p <crate>, commit ${CARGO_LOCK}.\n`,
    );
    process.exit(1);
  }

  console.log(`Tauri NPM packages and crates agree: ${checked} pair(s) checked.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
