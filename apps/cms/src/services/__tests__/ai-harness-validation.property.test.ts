import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { AISecureHarness, CORE_SKILLS } from '../ai-harness';
import type { Database } from '@lumibase/database';

/**
 * Feature: ai-first-cms-engine, Property 1: Skill validation — tên skill không hợp lệ bị từ chối
 *
 * For any string skillName that does NOT exist in CORE_SKILLS,
 * calling harness.execute(skillName, ...) must return status === 'denied'
 * with a message containing the invalid skill name.
 *
 * **Validates: Requirements 2.1, 2.2**
 */

const VALID_SKILL_NAMES = Object.keys(CORE_SKILLS);

/**
 * Arbitrary that generates strings NOT present in CORE_SKILLS keys.
 * Includes common prototype property names to test edge cases,
 * plus random strings filtered to exclude valid skill names.
 */
const invalidSkillNameArb = fc.oneof(
  // Random strings that are not valid skill names
  fc
    .string({ minLength: 1, maxLength: 100 })
    .filter((s) => !VALID_SKILL_NAMES.includes(s)),
  // Edge cases: prototype property names and common strings
  fc.constantFrom(
    'constructor',
    'toString',
    'valueOf',
    'hasOwnProperty',
    '__proto__',
    'nonExistentSkill',
    'deleteEverything',
    'unknown_skill_123',
  ),
);

describe('Feature: ai-first-cms-engine, Property 1: Skill validation — tên skill không hợp lệ bị từ chối', () => {
  // Mock db — validateSkill does not use the database
  const mockDb = {} as Database;
  const siteId = 'test-site-id';

  it('should return status "denied" for any skill name not in CORE_SKILLS', async () => {
    const harness = new AISecureHarness({ db: mockDb, siteId });

    await fc.assert(
      fc.asyncProperty(invalidSkillNameArb, async (skillName) => {
        const result = await harness.execute(skillName, {}, ['*']);

        // Property: invalid skill must be denied
        expect(result.status).toBe('denied');

        // Property: message must contain the invalid skill name
        expect(result.message).toBeDefined();
        expect(result.message).toContain(skillName);
      }),
      { numRuns: 100 },
    );
  });
});
