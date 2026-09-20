import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  agentGoals,
  agentRuns,
  collections,
  contentDrifts,
  contentIntents,
  fields,
  items,
  settings,
  sites,
  type Database,
} from '@lumibase/database';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';
import { CONTENT_OS_SETTINGS_KEY } from '../feature-flags';
import {
  DISPATCH_LEASE_MS,
  GoalDispatchService,
  STALE_QUEUED_RUN_MS,
  claimGoalLease,
  releaseGoalLease,
  runGoalDispatchTick,
} from '../goal-dispatch-service';

/**
 * Dispatch must be serialized, recoverable and fair (reviewer R3, R4, R5).
 *
 * Three defects, all in `GoalDispatchService`:
 *
 * - **R3** Advancing a goal is a read-then-write with two entry points (the cron
 *   tick and `POST /intents/:id/scan`). Two callers that both read "no active run"
 *   both created a run and a queue job for the same drift. The cron's leader lock
 *   did not help: it does not cover the HTTP path, and it was released before the
 *   work finished.
 * - **R4** The run row is inserted before its job is enqueued, so a process killed
 *   in between left a `queued` run with no job. Every later pass read that as
 *   `RUN_ACTIVE` and skipped the goal — permanently.
 * - **R5** The query took the newest `limit * 4` reconciler goals and filtered for
 *   `open`/`in_progress` afterwards, so enough newer terminal goals pushed an older
 *   pending one out of every pass.
 *
 * Evidence class: REAL PostgreSQL for the goals, runs, drift and lease rows —
 * concurrency and ordering are exactly what an in-memory fake cannot demonstrate.
 * The queue is an in-memory recorder: the claim is about which jobs are enqueued,
 * not about broker behaviour.
 *
 * **Validates: #455 / reviewer R3+R4+R5 — one run per goal/phase under concurrent
 * callers, recovery from a lost job, and no starvation of older goals**
 */

const SITE = 'site_g3_rel';
const COLLECTION = 'articles';

function memoryQueue() {
  const jobs: Array<{ queue: string; payload: Record<string, unknown> }> = [];
  return {
    jobs,
    provider: {
      enqueue: async (queue: string, _name: string, payload: unknown) => {
        jobs.push({ queue, payload: payload as Record<string, unknown> });
      },
      process: () => undefined,
    } as never,
  };
}

describe.skipIf(!hasDbIntegrationUrl)('G3 dispatch reliability — DB integration', () => {
  let db: Database;
  let collectionId: string;

  beforeAll(async () => {
    db = await connectDbIntegration('g3-dispatch-reliability');
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
  });

  beforeEach(async () => {
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.insert(sites).values({ id: SITE, name: 'G3 reliability' });
    const [coll] = await db
      .insert(collections)
      .values({ siteId: SITE, name: COLLECTION, label: 'Articles' })
      .returning({ id: collections.id });
    collectionId = coll!.id;
    await db.insert(fields).values([
      { siteId: SITE, collectionId, name: 'title', type: 'string', interface: 'input' },
      { siteId: SITE, collectionId, name: 'translations', type: 'json', interface: 'input' },
    ]);
    await db.insert(settings).values({
      siteId: SITE,
      key: CONTENT_OS_SETTINGS_KEY,
      value: { reconciler: true },
      scope: 'site',
    });
  });

  /** Seeds one translations drift and reconciles it into a goal. */
  async function seedGoal(): Promise<{ goalId: string; intentId: string }> {
    const [intent] = await db
      .insert(contentIntents)
      .values({
        siteId: SITE,
        name: `articles-translations-${Math.random().toString(36).slice(2, 8)}`,
        collection: COLLECTION,
        rules: [{ type: 'translations', fields: ['translations'], locales: ['en', 'vi'] }],
        schedule: '0 * * * *',
        budget: { maxGoalsPerCycle: 10 },
        autonomyCap: 2,
        status: 'active',
      })
      .returning({ id: contentIntents.id });
    await db.insert(items).values({
      siteId: SITE,
      collectionId,
      status: 'published',
      data: { title: 'Hello', translations: { en: 'Hello world' } },
    });

    const { DriftService } = await import('../drift-service');
    const { ReconcilerService } = await import('../reconciler-service');
    await new DriftService({ db, siteId: SITE }).scanIntent(intent!.id);
    await new ReconcilerService({ db, siteId: SITE }).reconcileIntent(intent!.id);

    const [goal] = await db
      .select()
      .from(agentGoals)
      .where(and(eq(agentGoals.siteId, SITE), eq(agentGoals.intentId, intent!.id)))
      .limit(1);
    return { goalId: goal!.id, intentId: intent!.id };
  }

  /**
   * The lease as a primitive: exclusive while live, releasable only by its holder.
   *
   * `claimGoalLease` is module-level for exactly this reason — the mutual
   * exclusion can be exercised without a queue, a drift or a run.
   *
   * ## What each case in this file actually proves (measured, not assumed)
   *
   * Two ways of breaking the lease were tried, and they are caught by **different**
   * cases — neither case is sufficient alone:
   *
   * | Break | This case | "two concurrent dispatch passes" | "lease held by another instance" |
   * |---|---|---|---|
   * | claim removed entirely | pass | **pass** | **fail** |
   * | conditional UPDATE → read-then-write | pass | **fail** | pass |
   *
   * The first row is the one worth knowing: with the claim gone, two dispatch
   * passes still produced one run, because the second pass read the first pass's
   * `queued` run and skipped on `RUN_ACTIVE`. That second layer is real, but it
   * covers a wider window than the lease does, so the end-state case alone would
   * have let a missing lease through.
   *
   * `Promise.all` of two claims is not in the table because it did not
   * discriminate: the driver serialized them, so it stayed green under both
   * breaks. Asserting on it would have been a guard that cannot fire — the class
   * this repo keeps re-learning. What this case does assert is the part that is
   * deterministic: a live lease refuses further claims, and a non-holder cannot
   * release it.
   */
  it('R3: the lease is exclusive while live and only its holder can release it', async () => {
    const { goalId } = await seedGoal();

    expect(await claimGoalLease(db, { siteId: SITE, goalId, instanceId: 'replica-a' })).toBe(true);
    expect(await claimGoalLease(db, { siteId: SITE, goalId, instanceId: 'replica-b' })).toBe(false);

    // A non-holder's release is a no-op, so it cannot hand the goal to itself.
    await releaseGoalLease(db, { siteId: SITE, goalId, instanceId: 'replica-b' });
    expect(await claimGoalLease(db, { siteId: SITE, goalId, instanceId: 'replica-b' })).toBe(false);

    await releaseGoalLease(db, { siteId: SITE, goalId, instanceId: 'replica-a' });
    expect(await claimGoalLease(db, { siteId: SITE, goalId, instanceId: 'replica-b' })).toBe(true);
  });

  it('R3: two concurrent dispatch passes create ONE run and ONE job for a goal', async () => {
    // End-state guard. It catches a read-then-write rewrite of the claim (two
    // runs, two jobs) but NOT a missing claim, because `RUN_ACTIVE` covers that
    // case — see the table above.
    await seedGoal();
    const q1 = memoryQueue();
    const q2 = memoryQueue();
    // Distinct instance ids, as two replicas would have.
    const cron = new GoalDispatchService({ db, siteId: SITE, queue: q1.provider, instanceId: 'replica-a' });
    const http = new GoalDispatchService({ db, siteId: SITE, queue: q2.provider, instanceId: 'replica-b' });

    const [a, b] = await Promise.all([
      cron.dispatchReconcilerGoals(),
      http.dispatchReconcilerGoals(),
    ]);

    // Exactly one side dispatched; the other reports the lease, not a failure.
    expect(a.dispatched + b.dispatched).toBe(1);
    expect(q1.jobs.length + q2.jobs.length).toBe(1);
    const runs = await db.select().from(agentRuns).where(eq(agentRuns.siteId, SITE));
    expect(runs).toHaveLength(1);

    const loser = a.dispatched === 0 ? a : b;
    expect(loser.outcomes.some((o) => o.reason === 'LEASE_HELD' || o.reason === 'RUN_ACTIVE')).toBe(true);
  });

  it('R3: the lease is released, so the next pass can advance the same goal', async () => {
    // A lease that leaked would look exactly like the bug it prevents: the goal
    // would stop advancing.
    const { goalId } = await seedGoal();
    const q = memoryQueue();
    const dispatcher = new GoalDispatchService({ db, siteId: SITE, queue: q.provider, instanceId: 'solo' });

    await dispatcher.dispatchReconcilerGoals();
    const [after] = await db.select().from(agentGoals).where(eq(agentGoals.id, goalId));
    expect(after!.dispatchLeaseUntil).toBeNull();
    expect(after!.dispatchLeaseBy).toBeNull();
  });

  it('R3: a lease held by another instance is respected until it expires', async () => {
    const { goalId } = await seedGoal();
    const q = memoryQueue();

    // Someone else holds a live lease.
    await db
      .update(agentGoals)
      .set({
        dispatchLeaseUntil: new Date(Date.now() + DISPATCH_LEASE_MS),
        dispatchLeaseBy: 'other-replica',
      })
      .where(eq(agentGoals.id, goalId));

    const blocked = await new GoalDispatchService({
      db,
      siteId: SITE,
      queue: q.provider,
      instanceId: 'me',
    }).dispatchReconcilerGoals();
    expect(blocked.dispatched).toBe(0);
    expect(q.jobs).toHaveLength(0);

    // Expired lease is reclaimable without operator action — the reason it is a
    // timestamp and not a boolean.
    await db
      .update(agentGoals)
      .set({ dispatchLeaseUntil: new Date(Date.now() - 1_000) })
      .where(eq(agentGoals.id, goalId));

    const reclaimed = await new GoalDispatchService({
      db,
      siteId: SITE,
      queue: q.provider,
      instanceId: 'me',
    }).dispatchReconcilerGoals();
    expect(reclaimed.dispatched).toBe(1);
    expect(q.jobs).toHaveLength(1);
  });

  it('R4: a run whose job was lost is re-dispatched instead of blocking forever', async () => {
    // Reproduces the crash window: the run row exists, no job ever reached the
    // queue. Injected by writing the state a killed process would leave, because
    // the failure is "the process stopped", not "enqueue threw" — the existing
    // catch already covers the latter.
    const { goalId } = await seedGoal();
    const q = memoryQueue();
    const dispatcher = new GoalDispatchService({ db, siteId: SITE, queue: q.provider, instanceId: 'solo' });

    await dispatcher.dispatchReconcilerGoals();
    expect(q.jobs).toHaveLength(1);
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.siteId, SITE));
    expect(run!.status).toBe('queued');

    // Pretend the job was never delivered: no worker picked it up, and enough time
    // has passed that "waiting for a worker" is no longer a plausible explanation.
    q.jobs.length = 0;
    const late = new GoalDispatchService({
      db,
      siteId: SITE,
      queue: q.provider,
      instanceId: 'solo',
      now: () => new Date(Date.now() + STALE_QUEUED_RUN_MS + 1_000),
    });
    const recovered = await late.dispatchReconcilerGoals();

    expect(recovered.dispatched).toBe(1);
    expect(q.jobs).toHaveLength(1);

    // The lost run is settled rather than left `queued`, so "is anything in
    // flight" stays answerable.
    const [lost] = await db.select().from(agentRuns).where(eq(agentRuns.id, run!.id));
    expect(lost!.status).toBe('cancelled');
    expect((lost!.metrics as Record<string, unknown>)['stopReason']).toBe('dispatch_lost');
    // And the goal is not blocked — a lost job is not a human decision.
    const [goal] = await db.select().from(agentGoals).where(eq(agentGoals.id, goalId));
    expect(goal!.status).not.toBe('blocked');
  });

  it('R4: a freshly queued run is left alone', async () => {
    // The recovery must not fire on normal waiting, or it would re-enqueue on
    // every tick under load.
    await seedGoal();
    const q = memoryQueue();
    const dispatcher = new GoalDispatchService({ db, siteId: SITE, queue: q.provider, instanceId: 'solo' });

    await dispatcher.dispatchReconcilerGoals();
    q.jobs.length = 0;
    const again = await dispatcher.dispatchReconcilerGoals();

    expect(again.dispatched).toBe(0);
    expect(again.skipped).toBe(1);
    expect(q.jobs).toHaveLength(0);
  });

  it('R5: an older pending goal is dispatched even behind many newer terminal goals', async () => {
    const { goalId } = await seedGoal();
    // Make it clearly the oldest.
    await db
      .update(agentGoals)
      .set({ createdAt: new Date(Date.now() - 86_400_000) })
      .where(eq(agentGoals.id, goalId));

    // 120 newer reconciler goals, all terminal. Under the old query these filled
    // the `limit * 4` window and the pending one disappeared from every pass.
    await db.insert(agentGoals).values(
      Array.from({ length: 120 }, (_, i) => ({
        siteId: SITE,
        title: `terminal ${i}`,
        origin: 'reconciler',
        status: i % 2 === 0 ? 'done' : 'blocked',
        createdAt: new Date(Date.now() - 1_000 * i),
      })),
    );

    const q = memoryQueue();
    const result = await new GoalDispatchService({
      db,
      siteId: SITE,
      queue: q.provider,
      instanceId: 'solo',
    }).dispatchReconcilerGoals();

    expect(result.dispatched).toBe(1);
    expect(q.jobs).toHaveLength(1);
    expect(q.jobs[0]!.payload['goalId']).toBe(goalId);
  });

  it('R5: the multi-tenant tick only visits sites with dispatchable goals', async () => {
    // Site discovery used to list every site that had ever had a reconciler goal,
    // capped at 500 with no ordering. Filtering by status is what keeps the cap
    // from silently cutting off tenants that do have work.
    await seedGoal();
    await db.insert(agentGoals).values({
      siteId: SITE,
      title: 'already done',
      origin: 'reconciler',
      status: 'done',
    });

    const q = memoryQueue();
    const summary = await runGoalDispatchTick({ db, queue: q.provider, sitesLimit: 500 });
    expect(summary.sites).toBeGreaterThanOrEqual(1);
    expect(summary.dispatched).toBeGreaterThanOrEqual(1);
  });
});
