import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_ENV_PREFIX,
  assertNoAdminPathEnv,
  findForbiddenAdminPathEnvVars,
} from '../build-assertions';

/**
 * Build-time guard against leaking the custom Admin Path into the Studio
 * bundle (admin-setup-wizard requirements §4.7; design.md §7.3).
 *
 * The Vite config calls `assertNoAdminPathEnv()` while loading; the helper
 * is exported separately so we can exercise it deterministically here
 * without spawning a real Vite build.
 */

describe('findForbiddenAdminPathEnvVars', () => {
  it('returns an empty list for a clean environment', () => {
    expect(
      findForbiddenAdminPathEnvVars({
        NODE_ENV: 'production',
        VITE_API_URL: 'https://example.test',
      }),
    ).toEqual([]);
  });

  it('flags an exact match for the forbidden prefix', () => {
    expect(
      findForbiddenAdminPathEnvVars({
        VITE_ADMIN_PATH: '/lumi-7f3a9c',
      }),
    ).toEqual(['VITE_ADMIN_PATH']);
  });

  it('flags any env var whose name starts with the forbidden prefix', () => {
    const offenders = findForbiddenAdminPathEnvVars({
      VITE_ADMIN_PATH_OVERRIDE: '/x',
      VITE_ADMIN_PATH_FALLBACK: '/y',
      VITE_API_URL: 'https://example.test',
    });
    expect(offenders.sort()).toEqual([
      'VITE_ADMIN_PATH_FALLBACK',
      'VITE_ADMIN_PATH_OVERRIDE',
    ]);
  });

  it('matches case-insensitively to defeat trivial bypasses', () => {
    expect(
      findForbiddenAdminPathEnvVars({
        vite_admin_path: '/x',
        Vite_Admin_Path_Suffix: '/y',
      }).sort(),
    ).toEqual(['Vite_Admin_Path_Suffix', 'vite_admin_path']);
  });

  it('does not flag unrelated VITE_* vars or substrings', () => {
    expect(
      findForbiddenAdminPathEnvVars({
        VITE_API_URL: 'https://example.test',
        VITE_FEATURE_ADMIN_PATH: '/x', // ADMIN_PATH appears mid-name, not as prefix
        ADMIN_PATH: '/x', // not a VITE_* var; Vite would not inline this
      }),
    ).toEqual([]);
  });
});

describe('assertNoAdminPathEnv', () => {
  it('does not throw on a clean environment', () => {
    expect(() =>
      assertNoAdminPathEnv({ NODE_ENV: 'production' }),
    ).not.toThrow();
  });

  it('throws with a helpful message when the forbidden prefix is present', () => {
    expect(() =>
      assertNoAdminPathEnv({ VITE_ADMIN_PATH: '/lumi-7f3a9c' }),
    ).toThrow(/VITE_ADMIN_PATH/);
  });

  it('lists every offending var in the error message', () => {
    let captured: Error | undefined;
    try {
      assertNoAdminPathEnv({
        VITE_ADMIN_PATH: '/a',
        VITE_ADMIN_PATH_BACKUP: '/b',
      });
    } catch (err) {
      captured = err as Error;
    }
    expect(captured).toBeInstanceOf(Error);
    expect(captured?.message).toContain('VITE_ADMIN_PATH');
    expect(captured?.message).toContain('VITE_ADMIN_PATH_BACKUP');
  });

  it('exposes the forbidden prefix as a constant for diagnostics', () => {
    expect(FORBIDDEN_ENV_PREFIX).toBe('VITE_ADMIN_PATH');
  });
});
