#!/usr/bin/env node
// Generates apps/docs/public/releases.json — the manifest Studio fetches from
// https://docs.lumibase.dev/releases.json for its opt-in "check for updates".
//
// The file is git-TRACKED and its editorial fields (migrationWarning,
// minimumSafeUpgradeVersion) are hand-set at release time (see the `release`
// skill) — it is the source of truth for those, not a throwaway build artifact.
// So generation is IDEMPOTENT: `version` comes from the repo, but editorial
// fields and `releaseDate` are preserved from the committed manifest unless an
// explicit override is present (env var, or a matching CHANGELOG heading for the
// date). This keeps a plain `docs:build` from dirtying the working tree and
// stops a deploy build from clobbering a hand-set editorial value back to its
// default.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
const version = (process.env.LUMIBASE_VERSION || pkg.version).replace(/^v/, '');

// Editorial fields are preserved from the previously committed manifest when not
// explicitly overridden (see header). Read it first; absent on first generation.
const MANIFEST_PATH = path.join(REPO_ROOT, 'apps/docs/public/releases.json');
let previous = {};
try {
  previous = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))?.stable ?? {};
} catch {
  // No committed manifest yet — fall through to defaults.
}

// releaseDate precedence: matching CHANGELOG heading → committed value → today.
let releaseDate;
try {
  const changelog = readFileSync(path.join(REPO_ROOT, 'CHANGELOG.md'), 'utf8');
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = changelog.match(new RegExp(`^## \\[${escaped}\\] - (\\d{4}-\\d{2}-\\d{2})`, 'm'));
  if (match) releaseDate = match[1];
} catch {
  // CHANGELOG is optional for manifest generation.
}
releaseDate = releaseDate || previous.releaseDate || new Date().toISOString().slice(0, 10);

// Editorial fields: explicit env override → committed value → default.
const minimumSafeUpgradeVersion =
  process.env.LUMIBASE_MIN_SAFE_UPGRADE || previous.minimumSafeUpgradeVersion || '0.0.0';
const migrationWarning =
  process.env.LUMIBASE_MIGRATION_WARNING !== undefined
    ? process.env.LUMIBASE_MIGRATION_WARNING === 'true'
    : (previous.migrationWarning ?? false);

const channel = {
  version,
  releaseDate,
  changelogUrl: `https://github.com/khuepm/lumibase/releases/tag/v${version}`,
  minimumSafeUpgradeVersion,
  migrationWarning,
  upgradeGuideUrl: 'https://docs.lumibase.dev/upgrade',
};

// One stable release stream for now; `edge` mirrors stable until a prerelease channel exists.
const manifest = { stable: channel, edge: channel };

mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`[release-manifest] wrote apps/docs/public/releases.json for v${version} (${releaseDate}).`);
