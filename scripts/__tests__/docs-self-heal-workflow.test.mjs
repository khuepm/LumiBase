// Contract for .github/workflows/docs-self-heal.yml (#756). Syntax and
// expressions are validated by the `workflow-lint` job in ci.yml (actionlint +
// shellcheck); this pins the properties that job cannot know are required.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const wf = fs.readFileSync(new URL('../../.github/workflows/docs-self-heal.yml', import.meta.url), 'utf8');
const code = wf.replace(/^\s*#.*$/gm, ''); // ignore comments for the "must not" checks

/** Text of one job block (from `  <name>:` to the next top-level job). */
function job(name) {
  const m = new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][\\w-]*:\\n|(?![\\s\\S]))`, 'm').exec(code);
  assert.ok(m, `job ${name} missing`);
  return m[1];
}

test('is plain YAML a workflow parser can read: no tabs, top-level keys present', () => {
  assert.doesNotMatch(wf, /\t/);
  for (const key of ['name:', 'on:', 'jobs:']) assert.match(wf, new RegExp(`^${key}`, 'm'));
});

test('triggers: PRs (code + docs), pushes to main, manual dispatch', () => {
  assert.match(code, /^  pull_request:\n    paths:[\s\S]*?- 'apps\/\*\*'[\s\S]*?- 'docs\/vi\/\*\*'/m);
  assert.match(code, /^  push:\n    branches:\n      - main/m);
  assert.match(code, /^  workflow_dispatch:/m);
});

test('the PR gate is read-only and runs the drift gate with full history', () => {
  const gate = job('gate');
  assert.match(gate, /if: github\.event_name == 'pull_request'/);
  assert.match(gate, /permissions:\n      contents: read\n/);
  assert.doesNotMatch(gate, /write/);
  assert.match(gate, /fetch-depth: 0/);
  assert.match(gate, /node scripts\/docs-i18n\/gate-code-drift\.mjs/);
});

test('the heal job has least privilege and opens/updates ONE PR on a fixed branch', () => {
  const heal = job('heal');
  assert.match(heal, /permissions:\n      contents: write\n      pull-requests: write\n/);
  assert.match(code, /HEAL_BRANCH: docs\/self-heal/);
  assert.match(heal, /node scripts\/docs-i18n\/self-heal\.mjs/);
  assert.match(heal, /gh pr list --head "\$HEAL_BRANCH" --state open/);
  assert.match(heal, /gh pr edit "\$existing"/);
  assert.match(heal, /gh pr create/);
  assert.match(heal, /git checkout -B "\$HEAL_BRANCH"/, 'branch rebuilt each run (idempotent)');
  assert.match(heal, /GH_TOKEN: \$\{\{ github\.token \}\}/);
});

test('no model call, no API key, no auto-merge, no third-party secrets', () => {
  assert.doesNotMatch(code, /ANTHROPIC|OPENAI|--apply|sync\.mjs/);
  assert.doesNotMatch(code, /secrets\./);
  assert.doesNotMatch(code, /auto-?merge|gh pr merge/i);
  assert.doesNotMatch(code, /^permissions:/m, 'no workflow-wide grant; per-job only');
});

test('the range base is sticky across runs via the marker self-heal writes', async () => {
  const { BASE_MARKER } = await import('../docs-i18n/self-heal.mjs');
  const marker = BASE_MARKER('a'.repeat(40));
  assert.match(code, /<!-- self-heal-base: /);
  assert.equal(marker, `<!-- self-heal-base: ${'a'.repeat(40)} -->`);
});
