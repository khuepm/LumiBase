import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { reviewFeedback, reviewRuns, reviewSessions, settings, sites, type Database } from '@lumibase/database';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';
import { DECISION_SETTINGS_KEY, readDecisionSettings, reviewRolloutMode } from '../decision-governance';
import { computeReviewMetrics, DrizzleReviewMetricsSource } from '../review-metrics';
import { purgeExpiredReviewRuns } from '../review-run-retention';
import { DrizzleReviewStore, type ReviewProfileInsert, type ReviewRunInsert } from '../review-store';

/**
 * Migration 0020 against Postgres (#516): the sessions table exists, every
 * pilot query is site scoped, turning the pilot off (and the kill switch)
 * deletes no run, feedback or session, and the run retention purge keeps the
 * timing rows. Skips when DATABASE_URL is unset/unreachable.
 */

const SITE_A = 'site_review_sess_a';
const SITE_B = 'site_review_sess_b';

describe.skipIf(!hasDbIntegrationUrl)('Review pilot sessions — DB integration', () => {
  let db: Database;
  let store: DrizzleReviewStore;
  let n = 0;
  const uid = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${(n += 1)}`;

  const profile = (siteId: string): ReviewProfileInsert => ({
    id: uid('rp'),
    siteId,
    collection: 'posts',
    key: 'spam-check',
    version: 1,
    preset: null,
    fields: ['title'],
    questions: { spam: { type: 'noul', instructions: 'Spam?', criteria: { true: 'yes', false: 'no' } } },
    sourceField: null,
    minConfidence: null,
    note: null,
    createdBy: 'usr_admin',
  });

  const run = (siteId: string, profileId: string): ReviewRunInsert => ({
    id: uid('rr'),
    siteId,
    profileId,
    profileKey: 'spam-check',
    profileVersion: 1,
    collection: 'posts',
    itemId: 'itm_1',
    revisionId: null,
    contentHash: 'sha256:' + '0'.repeat(64),
    source: 'item',
    omittedFields: [],
    principalType: 'user',
    principalId: 'usr_editor',
    status: 'running',
    idempotencyKey: uid('idem'),
  });

  /** One completed run with a reject verdict and an assisted session that viewed it. */
  async function seedAssisted(siteId: string) {
    const p = ((await store.insertFirstProfile(profile(siteId))) ?? (await store.getProfile(siteId, 'spam-check')))!;
    const { run: r } = await store.claimRun(run(siteId, p.id));
    await store.completeRun(siteId, r.id, {
      status: 'success',
      provider: 'typesafe',
      model: 'jev',
      calibrated: true,
      answers: { spam: { type: 'noul', noul: 0.9 } },
      usage: { inputTokens: 40, outputTokens: 3 },
      latencyMs: 800,
      errorCode: null,
    });
    await store.insertFeedback(siteId, r.id, 'usr_editor', [
      {
        id: uid('fb'),
        siteId,
        runId: r.id,
        questionKey: 'spam',
        verdict: 'reject',
        editedValue: null,
        principalType: 'user',
        principalId: 'usr_editor',
      },
    ]);
    const s = await store.insertSession({
      id: uid('rs'),
      siteId,
      collection: 'posts',
      itemId: 'itm_1',
      mode: 'assisted',
      runId: r.id,
      viewedQuestions: ['spam'],
      principalType: 'user',
      principalId: 'usr_editor',
      durationMs: 45_000,
      locale: 'vi',
    });
    return { runId: r.id, sessionId: s.id };
  }

  const counts = async (siteId: string) => ({
    runs: (await db.select().from(reviewRuns).where(eq(reviewRuns.siteId, siteId))).length,
    feedback: (await db.select().from(reviewFeedback).where(eq(reviewFeedback.siteId, siteId))).length,
    sessions: (await db.select().from(reviewSessions).where(eq(reviewSessions.siteId, siteId))).length,
  });

  const writeSetting = (siteId: string, value: Record<string, unknown>) =>
    db
      .insert(settings)
      .values({ siteId, key: DECISION_SETTINGS_KEY, value })
      .onConflictDoUpdate({ target: [settings.siteId, settings.key], set: { value, updatedAt: new Date() } });

  const window = () => ({ from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + 60_000) });

  beforeAll(async () => {
    db = await connectDbIntegration('review-sessions');
    store = new DrizzleReviewStore(db);
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(inArray(sites.id, [SITE_A, SITE_B])).catch(() => undefined);
  });

  beforeEach(async () => {
    await db.delete(sites).where(inArray(sites.id, [SITE_A, SITE_B]));
    await db.insert(sites).values([
      { id: SITE_A, name: 'Review sessions IT A' },
      { id: SITE_B, name: 'Review sessions IT B' },
    ]);
  });

  it('migration 0020 created the sessions table', async () => {
    const rows = await db.execute<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.tables WHERE table_name = 'lumibase_review_sessions'`);
    const names = (Array.isArray(rows) ? rows : (rows as { rows: Array<{ table_name: string }> }).rows).map(
      (row) => row.table_name,
    );
    expect(names).toEqual(['lumibase_review_sessions']);
  });

  it('loads metrics for one site only', async () => {
    await seedAssisted(SITE_A);
    await seedAssisted(SITE_B);
    await seedAssisted(SITE_B);

    const source = new DrizzleReviewMetricsSource(db);
    const loaded = await source.load(SITE_A, window());
    expect(loaded.sessions).toHaveLength(1);
    expect(loaded.runs).toHaveLength(1);
    expect(loaded.feedback).toHaveLength(1);

    const m = computeReviewMetrics({ ...loaded, window: window() });
    expect(m.sampleCounts).toMatchObject({ assistedSessions: 1, viewedSuggestions: 1 });
    expect(m.suggestions.reject).toMatchObject({ k: 1, n: 1 });
    expect(m.splits.byLocale.vi?.sampleCount).toBe(1);
  });

  it('turning the pilot off, or the kill switch, deletes no run, feedback or session', async () => {
    await seedAssisted(SITE_A);
    await writeSetting(SITE_A, { enabled: true, review: { enabled: true, pilotCollections: ['posts'], mode: 'assisted' } });
    expect(reviewRolloutMode(await readDecisionSettings(db, SITE_A), 'posts')).toBe('assisted');
    const before = await counts(SITE_A);
    expect(before).toEqual({ runs: 1, feedback: 1, sessions: 1 });

    await writeSetting(SITE_A, { enabled: true, review: { enabled: false, pilotCollections: ['posts'], mode: 'assisted' } });
    expect(reviewRolloutMode(await readDecisionSettings(db, SITE_A), 'posts')).toBe('off');
    expect(await counts(SITE_A)).toEqual(before);

    // Kill switch: decisions off as well.
    await writeSetting(SITE_A, { enabled: false, review: { enabled: false, pilotCollections: ['posts'], mode: 'assisted' } });
    expect(reviewRolloutMode(await readDecisionSettings(db, SITE_A), 'posts')).toBe('off');
    expect(await counts(SITE_A)).toEqual(before);

    // History stays readable while off.
    const loaded = await new DrizzleReviewMetricsSource(db).load(SITE_A, window());
    expect(loaded.feedback).toHaveLength(1);
  });

  it('the run retention purge keeps sessions and clears their run reference', async () => {
    const { runId, sessionId } = await seedAssisted(SITE_A);
    await db.update(reviewRuns).set({ createdAt: new Date(Date.now() - 200 * 86_400_000) }).where(eq(reviewRuns.id, runId));

    await purgeExpiredReviewRuns(db, new Date(), 180);

    const [row] = await db.select().from(reviewSessions).where(eq(reviewSessions.id, sessionId));
    expect(row).toMatchObject({ id: sessionId, runId: null, durationMs: 45_000 });
  });
});
