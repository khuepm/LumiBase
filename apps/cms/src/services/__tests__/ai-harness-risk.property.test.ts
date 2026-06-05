import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';
import { AISecureHarness, CORE_SKILLS } from '../ai-harness';
import type { Database } from '@lumibase/database';

/**
 * Feature: ai-first-cms-engine, Property 3: Risk classification và execution flow
 *
 * With any valid skill where the user has sufficient capabilities:
 * - If the skill requires a mutating `schema:*` capability OR its name starts with 'delete',
 *   the result must have status === 'pending_approval' with a valid approvalId.
 * - Otherwise, the result must have status === 'executed' with data.
 *
 * **Validates: Requirements 2.5, 2.6, 2.7**
 */

// All valid skill names from CORE_SKILLS
const validSkillNames = Object.keys(CORE_SKILLS);

// Arbitrary: pick a valid skill name from CORE_SKILLS
const validSkillNameArb = fc.constantFrom(...validSkillNames);

// Arbitrary: generate random arguments (Record<string, unknown>)
const argsArb = fc.dictionary(
  fc.string({ minLength: 1, maxLength: 10 }),
  fc.oneof(fc.string(), fc.integer(), fc.boolean()),
  { minKeys: 0, maxKeys: 5 },
);

// Helper: determine if a skill is dangerous based on the risk rules
function isDangerousSkill(skillName: string): boolean {
  const skill = CORE_SKILLS[skillName];
  if (!skill) return false;
  if (skill.requiredCapabilities.some((capability) => capability.startsWith('schema:') && capability !== 'schema:read')) return true;
  if (skillName.startsWith('delete')) return true;
  return false;
}

// Mock database that simulates insert into aiApprovals and returns an approvalId
function createMockDb(): Database {
  const mockReturning = vi.fn().mockResolvedValue([{ id: 'mock-approval-id-001' }]);
  const mockValues = vi.fn().mockReturnValue({ returning: mockReturning });
  const mockInsert = vi.fn().mockReturnValue({ values: mockValues });

  return { insert: mockInsert } as unknown as Database;
}

describe('Feature: ai-first-cms-engine, Property 3: Risk classification và execution flow', () => {
  it('dangerous skills (mutating schema capability or delete*) should return pending_approval with approvalId', async () => {
    await fc.assert(
      fc.asyncProperty(
        validSkillNameArb.filter((name) => isDangerousSkill(name)),
        argsArb,
        async (skillName, args) => {
          const mockDb = createMockDb();
          const harness = new AISecureHarness({
            db: mockDb,
            siteId: 'test-site-risk',
          });

          // Use wildcard '*' so capability check always passes
          const result = await harness.execute(skillName, args, ['*']);

          // Property: dangerous skill → pending_approval with valid approvalId
          expect(result.status).toBe('pending_approval');
          expect(result.approvalId).toBeDefined();
          expect(typeof result.approvalId).toBe('string');
          expect(result.approvalId!.length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('safe skills (no mutating schema capability, name does not start with delete) should return executed with data', async () => {
    await fc.assert(
      fc.asyncProperty(
        validSkillNameArb.filter((name) => !isDangerousSkill(name)),
        argsArb,
        async (skillName, args) => {
          const mockDb = createMockDb();
          const harness = new AISecureHarness({
            db: mockDb,
            siteId: 'test-site-risk',
          });

          // Use wildcard '*' so capability check always passes
          const result = await harness.execute(skillName, args, ['*']);

          // Property: safe skill → executed with data
          expect(result.status).toBe('executed');
          expect(result.data).toBeDefined();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('risk classification is consistent: evaluateRisk matches execute behavior', async () => {
    await fc.assert(
      fc.asyncProperty(validSkillNameArb, argsArb, async (skillName, args) => {
        const mockDb = createMockDb();
        const harness = new AISecureHarness({
          db: mockDb,
          siteId: 'test-site-risk',
        });

        const skill = CORE_SKILLS[skillName]!;
        const riskResult = harness.evaluateRisk(skill, skillName);
        const executeResult = await harness.execute(skillName, args, ['*']);

        // Property: evaluateRisk(true) ↔ pending_approval, evaluateRisk(false) ↔ executed
        if (riskResult) {
          expect(executeResult.status).toBe('pending_approval');
          expect(executeResult.approvalId).toBeDefined();
        } else {
          expect(executeResult.status).toBe('executed');
          expect(executeResult.data).toBeDefined();
        }
      }),
      { numRuns: 100 },
    );
  });
});
