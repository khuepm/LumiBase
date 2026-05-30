import { describe, it, expect } from 'vitest';
import {
  buildDefaultValues,
  inferActivePreset,
} from '../step-security';
import {
  LENIENT_PRESET,
  POLICY_PRESETS,
  STANDARD_PRESET,
  STRICT_PRESET,
  lockoutPolicySchema,
  type LockoutPolicyFormValues,
  type PolicyPresetId,
} from '../../schemas/policy';

/**
 * Unit tests for the pure helpers that drive the Security step's
 * preset chooser (task 6.5).
 *
 *   - `buildDefaultValues` produces the form's initial values from a
 *     preset id + an optional draft. With no draft, it mirrors the
 *     preset table from `schemas/policy.ts` 1:1 — the Phase C surface
 *     of the form (Failed Attempts + Notifications) plus the Phase D
 *     fields the form keeps invisible until task 8.3 lands. With a
 *     draft, it returns the draft as-is.
 *
 *   - `inferActivePreset` is the inverse: given a fully populated
 *     `LockoutPolicyFormValues`, return the preset id that produced
 *     them, or `null` when the operator has customised the values
 *     away from any preset. Used to highlight the active preset card
 *     in the chooser on remount.
 *
 *   - Round-trip: for every preset id, `inferActivePreset(buildDefaultValues(id, null))`
 *     must return the same id. This pins the contract that the
 *     chooser highlight and the form value table never drift apart.
 *
 * Spec refs: requirements §6.1, §6.2, §6.3 (Failed Attempts +
 * Notifications); design.md §5.5.
 */

const ALL_PRESETS: PolicyPresetId[] = ['standard', 'strict', 'lenient'];

describe('buildDefaultValues', () => {
  it.each(ALL_PRESETS)(
    'mirrors the %s preset table when no draft is provided',
    (id) => {
      const values = buildDefaultValues(id, null);
      const preset = POLICY_PRESETS[id];

      // Phase C visible fields — inline range validation lives off
      // these; mismatches would surface as form errors at runtime.
      expect(values.userMaxFailedAttempts).toBe(preset.userMaxFailedAttempts);
      expect(values.userLockoutDurationSeconds).toBe(
        preset.userLockoutDurationSeconds,
      );
      expect(values.ipMaxFailedAttempts).toBe(preset.ipMaxFailedAttempts);
      expect(values.ipLockoutDurationSeconds).toBe(
        preset.ipLockoutDurationSeconds,
      );
      expect(values.lockoutWindowSeconds).toBe(preset.lockoutWindowSeconds);
      expect(values.notifyChannels).toEqual(preset.notifyChannels);

      // Phase D defaults — kept in the form value object so task 8.3
      // can surface them without re-shipping the schema.
      expect(values.geoAnomalyEnabled).toBe(preset.geoAnomalyEnabled);
      expect(values.timeAnomalyEnabled).toBe(preset.timeAnomalyEnabled);
      expect(values.deviceAnomalyEnabled).toBe(preset.deviceAnomalyEnabled);
      expect(values.anomalyScoreThreshold).toBe(
        preset.anomalyScoreThreshold,
      );
      expect(values.anomalyAction).toBe(preset.anomalyAction);
    },
  );

  it('returns the draft as-is when a draft is provided', () => {
    const draft: LockoutPolicyFormValues = {
      ...buildDefaultValues('standard', null),
      userMaxFailedAttempts: 7,
    };
    const values = buildDefaultValues('lenient', draft);
    // The preset id is ignored when a draft is provided so the
    // operator's customisation always survives a remount.
    expect(values.userMaxFailedAttempts).toBe(7);
    expect(values).toBe(draft);
  });

  it('produces values that satisfy the policy schema (Standard)', () => {
    // Smoke-test that the preset → form values bridge never produces
    // a shape that would fail the Zod resolver (Req 6.3 ranges).
    const values = buildDefaultValues('standard', null);
    const result = lockoutPolicySchema.safeParse(values);
    expect(result.success).toBe(true);
  });

  it('produces values that satisfy the policy schema (Strict)', () => {
    const values = buildDefaultValues('strict', null);
    const result = lockoutPolicySchema.safeParse(values);
    expect(result.success).toBe(true);
  });

  it('produces values that satisfy the policy schema (Lenient)', () => {
    const values = buildDefaultValues('lenient', null);
    const result = lockoutPolicySchema.safeParse(values);
    expect(result.success).toBe(true);
  });
});

describe('inferActivePreset', () => {
  it.each(ALL_PRESETS)(
    'detects the %s preset from its canonical values',
    (id) => {
      const values = buildDefaultValues(id, null);
      expect(inferActivePreset(values)).toBe(id);
    },
  );

  it('returns null for fully customised values that do not match any preset', () => {
    // Mutate one Failed Attempts field away from every preset's
    // table and ensure the chooser stops highlighting any card.
    const customised: LockoutPolicyFormValues = {
      ...buildDefaultValues('standard', null),
      userMaxFailedAttempts: 7, // none of standard/strict/lenient use 7
    };
    expect(inferActivePreset(customised)).toBeNull();
  });

  it('detects Standard even when the channel array is reordered', () => {
    // The chooser shouldn't depend on the array literal order — the
    // channel set is what matters semantically.
    const values: LockoutPolicyFormValues = {
      ...buildDefaultValues('standard', null),
      // Standard ships ['email'] only; reordering a single-item
      // array is trivially the same array, but we exercise the path
      // with explicit construction to pin the contract.
      notifyChannels: ['email'],
    };
    expect(inferActivePreset(values)).toBe('standard');
  });

  it('returns null when the channel set differs from every preset', () => {
    // All three presets currently ship with `['email']`; flipping to
    // `['email', 'webhook']` should detune the chooser. This guards
    // against a future preset edit that accidentally lands the same
    // channel set as a different preset.
    const values: LockoutPolicyFormValues = {
      ...buildDefaultValues('standard', null),
      notifyChannels: ['email', 'webhook'],
    };
    expect(inferActivePreset(values)).toBeNull();
  });
});

describe('preset table sanity', () => {
  // These mirror the design.md §5.5 contract: Strict has lower
  // thresholds and longer lockouts than Standard; Lenient has higher
  // thresholds and shorter lockouts. If a future edit drifts those
  // properties, the test file pins the regression.

  it('Strict has stricter user thresholds than Standard', () => {
    expect(STRICT_PRESET.userMaxFailedAttempts).toBeLessThan(
      STANDARD_PRESET.userMaxFailedAttempts,
    );
    expect(STRICT_PRESET.userLockoutDurationSeconds).toBeGreaterThan(
      STANDARD_PRESET.userLockoutDurationSeconds,
    );
  });

  it('Strict has stricter IP thresholds than Standard', () => {
    expect(STRICT_PRESET.ipMaxFailedAttempts).toBeLessThan(
      STANDARD_PRESET.ipMaxFailedAttempts,
    );
    expect(STRICT_PRESET.ipLockoutDurationSeconds).toBeGreaterThan(
      STANDARD_PRESET.ipLockoutDurationSeconds,
    );
  });

  it('Lenient has looser user thresholds than Standard', () => {
    expect(LENIENT_PRESET.userMaxFailedAttempts).toBeGreaterThan(
      STANDARD_PRESET.userMaxFailedAttempts,
    );
    expect(LENIENT_PRESET.userLockoutDurationSeconds).toBeLessThan(
      STANDARD_PRESET.userLockoutDurationSeconds,
    );
  });

  it('Lenient has looser IP thresholds than Standard', () => {
    expect(LENIENT_PRESET.ipMaxFailedAttempts).toBeGreaterThan(
      STANDARD_PRESET.ipMaxFailedAttempts,
    );
    expect(LENIENT_PRESET.ipLockoutDurationSeconds).toBeLessThan(
      STANDARD_PRESET.ipLockoutDurationSeconds,
    );
  });
});
