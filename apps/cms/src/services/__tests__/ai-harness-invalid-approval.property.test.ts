import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';
import { AISecureHarness } from '../ai-harness';
import type { Database } from '@lumibase/database';

/**
 * Feature: ai-first-cms-engine, Property 6: Invalid approval denial
 *
 * With any approvalId where the Approval_Record does not exist, does not belong
 * to the current siteId, or has a status other than 'pending', when calling
 * harness.executeApproved(...), the result must have status === 'denied' and
 * no database update should occur.
 *
 * **Validates: Requirements 3.3, 6.6**
 */

// Arbitrary: generate random approvalId strings (non-empty)
const approvalIdArb = fc.string({ minLength: 1, maxLength: 50 }).filter(
  (s) => s.trim().length > 0,
);

// Arbitrary: generate random userId strings (non-empty)
const userIdArb = fc.string({ minLength: 1, maxLength: 50 }).filter(
  (s) => s.trim().length > 0,
);

// Arbitrary: generate non-pending statuses
const nonPendingStatusArb = fc.constantFrom('approved', 'rejected');

// Arbitrary: generate random siteId strings (non-empty)
const siteIdArb = fc.string({ minLength: 1, maxLength: 30 }).filter(
  (s) => s.trim().length > 0,
);

// Arbitrary: generate random skill names for records
const skillNameArb = fc.constantFrom(
  'listCollections',
  'createCollection',
  'deleteCollection',
  'listItems',
  'createItem',
  'deleteItem',
);

/**
 * Creates a mock database where select().from().where() returns an empty array
 * (simulating approval not found or belonging to a different site).
 */
function createMockDbNotFound() {
  const updateFn = vi.fn();
  const whereFn = vi.fn().mockResolvedValue([]);
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });

  const db = {
    select: selectFn,
    update: updateFn,
    insert: vi.fn(),
    delete: vi.fn(),
  };

  return { db: db as unknown as Database, updateFn };
}

/**
 * Creates a mock database where select().from().where() returns a record
 * with a non-pending status (simulating already processed approval).
 */
function createMockDbNonPending(status: string, skillName: string, siteId: string) {
  const updateFn = vi.fn();
  const whereFn = vi.fn().mockResolvedValue([
    {
      id: 'some-approval-id',
      siteId,
      agentName: 'lumibase-copilot',
      skillName,
      arguments: {},
      status,
      context: null,
      createdAt: new Date(),
      decidedAt: new Date(),
      decidedBy: 'some-user',
    },
  ]);
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });

  const db = {
    select: selectFn,
    update: updateFn,
    insert: vi.fn(),
    delete: vi.fn(),
  };

  return { db: db as unknown as Database, updateFn };
}

describe('Feature: ai-first-cms-engine, Property 6: Invalid approval denial', () => {
  it('should return status "denied" and not update DB when approval is not found', async () => {
    await fc.assert(
      fc.asyncProperty(
        approvalIdArb,
        userIdArb,
        siteIdArb,
        async (approvalId, userId, siteId) => {
          // Arrange: db returns empty array (approval not found)
          const { db, updateFn } = createMockDbNotFound();
          const harness = new AISecureHarness({ db, siteId });

          // Act
          const result = await harness.executeApproved(approvalId, userId, ['*']);

          // Assert: status must be 'denied'
          expect(result.status).toBe('denied');

          // Assert: message should indicate invalid/not found
          expect(result.message).toBeDefined();
          expect(typeof result.message).toBe('string');

          // Assert: no update should be called
          expect(updateFn).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should return status "denied" and not update DB when approval has non-pending status', async () => {
    await fc.assert(
      fc.asyncProperty(
        approvalIdArb,
        userIdArb,
        siteIdArb,
        nonPendingStatusArb,
        skillNameArb,
        async (approvalId, userId, siteId, status, skillName) => {
          // Arrange: db returns a record with non-pending status
          const { db, updateFn } = createMockDbNonPending(status, skillName, siteId);
          const harness = new AISecureHarness({ db, siteId });

          // Act
          const result = await harness.executeApproved(approvalId, userId, ['*']);

          // Assert: status must be 'denied'
          expect(result.status).toBe('denied');

          // Assert: message should indicate already processed
          expect(result.message).toBeDefined();
          expect(typeof result.message).toBe('string');

          // Assert: no update should be called (DB unchanged)
          expect(updateFn).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should consistently deny for any combination of invalid approval scenarios', async () => {
    // This test combines both scenarios: randomly choose between not-found and non-pending
    await fc.assert(
      fc.asyncProperty(
        approvalIdArb,
        userIdArb,
        siteIdArb,
        fc.boolean(), // true = not found, false = non-pending
        nonPendingStatusArb,
        skillNameArb,
        async (approvalId, userId, siteId, isNotFound, status, skillName) => {
          // Arrange: create appropriate mock based on scenario
          const { db, updateFn } = isNotFound
            ? createMockDbNotFound()
            : createMockDbNonPending(status, skillName, siteId);

          const harness = new AISecureHarness({ db, siteId });

          // Act
          const result = await harness.executeApproved(approvalId, userId, ['*']);

          // Assert: in all invalid cases, status must be 'denied'
          expect(result.status).toBe('denied');

          // Assert: result should never have 'executed' status
          expect(result.status).not.toBe('executed');

          // Assert: no database update should occur
          expect(updateFn).not.toHaveBeenCalled();

          // Assert: no data should be returned
          expect(result.data).toBeUndefined();
        },
      ),
      { numRuns: 100 },
    );
  });
});
