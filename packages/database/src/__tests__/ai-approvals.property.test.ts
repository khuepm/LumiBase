import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { nanoid } from 'nanoid';
import * as schema from '../schema';
import { aiApprovals } from '../schema/ai';
import { sites } from '../schema/core';

/**
 * Feature: ai-first-cms-engine, Property 15: Approval record round-trip
 *
 * For any valid Approval_Record data (skillName, arguments, context, siteId),
 * inserting into the database and querying back by id must preserve all field values,
 * id must be exactly 21 characters, and status defaults to 'pending'.
 *
 * **Validates: Requirements 1.1, 1.3, 1.6**
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL;

describe('Feature: ai-first-cms-engine, Property 15: Approval record round-trip', () => {
  let sqlClient: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let testSiteId: string;
  let canConnect = false;

  beforeAll(async () => {
    if (!TEST_DATABASE_URL) {
      return;
    }

    try {
      sqlClient = postgres(TEST_DATABASE_URL, { max: 3, prepare: false });
      db = drizzle(sqlClient, { schema });

      // Verify connection works
      await db.execute(sql`SELECT 1`);
      canConnect = true;

      // Create a test site for FK constraint
      testSiteId = nanoid();
      await db.insert(sites).values({ id: testSiteId, name: 'test-site-pbt-approvals' });
    } catch {
      canConnect = false;
    }
  });

  afterAll(async () => {
    if (!canConnect) return;

    // Clean up: delete test site (cascades to ai_approvals)
    await db.delete(sites).where(eq(sites.id, testSiteId));
    await sqlClient.end();
  });

  beforeEach(async () => {
    if (!canConnect) return;
    // Clean up any leftover approvals from previous test runs
    await db.delete(aiApprovals).where(eq(aiApprovals.siteId, testSiteId));
  });

  // Arbitrary generators for valid approval data
  const skillNameArb = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,49}$/);

  const argumentsArb = fc.oneof(
    fc.constant({}),
    fc.record({
      name: fc.string({ minLength: 1, maxLength: 20 }),
      value: fc.oneof(fc.string({ maxLength: 50 }), fc.integer(), fc.boolean()),
    }),
    fc.record({
      collectionName: fc.string({ minLength: 1, maxLength: 30 }),
      fields: fc.array(fc.string({ minLength: 1, maxLength: 10 }), { maxLength: 5 }),
    }),
  );

  const contextArb = fc.oneof(
    fc.constant(null),
    fc.string({ minLength: 1, maxLength: 200 }),
  );

  it('should preserve all field values after insert and query (round-trip)', async () => {
    if (!canConnect) {
      console.warn('Skipping: DATABASE_URL not set or database not reachable');
      return;
    }

    await fc.assert(
      fc.asyncProperty(skillNameArb, argumentsArb, contextArb, async (skillName, args, context) => {
        // Insert a record (let the schema defaults handle id, status, createdAt, agentName)
        const [inserted] = await db
          .insert(aiApprovals)
          .values({
            siteId: testSiteId,
            skillName,
            arguments: args,
            context,
          })
          .returning();

        expect(inserted).toBeDefined();

        // Query back by id
        const [queried] = await db
          .select()
          .from(aiApprovals)
          .where(eq(aiApprovals.id, inserted!.id));

        expect(queried).toBeDefined();

        // Property: id must be exactly 21 characters (nanoid default)
        expect(queried!.id).toHaveLength(21);

        // Property: status defaults to 'pending'
        expect(queried!.status).toBe('pending');

        // Property: all inserted values are preserved
        expect(queried!.siteId).toBe(testSiteId);
        expect(queried!.skillName).toBe(skillName);
        expect(queried!.arguments).toEqual(args);
        expect(queried!.context).toBe(context);

        // Property: agentName defaults to 'lumibase-copilot'
        expect(queried!.agentName).toBe('lumibase-copilot');

        // Property: createdAt is set (not null)
        expect(queried!.createdAt).toBeInstanceOf(Date);

        // Property: decidedAt and decidedBy are null by default
        expect(queried!.decidedAt).toBeNull();
        expect(queried!.decidedBy).toBeNull();

        // Clean up this record
        await db.delete(aiApprovals).where(eq(aiApprovals.id, inserted!.id));
      }),
      { numRuns: 100 },
    );
  });
});
