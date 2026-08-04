import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { nanoid } from 'nanoid';
import * as schema from '../schema';
import { collections, items, revisions } from '../schema/cms';
import { sites } from '../schema/core';

/**
 * Feature: content-os, Property 13: Provenance round-trip
 *
 * For any valid provenance data, inserting a revision and querying it back
 * must preserve authorType, model, constitutionHash, sources and confidence.
 * Defaults must hold: authorType 'human', staged false, autoCommitAt null
 * when omitted, and items.pinnedFields defaults to [].
 *
 * **Validates: Requirements 1.1, 1.2, 1.3**
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL;

describe('Feature: content-os, Property 13: Provenance round-trip', () => {
  let sqlClient: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let testSiteId: string;
  let testCollectionId: string;
  let testItemId: string;
  let canConnect = false;

  beforeAll(async () => {
    if (!TEST_DATABASE_URL) {
      return;
    }

    try {
      sqlClient = postgres(TEST_DATABASE_URL, { max: 3, prepare: false });
      db = drizzle(sqlClient, { schema });

      await db.execute(sql`SELECT 1`);
      canConnect = true;

      testSiteId = nanoid();
      await db.insert(sites).values({ id: testSiteId, name: 'test-site-pbt-provenance' });

      const [collection] = await db
        .insert(collections)
        .values({ siteId: testSiteId, name: `pbt_provenance_${nanoid(8)}` })
        .returning();
      testCollectionId = collection!.id;

      const [item] = await db
        .insert(items)
        .values({ siteId: testSiteId, collectionId: testCollectionId, data: { title: 'pbt' } })
        .returning();
      testItemId = item!.id;
    } catch {
      canConnect = false;
    }
  });

  afterAll(async () => {
    if (!canConnect) return;
    await db.delete(sites).where(eq(sites.id, testSiteId));
    await sqlClient.end();
  });

  beforeEach(async () => {
    if (!canConnect) return;
    await db.delete(revisions).where(eq(revisions.siteId, testSiteId));
  });

  const authorTypeArb = fc.constantFrom('human', 'agent');
  /**
   * A single lowercase hex digit — fast-check 4 dropped `fc.hexaString`, so hex
   * strings are now built from an explicit unit arbitrary.
   */
  const hexDigit = fc.constantFrom(...'0123456789abcdef'.split(''));

  const modelArb = fc.oneof(
    fc.constant(null),
    fc.stringMatching(/^[a-z][a-z0-9.-]{0,40}$/),
  );
  const hashArb = fc.oneof(
    fc.constant(null),
    fc.string({ unit: hexDigit, minLength: 8, maxLength: 64 }).map((h) => `sha256:${h}`),
  );
  const sourcesArb = fc.oneof(
    fc.constant(null),
    fc.array(fc.string({ minLength: 1, maxLength: 50 }), { maxLength: 5 }),
  );
  const confidenceArb = fc.oneof(
    fc.constant(null),
    // float32 round-trips exactly through the pg `real` column
    fc.float({ min: 0, max: 1, noNaN: true }).map((n) => Math.fround(n)),
  );

  it('preserves provenance fields after insert and query (round-trip)', async () => {
    if (!canConnect) {
      console.warn('Skipping: DATABASE_URL not set or database not reachable');
      return;
    }

    await fc.assert(
      fc.asyncProperty(
        authorTypeArb,
        modelArb,
        hashArb,
        sourcesArb,
        confidenceArb,
        async (authorType, model, constitutionHash, sources, confidence) => {
          const [inserted] = await db
            .insert(revisions)
            .values({
              siteId: testSiteId,
              collectionId: testCollectionId,
              itemId: testItemId,
              delta: { before: null, after: { title: 'pbt' } },
              authorType,
              model,
              constitutionHash,
              sources,
              confidence,
            })
            .returning();

          expect(inserted).toBeDefined();

          const [queried] = await db
            .select()
            .from(revisions)
            .where(eq(revisions.id, inserted!.id));

          expect(queried).toBeDefined();
          expect(queried!.authorType).toBe(authorType);
          expect(queried!.model).toBe(model);
          expect(queried!.constitutionHash).toBe(constitutionHash);
          expect(queried!.sources).toEqual(sources);
          expect(queried!.confidence).toBe(confidence);
          // Agent revisions without a run keep a null run reference
          expect(queried!.createdByRunId).toBeNull();
          // Staging defaults: revisions are live unless explicitly staged
          expect(queried!.staged).toBe(false);
          expect(queried!.autoCommitAt).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('defaults authorType to human and pinnedFields to [] when omitted', async () => {
    if (!canConnect) {
      console.warn('Skipping: DATABASE_URL not set or database not reachable');
      return;
    }

    const [revision] = await db
      .insert(revisions)
      .values({
        siteId: testSiteId,
        collectionId: testCollectionId,
        itemId: testItemId,
        delta: {},
      })
      .returning();
    expect(revision!.authorType).toBe('human');

    const [item] = await db
      .select()
      .from(items)
      .where(eq(items.id, testItemId));
    expect(item!.pinnedFields).toEqual([]);
  });
});
