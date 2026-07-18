import { describe, it, expect } from 'vitest';
import { completeBodySchema } from '../routes';
import { STANDARD_LOCKOUT_POLICY } from '../policy-codec';

/**
 * `policy` is optional in the setup-complete body: when omitted, the schema
 * applies the "Standard" lockout preset so callers don't have to spell out
 * every field. When provided, the explicit value wins.
 */
const validBody = {
  account: {
    email: 'admin@example.com',
    password: 'Sup3rSecret!Pass',
    firstName: 'Ada',
    lastName: 'Lovelace',
  },
  adminPath: 'control',
};

describe('completeBodySchema — optional lockout policy', () => {
  it('applies the Standard preset when policy is omitted', () => {
    const parsed = completeBodySchema.parse(validBody);
    expect(parsed.policy).toEqual({
      ...STANDARD_LOCKOUT_POLICY,
      notifyChannels: [...STANDARD_LOCKOUT_POLICY.notifyChannels],
    });
  });

  it('returns a fresh notifyChannels array (not a reference to the frozen preset)', () => {
    const a = completeBodySchema.parse(validBody);
    const b = completeBodySchema.parse(validBody);
    expect(a.policy.notifyChannels).not.toBe(STANDARD_LOCKOUT_POLICY.notifyChannels);
    expect(a.policy.notifyChannels).not.toBe(b.policy.notifyChannels);
  });

  it('keeps an explicitly provided policy', () => {
    const explicit = {
      ...STANDARD_LOCKOUT_POLICY,
      userMaxFailedAttempts: 9,
      notifyChannels: ['email', 'webhook'] as const,
    };
    const parsed = completeBodySchema.parse({ ...validBody, policy: explicit });
    expect(parsed.policy.userMaxFailedAttempts).toBe(9);
    expect(parsed.policy.notifyChannels).toEqual(['email', 'webhook']);
  });
});
