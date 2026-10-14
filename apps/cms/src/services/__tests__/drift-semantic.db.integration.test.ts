import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  agentGoals,
  collections,
  contentDrifts,
  contentIntents,
  fields,
  items,
  settings,
  sites,
  type Database,
} from '@lumibase/database';
import { ReviewProfileCreateInputSchema } from '@lumibase/contracts/schemas';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';
import { DECISION_SETTINGS_KEY, readDecisionSettings, type GovernedDecisionOutcome } from '../decision-governance';
import { DriftService } from '../drift-service';
import { CONTENT_OS_SETTINGS_KEY } from '../feature-flags';
import { GoalDispatchService } from '../goal-dispatch-service';
import { ReconcilerService } from '../reconciler-service';
import { reviewContentAccessForDriftScan } from '../review-content-access';
import { ReviewService } from '../review-service';
import { reviewStoreFor } from '../review-store';
import type { SemanticDriftRuntime } from '../semantic-drift-scan';

/**
 * Semantic drift against Postgres (Jev J12, #519): migration 0022, the REAL
 * DriftService (deterministic + semantic passes), the REAL system content
 * read (`itemServiceForSystem` + pinned/field narrowing), the REAL review
 * store, the reconciler and the goal dispatcher. Only the governed decision
 * is stubbed. Skips when DATABASE_URL is unset or unreachable.
 */

const SITE = 'site_semdrift_it_a';
const OTHER = 'site_semdrift_it_b';

describe.skipIf(!hasDbIntegrationUrl)('Semantic drift — DB integration', () => {
  let db: Database;
  let answer: () => GovernedDecisionOutcome;
  const decide = vi.fn(async () => answer());

  function ok(noul: number): GovernedDecisionOutcome {
    const data = { provider: 'typesafe', model: 'jev-1.13', calibrated: true, answers: { off_brief: { type: 'noul' as const, noul } }, usage: { inputTokens: 1, outputTokens: 1 } };
    return { result: { ok: true, data, accounting: { attempts: 1, inputBytes: 1, estimatedInputTokens: 1, reservedTokens: 1, chargedTokens: 1 } }, status: 200, body: { data } };
  }
  function outage(): GovernedDecisionOutcome {
    return {
      result: { ok: false, error: new Error('down'), accounting: { attempts: 1, inputBytes: 1, estimatedInputTokens: 1, reservedTokens: 1, chargedTokens: 1 } },
      status: 503,
      body: { errors: [{ code: 'DECISION_UNAVAILABLE', message: 'down' }] },
    };
  }

  function runtime(siteId: string): SemanticDriftRuntime {
    return {
      readSettings: () => readDecisionSettings(db, siteId),
      review(include) {
        const content = reviewContentAccessForDriftScan({ db, siteId, include });
        return { service: new ReviewService({ store: reviewStoreFor(db), siteId, content, decide }), content };
      },
    };
  }

  beforeAll(async () => {
    db = await connectDbIntegration('drift-semantic');
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(inArray(sites.id, [SITE, OTHER])).catch(() => undefined);
  });

  async function seedSite(siteId: string) {
    await db.insert(sites).values({ id: siteId, name: siteId });
    const [collection] = await db.insert(collections).values({ siteId, name: 'articles', label: 'Articles' }).returning();
    await db.insert(fields).values(
      ['brief', 'title', 'body', 'summary'].map((name) => ({ siteId, collectionId: collection!.id, name, type: 'string', interface: 'input' })),
    );
    await db.insert(settings).values([
      { siteId, key: CONTENT_OS_SETTINGS_KEY, value: { reconciler: true }, scope: 'site' },
      { siteId, key: DECISION_SETTINGS_KEY, value: { enabled: true, drift: true }, scope: 'site' },
    ]);
    await new ReviewService({ store: reviewStoreFor(db), siteId, content: reviewContentAccessForDriftScan({ db, siteId, include: [] }), decide }).createProfile(
      ReviewProfileCreateInputSchema.parse({
        key: 'brief',
        collection: 'articles',
        fields: ['brief', 'title', 'body'],
        questions: { off_brief: { type: 'noul', instructions: 'Does the text stray from the brief?', criteria: { true: 'off brief', false: 'on brief' } } },
      }),
      { type: 'user', id: 'usr_semdrift_admin', admin: true },
    );
    const [intent] = await db
      .insert(contentIntents)
      .values({
        siteId,
        name: 'briefs',
        collection: 'articles',
        rules: [
          { type: 'required_fields', fields: ['summary'] },
          { type: 'semantic', key: 'off-brief', version: 1, profileKey: 'brief', profileVersion: 1, questionKey: 'off_brief', threshold: 0.8, fields: ['title', 'body'], contextSource: 'field:brief' },
        ],
        schedule: '0 6 * * *',
        budget: { maxGoalsPerCycle: 10 },
        autonomyCap: 1,
      })
      .returning();
    const [item] = await db
      .insert(items)
      .values({
        siteId,
        collectionId: collection!.id,
        data: { brief: 'Home composting guide', title: 'Ten crypto tips', body: 'Buy now.', summary: '' },
        pinnedFields: [],
      })
      .returning();
    return { intentId: intent!.id, itemId: item!.id };
  }

  let a: { intentId: string; itemId: string };
  let b: { intentId: string; itemId: string };

  beforeEach(async () => {
    await db.delete(sites).where(inArray(sites.id, [SITE, OTHER]));
    decide.mockClear();
    answer = () => ok(0.95);
    a = await seedSite(SITE);
    b = await seedSite(OTHER);
  });

  const drifts = (siteId: string) => db.select().from(contentDrifts).where(eq(contentDrifts.siteId, siteId));

  it('migration 0022 added the semantic cursor column', async () => {
    const result = await db.execute<{ column_name: string }>(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'lumibase_content_intents' AND column_name = 'semantic_scan_cursor'`);
    const rows = Array.isArray(result) ? result : (result as { rows: Array<{ column_name: string }> }).rows;
    expect(rows).toHaveLength(1);
  });

  it('both passes record their own drift; the review goal carries provenance; a retry adds nothing', async () => {
    const scan = await new DriftService({ db, siteId: SITE, semantic: runtime(SITE) }).scanIntent(a.intentId);
    expect(scan.opened).toBe(1); // required_fields:summary
    expect(scan.semantic).toMatchObject({ status: 'ran', drift: 1, opened: 1, completed: true, cursor: null });

    const rows = await drifts(SITE);
    expect(rows.map((r) => r.ruleType).sort()).toEqual(['required_fields', 'semantic']);
    const semantic = rows.find((r) => r.ruleType === 'semantic')!;
    expect(semantic.fingerprint).toMatch(new RegExp(`^${a.intentId}:${a.itemId}:semantic:off-brief@v1:1:sha256:[0-9a-f]{64}$`));

    const reconcile = await new ReconcilerService({ db, siteId: SITE }).reconcileIntent(a.intentId);
    expect(reconcile.goalsCreated).toBe(2);
    const goals = await db.select().from(agentGoals).where(eq(agentGoals.siteId, SITE));
    const review = goals.find((g) => g.driftFingerprint === semantic.fingerprint)!;
    expect(review.title).toBe(`Review semantic drift "off-brief" on articles/${a.itemId}`);
    expect(review.metadata).toMatchObject({
      reviewOnly: true,
      semantic: { rule: 'off-brief', ruleVersion: 1, profileKey: 'brief', profileVersion: 1, provider: 'typesafe', model: 'jev-1.13' },
    });
    expect(typeof (review.metadata as { semantic: { runId: unknown } }).semantic.runId).toBe('string');

    // The dispatcher says what the goal is: a human review, not a missing skill.
    const dispatch = await new GoalDispatchService({ db, siteId: SITE }).advanceGoalById(review.id);
    expect(dispatch).toMatchObject({ action: 'block', reason: 'HUMAN_REVIEW_REQUIRED' });

    // Retry on the same content: replayed, no new drift, no new goal.
    const retry = await new DriftService({ db, siteId: SITE, semantic: runtime(SITE) }).scanIntent(a.intentId);
    expect(retry.semantic).toMatchObject({ drift: 1, opened: 0, reopened: 0, resolved: 0 });
    expect(decide).toHaveBeenCalledTimes(1);
    expect(await drifts(SITE)).toHaveLength(2);
    expect((await new ReconcilerService({ db, siteId: SITE }).reconcileIntent(a.intentId)).goalsCreated).toBe(0);

    // Tenant isolation: nothing appeared on the other site.
    expect(await drifts(OTHER)).toHaveLength(0);
    expect(await db.select().from(agentGoals).where(eq(agentGoals.siteId, OTHER))).toHaveLength(0);
  });

  it('a scan without the semantic runtime never resolves semantic drift', async () => {
    await new DriftService({ db, siteId: SITE, semantic: runtime(SITE) }).scanIntent(a.intentId);
    // Deterministic-only rescan (e.g. the dispatcher's verify scan).
    const plain = await new DriftService({ db, siteId: SITE }).scanIntent(a.intentId);
    expect(plain.semantic?.status).toBe('unavailable');
    expect(plain.resolved).toBe(0);
    const semantic = (await drifts(SITE)).find((r) => r.ruleType === 'semantic')!;
    expect(semantic.status).toBe('open');
  });

  it('an outage on changed content keeps the old drift open and records unevaluated', async () => {
    await new DriftService({ db, siteId: SITE, semantic: runtime(SITE) }).scanIntent(a.intentId);
    await db.update(items).set({ data: { brief: 'Home composting guide', title: 'Ten crypto tips (2)', body: 'Buy now!', summary: '' } }).where(eq(items.id, a.itemId));
    answer = () => outage();
    const scan = await new DriftService({ db, siteId: SITE, semantic: runtime(SITE) }).scanIntent(a.intentId);
    expect(scan.semantic).toMatchObject({ unevaluated: 1, resolved: 0 });
    const rows = (await drifts(SITE)).filter((r) => r.ruleType === 'semantic');
    expect(rows.map((r) => r.status).sort()).toEqual(['open', 'unevaluated']);
    expect(rows.find((r) => r.status === 'unevaluated')!.detail).toMatchObject({ reason: 'DECISION_UNAVAILABLE' });
    // Unevaluated never becomes a goal.
    await new ReconcilerService({ db, siteId: SITE }).reconcileIntent(a.intentId);
    const goals = await db.select().from(agentGoals).where(eq(agentGoals.siteId, SITE));
    const unevaluated = rows.find((r) => r.status === 'unevaluated')!;
    expect(goals.some((g) => g.driftFingerprint === unevaluated.fingerprint)).toBe(false);
  });

  it('pinned fields are not read; the budget cursor is persisted on the intent', async () => {
    await db.update(items).set({ pinnedFields: ['body'] }).where(eq(items.id, a.itemId));
    const [collection] = await db.select().from(collections).where(and(eq(collections.siteId, SITE), eq(collections.name, 'articles')));
    await db.insert(items).values({ siteId: SITE, collectionId: collection!.id, data: { brief: 'x', title: 'Second', body: 'y', summary: 'ok' } });

    const service = new DriftService({ db, siteId: SITE, semantic: runtime(SITE) });
    const first = await service.scanIntent(a.intentId, { maxSemanticItems: 1 });
    expect(first.semantic).toMatchObject({ items: 1, completed: false });
    const [intent] = await db.select().from(contentIntents).where(eq(contentIntents.id, a.intentId));
    expect(intent!.semanticScanCursor).toBe(first.semantic!.cursor);
    // The deterministic cursor is independent of it.
    expect(intent!.scanCursor).toBeNull();

    const second = await service.scanIntent(a.intentId, { maxSemanticItems: 1 });
    expect(second.semantic).toMatchObject({ items: 1, completed: false });
    expect(second.semantic!.cursor).not.toBe(first.semantic!.cursor);
    // A full budget cannot tell the collection ended; the next pass sees no items.
    const third = await service.scanIntent(a.intentId, { maxSemanticItems: 1 });
    expect(third.semantic).toMatchObject({ items: 0, completed: true, cursor: null });
    expect(decide).toHaveBeenCalledTimes(2);

    const states = decide.mock.calls.map((call) => (call as unknown as [{ state: Record<string, unknown> }])[0].state);
    const pinnedItem = states.find((state) => state['title'] === 'Ten crypto tips')!;
    expect(pinnedItem).toEqual({ brief: 'Home composting guide', title: 'Ten crypto tips' });
    expect(states.find((state) => state['title'] === 'Second')).toHaveProperty('body', 'y');
  });

  it('a disabled site sends nothing', async () => {
    await db.update(settings).set({ value: { enabled: true, drift: false } }).where(and(eq(settings.siteId, SITE), eq(settings.key, DECISION_SETTINGS_KEY)));
    const scan = await new DriftService({ db, siteId: SITE, semantic: runtime(SITE) }).scanIntent(a.intentId);
    expect(scan.semantic?.status).toBe('off');
    expect(decide).not.toHaveBeenCalled();
    expect((await drifts(SITE)).filter((r) => r.ruleType === 'semantic')).toHaveLength(0);
    expect(b.intentId).not.toBe(a.intentId);
  });
});
