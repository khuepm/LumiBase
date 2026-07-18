import { describe, expect, it } from 'vitest';

import { parseAllowedOrigins, resolveCorsOrigin } from '../cors';

describe('CORS origin resolution', () => {
  it('parses comma-separated allowlists', () => {
    expect(parseAllowedOrigins('https://studio.example.com, https://app.example.com')).toEqual([
      'https://studio.example.com',
      'https://app.example.com',
    ]);
  });

  it('allows configured origins', () => {
    expect(
      resolveCorsOrigin('https://studio.example.com', {
        LUMIBASE_ENV: 'production',
        CORS_ALLOWED_ORIGINS: 'https://studio.example.com',
      }),
    ).toBe('https://studio.example.com');
  });

  it('rejects unlisted production origins', () => {
    expect(
      resolveCorsOrigin('https://evil.example.com', {
        LUMIBASE_ENV: 'production',
        CORS_ALLOWED_ORIGINS: 'https://studio.example.com',
      }),
    ).toBeUndefined();
  });

  it('does not allow wildcard credentials in production', () => {
    expect(
      resolveCorsOrigin('https://studio.example.com', {
        LUMIBASE_ENV: 'production',
        CORS_ALLOWED_ORIGINS: '*',
      }),
    ).toBeUndefined();
  });

  it('reflects loopback origins outside production', () => {
    expect(resolveCorsOrigin('http://localhost:5173', { LUMIBASE_ENV: 'development' })).toBe(
      'http://localhost:5173',
    );
    expect(resolveCorsOrigin('http://127.0.0.1:3000', { LUMIBASE_ENV: 'development' })).toBe(
      'http://127.0.0.1:3000',
    );
  });

  it('does NOT reflect arbitrary internet origins in dev (CWE-942)', () => {
    // Credentialed CORS must never reflect a non-loopback origin that is not in
    // the explicit allowlist, even outside production.
    expect(
      resolveCorsOrigin('https://evil.example.com', { LUMIBASE_ENV: 'development' }),
    ).toBeUndefined();
  });

  it('never returns "*" (incompatible with credentials)', () => {
    expect(resolveCorsOrigin(undefined, { LUMIBASE_ENV: 'development' })).toBeUndefined();
    expect(
      resolveCorsOrigin('https://x.example.com', {
        LUMIBASE_ENV: 'development',
        CORS_ALLOWED_ORIGINS: '*',
      }),
    ).toBeUndefined();
  });

  it('honors an explicit allowlist even outside production', () => {
    expect(
      resolveCorsOrigin('https://studio.example.com', {
        LUMIBASE_ENV: 'development',
        CORS_ALLOWED_ORIGINS: 'https://studio.example.com',
      }),
    ).toBe('https://studio.example.com');
  });
});
