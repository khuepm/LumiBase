#!/usr/bin/env node
/**
 * Release freeze guard for pull requests into `main`.
 *
 * While `.github/release-freeze.json` has `active: true`, `main` only takes
 * work that finishes the version being stabilised: bug fixes, tests, docs,
 * CI/build/chore, reverts and the release PR itself. New features, epic
 * branches, epic release PRs and breaking changes wait until the freeze is
 * lifted. Security fixes are the exception: a `security` / `fix(security)`
 * title, or the `security` label, always passes.
 *
 * Policy: .kiro/steering/release-freeze.md
 *
 * CLI (used by .github/workflows/release-freeze.yml):
 *   PR_TITLE='fix(api): …' PR_HEAD_REF=fix/123-x PR_LABELS='["bug"]' \
 *     node scripts/check-release-freeze.mjs
 * Exit 0 = allowed, 1 = blocked by the freeze, 2 = bad config.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TITLE_RE = /^([a-z]+)(?:\(([^)]*)\))?(!)?:\s*\S/i;

/** Split a conventional-commit title into its parts, or null when it is not one. */
export function parseTitle(title) {
  const m = TITLE_RE.exec(String(title ?? '').trim());
  if (!m) return null;
  const scopes = (m[2] ?? '')
    .split(/[,/]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return { type: m[1].toLowerCase(), scopes, breaking: m[3] === '!' };
}

/**
 * Decide whether a PR may merge into `main` under the freeze.
 * @param {{ title: string, headRef?: string, labels?: string[] }} pr
 * @param {{ active: boolean, version?: string, allowedTypes: string[], exceptionLabels?: string[] }} freeze
 * @returns {{ allowed: boolean, reason: string }}
 */
export function evaluate(pr, freeze) {
  if (!freeze?.active) return { allowed: true, reason: 'no release freeze is active' };

  const version = freeze.version ? `v${freeze.version}` : 'the current release';
  const labels = (pr.labels ?? []).map((l) => String(l).toLowerCase());
  const exceptionLabels = (freeze.exceptionLabels ?? []).map((l) => l.toLowerCase());
  const hit = labels.find((l) => exceptionLabels.includes(l));
  if (hit) return { allowed: true, reason: `security exception (label "${hit}")` };

  const headRef = String(pr.headRef ?? '');
  if (headRef.startsWith('epic/')) {
    return { allowed: false, reason: `epic branch "${headRef}" cannot merge into main during the ${version} freeze` };
  }

  const parsed = parseTitle(pr.title);
  if (!parsed) {
    return {
      allowed: false,
      reason: 'title is not a conventional commit (type(scope): subject), so the freeze cannot classify it',
    };
  }
  const { type, scopes, breaking } = parsed;

  if (breaking) {
    return { allowed: false, reason: `breaking change ("${type}!") is held until the ${version} freeze is lifted` };
  }
  if (type === 'security' || (type === 'fix' && scopes.includes('security'))) {
    return { allowed: true, reason: 'security fix (exception to the freeze)' };
  }
  if (type === 'release' && scopes.some((s) => s.startsWith('epic'))) {
    return { allowed: false, reason: `epic release PR is held until the ${version} freeze is lifted` };
  }
  if (!freeze.allowedTypes.includes(type)) {
    return {
      allowed: false,
      reason: `"${type}" changes are frozen until ${version} ships; allowed: ${freeze.allowedTypes.join(', ')}`,
    };
  }
  return { allowed: true, reason: `"${type}" is allowed during the ${version} freeze` };
}

export function loadFreeze(path) {
  const freeze = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof freeze.active !== 'boolean' || !Array.isArray(freeze.allowedTypes)) {
    throw new Error(`${path}: needs boolean "active" and array "allowedTypes"`);
  }
  return freeze;
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const configPath = process.env.RELEASE_FREEZE_CONFIG ?? join(root, '.github', 'release-freeze.json');
  let freeze;
  let labels;
  try {
    freeze = loadFreeze(configPath);
    labels = JSON.parse(process.env.PR_LABELS || '[]');
    if (!Array.isArray(labels)) throw new Error('PR_LABELS must be a JSON array');
  } catch (err) {
    console.error(`release-freeze: ${err.message}`);
    process.exit(2);
  }
  const verdict = evaluate(
    { title: process.env.PR_TITLE ?? '', headRef: process.env.PR_HEAD_REF ?? '', labels },
    freeze,
  );
  if (verdict.allowed) {
    console.log(`release-freeze: allowed — ${verdict.reason}`);
    return;
  }
  console.error(`release-freeze: BLOCKED — ${verdict.reason}`);
  console.error(`Policy: ${freeze.policy ?? '.kiro/steering/release-freeze.md'}`);
  console.error('Keep the work on its epic/feature branch; it merges after the release is tagged.');
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
