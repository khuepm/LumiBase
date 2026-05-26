import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { decideSchema } from '../ai';

/**
 * Feature: ai-first-cms-engine, Property 12: Decision validation
 *
 * For any value of `decision`:
 * - If decision is 'approved' or 'rejected' → decideSchema.safeParse succeeds
 * - If decision is any other string → decideSchema.safeParse fails
 *
 * **Validates: Requirements 6.2, 6.5**
 */

describe('Feature: ai-first-cms-engine, Property 12: Decision validation', () => {
  it('should accept valid decisions: "approved" or "rejected"', () => {
    const validDecisionArb = fc.constantFrom('approved', 'rejected');

    fc.assert(
      fc.property(validDecisionArb, (decision) => {
        const result = decideSchema.safeParse({ decision });

        // Property: valid decisions must be accepted
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.decision).toBe(decision);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('should reject invalid decisions: any string other than "approved"/"rejected"', () => {
    const invalidDecisionArb = fc
      .string({ minLength: 0, maxLength: 200 })
      .filter((s) => s !== 'approved' && s !== 'rejected');

    fc.assert(
      fc.property(invalidDecisionArb, (decision) => {
        const result = decideSchema.safeParse({ decision });

        // Property: invalid decisions must be rejected
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 100 },
    );
  });
});
