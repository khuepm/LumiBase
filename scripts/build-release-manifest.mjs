#!/usr/bin/env node
// Generates apps/docs/public/releases.json — the manifest Studio fetches from
// https://docs.lumibase.dev/releases.json for its opt-in "check for updates".
// Version/date are derived from the repo so the manifest stays in sync with the
// release; editorial fields can be overridden via env for a given release.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
const version = (process.env.LUMIBASE_VERSION || pkg.version).replace(/^v/, '');

// releaseDate from the `## [<version>] - <YYYY-MM-DD>` CHANGELOG heading, else today (UTC).
let releaseDate = new Date().toISOString().slice(0, 10);
try {
  const changelog = readFileSync(path.join(REPO_ROOT, 'CHANGELOG.md'), 'utf8');
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = changelog.match(new RegExp(`^## \\[${escaped}\\] - (\\d{4}-\\d{2}-\\d{2})`, 'm'));
  if (match) releaseDate = match[1];
} catch {
  // CHANGELOG is optional for manifest generation; fall back to today.
}

const minimumSafeUpgradeVersion = process.env.LUMIBASE_MIN_SAFE_UPGRADE || '0.0.0';
const migrationWarning = process.env.LUMIBASE_MIGRATION_WARNING === 'true';

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

const outDir = path.join(REPO_ROOT, 'apps/docs/public');
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'releases.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`[release-manifest] wrote apps/docs/public/releases.json for v${version} (${releaseDate}).`);
