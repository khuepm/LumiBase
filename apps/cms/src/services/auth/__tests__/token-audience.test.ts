import { describe, expect, it } from 'vitest';
import {
  TOKEN_AUDIENCE,
  audienceValues,
  isFrontendAudience,
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
