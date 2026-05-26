import { describe, it, expect, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { AISecureHarness, CORE_SKILLS } from '../ai-harness';
import type { SkillDefinition } from '../ai-harness';
import type { Database } from '@lumibase/database';
import { vi } from 'vitest';

/**
 * Feature: ai-first-cms-engine, Property 7: Execution failure preserves pending state
 *
 * With any Approval_Record in 'pending' state whose skill handler throws an exception
 * or times out, when calling harness.executeApproved(approvalId, userId), the
 * Approval_Record must remain in 'pending' state and the result must have
 * status === 'denied' with an error message.
 *
 * **Validates: Requirements 3.5, 6.7**
 */

// Identify safe skills (not schema:write, not delete*) from CORE_SKILLS
const SAFE_SKILL_NAMES = Object.entries(CORE_SKILLS)
  .filter(([name, skill]) => {
    const requiresSchemaWrite = skill.requiredCapabilities.includes('schema:write');
    const startsWithDelete = name.startsWith('delete');
    return !requiresSchemaWrite && !startsWithDelete;
  })
  .map(([name]) => name);

// All skill names from CORE_SKILLS (for broader coverage)
const ALL_SKILL_NAMES = Object.keys(CORE_SKILLS);

// Store original handlers so we can restore them
const originalHandlers = new Map<string, SkillDefinition['handler']>();

function saveOriginalHandlers(): void {
  for (const name of ALL_SKILL_NAMES) {
    const skill = CORE_SKILLS[name];
    if (skill) {
      originalHandlers.set(name, skill.handler);
    }
  }
}

function restoreOriginalHandlers(): void {
  for (const [name, handler] of originalHandlers.entries()) {
    const skill = CORE_SKILLS[name];
    if (skill) {
      skill.handler = handler;
    }
  }
  originalHandlers.clear();
}

// Save handlers before tests run
saveOriginalHandlers();

// Arbitrary: pick a skill name from CORE_SKILLS
const skillNameArb = fc.constantFrom(...ALL_SKILL_NAMES);

// Arbitrary: generate error messages (non-empty strings)
const errorMessageArb = fc.string({ minLength: 1, maxLength: 200 });

// Arbitrary: generate approval IDs
const approvalIdArb = fc.string({ minLength: 10, maxLength: 21 }).filter((s) => s.length > 0);

// Arbitrary: generate user IDs
const userIdArb = fc.string({ minLength: 5, maxLength: 21 }).filter((s) => s.length > 0);

// Arbitrary: generate arbitrary arguments for the skill
const argsArb = fc.dictionary(
  fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^[a-zA-Z_]/.test(s)),
  fc.oneof(fc.string(), fc.integer(), fc.boolean()),
  { minKeys: 0, maxKeys: 5 },
);

// Arbitrary: generate a siteId
const siteIdArb = fc.string({ minLength: 5, maxLength: 30 }).filter((s) => s.length > 0);

/**
 * Creates a mock database that returns a pending approval record on select,
 * and tracks whether update was called.
 */
function createMockDbWithPendingApproval(
  approvalId: string,
  siteId: string,
  skillName: string,
  args: Record<string, unknown>,
) {
  const updateFn = vi.fn();

  // Build a chainable select mock that returns a pending approval record
  const selectResult = [
    {
      id: approvalId,
      siteId,
      agentName: 'lumibase-copilot',
      skillName,
      arguments: args,
      status: 'pending',
      context: null,
      createdAt: new Date(),
      decidedAt: null,
      decidedBy: null,
    },
  ];

  const whereFn = vi.fn().mockResolvedValue(selectResult);
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });

  // Update mock — should NOT be called when skill fails
  const updateWhereFn = vi.fn().mockResolvedValue([]);
  const updateSetFn = vi.fn().mockReturnValue({ where: updateWhereFn });
  updateFn.mockReturnValue({ set: updateSetFn });

  const db = {
    select: selectFn,
    insert: vi.fn(),
    update: updateFn,
    delete: vi.fn(),
  };

  return { db: db as unknown as Database, updateFn };
}

describe('Feature: ai-first-cms-engine, Property 7: Execution failure preserves pending state', () => {
  afterEach(() => {
    restoreOriginalHandlers();
    saveOriginalHandlers();
  });

  it('should return status "denied" and NOT update approval when skill handler throws an Error', async () => {
    await fc.assert(
      fc.asyncProperty(
        skillNameArb,
        errorMessageArb,
        approvalIdArb,
        userIdArb,
        argsArb,
        siteIdArb,
        async (skillName, errorMsg, approvalId, userId, args, siteId) => {
          // Arrange: override the skill handler to throw
          const skill = CORE_SKILLS[skillName];
          if (!skill) return;

          skill.handler = async () => {
            throw new Error(errorMsg);
          };

          const { db, updateFn } = createMockDbWithPendingApproval(
            approvalId,
            siteId,
            skillName,
            args,
          );

          const harness = new AISecureHarness({ db, siteId });

          // Act
          const result = await harness.executeApproved(approvalId, userId);

          // Assert: result has status 'denied'
          expect(result.status).toBe('denied');

          // Assert: result has an error message
          expect(result.message).toBeDefined();
          expect(typeof result.message).toBe('string');
          expect(result.message!.length).toBeGreaterThan(0);

          // Assert: db.update() is NOT called (record stays 'pending')
          expect(updateFn).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should return status "denied" and NOT update approval when skill handler throws a non-Error value', async () => {
    await fc.assert(
      fc.asyncProperty(
        skillNameArb,
        approvalIdArb,
        userIdArb,
        argsArb,
        siteIdArb,
        async (skillName, approvalId, userId, args, siteId) => {
          // Arrange: override the skill handler to throw a non-Error value
          const skill = CORE_SKILLS[skillName];
          if (!skill) return;

          skill.handler = async () => {
            throw 'non-error-thrown-value'; // eslint-disable-line no-throw-literal
          };

          const { db, updateFn } = createMockDbWithPendingApproval(
            approvalId,
            siteId,
            skillName,
            args,
          );

          const harness = new AISecureHarness({ db, siteId });

          // Act
          const result = await harness.executeApproved(approvalId, userId);

          // Assert: result has status 'denied'
          expect(result.status).toBe('denied');

          // Assert: result has an error message
          expect(result.message).toBeDefined();
          expect(typeof result.message).toBe('string');
          expect(result.message!.length).toBeGreaterThan(0);

          // Assert: db.update() is NOT called (record stays 'pending')
          expect(updateFn).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should preserve pending state with arbitrary error messages from skill handler', async () => {
    await fc.assert(
      fc.asyncProperty(
        skillNameArb,
        errorMessageArb,
        approvalIdArb,
        userIdArb,
        siteIdArb,
        async (skillName, errorMsg, approvalId, userId, siteId) => {
          // Arrange: override the skill handler to throw with the generated error message
          const skill = CORE_SKILLS[skillName];
          if (!skill) return;

          skill.handler = async () => {
            throw new Error(errorMsg);
          };

          const { db, updateFn } = createMockDbWithPendingApproval(
            approvalId,
            siteId,
            skillName,
            {},
          );

          const harness = new AISecureHarness({ db, siteId });

          // Act
          const result = await harness.executeApproved(approvalId, userId);

          // Assert: status is 'denied'
          expect(result.status).toBe('denied');

          // Assert: the error message from the handler is propagated
          expect(result.message).toBe(errorMsg);

          // Assert: db.update() is NOT called — approval stays 'pending'
          expect(updateFn).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 100 },
    );
  });
});
