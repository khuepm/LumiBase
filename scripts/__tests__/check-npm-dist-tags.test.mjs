/**
 * Tripwire for the npm dist-tag guard.
 *
 * A guard that is always green is indistinguishable from a guard that does not
 * work, so the cases below are the real registry state observed on
 * 2026-09-05, package by package: `lumibase` and `@lumibase/contracts` with
 * `latest = 1.0.0-rc.1`, and `@lumibase/sdk` with `latest = 0.26.0` plus the
 * RC parked on `next`.
 *
 * Uses `node --test` rather than Vitest: the guard is dependency-free by
 * design (a check on publishing must not depend on a successful install), and
 * its test should not reintroduce that dependency.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decideDistTag,
  highestStable,
  isPrerelease,
  compareVersions,
} from '../check-npm-dist-tags.mjs';

test('the lumibase case: born at an RC, so latest cannot be repaired', () => {
  // Observed: npm view lumibase versions → ['1.0.0-rc.1'] only.
  const verdict = decideDistTag({
    name: 'lumibase',
    versions: ['1.0.0-rc.1'],
    distTags: { latest: '1.0.0-rc.1', next: '1.0.0-rc.1' },
  });
  assert.equal(verdict.action, 'warn');
  assert.equal(verdict.reason, 'no-stable-version');
});

test('the @lumibase/sdk case: stable on latest, RC on next, nothing to do', () => {
  const verdict = decideDistTag({
    name: '@lumibase/sdk',
    versions: ['0.25.0', '0.26.0', '1.0.0-rc.1'],
    distTags: { latest: '0.26.0', next: '1.0.0-rc.1' },
  });
  assert.equal(verdict.action, 'ok');
});

test('catches a hijacked latest when a stable release does exist', () => {
  // The repairable form of the same incident: npm moved latest onto the RC of
  // a package that already had 0.26.0 out.
  const verdict = decideDistTag({
    name: '@lumibase/mcp-server',
    versions: ['0.26.0', '1.0.0-rc.1'],
    distTags: { latest: '1.0.0-rc.1', next: '1.0.0-rc.1' },
  });
  assert.equal(verdict.action, 'realign');
  assert.equal(verdict.to, '0.26.0');
});

test('a stable release on latest passes', () => {
  const verdict = decideDistTag({
    name: 'lumibase',
    versions: ['1.0.0-rc.1', '1.0.0'],
    distTags: { latest: '1.0.0', next: '1.0.0-rc.1' },
  });
  assert.equal(verdict.action, 'ok');
});

test('an unpublished package is not a failure', () => {
  const verdict = decideDistTag({ name: 'lumibase', versions: [], distTags: {} });
  assert.equal(verdict.action, 'ok');
  assert.equal(verdict.reason, 'no-latest-tag');
});

test('picks the highest stable numerically, not lexicographically', () => {
  // Sorted as strings, '0.9.0' beats '0.26.0' and the guard would "repair"
  // latest by pointing it at an older release — worse than leaving it alone.
  assert.equal(highestStable(['0.9.0', '0.26.0', '0.18.0']), '0.26.0');
  assert.equal(compareVersions('0.9.0', '0.26.0'), -1);
});

test('prereleases never win the stable selection', () => {
  assert.equal(highestStable(['0.26.0', '1.0.0-rc.1', '1.0.0-rc.2']), '0.26.0');
  assert.equal(highestStable(['1.0.0-rc.1']), null);
});

test('prerelease detection matches the rule the publish step uses', () => {
  assert.equal(isPrerelease('1.0.0-rc.1'), true);
  assert.equal(isPrerelease('1.0.0'), false);
  assert.equal(isPrerelease('0.26.0'), false);
});
