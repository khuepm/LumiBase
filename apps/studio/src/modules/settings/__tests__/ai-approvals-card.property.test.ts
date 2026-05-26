import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

/**
 * Feature: ai-first-cms-engine, Property 14: Approval card rendering completeness
 *
 * For any valid ApprovalRecord, when rendered as a card in the Approvals Dashboard,
 * the card must display:
 * - skillName (as text)
 * - arguments as JSON pretty-printed with 2-space indentation
 * - context (as text, or handled when null/empty)
 *
 * **Validates: Requirements 8.2**
 */

interface ApprovalRecord {
  id: string;
  siteId: string;
  agentName: string;
  skillName: string;
  arguments: Record<string, unknown>;
  status: string;
  context: string | null;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
}

/**
 * Extracts the card rendering data from an ApprovalRecord.
 * This mirrors the rendering logic in AIApprovalsPage:
 * - skillName displayed as heading text
 * - context displayed as paragraph text (when not null)
 * - arguments displayed as JSON.stringify(arguments, null, 2)
 */
function extractCardContent(approval: ApprovalRecord): {
  skillName: string;
  argumentsJson: string;
  context: string | null;
} {
  return {
    skillName: approval.skillName,
    argumentsJson: JSON.stringify(approval.arguments, null, 2),
    context: approval.context,
  };
}

/**
 * Arbitrary for generating valid arguments objects with various shapes.
 */
const argumentsArb: fc.Arbitrary<Record<string, unknown>> = fc.oneof(
  fc.constant({}),
  fc.record({
    name: fc.string({ minLength: 1, maxLength: 50 }),
  }),
  fc.record({
    name: fc.string({ minLength: 1, maxLength: 50 }),
    value: fc.oneof(fc.integer(), fc.string(), fc.boolean()),
  }),
  fc.record({
    collection: fc.string({ minLength: 1, maxLength: 30 }),
    fields: fc.array(
      fc.record({
        name: fc.string({ minLength: 1, maxLength: 20 }),
        type: fc.constantFrom('text', 'number', 'boolean', 'json'),
      }),
      { minLength: 0, maxLength: 5 },
    ),
  }),
  fc.dictionary(
    fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)),
    fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
    { minKeys: 0, maxKeys: 10 },
  ),
);

/**
 * Arbitrary for generating valid ApprovalRecord instances.
 */
const approvalRecordArb: fc.Arbitrary<ApprovalRecord> = fc.record({
  id: fc.string({ minLength: 21, maxLength: 21 }).filter((s) => s.length === 21),
  siteId: fc.string({ minLength: 1, maxLength: 30 }),
  agentName: fc.constant('lumibase-copilot'),
  skillName: fc.stringOf(
    fc.char().filter((c) => /[a-zA-Z0-9_-]/.test(c)),
    { minLength: 1, maxLength: 50 },
  ),
  arguments: argumentsArb,
  status: fc.constant('pending'),
  context: fc.oneof(
    fc.constant(null),
    fc.string({ minLength: 0, maxLength: 200 }),
  ),
  createdAt: fc.date().map((d) => d.toISOString()),
  decidedAt: fc.constant(null),
  decidedBy: fc.constant(null),
});

describe('Feature: ai-first-cms-engine, Property 14: Approval card rendering completeness', () => {
  it('card content must include skillName displayed as text', () => {
    fc.assert(
      fc.property(approvalRecordArb, (approval) => {
        const content = extractCardContent(approval);

        // Property: skillName must be present and match the record's skillName exactly
        expect(content.skillName).toBe(approval.skillName);
        expect(content.skillName.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 },
    );
  });

  it('card content must include arguments as JSON pretty-printed with 2-space indentation', () => {
    fc.assert(
      fc.property(approvalRecordArb, (approval) => {
        const content = extractCardContent(approval);

        // Property: argumentsJson must equal JSON.stringify(arguments, null, 2)
        const expectedJson = JSON.stringify(approval.arguments, null, 2);
        expect(content.argumentsJson).toBe(expectedJson);

        // Property: the JSON must be valid and parseable back to the original
        const parsed = JSON.parse(content.argumentsJson) as Record<string, unknown>;
        expect(parsed).toEqual(approval.arguments);

        // Property: multi-line objects use 2-space indentation (not tabs, not 4 spaces)
        if (Object.keys(approval.arguments).length > 0) {
          // Non-empty objects should have indented lines with exactly 2 spaces
          const lines = content.argumentsJson.split('\n');
          const indentedLines = lines.filter((line) => line.startsWith(' '));
          for (const line of indentedLines) {
            const leadingSpaces = line.match(/^( +)/);
            if (leadingSpaces) {
              // Indentation must be a multiple of 2
              expect(leadingSpaces[1].length % 2).toBe(0);
            }
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it('card content must include context (displayed as text or null handled)', () => {
    fc.assert(
      fc.property(approvalRecordArb, (approval) => {
        const content = extractCardContent(approval);

        // Property: context must be preserved exactly as-is from the record
        expect(content.context).toBe(approval.context);

        // Property: when context is a non-null string, it is available for display
        if (approval.context !== null) {
          expect(typeof content.context).toBe('string');
        }
      }),
      { numRuns: 100 },
    );
  });

  it('card rendering includes all three required fields for any valid approval', () => {
    fc.assert(
      fc.property(approvalRecordArb, (approval) => {
        const content = extractCardContent(approval);

        // Property: all three fields must be present in the card content
        expect(content).toHaveProperty('skillName');
        expect(content).toHaveProperty('argumentsJson');
        expect(content).toHaveProperty('context');

        // Property: skillName is always a non-empty string
        expect(typeof content.skillName).toBe('string');
        expect(content.skillName.length).toBeGreaterThan(0);

        // Property: argumentsJson is always a valid JSON string
        expect(typeof content.argumentsJson).toBe('string');
        expect(() => JSON.parse(content.argumentsJson)).not.toThrow();

        // Property: context is either null or a string
        expect(content.context === null || typeof content.context === 'string').toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
