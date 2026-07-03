import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SAVE_ACTION,
  UserPreferencesUpdateSchema,
  resolveSaveAction,
  SAVE_ACTIONS,
} from '@lumibase/shared/schemas';

/**
 * Feature: save-default-preference
 *   Req 4 — effective action resolves user → site → hardcoded fallback.
 *   Req 2 — preference update validates the enum (and allows null to clear).
 *
 * **Validates: Requirements 2.1, 2.2, 2.4, 4.1, 4.2, 4.3, 4.5**
 */

describe('resolveSaveAction', () => {
  it('prefers a valid user preference over the site default (Req 4.1, 4.2)', () => {
    expect(resolveSaveAction('return', 'create_new')).toBe('return');
  });

  it('falls back to the site default when the user has none (Req 4.1)', () => {
    expect(resolveSaveAction(undefined, 'create_new')).toBe('create_new');
    expect(resolveSaveAction(null, 'return')).toBe('return');
  });

  it('falls back to the hardcoded default when both are absent/invalid (Req 4.3)', () => {
    expect(resolveSaveAction(undefined, undefined)).toBe(DEFAULT_SAVE_ACTION);
    expect(DEFAULT_SAVE_ACTION).toBe('stay');
  });

  it('treats an invalid value as not-configured rather than throwing (Req 4.5)', () => {
    expect(resolveSaveAction('garbage', 'return')).toBe('return');
    expect(resolveSaveAction('garbage', 'also-garbage')).toBe(DEFAULT_SAVE_ACTION);
  });

  it('covers every declared action', () => {
    for (const a of SAVE_ACTIONS) {
      expect(resolveSaveAction(a, undefined)).toBe(a);
    }
  });
});

describe('UserPreferencesUpdateSchema', () => {
  it('accepts a valid saveAction (Req 2.1)', () => {
    expect(UserPreferencesUpdateSchema.safeParse({ saveAction: 'stay' }).success).toBe(true);
  });

  it('rejects an invalid saveAction enum (Req 2.2)', () => {
    expect(UserPreferencesUpdateSchema.safeParse({ saveAction: 'nope' }).success).toBe(false);
  });

  it('accepts saveAction: null to clear the override (Req 7.2)', () => {
    const parsed = UserPreferencesUpdateSchema.safeParse({ saveAction: null });
    expect(parsed.success).toBe(true);
  });

  it('passes through unknown keys (forward compat, Req 8.4)', () => {
    const parsed = UserPreferencesUpdateSchema.safeParse({ saveAction: 'return', futureKey: 1 });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect((parsed.data as { futureKey?: number }).futureKey).toBe(1);
  });
});
