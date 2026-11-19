import { describe, expect, it } from 'vitest';
import {
  RELEASE_FLAGS,
  RELEASE_FLAG_KEY_PATTERN,
  defineReleaseFlags,
  expiredReleaseFlags,
  type ReleaseFlagDefinition,
} from '../registry';

const valid: ReleaseFlagDefinition = {
  key: 'demo-feature',
  description: 'Demo.',
  stage: 'dark',
  siteToggle: true,
  siteDefault: false,
  owner: '#1',
  removeBy: '2099-01-01',
};

describe('release-flag registry', () => {
  it('declares only well-formed flags', () => {
    for (const def of RELEASE_FLAGS.values()) {
      expect(def.key).toMatch(RELEASE_FLAG_KEY_PATTERN);
      expect(def.owner).toMatch(/^(#\d+|\.kiro\/specs\/)/);
    }
  });

  // Flag debt gate: a flag past its removeBy date fails CI until the flag (not
  // the feature) is deleted or the date is moved with a reason in the PR.
  it('has no flag past its removeBy date', () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(expiredReleaseFlags(RELEASE_FLAGS, today)).toEqual([]);
  });

  it('reports flags past their removeBy date', () => {
    const registry = defineReleaseFlags([valid, { ...valid, key: 'old-one', removeBy: '2020-01-01' }]);
    expect(expiredReleaseFlags(registry, '2026-11-17')).toEqual(['old-one']);
  });

  it.each([
    ['bad key', { key: 'Bad_Key' }, /must match/],
    ['unknown stage', { stage: 'alpha' as never }, /unknown stage/],
    ['empty description', { description: ' ' }, /description/],
    ['empty owner', { owner: '' }, /owner/],
    ['bad date', { removeBy: '2027-13-45' }, /removeBy/],
    ['loose date', { removeBy: '27-1-1' }, /removeBy/],
  ])('refuses a definition with %s', (_label, patch, message) => {
    expect(() => defineReleaseFlags([{ ...valid, ...patch }])).toThrow(message);
  });

  it('refuses a duplicate key', () => {
    expect(() => defineReleaseFlags([valid, valid])).toThrow(/declared twice/);
  });

  it('freezes definitions', () => {
    const registry = defineReleaseFlags([valid]);
    expect(Object.isFrozen(registry.get('demo-feature'))).toBe(true);
  });
});
