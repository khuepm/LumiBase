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

  it('keeps the permissive default outside production', () => {
    expect(resolveCorsOrigin('http://localhost:5173', { LUMIBASE_ENV: 'development' })).toBe(
      'http://localhost:5173',
    );
  });
});
