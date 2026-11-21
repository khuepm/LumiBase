import { describe, expect, it } from 'vitest';
import {
  MAX_PBKDF2_ITERATIONS,
  hashPassword,
  passwordNeedsRehash,
  targetPbkdf2Iterations,
  verifyPassword,
} from '../password';
import { apiKeyExpiry, DEFAULT_API_KEY_TTL_DAYS } from '../../api-key-token';
import { parseRegistrationSetting } from '../registration-settings';

/**
 * #994 — credential-abuse defaults: a configurable PBKDF2 work factor with
 * re-hash on login, a default lifetime for new API keys, and a switch that
 * closes public self-registration.
 */
describe('PBKDF2 work factor', () => {
  it('defaults to 100,000 and clamps the env knob', () => {
    expect(targetPbkdf2Iterations({})).toBe(100_000);
    expect(targetPbkdf2Iterations({ PASSWORD_PBKDF2_ITERATIONS: '600000' })).toBe(600_000);
    expect(targetPbkdf2Iterations({ PASSWORD_PBKDF2_ITERATIONS: '10' })).toBe(100_000);
    expect(targetPbkdf2Iterations({ PASSWORD_PBKDF2_ITERATIONS: '99999999' })).toBe(MAX_PBKDF2_ITERATIONS);
    expect(targetPbkdf2Iterations({ PASSWORD_PBKDF2_ITERATIONS: 'lots' })).toBe(100_000);
  });

  it('flags hashes below the target for re-hash, and only those', async () => {
    const old = await hashPassword('correct horse battery', 100_000);
    expect(passwordNeedsRehash(old, 200_000)).toBe(true);
    expect(passwordNeedsRehash(old, 100_000)).toBe(false);
    expect(passwordNeedsRehash('garbage', 200_000)).toBe(false);
    expect(passwordNeedsRehash(null, 200_000)).toBe(false);
  });

  it('a re-hashed password still verifies, and carries its work factor', async () => {
    const stronger = await hashPassword('correct horse battery', 150_000);
    expect(stronger.split('$')[1]).toBe('150000');
    expect(await verifyPassword('correct horse battery', stronger)).toBe(true);
    expect(await verifyPassword('wrong', stronger)).toBe(false);
  });
});

describe('apiKeyExpiry', () => {
  const now = new Date('2026-11-20T00:00:00Z');
  const day = 24 * 60 * 60 * 1000;

  it('gives a new key a default lifetime when the caller says nothing', () => {
    expect(apiKeyExpiry(undefined, {}, now)!.getTime()).toBe(now.getTime() + DEFAULT_API_KEY_TTL_DAYS * day);
  });

  it('honours an explicit date, and explicit null for a never-expiring key', () => {
    expect(apiKeyExpiry('2027-01-01T00:00:00Z', {}, now)!.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(apiKeyExpiry(null, {}, now)).toBeNull();
  });

  it('is configurable, and 0 restores the old never-expires default', () => {
    expect(apiKeyExpiry(undefined, { API_KEY_DEFAULT_TTL_DAYS: '30' }, now)!.getTime()).toBe(now.getTime() + 30 * day);
    expect(apiKeyExpiry(undefined, { API_KEY_DEFAULT_TTL_DAYS: '0' }, now)).toBeNull();
    expect(apiKeyExpiry(undefined, { API_KEY_DEFAULT_TTL_DAYS: 'x' }, now)!.getTime()).toBe(now.getTime() + 90 * day);
  });
});

describe('parseRegistrationSetting', () => {
  it('is open unless explicitly closed', () => {
    expect(parseRegistrationSetting(undefined)).toEqual({ enabled: true });
    expect(parseRegistrationSetting({})).toEqual({ enabled: true });
    expect(parseRegistrationSetting({ enabled: 'no' })).toEqual({ enabled: true });
    expect(parseRegistrationSetting({ enabled: false })).toEqual({ enabled: false });
  });
});
