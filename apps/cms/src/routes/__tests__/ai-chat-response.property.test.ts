import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';
import { AISecureHarness, CORE_SKILLS } from '../../services/ai-harness';
import type { Database } from '@lumibase/database';

export function analyzeIntent(message: string): { skillName: string; args: Record<string, any> } | null {
  const lower = message.toLowerCase();

  if (lower.includes('list collections') || lower.includes('show collections')) {
    return { skillName: 'listCollections', args: {} };
  }

  if (lower.includes('create collection')) {
    const nameMatch = message.match(/create collection\s+["']?(\w+)["']?/i);
    return {
      skillName: 'createCollection',
      args: { name: nameMatch?.[1] ?? 'untitled' },
    };
  }

  if (lower.includes('delete collection')) {
    const nameMatch = message.match(/delete collection\s+["']?(\w+)["']?/i);
    return {
      skillName: 'deleteCollection',
      args: { name: nameMatch?.[1] ?? '' },
    };
  }

  if (lower.includes('list items') || lower.includes('show items')) {
    const collMatch = message.match(
      /(?:list|show) items\s+(?:in|from|of)\s+["']?(\w+)["']?/i,
    );
    return {
      skillName: 'listItems',
      args: { collection: collMatch?.[1] ?? '' },
    };
  }

  if (lower.includes('create item')) {
    const collMatch = message.match(/create item\s+(?:in|for)\s+["']?(\w+)["']?/i);
    return {
      skillName: 'createItem',
      args: { collection: collMatch?.[1] ?? '' },
    };
  }

  if (lower.includes('delete item')) {
    const idMatch = message.match(/delete item\s+["']?(\w+)["']?/i);
    return {
      skillName: 'deleteItem',
      args: { id: idMatch?.[1] ?? '' },
    };
  }

  return null;
}

/**
 * Feature: ai-first-cms-engine, Property 10: Chat API response structure
 *
 * With any successful result from AI_Harness, the response of the `/chat` endpoint
 * must have the structure `{ data: { status } }` where `status` is one of three values:
 * 'executed', 'pending_approval', or 'denied'.
 *
 * **Validates: Requirements 4.7**
 */

// Valid status values for the chat API response
const VALID_STATUSES = ['executed', 'pending_approval', 'denied'] as const;

// ---------------------------------------------------------------------------
// Generators: messages that produce valid intents
// ---------------------------------------------------------------------------

// Collection name generator
const collectionNameArb = fc.string({
  unit: fc.string({ minLength: 1, maxLength: 1 }).filter((c) => /\w/.test(c)),
  minLength: 1,
  maxLength: 15,
});

// Item id generator
const itemIdArb = fc.string({
  unit: fc.string({ minLength: 1, maxLength: 1 }).filter((c) => /\w/.test(c)),
  minLength: 1,
  maxLength: 15,
});

// Messages that map to known intents via analyzeIntent
const intentMessageArb = fc.oneof(
  // listCollections
  fc.constantFrom('list collections', 'show collections'),
  // createCollection
  collectionNameArb.map((name) => `create collection ${name}`),
  // deleteCollection
  collectionNameArb.map((name) => `delete collection ${name}`),
  // listItems
  collectionNameArb.map((name) => `list items in ${name}`),
  // createItem
  collectionNameArb.map((name) => `create item in ${name}`),
  // deleteItem
  itemIdArb.map((id) => `delete item ${id}`),
);

// Capabilities generator: either wildcard or a subset of known capabilities
const capabilitiesArb = fc.oneof(
  // fast-check 4 infers `const` type parameters, so the wildcard needs an
  // explicit `string[]` or it widens to a readonly tuple the harness rejects.
  fc.constant<string[]>(['*']),
  fc.subarray(['schema:read', 'schema:create', 'schema:update', 'schema:delete', 'schema:migrate', 'items:read', 'items:write'], {
    minLength: 0,
    maxLength: 7,
  }),
);

// ---------------------------------------------------------------------------
// Mock database for dangerous skills that create approval records
// ---------------------------------------------------------------------------

function createMockDb(): Database {
  const mockReturning = vi.fn().mockResolvedValue([{ id: 'mock-approval-id-001' }]);
  const mockValues = vi.fn().mockReturnValue({ returning: mockReturning });
  const mockInsert = vi.fn().mockReturnValue({ values: mockValues });

  return { insert: mockInsert } as unknown as Database;
}

// ---------------------------------------------------------------------------
// Property Test
// ---------------------------------------------------------------------------

describe('Feature: ai-first-cms-engine, Property 10: Chat API response structure', () => {
  it('for any message that maps to a valid intent, harness response has { status } where status is executed, pending_approval, or denied', async () => {
    await fc.assert(
      fc.asyncProperty(
        intentMessageArb,
        capabilitiesArb,
        async (message, capabilities) => {
          // Step 1: Analyze intent — must produce a valid intent for these messages
          const intent = analyzeIntent(message);
          expect(intent).not.toBeNull();

          // Step 2: Execute via harness
          const mockDb = createMockDb();
          const harness = new AISecureHarness({
            db: mockDb,
            siteId: 'test-site-chat-response',
          });

          const result = await harness.execute(
            intent!.skillName,
            intent!.args,
            capabilities,
            message,
          );

          // Step 3: Verify response structure matches { data: { status } } contract
          // The API wraps this as { data: result }, so we verify the result itself
          expect(result).toBeDefined();
          expect(result).toHaveProperty('status');
          expect(VALID_STATUSES).toContain(result.status);

          // Additional structural checks based on status
          if (result.status === 'executed') {
            expect(result).toHaveProperty('data');
          }
          if (result.status === 'pending_approval') {
            expect(result).toHaveProperty('approvalId');
            expect(typeof result.approvalId).toBe('string');
            expect(result.approvalId!.length).toBeGreaterThan(0);
          }
          if (result.status === 'denied') {
            expect(result).toHaveProperty('message');
            expect(typeof result.message).toBe('string');
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('response status is always one of the three valid values regardless of skill or capabilities combination', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Use all valid skill names directly
        fc.constantFrom(...Object.keys(CORE_SKILLS)),
        fc.dictionary(
          fc.string({ minLength: 1, maxLength: 8 }),
          fc.oneof(fc.string(), fc.integer(), fc.boolean()),
          { minKeys: 0, maxKeys: 3 },
        ),
        capabilitiesArb,
        async (skillName, args, capabilities) => {
          const mockDb = createMockDb();
          const harness = new AISecureHarness({
            db: mockDb,
            siteId: 'test-site-chat-response',
          });

          const result = await harness.execute(
            skillName,
            args,
            capabilities,
          );

          // Property: status is always one of the three valid values
          expect(result).toBeDefined();
          expect(result).toHaveProperty('status');
          expect(VALID_STATUSES).toContain(result.status);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('simulated chat API response wrapping preserves the correct structure', async () => {
    await fc.assert(
      fc.asyncProperty(
        intentMessageArb,
        capabilitiesArb,
        async (message, capabilities) => {
          const intent = analyzeIntent(message);
          expect(intent).not.toBeNull();

          const mockDb = createMockDb();
          const harness = new AISecureHarness({
            db: mockDb,
            siteId: 'test-site-chat-response',
          });

          const result = await harness.execute(
            intent!.skillName,
            intent!.args,
            capabilities,
            message,
          );

          // Simulate the API response wrapping: { data: result }
          const apiResponse = { data: result };

          // Property: API response has { data: { status } } structure
          expect(apiResponse).toHaveProperty('data');
          expect(apiResponse.data).toHaveProperty('status');
          expect(VALID_STATUSES).toContain(apiResponse.data.status);
        },
      ),
      { numRuns: 100 },
    );
  });
});
