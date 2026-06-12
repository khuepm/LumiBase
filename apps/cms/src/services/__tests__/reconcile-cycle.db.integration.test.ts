import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  agentGoals,
  collections,
  contentDrifts,
  contentIntents,
  createDb,
  items,
  settings,
  sites,
  type Database,
} from '@lumibase/database';
import { DriftService } from '../drift-service';
import { ReconcilerService } from '../reconciler-service';
import { CONTENT_OS_SETTINGS_KEY } from '../feature-flags';

/**
 * DB-backed integration test for the Content OS reconciliation cycle
 * (content-os task 20.3; Req 6.x, 7.x). Unlike the in-memory orchestration
 * test, this drives the REAL DriftService + ReconcilerService against a
 * live Postgres so the actual SQL (drift fingerprint dedupe, goal lineage
 * columns, drift→goal status transitions) is exercised end to end.
 *
 * Uses the repo's shared `DATABASE_URL` pattern: skips with a warning when
 * the variable is unset or the database is unreachable, so local-only
 * `pnpm test` and CI without a database stay green.
 *
 * **Validates: Requirements 6.x, 7.x (reconciliation cycle, drift dedupe,
 * goal lineage, flag gating)**
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL;
const SITE = 'site_reconcile_it';
const OTHER_SITE = 'site_reconcile_other';
const COLLECTION = 'articles';

describe('Reconciliation cycle — DB integration', () => {
  let db: Database;
  let canConnect = false;
  let collectionId: string;

  beforeAll(async () => {
    if (!TEST_DATABASE_URL) {
      console.warn('Skipping reconcile-cycle DB integration: DATABASE_URL not set.');
      return;
    }
    try {
      db = createDb(TEST_DATABASE_URL);
      await db.execute(sql`SELECT 1`);
      canConnect = true;
    } catch {
      console.warn('Skipping reconcile-cycle DB integration: database not reachable.');
      canConnect = false;
    }
  });

  afterAll(async () => {
    if (!canConnect) return;
    await db
      .delete(sites)
      .where(sql`${sites.id} IN (${SITE}, ${OTHER_SITE})`)
      .catch(() => undefined);
  });

  beforeEach(async () => {
    if (!canConnect) return;
    // Fresh slate: cascade from sites clears intents, drifts, goals, items.
    await db.delete(sites).where(sql`${sites.id} IN (${SITE}, ${OTHER_SITE})`);
    await db.insert(sites).values([
      { id: SITE, name: 'Reconcile IT' },
      { id: OTHER_SITE, name: 'Other tenant' },
    ]);
    for (const siteId of [SITE, OTHER_SITE]) {
      const [coll] = await db
        .insert(collections)
        .values({ siteId, name: COLLECTION, label: 'Articles' })
        .returning({ id: collections.id });
      if (siteId === SITE) collectionId = coll!.id;
      // Enable the reconciler flag for this site.
      await db.insert(settings).values({
        siteId,
        key: CONTENT_OS_SETTINGS_KEY,
        value: { reconciler: true },
        scope: 'site',
      });
    }
  });

  async function seedIntent(siteId: string): Promise<string> {
    const [intent] = await db
      .insert(contentIntents)
      .values({
        siteId,
        name: 'articles-required-fields',
        collection: COLLECTION,
        rules: [{ type: 'required_fields', fields: ['title', 'summary'] }],
        schedule: '0 * * * *',
        budget: { maxGoalsPerCycle: 10 },
        autonomyCap: 2,
        status: 'active',
      })
      .returning({ id: contentIntents.id });
    return intent!.id;
  }

  async function seedItem(siteId: string, collId: string, data: Record<string, unknown>): Promise<string> {
    const [row] = await db
      .insert(items)
      .values({ siteId, collectionId: collId, status: 'published', data })
      .returning({ id: items.id });
    return row!.id;
  }

  it.runIf(TEST_DATABASE_URL)(
    'seed intent → drift → goal → fix → resolved, with no duplicate drift across scans',
    async () => {
      if (!canConnect) return;
      const intentId = await seedIntent(SITE);
      // One item violates `summary` required; one is clean.
      const brokenId = await seedItem(SITE, collectionId, { title: 'Hello', summary: '' });
      await seedItem(SITE, collectionId, { title: 'Good', summary: 'Complete summary.' });

      const drift = new DriftService({ db, siteId: SITE });
      const reconciler = new ReconcilerService({ db, siteId: SITE });

      // --- Scan 1: detect the violation as an OPEN drift.
      const scan1 = await drift.scanIntent(intentId);
      expect(scan1.scanned).toBe(2);
      expect(scan1.opened).toBeGreaterThan(0);

      const openDrifts = await db
        .select()
        .from(contentDrifts)
        .where(and(eq(contentDrifts.siteId, SITE), eq(contentDrifts.intentId, intentId)));
      expect(openDrifts).toHaveLength(1);
      expect(openDrifts[0]!.itemId).toBe(brokenId);
      expect(openDrifts[0]!.status).toBe('open');
      const fingerprint = openDrifts[0]!.fingerprint;

      // --- Reconcile: the open drift becomes a goal with first-class lineage.
      const recon = await reconciler.reconcileIntent(intentId);
      expect(recon.goalsCreated).toBe(1);
      expect(recon.flagOff).toBeUndefined();

      const goals = await db.select().from(agentGoals).where(eq(agentGoals.siteId, SITE));
      expect(goals).toHaveLength(1);
      expect(goals[0]!.origin).toBe('reconciler');
      expect(goals[0]!.intentId).toBe(intentId);
      expect(goals[0]!.driftFingerprint).toBe(fingerprint);
      expect(goals[0]!.agentRole).toBeTruthy();

      const assigned = await db
        .select()
        .from(contentDrifts)
        .where(eq(contentDrifts.id, openDrifts[0]!.id));
      expect(assigned[0]!.status).toBe('assigned');
      expect(assigned[0]!.goalId).toBe(goals[0]!.id);

      // --- Scan 2 while assigned: the same fingerprint must NOT re-open and
      // reconcile must NOT mint a second goal (Property 4 / fingerprint dedupe).
      const scan2 = await drift.scanIntent(intentId);
      expect(scan2.opened).toBe(0);
      expect(scan2.reopened).toBe(0);
      const recon2 = await reconciler.reconcileIntent(intentId);
      expect(recon2.goalsCreated).toBe(0);
      expect(await db.select().from(agentGoals).where(eq(agentGoals.siteId, SITE))).toHaveLength(1);

      // --- Agent fixes the item → scan 3 resolves the drift.
      await db
        .update(items)
        .set({ data: { title: 'Hello', summary: 'Now filled.' }, updatedAt: new Date() })
        .where(eq(items.id, brokenId));
      const scan3 = await drift.scanIntent(intentId);
      expect(scan3.resolved).toBeGreaterThan(0);

      const finalDrifts = await db
        .select()
        .from(contentDrifts)
        .where(eq(contentDrifts.id, openDrifts[0]!.id));
      expect(finalDrifts[0]!.status).toBe('resolved');
    },
  );

  it.runIf(TEST_DATABASE_URL)('the reconciler is a no-op when contentOs.reconciler is off', async () => {
    if (!canConnect) return;
    // Flip the flag off for SITE.
    await db
      .update(settings)
      .set({ value: { reconciler: false } })
      .where(and(eq(settings.siteId, SITE), eq(settings.key, CONTENT_OS_SETTINGS_KEY)));

    const intentId = await seedIntent(SITE);
    await seedItem(SITE, collectionId, { title: 'Hello', summary: '' });

    const drift = new DriftService({ db, siteId: SITE });
    const reconciler = new ReconcilerService({ db, siteId: SITE });

    // Drift detection still records state (scans are independent of the flag)…
    await drift.scanIntent(intentId);
    // …but reconcile generates nothing while the flag is off.
    const recon = await reconciler.reconcileIntent(intentId);
    expect(recon.flagOff).toBe(true);
    expect(recon.goalsCreated).toBe(0);
    expect(await db.select().from(agentGoals).where(eq(agentGoals.siteId, SITE))).toHaveLength(0);
  });

  it.runIf(TEST_DATABASE_URL)('drift scans never cross tenant boundaries', async () => {
    if (!canConnect) return;
    // SITE has a violating item; the reconciler for SITE must never touch
    // OTHER_SITE's intent or produce drifts/goals there.
    const intentId = await seedIntent(SITE);
    await seedItem(SITE, collectionId, { title: 'Hello', summary: '' });

    const [otherColl] = await db
      .select({ id: collections.id })
      .from(collections)
      .where(and(eq(collections.siteId, OTHER_SITE), eq(collections.name, COLLECTION)))
      .limit(1);
    const otherIntentId = await seedIntent(OTHER_SITE);
    await seedItem(OTHER_SITE, otherColl!.id, { title: 'X', summary: '' });

    await new DriftService({ db, siteId: SITE }).scanIntent(intentId);
    await new ReconcilerService({ db, siteId: SITE }).reconcileIntent(intentId);

    // OTHER_SITE was never scanned/reconciled by SITE's services.
    const otherDrifts = await db
      .select()
      .from(contentDrifts)
      .where(eq(contentDrifts.siteId, OTHER_SITE));
    expect(otherDrifts).toHaveLength(0);
    const otherGoals = await db.select().from(agentGoals).where(eq(agentGoals.siteId, OTHER_SITE));
    expect(otherGoals).toHaveLength(0);
    // Sanity: SITE's own cycle did run.
    expect(await db.select().from(agentGoals).where(eq(agentGoals.siteId, SITE))).toHaveLength(1);
    void otherIntentId;
  });
});
