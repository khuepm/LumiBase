import { describe, expect, it } from 'vitest';
import { isSessionTfaVerified, isTfaEnrolled } from '../studio-access';
import type { AuthPrincipal } from '../../env';

function principal(raw: Record<string, unknown>): AuthPrincipal {
  return {
    userId: 'user-1',
    email: 'user@example.com',
    raw,
  };
}

describe('studio access TFA helpers', () => {
  it('recognizes common TFA enrollment metadata shapes', () => {
    expect(isTfaEnrolled({ enabled: true })).toBe(true);
    expect(isTfaEnrolled({ enrolled: true })).toBe(true);
    expect(isTfaEnrolled({ verified: true })).toBe(true);
    expect(isTfaEnrolled({ secret: 'totp-secret' })).toBe(true);
    expect(isTfaEnrolled({ tfaSecret: 'totp-secret' })).toBe(true);
    expect(isTfaEnrolled({ enabled: false })).toBe(false);
    expect(isTfaEnrolled(null)).toBe(false);
  });

  it('recognizes MFA-verified sessions from JWT claims', () => {
    expect(isSessionTfaVerified(principal({ tfaVerified: true }))).toBe(true);
    expect(isSessionTfaVerified(principal({ mfa: true }))).toBe(true);
    expect(isSessionTfaVerified(principal({ mfaVerified: true }))).toBe(true);
    expect(isSessionTfaVerified(principal({ amr: ['pwd', 'totp'] }))).toBe(true);
    expect(isSessionTfaVerified(principal({ acr: 'urn:lumibase:mfa' }))).toBe(true);
    expect(isSessionTfaVerified(principal({ amr: ['pwd'] }))).toBe(false);
  });
});
