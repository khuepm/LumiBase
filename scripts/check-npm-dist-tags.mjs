#!/usr/bin/env node
/**
 * Guard against `latest` on npm pointing at a prerelease.
 *
 * The release workflow already computes the right tag —
 * `version.includes('-') ? 'next' : 'latest'` — and publishes with
 * `--tag next` for a release candidate. That reads correctly and still does
 * not produce what it promises, because npm assigns `latest` on the **first**
 * publish of a brand-new package regardless of `--tag`.
 *
 * That is not hypothetical. `lumibase` and `@lumibase/contracts` were both
 * born at `1.0.0-rc.1`, so both ended up with `latest = 1.0.0-rc.1` while
 * `@lumibase/sdk`, `create-lumibase`, `@lumibase/mcp-server` and
 * `@lumibase/extension-sdk` correctly kept `latest = 0.26.0` with the RC on
 * `next`. `npm i lumibase` and `npm i @lumibase/sdk` therefore resolved to two
 * different generations of the same product.
 *
 * Two distinct situations, two different verdicts — collapsing them would make
 * the guard either useless or unpassable:
 *
 *   - a stable version exists but `latest` points at a prerelease → drift that
 *     CAN be repaired, so fail (or repair it with `--fix`);
 *   - no stable version exists at all → nothing to point `latest` at, and
 *     `npm dist-tag rm <pkg> latest` is not permitted. Warn, do not fail:
 *     the only real fix is shipping a stable release, which is a human
 *     decision, not something CI should block on.
 *
 * `--fix` is deliberately **not** used in CI. Epic #331 states "không tự đổi
 * dist-tag", and #448 records that the owner chose to keep `latest` on the RC
 * for `lumibase`. So the release workflow runs this as a report, and moving a
 * tag stays an explicit human act via `pnpm dist-tags:fix`.
 *
 * Dependency-free on purpose, matching the other install/release guards: a
 * check on publishing must not depend on a successful install.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── version handling ───────────────────────────────────────────────────────

/**
 * A version is a prerelease when it carries a `-` suffix. Same rule the
 * release workflow uses to pick the dist-tag, kept identical on purpose: if
 * the two ever disagree, the guard would be checking a different question than
 * the one the publish step answered.
 */
export function isPrerelease(version) {
  return typeof version === 'string' && version.includes('-');
}

/** `[major, minor, patch]`, or null when the version is not parseable. */
export function parseVersion(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version).trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Highest stable (non-prerelease) version, compared numerically.
 *
 * Numerically matters: sorted as strings, `0.9.0` beats `0.26.0` and the guard
 * would "repair" `latest` by pointing it at an older release.
 */
export function highestStable(versions) {
  const stable = (versions ?? []).filter((v) => !isPrerelease(v) && parseVersion(v));
  if (stable.length === 0) return null;
  return stable.sort(compareVersions)[stable.length - 1];
}

// ── the decision ───────────────────────────────────────────────────────────

/**
 * @param {{ name: string, versions?: string[], distTags?: Record<string,string> }} pkg
 * @returns {{ name: string, action: 'ok'|'realign'|'warn', latest: string|null, to?: string, reason?: string }}
 */
export function decideDistTag({ name, versions = [], distTags = {} }) {
  const latest = distTags.latest ?? null;

  // Never published, or no `latest` at all: nothing to assert.
  if (!latest) return { name, action: 'ok', latest: null, reason: 'no-latest-tag' };

  if (!isPrerelease(latest)) return { name, action: 'ok', latest };

  const stable = highestStable(versions);
  if (stable) return { name, action: 'realign', latest, to: stable };

  return { name, action: 'warn', latest, reason: 'no-stable-version' };
}

// ── registry access ────────────────────────────────────────────────────────

function readPublicPackages() {
  const dir = join(root, 'packages');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(dir, entry.name, 'package.json'))
    .filter((path) => existsSync(path))
    .map((path) => JSON.parse(readFileSync(path, 'utf8')))
    .filter((manifest) => manifest.private !== true && manifest.name)
    .map((manifest) => manifest.name);
}

function viewPackage(name) {
  const result = spawnSync('npm', ['view', name, '--json'], { encoding: 'utf8' });
  if (result.status !== 0) {
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    // Not published yet is a valid state, not a failure: a package can be
    // public in the repo and not on the registry until its first release.
    if (/E404|is not in this registry/i.test(output)) return null;
    throw new Error(`npm view ${name} failed:\n${output}`);
  }
  const parsed = JSON.parse(result.stdout);
  // `npm view` returns an array when several versions match the selector.
  const manifest = Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed;
  return {
    name,
    versions: manifest.versions ?? [],
    distTags: manifest['dist-tags'] ?? {},
  };
}

function realign(name, version) {
  const result = spawnSync('npm', ['dist-tag', 'add', `${name}@${version}`, 'latest'], {
    encoding: 'utf8',
    stdio: 'inherit',
  });
  return result.status === 0;
}

// ── CLI ────────────────────────────────────────────────────────────────────

function main(argv) {
  const fix = argv.includes('--fix');
  const names = readPublicPackages();

  if (names.length === 0) {
    console.log('No public packages to check.');
    return 0;
  }

  const drift = [];
  const warnings = [];

  for (const name of names) {
    const pkg = viewPackage(name);
    if (!pkg) {
      console.log(`• ${name} — not published yet, skipping.`);
      continue;
    }

    const verdict = decideDistTag(pkg);

    if (verdict.action === 'ok') {
      console.log(`✔ ${name} — latest = ${verdict.latest ?? '(none)'}`);
      continue;
    }

    if (verdict.action === 'warn') {
      warnings.push(verdict);
      const message =
        `${name}: latest = ${verdict.latest} is a prerelease and no stable version exists. ` +
        'npm assigns latest on a package\'s first publish regardless of --tag, so this cannot ' +
        'be repaired by retagging — only by publishing a stable release.';
      console.log(`::warning::${message}`);
      continue;
    }

    drift.push(verdict);
    console.log(
      `✖ ${name} — latest = ${verdict.latest} is a prerelease while ${verdict.to} is stable.`,
    );

    if (fix) {
      if (realign(name, verdict.to)) {
        console.log(`  ↳ repointed latest to ${verdict.to}`);
        drift.pop();
      } else {
        console.log(`  ↳ failed to repoint latest to ${verdict.to}`);
      }
    }
  }

  if (drift.length > 0) {
    console.error(
      `\nlatest points at a prerelease for: ${drift.map((d) => d.name).join(', ')}\n` +
        'Repair with: node scripts/check-npm-dist-tags.mjs --fix',
    );
    return 1;
  }

  if (warnings.length > 0) {
    console.log(
      `\n${warnings.length} package(s) have no stable release yet — latest stays on a prerelease ` +
        'until one ships. Not a failure.',
    );
  }

  return 0;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
