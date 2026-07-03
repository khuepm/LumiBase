import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';
import { AISecureHarness, CORE_SKILLS } from '../ai-harness';
import type { Database } from '@lumibase/database';

/**
 * Feature: ai-first-cms-engine, Property 5: Approval execution flow — phê duyệt thực thi đúng
 *
 * With any Approval_Record in 'pending' status belonging to the current siteId,
 * when calling harness.executeApproved(approvalId, userId, ['*']) and the skill executes
 * successfully, then:
 * (a) result has status === 'executed'
 * (b) Approval_Record is updated to status === 'approved'
 * (c) decidedAt is recorded
 * (d) decidedBy === userId
 *
 * **Validates: Requirements 3.1, 3.2, 6.1**
 */

// Safe skills that will execute successfully (not dangerous, handlers return data)
const SAFE_SKILL_NAMES = Object.entries(CORE_SKILLS)
  .filter(([name, skill]) => {
    const requiresSchemaWrite = skill.requiredCapabilities.some((capability) => capability.startsWith('schema:') && capability !== 'schema:read');
    const startsWithDelete = name.startsWith('delete');
    // Deployment skills have no offline handler behaviour (they require a
    // runtime KeyProvider, absent here) and deliberately error instead of
    // stubbing — they are covered by deployment/__tests__ instead.
    const isDeployment = skill.service === 'deployments';
    return !requiresSchemaWrite && !startsWithDelete && !isDeployment;
  })
  .map(([name]) => name);

// All skill names (including dangerous ones) — the executeApproved method
// runs any skill stored in the approval record regardless of risk
// classification. Deployment skills are excluded: they have no offline handler
// behaviour (require a runtime KeyProvider), so they can't be executed in this
// mock harness; their approval/execution path is covered in deployment tests.
const ALL_SKILL_NAMES = Object.entries(CORE_SKILLS)
  .filter(([, skill]) => skill.service !== 'deployments')
  .map(([name]) => name);

// Arbitrary: approvalId — nanoid-like string (21 alphanumeric chars)
const approvalIdArb = fc.string({ minLength: 21, maxLength: 21, unit: fc.constantFrom(
  ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-'.split(''),
) });

// Arbitrary: userId — non-empty string
const userIdArb = fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0);

// Arbitrary: pick a skill name from CORE_SKILLS (all skills, since approval can store any)
const skillNameArb = fc.constantFrom(...ALL_SKILL_NAMES);

// Arbitrary: generate random arguments for the skill
const argsArb = fc.dictionary(
  fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^[a-zA-Z_]/.test(s)),
  fc.oneof(fc.string(), fc.integer(), fc.boolean()),
  { minKeys: 0, maxKeys: 5 },
);

// Arbitrary: siteId — non-empty string
const siteIdArb = fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0);

/**
 * Creates a mock database that:
 * - db.select().from().where() returns a pending approval record
 * - db.update().set().where() captures the update call for verification
 */
function createMockDbForApproval(record: {
  id: string;
  siteId: string;
  skillName: string;
  arguments: Record<string, unknown>;
  status: string;
}) {
  // Track update calls
  const updateSetArgs: Record<string, unknown>[] = [];

  // Mock: db.select().from().where() → returns [record]
  const mockWhere = vi.fn().mockResolvedValue([record]);
  const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
  const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });

  // Mock: db.update().set().where() → resolves (captures set args)
  const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
  const mockSet = vi.fn().mockImplementation((setData: Record<string, unknown>) => {
    updateSetArgs.push(setData);
    return { where: mockUpdateWhere };
  });
  const mockUpdate = vi.fn().mockReturnValue({ set: mockSet });

  const db = {
    select: mockSelect,
    update: mockUpdate,
    insert: vi.fn(),
    delete: vi.fn(),
  } as unknown as Database;

  return { db, updateSetArgs, mockSelect, mockUpdate, mockSet, mockUpdateWhere };
}

describe('Feature: ai-first-cms-engine, Property 5: Approval execution flow — phê duyệt thực thi đúng', () => {
  it('pending approval with successful skill execution returns status "executed" and updates record to "approved"', async () => {
    await fc.assert(
      fc.asyncProperty(
        approvalIdArb,
        userIdArb,
        skillNameArb,
        argsArb,
        siteIdArb,
        async (approvalId, userId, skillName, args, siteId) => {
          // Arrange: create a pending approval record
          const pendingRecord = {
            id: approvalId,
            siteId,
            skillName,
            arguments: args,
            status: 'pending',
            agentName: 'lumibase-copilot',
            context: null,
            createdAt: new Date(),
            decidedAt: null,
            decidedBy: null,
          };

          const { db, updateSetArgs } = createMockDbForApproval(pendingRecord);
          const harness = new AISecureHarness({ db, siteId });

          // Act: execute the approved action
          const result = await harness.executeApproved(approvalId, userId, ['*']);

          // Assert (a): result has status === 'executed'
          expect(result.status).toBe('executed');

          // Assert: result has data from the skill handler
          expect(result.data).toBeDefined();

          // Assert (b), (c), (d): database update was called with correct values
          expect(updateSetArgs.length).toBe(1);
          const setData = updateSetArgs[0]!;

          // (b) status updated to 'approved'
          expect(setData['status']).toBe('approved');

          // (c) decidedAt is recorded (must be a Date)
          expect(setData['decidedAt']).toBeInstanceOf(Date);

          // (d) decidedBy === userId
          expect(setData['decidedBy']).toBe(userId);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('executeApproved returns data matching the skill handler output', async () => {
    await fc.assert(
      fc.asyncProperty(
        approvalIdArb,
        userIdArb,
        fc.constantFrom(...SAFE_SKILL_NAMES),
        argsArb,
        siteIdArb,
        async (approvalId, userId, skillName, args, siteId) => {
          // Arrange
          const pendingRecord = {
            id: approvalId,
            siteId,
            skillName,
            arguments: args,
            status: 'pending',
            agentName: 'lumibase-copilot',
            context: null,
            createdAt: new Date(),
            decidedAt: null,
            decidedBy: null,
          };

          const { db } = createMockDbForApproval(pendingRecord);
          const harness = new AISecureHarness({ db, siteId });

          // Act
          const result = await harness.executeApproved(approvalId, userId, ['*']);

          // Assert: result data matches what the skill handler returns
          expect(result.status).toBe('executed');
          expect(result.data).toBeDefined();

          // The skill handler should have been called — verify data is not null/undefined
          // Each CORE_SKILLS handler returns a specific object shape
          const skill = CORE_SKILLS[skillName];
          if (skill) {
            const expectedData = await skill.handler(args);
            expect(result.data).toEqual(expectedData);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('denies pending approval execution when the approver lacks the stored skill capabilities', async () => {
    const pendingRecord = {
      id: 'approval-with-schema-write',
      siteId: 'site-with-approval',
      skillName: 'deleteCollection',
      arguments: { name: 'posts' },
      status: 'pending',
      agentName: 'lumibase-copilot',
      context: null,
      createdAt: new Date(),
      decidedAt: null,
      decidedBy: null,
    };

    const { db, updateSetArgs } = createMockDbForApproval(pendingRecord);
    const harness = new AISecureHarness({ db, siteId: pendingRecord.siteId });

    const result = await harness.executeApproved(
      pendingRecord.id,
      'low-privilege-user',
      ['items:read'],
    );

    expect(result).toEqual({
      status: 'denied',
      message: 'Insufficient capabilities',
    });
    expect(updateSetArgs).toHaveLength(0);
  });
});
