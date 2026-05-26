import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { chatSchema } from '../ai';

/**
 * Feature: ai-first-cms-engine, Property 9: Chat message validation
 *
 * For any input string:
 * - If after trimming the string has length 1-2000 → chatSchema.safeParse succeeds
 * - If the string is empty after trimming, or exceeds 2000 characters → chatSchema.safeParse fails
 *
 * **Validates: Requirements 4.1, 4.2**
 */

/**
 * Arbitrary that generates valid messages: strings that after trim have length 1-2000.
 * We generate a non-whitespace-only string of length 1-2000 and optionally pad with spaces.
 */
const validMessageArb = fc
  .tuple(
    // Core content: at least 1 non-whitespace char, up to 2000 total
    fc.integer({ min: 1, max: 2000 }),
    fc.string({ minLength: 1, maxLength: 50 }),
  )
  .chain(([targetLen, seed]) => {
    // Generate a string that after trim has length between 1 and 2000
    const coreLen = Math.min(targetLen, 2000);
    return fc
      .string({ minLength: coreLen, maxLength: coreLen })
      .filter((s) => s.trim().length >= 1 && s.trim().length <= 2000)
      .map((s) => {
        // Ensure it's not whitespace-only by prepending a char if needed
        if (s.trim().length === 0) return seed.slice(0, 1) + s.slice(1);
        return s;
      });
  })
  .filter((s) => {
    const trimmed = s.trim();
    return trimmed.length >= 1 && trimmed.length <= 2000;
  });

/**
 * Simpler valid message arbitrary: generate non-whitespace content of length 1-2000
 * with optional leading/trailing whitespace that keeps total under the max limit.
 */
const simpleValidMessageArb = fc
  .tuple(
    // Non-whitespace content between 1 and 2000 chars
    fc.stringOf(
      fc.char().filter((c) => c.trim().length > 0),
      { minLength: 1, maxLength: 100 },
    ),
    // Optional leading whitespace
    fc.stringOf(fc.constant(' '), { minLength: 0, maxLength: 5 }),
    // Optional trailing whitespace
    fc.stringOf(fc.constant(' '), { minLength: 0, maxLength: 5 }),
  )
  .map(([content, leading, trailing]) => leading + content + trailing)
  .filter((s) => s.trim().length >= 1 && s.trim().length <= 2000);

/**
 * Arbitrary that generates invalid messages:
 * - Empty strings
 * - Whitespace-only strings
 * - Strings exceeding 2000 characters (before trim check, max is applied pre-trim)
 */
const emptyOrWhitespaceArb = fc.oneof(
  // Empty string
  fc.constant(''),
  // Whitespace-only strings of various lengths
  fc.stringOf(fc.constantFrom(' ', '\t', '\n', '\r'), { minLength: 1, maxLength: 50 }),
);

const tooLongMessageArb = fc
  .string({ minLength: 2001, maxLength: 2500 })
  .filter((s) => s.length > 2000);

describe('Feature: ai-first-cms-engine, Property 9: Chat message validation', () => {
  it('should accept messages that after trim have length 1-2000', () => {
    fc.assert(
      fc.property(simpleValidMessageArb, (message) => {
        const result = chatSchema.safeParse({ message });

        // Property: valid messages (1-2000 chars after trim) must be accepted
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.message).toBe(message.trim());
        }
      }),
      { numRuns: 100 },
    );
  });

  it('should reject empty or whitespace-only messages with errors array', () => {
    fc.assert(
      fc.property(emptyOrWhitespaceArb, (message) => {
        const result = chatSchema.safeParse({ message });

        // Property: empty/whitespace-only messages must be rejected
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('should reject messages exceeding 2000 characters with errors array', () => {
    fc.assert(
      fc.property(tooLongMessageArb, (message) => {
        const result = chatSchema.safeParse({ message });

        // Property: messages > 2000 chars must be rejected
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 100 },
    );
  });
});
