import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REFRESH_TTL,
  DEFAULT_SESSION_TTL,
  TOKEN_AUDIENCE,
  audienceValues,
  isFrontendAudience,
  refreshTtlFor,
  sessionTtlFor,
  ttlToSeconds,
} from '../token-audience';

describe('token-audience helpers', () => {
  it('normalizes string and array `aud` claims', () => {
    expect(audienceValues('frontend')).toEqual(['frontend']);
    expect(audienceValues(['studio', 'frontend'])).toEqual(['studio', 'frontend']);
    expect(audienceValues(undefined)).toEqual([]);
    expect(audienceValues(123)).toEqual([]);
    expect(audienceValues([1, 'studio', null])).toEqual(['studio']);
  });

  it('detects the frontend audience in either shape', () => {
    expect(isFrontendAudience(TOKEN_AUDIENCE.frontend)).toBe(true);
    expect(isFrontendAudience(['studio', 'frontend'])).toBe(true);
    expect(isFrontendAudience(TOKEN_AUDIENCE.studio)).toBe(false);
    expect(isFrontendAudience(undefined)).toBe(false);
    expect(isFrontendAudience(TOKEN_AUDIENCE.emailVerify)).toBe(false);
  });

  it('keeps the three audiences distinct', () => {
    const values = Object.values(TOKEN_AUDIENCE);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('sessionTtlFor', () => {
  it('uses per-realm defaults when no override is set', () => {
    expect(sessionTtlFor(TOKEN_AUDIENCE.studio)).toBe(DEFAULT_SESSION_TTL.studio);
    expect(sessionTtlFor(TOKEN_AUDIENCE.frontend)).toBe(DEFAULT_SESSION_TTL.frontend);
    // Any non-frontend audience is treated as the (stricter) studio realm.
    expect(sessionTtlFor('anything-else')).toBe(DEFAULT_SESSION_TTL.studio);
  });

  it('honours valid env overrides per realm', () => {
    const env = { STUDIO_SESSION_TTL: '4h', FRONTEND_SESSION_TTL: '90d' };
    expect(sessionTtlFor(TOKEN_AUDIENCE.studio, env)).toBe('4h');
    expect(sessionTtlFor(TOKEN_AUDIENCE.frontend, env)).toBe('90d');
  });

  it('accepts a bare number of seconds', () => {
    expect(sessionTtlFor(TOKEN_AUDIENCE.studio, { STUDIO_SESSION_TTL: '3600' })).toBe('3600');
  });

  it('falls back to the default on a malformed or empty override', () => {
    for (const bad of ['', '   ', 'abc', '12 hours', '10x', 'h12']) {
      expect(sessionTtlFor(TOKEN_AUDIENCE.studio, { STUDIO_SESSION_TTL: bad })).toBe(
        DEFAULT_SESSION_TTL.studio,
      );
    }
  });

  it('does not cross realms (frontend override never affects studio)', () => {
    const env = { FRONTEND_SESSION_TTL: '90d' };
    expect(sessionTtlFor(TOKEN_AUDIENCE.studio, env)).toBe(DEFAULT_SESSION_TTL.studio);
  });
});

describe('refreshTtlFor', () => {
  it('defaults frontend longer than studio, both longer than the access TTL', () => {
    expect(refreshTtlFor(TOKEN_AUDIENCE.studio)).toBe(DEFAULT_REFRESH_TTL.studio);
    expect(refreshTtlFor(TOKEN_AUDIENCE.frontend)).toBe(DEFAULT_REFRESH_TTL.frontend);
    expect(ttlToSeconds(DEFAULT_REFRESH_TTL.studio)).toBeGreaterThan(
      ttlToSeconds(DEFAULT_SESSION_TTL.studio),
    );
    expect(ttlToSeconds(DEFAULT_REFRESH_TTL.frontend)).toBeGreaterThan(
      ttlToSeconds(DEFAULT_REFRESH_TTL.studio),
    );
  });

  it('honours valid env overrides and falls back on bad ones', () => {
    expect(refreshTtlFor(TOKEN_AUDIENCE.studio, { STUDIO_REFRESH_TTL: '7d' })).toBe('7d');
    expect(refreshTtlFor(TOKEN_AUDIENCE.studio, { STUDIO_REFRESH_TTL: 'bogus' })).toBe(
      DEFAULT_REFRESH_TTL.studio,
    );
  });
});

describe('ttlToSeconds', () => {
  it('parses compact units', () => {
    expect(ttlToSeconds('30s')).toBe(30);
    expect(ttlToSeconds('5m')).toBe(300);
    expect(ttlToSeconds('2h')).toBe(7200);
    expect(ttlToSeconds('1d')).toBe(86400);
    expect(ttlToSeconds('1w')).toBe(604800);
  });

  it('treats a bare number as seconds', () => {
    expect(ttlToSeconds('3600')).toBe(3600);
  });

  it('returns 0 for an unparseable value', () => {
    expect(ttlToSeconds('abc')).toBe(0);
    expect(ttlToSeconds('')).toBe(0);
  });
});
