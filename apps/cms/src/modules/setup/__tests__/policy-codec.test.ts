import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  isPolicyValidationError,
  parseLockoutPolicy,
  serializeLockoutPolicy,
  STANDARD_LOCKOUT_POLICY,
  type LockoutPolicy,
  type NotificationChannel,
} from '../policy-codec';

/**
 * Feature: admin-setup-wizard, Property 5: Round-trip serialization
 *
 * For all valid LockoutPolicy values `p`,
 *   parseLockoutPolicy(serializeLockoutPolicy(p)) deepEqual p.
 *
 * Additional unit checks cover the forward-compatibility rules from
 * Req 16.4 (default-fill missing fields) and Req 16.5 (drop unknown
 * fields).
 *
 * **Validates: Requirements 16.1, 16.2, 16.3, 16.4, 16.5, 16.6**
 */

const validPolicyArb: fc.Arbitrary<LockoutPolicy> = fc.record({
  userMaxFailedAttempts: fc.integer({ min: 3, max: 20 }),
  userLockoutDurationSeconds: fc.integer({ min: 60, max: 86_400 }),
  // Req 6.3: ipMaxFailedAttempts ∈ [5, 100]. The [5,100] range already
  // covers the Req 8.2 floor-of-3.
  ipMaxFailedAttempts: fc.integer({ min: 5, max: 100 }),
  ipLockoutDurationSeconds: fc.integer({ min: 60, max: 86_400 }),
  lockoutWindowSeconds: fc.integer({ min: 60, max: 86_400 }),
  geoAnomalyEnabled: fc.boolean(),
  timeAnomalyEnabled: fc.boolean(),
  deviceAnomalyEnabled: fc.boolean(),
  // 0.00 to 1.00 in 2-decimal increments to match the canonical
  // representation enforced by the codec.
  anomalyScoreThreshold: fc
    .integer({ min: 0, max: 100 })
    .map((v) => v / 100),
  anomalyAction: fc.constantFrom<LockoutPolicy['anomalyAction']>(
    'notify_only',
    'require_mfa',
    'lock',
  ),
  notifyChannels: fc
    .subarray<NotificationChannel>(['email', 'webhook'], { minLength: 0 })
    // Ensure stable comparison: notifyChannels canonicalises to sorted.
    .map((arr) => [...arr].sort() as NotificationChannel[]),
});

describe('Feature: admin-setup-wizard, Property 5: Round-trip serialization', () => {
  it('parseLockoutPolicy(serializeLockoutPolicy(p)) === p for any valid policy', () => {
    fc.assert(
      fc.property(validPolicyArb, (policy) => {
        const json = serializeLockoutPolicy(policy);
        const parsed = parseLockoutPolicy(json);
        expect(isPolicyValidationError(parsed)).toBe(false);
        expect(parsed).toEqual(policy);
      }),
      { numRuns: 200 },
    );
  });

  it('serializes to canonical JSON with alphabetically sorted keys', () => {
    const json = serializeLockoutPolicy({ ...STANDARD_LOCKOUT_POLICY } as LockoutPolicy);
    const reordered = serializeLockoutPolicy({
      // intentionally pass keys in random order
      notifyChannels: STANDARD_LOCKOUT_POLICY.notifyChannels.slice(),
      userMaxFailedAttempts: STANDARD_LOCKOUT_POLICY.userMaxFailedAttempts,
      anomalyAction: STANDARD_LOCKOUT_POLICY.anomalyAction,
      timeAnomalyEnabled: STANDARD_LOCKOUT_POLICY.timeAnomalyEnabled,
      anomalyScoreThreshold: STANDARD_LOCKOUT_POLICY.anomalyScoreThreshold,
      deviceAnomalyEnabled: STANDARD_LOCKOUT_POLICY.deviceAnomalyEnabled,
      ipLockoutDurationSeconds: STANDARD_LOCKOUT_POLICY.ipLockoutDurationSeconds,
      ipMaxFailedAttempts: STANDARD_LOCKOUT_POLICY.ipMaxFailedAttempts,
      lockoutWindowSeconds: STANDARD_LOCKOUT_POLICY.lockoutWindowSeconds,
      userLockoutDurationSeconds: STANDARD_LOCKOUT_POLICY.userLockoutDurationSeconds,
      geoAnomalyEnabled: STANDARD_LOCKOUT_POLICY.geoAnomalyEnabled,
    } as LockoutPolicy);
    expect(json).toBe(reordered);
    // Sanity: keys are sorted alphabetically.
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const keys = Object.keys(parsed);
    expect(keys).toEqual([...keys].sort());
  });

  it('fills missing optional fields with the Standard preset (Req 16.4)', () => {
    const partial = JSON.stringify({
      userMaxFailedAttempts: 7,
      anomalyScoreThreshold: 0.85,
    });
    const parsed = parseLockoutPolicy(partial);
    expect(isPolicyValidationError(parsed)).toBe(false);
    if (isPolicyValidationError(parsed)) return;
    expect(parsed.userMaxFailedAttempts).toBe(7);
    expect(parsed.anomalyScoreThreshold).toBe(0.85);
    expect(parsed.userLockoutDurationSeconds).toBe(
      STANDARD_LOCKOUT_POLICY.userLockoutDurationSeconds,
    );
    expect(parsed.ipLockoutDurationSeconds).toBe(
      STANDARD_LOCKOUT_POLICY.ipLockoutDurationSeconds,
    );
    expect(parsed.notifyChannels).toEqual(['email']);
  });

  it('drops unknown fields (Req 16.5)', () => {
    const withExtras = JSON.stringify({
      ...STANDARD_LOCKOUT_POLICY,
      extraField: 'ignored',
      nested: { also: 'ignored' },
    });
    const parsed = parseLockoutPolicy(withExtras);
    expect(isPolicyValidationError(parsed)).toBe(false);
    if (isPolicyValidationError(parsed)) return;
    expect(Object.keys(parsed)).not.toContain('extraField');
    expect(Object.keys(parsed)).not.toContain('nested');
  });

  it('returns a ValidationError for out-of-range values (Req 16.6)', () => {
    const bad = JSON.stringify({
      ...STANDARD_LOCKOUT_POLICY,
      userMaxFailedAttempts: 1, // below min 3
    });
    const parsed = parseLockoutPolicy(bad);
    expect(isPolicyValidationError(parsed)).toBe(true);
    if (!isPolicyValidationError(parsed)) return;
    expect(parsed.issues.some((i) => i.path.includes('userMaxFailedAttempts'))).toBe(true);
  });

  it('returns a ValidationError for malformed JSON', () => {
    const parsed = parseLockoutPolicy('{not-json');
    expect(isPolicyValidationError(parsed)).toBe(true);
  });

  it('returns a ValidationError for non-object JSON values', () => {
    expect(isPolicyValidationError(parseLockoutPolicy('null'))).toBe(true);
    expect(isPolicyValidationError(parseLockoutPolicy('"string"'))).toBe(true);
    expect(isPolicyValidationError(parseLockoutPolicy('[]'))).toBe(true);
  });
});
