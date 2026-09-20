import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq, sql } from 'drizzle-orm';
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
  holdsGoalLease,
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
   * Two goals under ONE intent, oldest first.
   *
   * Calling `seedGoal` twice does not produce this: the drift scan covers the whole
   * collection, so the second intent sees both items and reconciles into two goals
   * of its own — three in total, which makes "which goal should have been served"
   * ambiguous. Two items under one intent gives exactly two goals with a defined
   * order.
   */
  async function seedTwoGoals(): Promise<{ older: string; newer: string; intentId: string }> {
    const [intent] = await db
      .insert(contentIntents)
      .values({
        siteId: SITE,
        name: `articles-pair-${Math.random().toString(36).slice(2, 8)}`,
        collection: COLLECTION,
        rules: [{ type: 'translations', fields: ['translations'], locales: ['en', 'vi'] }],
        schedule: '0 * * * *',
        budget: { maxGoalsPerCycle: 10 },
        autonomyCap: 2,
        status: 'active',
      })
      .returning({ id: contentIntents.id });
    for (const n of [1, 2]) {
      await db.insert(items).values({
        siteId: SITE,
        collectionId,
        status: 'published',
        data: { title: `Hello ${n}`, translations: { en: `Hello world ${n}` } },
      });
    }

    const { DriftService } = await import('../drift-service');
    const { ReconcilerService } = await import('../reconciler-service');
    await new DriftService({ db, siteId: SITE }).scanIntent(intent!.id);
    await new ReconcilerService({ db, siteId: SITE }).reconcileIntent(intent!.id);

    const goals = await db
      .select()
      .from(agentGoals)
      .where(and(eq(agentGoals.siteId, SITE), eq(agentGoals.intentId, intent!.id)))
      .orderBy(asc(agentGoals.createdAt));
    expect(goals, 'fixture must produce exactly two goals').toHaveLength(2);

    // Spread them in time so "oldest" is unambiguous rather than insertion-order
    // dependent.
    await db
      .update(agentGoals)
      .set({ createdAt: new Date(Date.now() - 86_400_000) })
      .where(eq(agentGoals.id, goals[0]!.id));
    return { older: goals[0]!.id, newer: goals[1]!.id, intentId: intent!.id };
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

    const a = await claimGoalLease(db, { siteId: SITE, goalId, instanceId: 'replica-a' });
    expect(a, 'first claim wins').not.toBeNull();
    expect(await claimGoalLease(db, { siteId: SITE, goalId, instanceId: 'replica-b' })).toBeNull();

    // A non-holder's release is a no-op, so it cannot hand the goal to itself.
    await releaseGoalLease(db, { siteId: SITE, goalId, token: 'replica-b#not-the-holder' });
    expect(await claimGoalLease(db, { siteId: SITE, goalId, instanceId: 'replica-b' })).toBeNull();

    await releaseGoalLease(db, { siteId: SITE, goalId, token: a! });
    expect(await claimGoalLease(db, { siteId: SITE, goalId, instanceId: 'replica-b' })).not.toBeNull();
  });

  /**
   * The stale-holder release, which the owner id alone could not prevent (F4).
   *
   * `dispatchLeaseBy` used to be `${HOSTNAME}:${pid}` — one string for every
   * acquisition in a process. Two overlapping ticks in the SAME process were
   * therefore indistinguishable, and the measured sequence was: A claims, A's
   * lease expires, B reclaims, A's `finally` releases by owner match and deletes
   * B's lease, C walks in while B is still working. Two replicas were never
   * needed to hit it.
   *
   * The clock is injected rather than waited on, so this is deterministic.
   */
  it('R3/F4: an expired holder cannot release the lease that replaced it', async () => {
    const { goalId } = await seedGoal();
    const t0 = new Date();

    const stale = await claimGoalLease(db, { siteId: SITE, goalId, instanceId: 'same-process', now: t0 });
    expect(stale).not.toBeNull();

    // Same owner string, one lease period later: this is the second tick of the
    // same process reclaiming its own expired lease.
    const fresh = await claimGoalLease(db, {
      siteId: SITE,
      goalId,
      instanceId: 'same-process',
      now: new Date(t0.getTime() + DISPATCH_LEASE_MS + 1),
    });
    expect(fresh, 'the expired lease is reclaimable').not.toBeNull();
    expect(fresh).not.toBe(stale);

    // The slow first caller finally finishes and releases. It must release nothing.
    await releaseGoalLease(db, { siteId: SITE, goalId, token: stale! });

    const intruder = await claimGoalLease(db, {
      siteId: SITE,
      goalId,
      instanceId: 'third',
      now: new Date(t0.getTime() + DISPATCH_LEASE_MS + 2),
    });
    expect(intruder, 'nobody may enter while the new holder owns the lease').toBeNull();
  });

  /**
   * The fence, exercised through a real dispatch pass.
   *
   * Written after measuring that removing the fence left every other case in this
   * file green — the primitive-level case below proves `holdsGoalLease` computes
   * the right answer, not that `dispatchPhase` asks it. Those are different
   * claims, and only this one would notice the check being deleted.
   *
   * The clock advances between the claim and the write, which is what a pass
   * slower than its own lease looks like from the outside.
   */
  it('R3/F4: a pass that outlived its lease enqueues nothing', async () => {
    await seedGoal();
    const q = memoryQueue();
    const t0 = new Date();
    let calls = 0;
    const dispatcher = new GoalDispatchService({
      db,
      siteId: SITE,
      queue: q.provider,
      instanceId: 'slow-pass',
      // Readings 1–2 are the candidate query and the claim; from the third on, the
      // pass has taken longer than its own lease. Counting rather than using a
      // wall-clock delay keeps this deterministic — and the count is asserted
      // below, so a change in how often the clock is read fails loudly instead of
      // quietly turning this case into a no-op.
      now: () => (calls++ < 2 ? t0 : new Date(t0.getTime() + DISPATCH_LEASE_MS + 1)),
    });

    const pass = await dispatcher.dispatchReconcilerGoals();
    expect(pass.dispatched, 'no job may be enqueued without the lease').toBe(0);
    expect(q.jobs, 'and nothing reached the queue').toHaveLength(0);
    expect(pass.outcomes.some((o) => o.reason === 'LEASE_LOST')).toBe(true);
    const runs = await db.select().from(agentRuns).where(eq(agentRuns.siteId, SITE));
    expect(runs, 'no run row either').toHaveLength(0);
    expect(calls, 'the clock was read past the claim, so the fence was reachable').toBeGreaterThan(2);
  });

  it('R3/F4: the fence reports a lease that expired underneath us', async () => {
    // What `dispatchPhase` checks before it writes anything. Without it, a pass
    // slower than its own lease enqueues alongside the goal's new owner.
    const { goalId } = await seedGoal();
    const t0 = new Date();
    const token = await claimGoalLease(db, { siteId: SITE, goalId, instanceId: 'slow', now: t0 });

    expect(await holdsGoalLease(db, { siteId: SITE, goalId, token: token!, now: t0 })).toBe(true);
    expect(
      await holdsGoalLease(db, {
        siteId: SITE,
        goalId,
        token: token!,
        now: new Date(t0.getTime() + DISPATCH_LEASE_MS + 1),
      }),
      'an expired lease is not held',
    ).toBe(false);

    await claimGoalLease(db, {
      siteId: SITE,
      goalId,
      instanceId: 'next',
      now: new Date(t0.getTime() + DISPATCH_LEASE_MS + 1),
    });
    expect(
      await holdsGoalLease(db, {
        siteId: SITE,
        goalId,
        token: token!,
        now: new Date(t0.getTime() + DISPATCH_LEASE_MS + 2),
      }),
      'a lease handed to someone else is not held',
    ).toBe(false);
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

    // The loser has three legitimate shapes, and which one it takes is a timing
    // detail rather than a contract — CI hit the third while local runs hit the
    // first two:
    //
    //   - `LEASE_HELD`: it reached the claim while the winner held the lease;
    //   - `RUN_ACTIVE`: it read the goal before the winner's run existed, then saw it;
    //   - no outcome at all: since F5 the candidate query itself excludes a goal
    //     whose run is in flight, so by the time the loser queried, the goal was
    //     not a candidate.
    //
    // Pinning one of them would be pinning the schedule. What must hold is that the
    // loser did not dispatch, and that it did not fail.
    const loser = a.dispatched === 0 ? a : b;
    expect(loser.dispatched).toBe(0);
    expect(loser.blocked, 'losing a race is not an error').toBe(0);
    for (const outcome of loser.outcomes) {
      expect(['LEASE_HELD', 'RUN_ACTIVE', 'LEASE_LOST']).toContain(outcome.reason);
    }
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
    expect(q.jobs).toHaveLength(0);
    // Since F5 the goal is excluded in SQL while its run is in flight, so the pass
    // does not even take its lease. Before that it was fetched and then skipped
    // with `RUN_ACTIVE` — same outcome for this goal, but it consumed a slot that
    // an actionable goal behind it needed.
    expect(again.outcomes).toEqual([]);
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

  /**
   * Starvation behind goals that are waiting on a human (F5).
   *
   * The status filter fixed terminal rows; it could not fix this, because
   * `in_progress` is precisely the status of a goal parked at `awaiting_approval`.
   * Measured with `limit = 1` before the fix: two consecutive passes each took the
   * one oldest goal, reported `RUN_ACTIVE`, enqueued nothing, and never looked at
   * the actionable goal behind it. Oldest-first had moved the starvation to the
   * front of the queue rather than removing it.
   */
  it('R5/F5: a goal waiting on a human does not consume the pass limit', async () => {
    const { older: waiting, newer: actionable } = await seedTwoGoals();

    await db
      .update(agentGoals)
      .set({ status: 'in_progress' })
      .where(eq(agentGoals.id, waiting));
    // Its run is parked for approval — in flight, but not moving on its own.
    await db.insert(agentRuns).values({
      siteId: SITE,
      goalId: waiting,
      agentName: 'translator',
      status: 'awaiting_approval',
    });

    const q = memoryQueue();
    const dispatcher = new GoalDispatchService({
      db,
      siteId: SITE,
      queue: q.provider,
      instanceId: 'solo',
    });

    // limit = 1 is the sharp version of the bug: one slot, and the waiting goal
    // used to take it every time.
    const pass = await dispatcher.dispatchReconcilerGoals(1);
    expect(pass.dispatched, 'the actionable goal behind it must be served').toBe(1);
    expect(q.jobs).toHaveLength(1);
    expect(q.jobs[0]!.payload['goalId']).toBe(actionable);
  });

  it('R5/F5: the waiting goal comes back once its run is no longer in flight', async () => {
    // The exclusion must be a state, not a blacklist: nothing records that a goal
    // was skipped, so the only thing that can bring it back is the run leaving the
    // in-flight set. If that did not work, F5's fix would trade one starvation for
    // another.
    const { goalId } = await seedGoal();
    const [run] = await db
      .insert(agentRuns)
      .values({ siteId: SITE, goalId, agentName: 'translator', status: 'awaiting_approval' })
      .returning({ id: agentRuns.id });

    const q = memoryQueue();
    const dispatcher = new GoalDispatchService({
      db,
      siteId: SITE,
      queue: q.provider,
      instanceId: 'solo',
    });
    expect((await dispatcher.dispatchReconcilerGoals()).outcomes, 'skipped entirely').toEqual([]);

    // The human rejected it, so the run is terminal and the goal is decidable
    // again — here it blocks with a reason, which is a decision rather than silence.
    await db.update(agentRuns).set({ status: 'cancelled' }).where(eq(agentRuns.id, run!.id));
    const after = await dispatcher.dispatchReconcilerGoals();
    expect(after.outcomes.map((o) => o.goalId)).toContain(goalId);
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
