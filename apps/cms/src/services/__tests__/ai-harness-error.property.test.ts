import { describe, it, expect, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { AISecureHarness, CORE_SKILLS } from '../ai-harness';
import type { SkillDefinition } from '../ai-harness';
import type { Database } from '@lumibase/database';
import { vi } from 'vitest';

/**
 * Feature: ai-first-cms-engine, Property 4: Execution error handling
 *
 * With any safe skill whose handler throws an exception, when calling
 * harness.execute(...), the result must have status === 'denied' with an error
 * message, and no database changes occur.
 *
 * **Validates: Requirements 2.8**
 */

// Safe skills: those that do NOT require 'schema:write' and whose name does NOT start with 'delete'
const SAFE_SKILL_NAMES = Object.entries(CORE_SKILLS)
  .filter(([name, skill]) => {
    const requiresSchemaWrite = skill.requiredCapabilities.includes('schema:write');
    const startsWithDelete = name.startsWith('delete');
    return !requiresSchemaWrite && !startsWithDelete;
  })
  .map(([name]) => name);

// Store original handlers so we can restore them
const originalHandlers = new Map<string, SkillDefinition['handler']>();

function saveOriginalHandlers(): void {
  for (const name of SAFE_SKILL_NAMES) {
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

// Arbitrary: pick a safe skill name
const safeSkillNameArb = fc.constantFrom(...SAFE_SKILL_NAMES);

// Arbitrary: generate error messages (non-empty strings)
const errorMessageArb = fc.string({ minLength: 1, maxLength: 200 });

// Arbitrary: generate arbitrary arguments for the skill
const argsArb = fc.dictionary(
  fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^[a-zA-Z_]/.test(s)),
  fc.oneof(fc.string(), fc.integer(), fc.boolean()),
  { minKeys: 0, maxKeys: 5 },
);

// Create a mock database that tracks insert calls
function createMockDb() {
  const insertFn = vi.fn();
  const db = {
    insert: insertFn,
    select: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  return { db: db as unknown as Database, insertFn };
}

describe('Feature: ai-first-cms-engine, Property 4: Execution error handling', () => {
  afterEach(() => {
    restoreOriginalHandlers();
    saveOriginalHandlers();
  });

  it('should return status "denied" with error message when safe skill handler throws an Error', async () => {
    await fc.assert(
      fc.asyncProperty(
        safeSkillNameArb,
        errorMessageArb,
        argsArb,
        async (skillName, errorMsg, args) => {
          // Arrange: override the safe skill handler to throw
          const skill = CORE_SKILLS[skillName];
          if (!skill) return;

          skill.handler = async () => {
            throw new Error(errorMsg);
          };

          // Give user sufficient capabilities for this skill
          const userCapabilities = [...skill.requiredCapabilities];

          const { db, insertFn } = createMockDb();
          const harness = new AISecureHarness({ db, siteId: 'test-site' });

          // Act
          const result = await harness.execute(skillName, args, userCapabilities);

          // Assert: status must be 'denied'
          expect(result.status).toBe('denied');

          // Assert: message must describe the error
          expect(result.message).toBeDefined();
          expect(result.message).toBe(errorMsg);

          // Assert: no database changes (insert should not be called)
          expect(insertFn).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should return status "denied" when safe skill handler throws a non-Error value', async () => {
    await fc.assert(
      fc.asyncProperty(
        safeSkillNameArb,
        argsArb,
        async (skillName, args) => {
          // Arrange: override the safe skill handler to throw a non-Error value
          const skill = CORE_SKILLS[skillName];
          if (!skill) return;

          skill.handler = async () => {
            throw 'string error'; // eslint-disable-line no-throw-literal
          };

          const userCapabilities = [...skill.requiredCapabilities];

          const { db, insertFn } = createMockDb();
          const harness = new AISecureHarness({ db, siteId: 'test-site' });

          // Act
          const result = await harness.execute(skillName, args, userCapabilities);

          // Assert: status must be 'denied'
          expect(result.status).toBe('denied');

          // Assert: message must exist (describes the error)
          expect(result.message).toBeDefined();
          expect(typeof result.message).toBe('string');
          expect(result.message!.length).toBeGreaterThan(0);

          // Assert: no database changes
          expect(insertFn).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should return status "denied" when safe skill handler throws with wildcard capability', async () => {
    await fc.assert(
      fc.asyncProperty(
        safeSkillNameArb,
        errorMessageArb,
        argsArb,
        async (skillName, errorMsg, args) => {
          // Arrange: override the safe skill handler to throw
          const skill = CORE_SKILLS[skillName];
          if (!skill) return;

          skill.handler = async () => {
            throw new Error(errorMsg);
          };

          // Use wildcard capability — should still get 'denied' on execution error
          const userCapabilities = ['*'];

          const { db, insertFn } = createMockDb();
          const harness = new AISecureHarness({ db, siteId: 'test-site' });

          // Act
          const result = await harness.execute(skillName, args, userCapabilities);

          // Assert: status must be 'denied' even with wildcard
          expect(result.status).toBe('denied');

          // Assert: message describes the error
          expect(result.message).toBe(errorMsg);

          // Assert: no database changes
          expect(insertFn).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 100 },
    );
  });
});
