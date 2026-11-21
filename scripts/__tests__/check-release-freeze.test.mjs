/**
 * Release freeze guard (`.github/workflows/release-freeze.yml`).
 * Titles below are real open PRs on 2026-11-20, when the v2.2.0 freeze started.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, loadFreeze, parseTitle } from '../check-release-freeze.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const freeze = loadFreeze(join(root, '.github', 'release-freeze.json'));
const pr = (title, headRef = 'fix/x', labels = []) => evaluate({ title, headRef, labels }, freeze);

test('parseTitle reads type, scopes and the breaking marker', () => {
  assert.deepEqual(parseTitle('fix(security, scim): x'), { type: 'fix', scopes: ['security', 'scim'], breaking: false });
  assert.deepEqual(parseTitle('chore(shell)!: remove'), { type: 'chore', scopes: ['shell'], breaking: true });
  assert.equal(parseTitle('Merge stuff'), null);
});

test('stabilisation work passes', () => {
  for (const t of [
    'fix(ai): Copilot tool catalogue no longer eats the default context budget',
    'chore(release): prepare v2.2.0',
    'test(cdc): compare keyset signs without -0',
    'docs(data-model): release manifest migration is 0043',
    'chore(deps): bump picomatch',
    'perf(import): stream chunks',
  ]) {
    assert.equal(pr(t).allowed, true, t);
  }
});

test('features, epic branches, epic release PRs and breaking changes are blocked', () => {
  assert.equal(pr('feat(integrations): commerce content adapters for Medusa and Shopify (#764)').allowed, false);
  assert.equal(pr('release(epic #869): Release flags — hold until prod release', 'epic/869-release-flags').allowed, false);
  assert.equal(pr('release(epic #900): Backend Templates', 'claude/x').allowed, false);
  assert.equal(pr('fix(flags): small thing', 'epic/869-release-flags').allowed, false);
  assert.equal(pr('chore(shell)!: remove the desktop shell from this repo').allowed, false);
  assert.equal(pr('refactor(items): split service').allowed, false);
  assert.equal(pr('Add new widget').allowed, false, 'unclassifiable titles fail closed');
});

test('security fixes are the exception', () => {
  assert.equal(pr('fix(security): content-integrity hardening P0–P2 (#986–#996)').allowed, true);
  assert.equal(pr('security(richtext): sanitise on render').allowed, true);
  assert.equal(pr('feat(auth): rotate keys', 'feat/x', ['security']).allowed, true, 'label overrides');
  assert.equal(pr('feat(security): new SSO provider').allowed, false, 'a security feature is still a feature');
  assert.equal(pr('fix(security)!: drop legacy tokens').allowed, false, 'breaking needs the label');
});

test('an inactive freeze allows everything', () => {
  assert.equal(evaluate({ title: 'feat: x', headRef: 'epic/1' }, { ...freeze, active: false }).allowed, true);
});
