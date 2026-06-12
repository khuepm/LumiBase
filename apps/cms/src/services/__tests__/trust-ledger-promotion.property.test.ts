import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import {
  DEFAULT_PROMOTION_THRESHOLDS,
  defaultLevelFor,
  evaluatePromotionEvidence,
  validatePromotionApplication,
  type PromotionEvidenceInput,
} from '../trust-ledger-service';

/**
 * Feature: content-os, Property 7 (promotion half).
 *
 * - A promotion is never effective without a human decision on a pending
 *   `kind='promotion'` approval (no auto-commit path exists).
 * - Eligibility holds only when every evidence condition holds: below L4,
 *   unbroken success streak, enough decided approvals at the required
 *   rate, zero open incidents. The target is always exactly one level up,
 *   capped at 4.
 *
 * Together with the demotion half (autonomy-resolver.property.test.ts)
 * this validates the trust-ledger asymmetry: trust rises slowly through
 * people, falls instantly through incidents.
 *
 * **Validates: Requirements 12.5, 12.6**
 */

const thresholdsArb = fc.record({
  streak: fc.integer({ min: 1, max: 20 }),
  minDecided: fc.integer({ min: 1, max: 20 }),
  approveRate: fc.float({ min: Math.fround(0.5), max: 1, noNaN: true }),
});

const evidenceArb: fc.Arbitrary<PromotionEvidenceInput> = fc.record({
  currentLevel: fc.integer({ min: 0, max: 4 }),
  runStatuses: fc.array(fc.constantFrom('succeeded', 'failed', 'cancelled', 'running'), { maxLength: 30 }),
  approvalsDecided: fc.record({
    approved: fc.integer({ min: 0, max: 100 }),
    rejected: fc.integer({ min: 0, max: 100 }),
  }),
  openIncidents: fc.integer({ min: 0, max: 5 }),
  thresholds: thresholdsArb,
});

describe('Feature: content-os, Property 7: promotion eligibility', () => {
  it('eligible implies every condition holds; any violation implies ineligible', () => {
    fc.assert(
      fc.property(evidenceArb, (input) => {
        const result = evaluatePromotionEvidence(input);
        const decided = input.approvalsDecided.approved + input.approvalsDecided.rejected;
        const streakOk =
          input.runStatuses.slice(0, input.thresholds.streak).length >= input.thresholds.streak &&
          input.runStatuses.slice(0, input.thresholds.streak).every((s) => s === 'succeeded');
        const rateOk =
          decided >= input.thresholds.minDecided &&
          input.approvalsDecided.approved / decided >= input.thresholds.approveRate;
        const expected =
          input.currentLevel < 4 && streakOk && rateOk && input.openIncidents === 0;
        expect(result.eligible).toBe(expected);
        // Ineligible results always explain themselves.
        if (!result.eligible) expect(result.reasons.length).toBeGreaterThan(0);
      }),
      { numRuns: 400 },
    );
  });

  it('the target is exactly one level up, capped at L4', () => {
    fc.assert(
      fc.property(evidenceArb, (input) => {
        const result = evaluatePromotionEvidence(input);
        expect(result.targetLevel).toBe(Math.min(4, Math.max(0, Math.trunc(input.currentLevel)) + 1));
      }),
      { numRuns: 200 },
    );
  });

  it('open incidents always block promotion', () => {
    fc.assert(
      fc.property(evidenceArb, fc.integer({ min: 1, max: 10 }), (input, incidents) => {
        const result = evaluatePromotionEvidence({ ...input, openIncidents: incidents });
        expect(result.eligible).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});

describe('Feature: content-os, Property 7: promotion requires a human decision', () => {
  const kindArb = fc.constantFrom('promotion', 'approval', 'veto');
  const statusArb = fc.constantFrom('pending', 'approved', 'rejected', 'expired');
  const userArb = fc.option(fc.stringMatching(/^user_[a-z0-9]{4}$/), { nil: null });

  it('only (kind=promotion, status=pending, human actor) can apply', () => {
    fc.assert(
      fc.property(kindArb, statusArb, userArb, (kind, status, userId) => {
        const result = validatePromotionApplication({ kind, status }, userId);
        const shouldPass = kind === 'promotion' && status === 'pending' && userId !== null;
        expect(result.ok).toBe(shouldPass);
      }),
      { numRuns: 200 },
    );
  });

  it('a missing approval or missing human always fails', () => {
    expect(validatePromotionApplication(null, 'user_1')).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(validatePromotionApplication({ kind: 'promotion', status: 'pending' }, null)).toMatchObject({
      ok: false,
      code: 'HUMAN_REQUIRED',
    });
  });
});

describe('defaultLevelFor mirrors the resolver defaults', () => {
  it('dangerous capabilities default to L1, safe to L2', () => {
    expect(defaultLevelFor('schema:create')).toBe(1);
    expect(defaultLevelFor('schema:delete')).toBe(1);
    expect(defaultLevelFor('items:delete')).toBe(1);
    expect(defaultLevelFor('schema:read')).toBe(2);
    expect(defaultLevelFor('items:update')).toBe(2);
    expect(defaultLevelFor('items:read')).toBe(2);
  });

  it('sanity: defaults agree with DEFAULT_PROMOTION_THRESHOLDS shape', () => {
    expect(DEFAULT_PROMOTION_THRESHOLDS.streak).toBeGreaterThan(0);
    expect(DEFAULT_PROMOTION_THRESHOLDS.approveRate).toBeLessThanOrEqual(1);
  });
});
