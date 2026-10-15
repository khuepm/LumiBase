import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { reviewFeedback, reviewProfiles, reviewRuns, sites, type Database } from '@lumibase/database';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';
import { purgeExpiredReviewRuns } from '../review-run-retention';
import { DrizzleReviewStore, type ReviewProfileInsert, type ReviewRunInsert } from '../review-store';

/**
 * Migration 0019 against Postgres (#512): the tables exist, the unique
 * constraints back the service's idempotency, every store query is site
 * scoped, and the retention purge removes only expired runs (feedback
 * cascades). Skips when DATABASE_URL is unset/unreachable.
 */

const SITE_A = 'site_review_it_a';
const SITE_B = 'site_review_it_b';

describe.skipIf(!hasDbIntegrationUrl)('Review profiles and runs — DB integration', () => {
  let db: Database;
  let store: DrizzleReviewStore;
  let n = 0;
  const uid = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${(n += 1)}`;

  const profile = (siteId: string, overrides: Partial<ReviewProfileInsert> = {}): ReviewProfileInsert => ({
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
    ...overrides,
  });

  const run = (siteId: string, profileId: string, overrides: Partial<ReviewRunInsert> = {}): ReviewRunInsert => ({
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
    ...overrides,
  });

  beforeAll(async () => {
    db = await connectDbIntegration('review-runs');
    store = new DrizzleReviewStore(db);
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(inArray(sites.id, [SITE_A, SITE_B])).catch(() => undefined);
  });

  beforeEach(async () => {
    await db.delete(sites).where(inArray(sites.id, [SITE_A, SITE_B]));
    await db.insert(sites).values([
      { id: SITE_A, name: 'Review IT A' },
      { id: SITE_B, name: 'Review IT B' },
    ]);
  });

  it('migration 0019 created the three tables', async () => {
    const rows = await db.execute<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_name IN ('lumibase_review_profiles', 'lumibase_review_runs', 'lumibase_review_feedback')
      ORDER BY table_name`);
    const names = (Array.isArray(rows) ? rows : (rows as { rows: Array<{ table_name: string }> }).rows).map(
      (row) => row.table_name,
    );
    expect(names).toEqual(['lumibase_review_feedback', 'lumibase_review_profiles', 'lumibase_review_runs']);
  });

  it('versions a profile atomically and refuses a duplicate key/version', async () => {
    const v1 = await store.insertFirstProfile(profile(SITE_A));
    expect(v1?.version).toBe(1);
    expect(await store.insertFirstProfile(profile(SITE_A))).toBeNull();
    await expect(db.insert(reviewProfiles).values(profile(SITE_A))).rejects.toThrow();

    const v2 = await store.insertNextProfileVersion(SITE_A, 'spam-check', (version) => profile(SITE_A, { version }));
    expect(v2).toMatchObject({ version: 2, status: 'active' });
    expect((await store.getProfile(SITE_A, 'spam-check', 1))?.status).toBe('archived');
    expect((await store.getProfile(SITE_A, 'spam-check'))?.version).toBe(2);
    expect(await store.insertNextProfileVersion(SITE_A, 'missing', (version) => profile(SITE_A, { version }))).toBe(
      'not_found',
    );
  });

  it('claims one run per idempotency key and reclaims an errored one', async () => {
    const p = (await store.insertFirstProfile(profile(SITE_A)))!;
    const key = uid('key');

    const first = await store.claimRun(run(SITE_A, p.id, { idempotencyKey: key }));
    const again = await store.claimRun(run(SITE_A, p.id, { idempotencyKey: key }));
    expect(first.created).toBe(true);
    expect(again).toMatchObject({ created: false, run: { id: first.run.id } });

    await store.completeRun(SITE_A, first.run.id, {
      status: 'error',
      provider: null,
      model: null,
      calibrated: null,
      answers: null,
      usage: null,
      latencyMs: 5,
      errorCode: 'DECISION_UNAVAILABLE',
    }, first.run.createdAt);
    const newHash = 'sha256:' + '1'.repeat(64);
    const reclaimed = await store.claimRun(
      run(SITE_A, p.id, { idempotencyKey: key, contentHash: newHash, revisionId: 'rev_2', omittedFields: ['body'] }),
    );
    expect(reclaimed).toMatchObject({
      created: true,
      run: {
        id: first.run.id,
        status: 'running',
        contentHash: newHash,
        revisionId: 'rev_2',
        omittedFields: ['body'],
        errorCode: null,
        latencyMs: null,
        completedAt: null,
      },
    });

    const rows = await db.select().from(reviewRuns).where(eq(reviewRuns.idempotencyKey, key));
    expect(rows).toHaveLength(1);
  });

  it('scopes the idempotency key to the principal', async () => {
    const p = (await store.insertFirstProfile(profile(SITE_A)))!;
    const key = uid('key');
    const mine = await store.claimRun(run(SITE_A, p.id, { idempotencyKey: key }));
    await store.completeRun(SITE_A, mine.run.id, {
      status: 'error',
      provider: null,
      model: null,
      calibrated: null,
      answers: null,
      usage: null,
      latencyMs: 5,
      errorCode: 'DECISION_UNAVAILABLE',
    }, mine.run.createdAt);

    const theirs = await store.claimRun(run(SITE_A, p.id, { idempotencyKey: key, principalId: 'usr_other' }));
    expect(theirs.created).toBe(true);
    expect(theirs.run.id).not.toBe(mine.run.id);
    expect(await store.getRun(SITE_A, mine.run.id)).toMatchObject({ status: 'error', principalId: 'usr_editor' });
  });

  it('reclaims a running run only after the orphan timeout', async () => {
    const p = (await store.insertFirstProfile(profile(SITE_A)))!;
    const key = uid('key');
    const first = await store.claimRun(run(SITE_A, p.id, { idempotencyKey: key }));
    expect(await store.claimRun(run(SITE_A, p.id, { idempotencyKey: key }))).toMatchObject({ created: false });

    await db
      .update(reviewRuns)
      .set({ createdAt: sql`now() - interval '1 hour'` })
      .where(eq(reviewRuns.id, first.run.id));
    expect(await store.claimRun(run(SITE_A, p.id, { idempotencyKey: key }))).toMatchObject({
      created: true,
      run: { id: first.run.id, status: 'running' },
    });
  });

  it('a completion from a claim that was reclaimed writes nothing (late process after the orphan timeout)', async () => {
    const p = (await store.insertFirstProfile(profile(SITE_A)))!;
    const key = uid('key');
    const first = await store.claimRun(run(SITE_A, p.id, { idempotencyKey: key }));
    await db
      .update(reviewRuns)
      .set({ createdAt: sql`now() - interval '1 hour'` })
      .where(eq(reviewRuns.id, first.run.id));
    const [orphaned] = await db.select().from(reviewRuns).where(eq(reviewRuns.id, first.run.id));
    const newHash = 'sha256:' + '2'.repeat(64);
    const retry = await store.claimRun(run(SITE_A, p.id, { idempotencyKey: key, contentHash: newHash }));
    expect(retry).toMatchObject({ created: true, run: { id: first.run.id, status: 'running', contentHash: newHash } });

    const answer = (noul: number) => ({
      status: 'success', provider: 'typesafe', model: 'jev', calibrated: true,
      answers: { spam: { type: 'noul', noul } }, usage: null, latencyMs: 1, errorCode: null,
    });
    // The orphaned attempt finishes while the retry is still running: refused.
    expect(await store.completeRun(SITE_A, first.run.id, answer(0.1), orphaned!.createdAt)).toBeNull();
    // The retry completes under its own claim.
    expect(await store.completeRun(SITE_A, first.run.id, answer(0.9), retry.run.createdAt)).toMatchObject({ status: 'success' });
    // A second completion of the same claim is refused too: the run is no longer running.
    expect(await store.completeRun(SITE_A, first.run.id, answer(0.5), retry.run.createdAt)).toBeNull();
    expect(await store.getRun(SITE_A, first.run.id)).toMatchObject({
      status: 'success',
      contentHash: newHash,
      answers: { spam: { type: 'noul', noul: 0.9 } },
    });
  });

  it('stores one feedback row per run, question and principal', async () => {
    const p = (await store.insertFirstProfile(profile(SITE_A)))!;
    const { run: r } = await store.claimRun(run(SITE_A, p.id));
    const entry = () => ({
      id: uid('fb'),
      siteId: SITE_A,
      runId: r.id,
      questionKey: 'spam',
      verdict: 'accept',
      editedValue: null,
      principalType: 'user',
      principalId: 'usr_editor',
    });

    const first = await store.insertFeedback(SITE_A, r.id, 'usr_editor', [entry()]);
    const second = await store.insertFeedback(SITE_A, r.id, 'usr_editor', [entry()]);

    expect(second.map((row) => row.id)).toEqual(first.map((row) => row.id));
    expect(await db.select().from(reviewFeedback).where(eq(reviewFeedback.runId, r.id))).toHaveLength(1);
  });

  it('scopes profiles and runs to their site', async () => {
    const p = (await store.insertFirstProfile(profile(SITE_A)))!;
    const { run: r } = await store.claimRun(run(SITE_A, p.id));

    expect(await store.listActiveProfiles(SITE_B)).toEqual([]);
    expect(await store.getProfile(SITE_B, 'spam-check')).toBeNull();
    expect(await store.getProfileById(SITE_B, p.id)).toBeNull();
    expect(await store.getRun(SITE_B, r.id)).toBeNull();
    expect(await store.listRuns(SITE_B, { collection: 'posts', itemId: 'itm_1', limit: 10 })).toEqual([]);
    expect(await store.completeRun(SITE_B, r.id, {
      status: 'success', provider: 'x', model: 'x', calibrated: true, answers: {}, usage: null, latencyMs: 1, errorCode: null,
    }, r.createdAt)).toBeNull();
    // The same key on another site is its own version 1.
    expect((await store.insertFirstProfile(profile(SITE_B)))?.version).toBe(1);
  });

  it('retention deletes only expired runs, and their feedback with them', async () => {
    const p = (await store.insertFirstProfile(profile(SITE_A)))!;
    const { run: old } = await store.claimRun(run(SITE_A, p.id));
    const { run: fresh } = await store.claimRun(run(SITE_A, p.id));
    await db.update(reviewRuns).set({ createdAt: new Date(Date.now() - 200 * 86_400_000) }).where(eq(reviewRuns.id, old.id));
    await store.insertFeedback(SITE_A, old.id, 'usr_editor', [
      {
        id: uid('fb'),
        siteId: SITE_A,
        runId: old.id,
        questionKey: 'spam',
        verdict: 'reject',
        editedValue: null,
        principalType: 'user',
        principalId: 'usr_editor',
      },
    ]);

    const deleted = await purgeExpiredReviewRuns(db, new Date(), 180);

    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(await store.getRun(SITE_A, old.id)).toBeNull();
    expect(await store.getRun(SITE_A, fresh.id)).not.toBeNull();
    expect(await db.select().from(reviewFeedback).where(eq(reviewFeedback.runId, old.id))).toHaveLength(0);
    expect(await store.getProfileById(SITE_A, p.id)).not.toBeNull();
  });
});
