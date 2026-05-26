import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { AISecureHarness, CORE_SKILLS } from '../ai-harness';
import type { SkillDefinition } from '../ai-harness';

/**
 * Feature: ai-first-cms-engine, Property 2: Capability checking với wildcard
 *
 * With any valid skill and any set of user capabilities, harness SHALL allow
 * execution if and only if: (a) all required capabilities of the skill are in
 * the user's capabilities set, OR (b) the capabilities set contains wildcard '*'.
 * Otherwise, the result must be false (denied).
 *
 * **Validates: Requirements 2.3, 2.4**
 */

// Create a harness instance with a mock db (checkCapabilities doesn't use db)
const harness = new AISecureHarness({
  db: {} as Parameters<typeof AISecureHarness.prototype['checkCapabilities']> extends never[]
    ? never
    : unknown as import('@lumibase/database').Database,
  siteId: 'test-site',
});

// All valid skill names from CORE_SKILLS
const validSkillNames = Object.keys(CORE_SKILLS);

// Arbitrary: pick a valid skill from CORE_SKILLS
const validSkillArb = fc.constantFrom(...validSkillNames).map(
  (name) => CORE_SKILLS[name] as SkillDefinition,
);

// Arbitrary: generate a set of capability strings (realistic capability format)
const capabilityArb = fc.stringMatching(/^[a-z][a-z0-9_-]{0,19}:[a-z][a-z0-9_-]{0,19}$/);

// Arbitrary: generate a non-empty array of capabilities (without wildcard)
const capabilitiesWithoutWildcardArb = fc.array(capabilityArb, {
  minLength: 0,
  maxLength: 10,
});

describe('Feature: ai-first-cms-engine, Property 2: Capability checking với wildcard', () => {
  it('should always return true when userCapabilities includes wildcard "*"', () => {
    fc.assert(
      fc.property(validSkillArb, capabilitiesWithoutWildcardArb, (skill, extraCaps) => {
        // Add wildcard to the capabilities
        const userCapabilities = ['*', ...extraCaps];

        const result = harness.checkCapabilities(skill, userCapabilities);

        // Property: wildcard '*' always grants access regardless of required capabilities
        expect(result).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('should return true when userCapabilities includes all required capabilities', () => {
    fc.assert(
      fc.property(validSkillArb, capabilitiesWithoutWildcardArb, (skill, extraCaps) => {
        // Include all required capabilities plus some extra ones
        const userCapabilities = [...skill.requiredCapabilities, ...extraCaps];

        const result = harness.checkCapabilities(skill, userCapabilities);

        // Property: having all required capabilities grants access
        expect(result).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('should return false when any required capability is missing and no wildcard', () => {
    // Only test skills that have at least one required capability
    const skillWithCapsArb = validSkillArb.filter(
      (skill) => skill.requiredCapabilities.length > 0,
    );

    fc.assert(
      fc.property(
        skillWithCapsArb,
        capabilitiesWithoutWildcardArb,
        fc.nat(),
        (skill, extraCaps, indexSeed) => {
          // Remove at least one required capability
          const requiredCaps = skill.requiredCapabilities;
          const indexToRemove = indexSeed % requiredCaps.length;

          // Build user capabilities with all required EXCEPT one, plus extras
          // Ensure extras don't accidentally include the removed capability or wildcard
          const removedCap = requiredCaps[indexToRemove]!;
          const partialRequired = requiredCaps.filter((_, i) => i !== indexToRemove);
          const filteredExtras = extraCaps.filter(
            (cap) => cap !== removedCap && cap !== '*',
          );
          const userCapabilities = [...partialRequired, ...filteredExtras];

          const result = harness.checkCapabilities(skill, userCapabilities);

          // Property: missing any required capability (without wildcard) denies access
          expect(result).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should return true for skills with empty requiredCapabilities regardless of user caps', () => {
    // Create a skill with no required capabilities
    const emptyCapSkill: SkillDefinition = {
      name: 'noCapSkill',
      description: 'A skill requiring no capabilities',
      requiredCapabilities: [],
      handler: async () => ({}),
    };

    fc.assert(
      fc.property(capabilitiesWithoutWildcardArb, (userCaps) => {
        // Filter out wildcard to test pure capability matching
        const capsWithoutWildcard = userCaps.filter((c) => c !== '*');

        const result = harness.checkCapabilities(emptyCapSkill, capsWithoutWildcard);

        // Property: no requirements means always allowed
        expect(result).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
