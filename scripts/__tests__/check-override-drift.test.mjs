/**
 * Tripwire for the override-drift guard.
 *
 * A guard that is always green is indistinguishable from a guard that does not
 * work, so the cases below include the real incident the script was written
 * for: `overrides.vite` at `^7.3.5` while `apps/{studio,docs}` declared
 * `^8.1.3`, which shipped Vite 7 builds under manifests claiming Vite 8.
 *
 * Uses `node --test` rather than Vitest: the guard is dependency-free by
 * design (a check on install settings must not depend on a successful
 * install), and its test should not reintroduce that dependency.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseRange,
  rangesIntersect,
  splitOverrideKey,
} from '../check-override-drift.mjs';

/** Does an override range contradict a declared range? */
function drifts(overrideRange, declaredRange) {
  const a = parseRange(overrideRange);
  const b = parseRange(declaredRange);
  assert.ok(a, `unparseable override range: ${overrideRange}`);
  assert.ok(b, `unparseable declared range: ${declaredRange}`);
  return !rangesIntersect(a, b);
}

test('catches the vite incident: override on 7 vs manifests on 8', () => {
  assert.equal(drifts('^7.3.5', '^8.1.3'), true);
});

test('catches an exact override pinned below the declared floor', () => {
  // @types/react: override `19.2.0` exact cannot satisfy `^19.2.18`, even
  // though both sit in the same major — so a major-only check would miss it.
  assert.equal(drifts('19.2.0', '^19.2.18'), true);
});

test('accepts an override that raises the floor inside the declared range', () => {
  // nanoid@5: `^5.1.16` is exactly how a security pin is supposed to work
  // against a manifest declaring `^5.0.7`.
  assert.equal(drifts('^5.1.16', '^5.0.7'), false);
});

test('accepts an open-ended override above the declared floor', () => {
  assert.equal(drifts('>=0.35.0', '^0.35.1'), false);
});

test('accepts matching ranges', () => {
  assert.equal(drifts('^8.2.0', '^8.2.0'), false);
});

test('a scoped override only speaks for its own range', () => {
  const { name, scope } = splitOverrideKey('nanoid@3');
  assert.equal(name, 'nanoid');
  assert.equal(scope, '3');
  // The 3.x pin must not be measured against a 5.x manifest declaration.
  assert.equal(rangesIntersect(parseRange(scope), parseRange('^5.1.16')), false);
  // But it does speak for a 3.x declaration.
  assert.equal(rangesIntersect(parseRange(scope), parseRange('^3.3.0')), true);
});

test('scoped keys on namespaced packages split on the right @', () => {
  assert.deepEqual(splitOverrideKey('@types/react'), { name: '@types/react', scope: null });
  assert.deepEqual(splitOverrideKey('@babel/core@7'), { name: '@babel/core', scope: '7' });
});

test('caret on a 0.x range is minor-locked, not major-locked', () => {
  assert.equal(drifts('^0.28.2', '^0.29.0'), true);
  assert.equal(drifts('^0.28.2', '^0.28.1'), false);
});

test('non-registry protocols are reported as unparseable, not guessed at', () => {
  assert.equal(parseRange('workspace:*'), null);
  assert.equal(parseRange('catalog:'), null);
  assert.equal(parseRange('link:../foo'), null);
});

test('union ranges intersect when any alternative does', () => {
  assert.equal(drifts('^20.19.0 || >=22.12.0', '^22.13.0'), false);
  assert.equal(drifts('^20.19.0', '^22.13.0'), true);
});
