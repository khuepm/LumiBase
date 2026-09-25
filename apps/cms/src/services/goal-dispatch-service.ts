import {
  agentGoals,
  agentRuns,
  collections,
  contentDrifts,
  contentIntents,
  contentVersions,
  type Database,
} from '@lumibase/database';
import type { QueueProvider } from '@lumibase/runtime';
import { and, asc, desc, eq, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { AgentRunService, type AgentRunContext } from './agent-run-service';
import { AGENT_RUNS_QUEUE, type AgentRunJobPayload } from './agent-run-worker';
import { KillSwitchService } from './kill-switch-service';

/**
 * GoalDispatchService — the missing link between a reconciler goal and an
 * executed run (#455).
 *
 * ## What was broken
 *
 * `ReconcilerService.reconcileIntent()` inserted an `agent_goals` row and
 * flipped the drift to `assigned` with `goalId` set. That was the end of the
 * chain: `ReconcilerServiceDeps` had no queue, the only `AGENT_RUNS_QUEUE`
 * enqueue in the codebase was the human-triggered `POST /agent/goals` route, and
 * no cron, queue consumer, planner or flow turned a goal into a run. Measured on
 * Postgres: after one reconcile plus three further cycles, `agent_runs` stayed
 * empty while the drift stayed `assigned` forever.
 *
 * That is worse than doing nothing. `planReconciliation` deliberately skips
 * drifts that already carry a `goalId`, so the unexecutable goal *locked* the
 * drift out of every future cycle. A site could accumulate assigned drift that
 * no longer appeared as actionable and never got repaired.
 *
 * ## Why a separate service rather than enqueueing inside the reconciler
 *
 * Enqueueing from `reconcileIntent` would tie goal creation to queue
 * availability: a transient enqueue failure after the goal row is committed
 * leaves exactly the stuck state described above, with no component whose job is
 * to notice. This service instead derives what to do next from **observable
 * state** — the goal's phase, its latest run, whether the draft branch exists,
 * and the drift's status — so it is safe to run repeatedly, safe to run after a
 * crash mid-sequence, and idempotent under duplicate queue delivery.
 *
 * ## The bounded repair loop
 *
 * One scenario is wired end to end (missing translation), in two runs:
 *
 * 1. **draft** — `repairTranslation` writes the proposed translation into a
 *    named content version branch. Nothing live changes, so this can execute at
 *    the intent's own autonomy level.
 * 2. **promote** — `promoteVersion` applies that branch to main. It is
 *    classified dangerous, so the harness parks it for human approval (G1,
 *    #453); only after a human approves does published content change.
 * 3. **verify** — the drift is re-scanned. The goal completes only when the
 *    re-evaluation finds the violation gone. A promoted draft that does not
 *    actually resolve the drift blocks the goal instead of reporting success.
 *
 * Anything other than a clean success blocks the goal with a reason. This
 * service never retries on its own: an automatic retry of a rejected approval
 * would re-ask a human who already said no.
 */

/** Non-terminal run states: work is in flight, do not dispatch again. */
const ACTIVE_RUN_STATES = new Set(['queued', 'running', 'awaiting_approval']);

/** Goal statuses a dispatch pass may act on. Filtered in SQL, not in memory. */
export const DISPATCHABLE_GOAL_STATUSES = ['open', 'in_progress'] as const;

/**
 * How long one caller may hold a goal's dispatch lease.
 *
 * Long enough to cover a pass (a few DB round trips plus one enqueue), short
 * enough that a process killed mid-dispatch does not strand the goal for long.
 * The cron tick runs every minute, so a 30s lease means at most one skipped tick
 * after a crash.
 */
export const DISPATCH_LEASE_MS = 30_000;

/**
 * How long any dispatch statement may wait for the goal row lock.
 *
 * Long enough to absorb a normal dispatch transaction (a few statements, no
 * network calls — the enqueue happens after commit), short enough that a caller
 * stuck inside one cannot stall later ticks on the same goal. Reaching it is not
 * an error: it means someone else is mid-dispatch, which is the `LEASE_HELD` /
 * `LEASE_LOST` case every caller already handles.
 */
export const DISPATCH_LOCK_TIMEOUT = '2s';

// The value is inlined into `SET LOCAL` (which takes no bind parameters), so its
// shape is asserted at module load rather than assumed. A future edit to something
// like `2s'; DROP …` fails here, at import time, instead of reaching Postgres.
if (!/^\d+(ms|s)$/.test(DISPATCH_LOCK_TIMEOUT)) {
  throw new Error('DISPATCH_LOCK_TIMEOUT must be a plain duration literal');
}

/**
 * How long a `queued` run may sit before dispatch assumes its job was lost.
 *
 * The window that R4 is about: the run row is inserted before the job is
 * enqueued, so a process that dies in between leaves a `queued` run with no job.
 * Nothing consumes it, and `RUN_ACTIVE` used to make every later pass skip the
 * goal forever.
 *
 * Generous on purpose. A queue under load can legitimately leave a job waiting,
 * and re-enqueueing early is harmless but wasteful; five minutes is far longer
 * than a healthy pickup and far shorter than "forever".
 */
export const STALE_QUEUED_RUN_MS = 5 * 60_000;

/**
 * "This goal has a run in flight", expressed in SQL (#455 F5).
 *
 * ## Why the status filter was not enough
 *
 * Filtering `status IN ('open','in_progress')` fixed the case where terminal goals
 * ate the limit, but `in_progress` is exactly the status of a goal whose run is
 * parked at `awaiting_approval` — waiting on a human, for as long as the human
 * takes. Each pass took the N oldest such goals, skipped every one of them with
 * `RUN_ACTIVE`, and finished. Measured with `limit = 1`: two passes in a row
 * reported one skip and enqueued nothing, while an `open` goal sat behind the
 * waiting one and was never looked at. Oldest-first had moved the starvation from
 * the back of the queue to the front, not removed it.
 *
 * Excluding these in SQL means the limit counts goals that can actually move. A
 * goal reappears the moment its run leaves the in-flight set — approved, rejected,
 * failed or aged out — so nothing needs to remember it.
 *
 * `queued` is in-flight only while it is young: past {@link STALE_QUEUED_RUN_MS}
 * its job is presumed lost and the goal must be reconsidered, which is the R4
 * recovery. Those two rules have to agree, or the recovery would be filtered out
 * before it could happen.
 */
/**
 * "This goal's intent can actually spawn work right now" (#481 R3.3).
 *
 * `noRunInFlight` removed goals waiting on a human, but a goal whose intent is
 * `paused` or `error` is equally unable to move — and it stayed in the candidate
 * set, took a slot, and came back with `INTENT_NOT_ACTIVE` on every tick.
 * Measured with `limit = 1`: two consecutive passes reported that skip, enqueued
 * nothing, and never looked at the runnable goal behind it.
 *
 * A goal with no `intent_id` is kept: it is not reconciler-shaped work and the
 * dispatcher blocks it with `MISSING_LINEAGE`, which is a decision rather than the
 * silent skip this filter exists to stop.
 */
export function intentDispatchable(): SQL {
  return sql`(
    ${agentGoals.intentId} is null
    or exists (
      select 1 from ${contentIntents}
      where ${contentIntents.id} = ${agentGoals.intentId}
        and ${contentIntents.siteId} = ${agentGoals.siteId}
        and ${contentIntents.status} = 'active'
    )
  )`;
}

export function noRunInFlight(now: Date): SQL {
  const staleBefore = new Date(now.getTime() - STALE_QUEUED_RUN_MS);
  // Written as `sql` rather than through the builder because a correlated
  // subquery needs the outer `agent_goals.id`, and spelling it out keeps the
  // generated SQL legible in a query plan.
  return sql`not exists (
    select 1 from ${agentRuns}
    where ${agentRuns.goalId} = ${agentGoals.id}
      and ${agentRuns.siteId} = ${agentGoals.siteId}
      and (
        ${agentRuns.status} in ('running', 'awaiting_approval')
        or (
          ${agentRuns.status} = 'queued'
          -- ISO string with an explicit cast, not a Date: inside a raw fragment
          -- drizzle has no column type to infer from, and postgres.js then
          -- rejects the Date outright ("must be of type string or Buffer").
          and ${agentRuns.createdAt} >= ${staleBefore.toISOString()}::timestamp
        )
      )
  )`;
}

/** Phase recorded on the goal so a dispatch decision is auditable. */
export type RepairPhase = 'drafting' | 'promoting';

export type GoalDispatchAction =
  | { action: 'dispatch_draft' }
  | { action: 'dispatch_promote' }
  | { action: 'verify' }
  | { action: 'complete' }
  | { action: 'skip'; reason: string }
  | { action: 'block'; reason: string };

export interface GoalDispatchState {
  /** Latest run for this goal, or null when none exists yet. */
  latestRunStatus: string | null;
  /**
   * `metrics.stopReason` of that run. `'deferred'` means the write budget or the
   * load guard said "not now" — a temporary condition, not a decision.
   */
  latestRunStopReason?: string | null;
  /**
   * How long the latest run has been `queued`, when it is.
   *
   * Only meaningful for `queued`; used to tell "waiting for a worker" from "its
   * job was lost when the dispatching process died".
   */
  queuedRunAgeMs?: number | undefined;
  /** `metadata.repairPhase`, or null before the first dispatch. */
  repairPhase: RepairPhase | null;
  /** Whether the deterministic draft branch for this drift still exists. */
  draftExists: boolean;
  /** Drift status, or null when the drift row is gone. */
  driftStatus: string | null;
}

/**
 * Pure decision function — exported so the state machine is testable without a
 * queue, a harness or an LLM.
 *
 * Ordering matters and is deliberate:
 *
 * - An in-flight run wins over everything. Completing a goal while its run is
 *   still executing would leave an orphan run mutating content behind a goal
 *   already marked done.
 * - A resolved drift completes the goal even if a phase is half-finished: the
 *   violation is gone, which is the only success condition that counts. A human
 *   fixing the content by hand is a legitimate way to get there.
 * - A failed or cancelled run blocks. It never re-dispatches the same phase,
 *   because the most common cause is a human rejecting the approval.
 */
export function decideGoalAction(state: GoalDispatchState): GoalDispatchAction {
  // A `queued` run that nothing picked up is the R4 crash window: the run row is
  // written before the job is enqueued, so a process killed in between leaves a
  // run with no job. Treating that as `RUN_ACTIVE` forever is what made the goal
  // unrecoverable — the state this whole service exists to eliminate.
  //
  // Re-dispatching is safe rather than clever: `claimQueuedRun` is a conditional
  // UPDATE, so only one delivery of a job can start it and a duplicate is a no-op
  // (this was NOT true of the `markRunning` it replaced — see #455 F3), and the
  // draft branch key is deterministic, so a duplicated draft cannot exist. The
  // worst case of re-enqueueing too early is one wasted pickup; the worst case of
  // not re-enqueueing is a goal that never moves again.
  if (state.latestRunStatus === 'queued' && state.queuedRunAgeMs !== undefined) {
    if (state.queuedRunAgeMs >= STALE_QUEUED_RUN_MS) {
      return state.repairPhase === 'promoting'
        ? { action: 'dispatch_promote' }
        : { action: 'dispatch_draft' };
    }
  }

  if (state.latestRunStatus && ACTIVE_RUN_STATES.has(state.latestRunStatus)) {
    return { action: 'skip', reason: 'RUN_ACTIVE' };
  }
  if (state.driftStatus === 'resolved') {
    return { action: 'complete' };
  }
  if (state.driftStatus === null) {
    // The drift row disappeared (item hard-deleted, intent removed). Repairing
    // a violation that no longer has a record would write content nobody asked
    // for, so this is a human question, not a retry.
    return { action: 'block', reason: 'DRIFT_MISSING' };
  }
  // A deferral is re-issued, not blocked. The write budget and the load guard are
  // rate limits: the work is still wanted, just not right now. Blocking here would
  // turn "the site is busy" into a goal a human has to unblock by hand.
  if (state.latestRunStopReason === 'deferred') {
    return state.repairPhase === 'promoting'
      ? { action: 'dispatch_promote' }
      : { action: 'dispatch_draft' };
  }

  if (state.latestRunStatus === 'failed' || state.latestRunStatus === 'cancelled') {
    return { action: 'block', reason: `RUN_${state.latestRunStatus.toUpperCase()}` };
  }

  if (state.repairPhase === null) {
    return { action: 'dispatch_draft' };
  }

  if (state.repairPhase === 'drafting') {
    // The draft run reported success, so the branch must exist. If it does not,
    // the skill returned a success shape without doing the work — exactly the
    // "success-shaped placeholder" this loop must not accept.
    return state.draftExists
      ? { action: 'dispatch_promote' }
      : { action: 'block', reason: 'DRAFT_MISSING' };
  }

  // phase === 'promoting': promote deletes the branch on success, so a branch
  // that is still present means the promote did not apply.
  return state.draftExists
    ? { action: 'block', reason: 'PROMOTE_INCOMPLETE' }
    : { action: 'verify' };
}

/**
 * Deterministic draft branch key for a drift.
 *
 * Deterministic on purpose: `ContentVersionService.create` rejects a duplicate
 * key with `VERSION_EXISTS`, so a duplicate queue delivery of the same draft job
 * cannot produce a second draft. The key is also how `draftExists` is derived,
 * which is what removes the need to trust a stored flag.
 */
export function draftVersionKey(fingerprint: string): string {
  return `drift-repair:${fingerprint}`;
}

export interface GoalLeaseRef {
  siteId: string;
  goalId: string;
  /** Lease holder id, so only the holder can release it. */
  instanceId: string;
}

/**
 * Takes a goal's dispatch lease, or reports that someone else holds it.
 *
 * One conditional UPDATE is the whole mechanism: `WHERE lease IS NULL OR lease <
 * now()` means exactly one concurrent caller gets a row back, and Postgres — not
 * this code — decides which, because both statements contend for the same row
 * lock. Advancing a goal is a read-then-write with two entry points (the cron
 * tick and `POST /intents/:id/scan`), so without this both callers can read "no
 * active run" and both create one.
 *
 * Module-level rather than a private method so the mutual exclusion can be
 * measured directly (`Promise.all` of two claims must yield exactly one winner).
 * A read-then-write rewrite of this function would pass every end-to-end test in
 * the suite and fail that one.
 */
export async function claimGoalLease(
  db: Database,
  ref: GoalLeaseRef & { now?: Date },
): Promise<string | null> {
  // Bounded wait (#481 R3.2). Dispatch writes inside a transaction that holds the
  // goal row, so a claim for the same goal can legitimately have to wait — but
  // "wait" must never mean "forever". Without a bound, one dispatcher stuck inside
  // its transaction stalls every later tick on that goal; with it, the claim gives
  // up and the caller simply reports the goal as held, which is already a state it
  // knows how to handle.
  return withLockTimeout(db, async (tx) => claimGoalLeaseWithin(tx, ref), null);
}

/**
 * Runs `fn` with a short `lock_timeout`, answering `fallback` if it waits too long.
 *
 * `SET LOCAL` scopes the timeout to this transaction, so it cannot leak into the
 * pool and change unrelated queries. A lock timeout here is not an error worth
 * propagating: it means somebody else is mid-dispatch on this row, which every
 * caller already treats as "not mine this pass".
 */
async function withLockTimeout<T>(
  db: Database,
  fn: (tx: Database) => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await db.transaction(async (tx) => {
      // `SET LOCAL` does not accept bind parameters, so the value is inlined.
      // Safe because it is a module constant, never caller input — a literal
      // checked by the assertion below rather than trusted by convention.
      await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${DISPATCH_LOCK_TIMEOUT}'`));
      return fn(tx as unknown as Database);
    });
  } catch (error) {
    if (isLockTimeout(error)) return fallback;
    throw error;
  }
}

/** Postgres `lock_not_available` (55P03) — the wait bound was reached. */
function isLockTimeout(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  const causeCode = (error as { cause?: { code?: unknown } })?.cause?.code;
  return code === '55P03' || causeCode === '55P03';
}

async function claimGoalLeaseWithin(
  db: Database,
  ref: GoalLeaseRef & { now?: Date },
): Promise<string | null> {
  const now = ref.now ?? new Date();
  // Identity of THIS acquisition, not of the process (#455 F4).
  //
  // `dispatchLeaseBy` used to hold `${HOSTNAME}:${pid}`, which is the same string
  // for every acquisition inside one process — so it identified the holder about
  // as precisely as "someone here". Measured consequence: caller A's lease
  // expires, B reclaims it, then A's `finally` runs and releases "its" lease by
  // owner match — deleting B's. A third caller then walks in while B is still
  // working, which is the one thing the lease exists to prevent. Two replicas were
  // not needed to reproduce it; two overlapping ticks in one process were enough.
  //
  // The token makes release and fencing answer "is this still *my* lease" instead
  // of "does this look like one of ours". The instance id stays in the string
  // because a stuck lease has to be attributable to a machine in support.
  const token = `${ref.instanceId}#${nanoid(10)}`;
  const claimed = await db
    .update(agentGoals)
    .set({
      dispatchLeaseUntil: new Date(now.getTime() + DISPATCH_LEASE_MS),
      dispatchLeaseBy: token,
    })
    .where(
      and(
        eq(agentGoals.siteId, ref.siteId),
        eq(agentGoals.id, ref.goalId),
        or(isNull(agentGoals.dispatchLeaseUntil), lt(agentGoals.dispatchLeaseUntil, now)),
      ),
    )
    .returning({ id: agentGoals.id });
  return claimed.length > 0 ? token : null;
}

/**
 * Releases a lease we hold, so the next pass is not blocked by our own hold.
 *
 * Scoped to the exact token, so a caller whose lease already expired and was
 * reclaimed by someone else releases nothing. Best-effort otherwise: a failure
 * here costs one skipped tick rather than a stuck goal, which is why the lease is
 * a timestamp and not a flag.
 */
export async function releaseGoalLease(
  db: Database,
  ref: { siteId: string; goalId: string; token: string },
): Promise<void> {
  await db
    .update(agentGoals)
    .set({ dispatchLeaseUntil: null, dispatchLeaseBy: null })
    .where(
      and(
        eq(agentGoals.siteId, ref.siteId),
        eq(agentGoals.id, ref.goalId),
        eq(agentGoals.dispatchLeaseBy, ref.token),
      ),
    )
    .catch(() => undefined);
}

/**
 * Whether we still hold the lease — the fence checked before any side effect.
 *
 * A lease is a time-boxed promise, and a slow pass can outlive it: the row has
 * already been handed to someone else while this code is still walking through its
 * decision. Releasing correctly (above) stops us from *taking away* the new
 * holder's lease, but it does not stop us from enqueueing a job the new holder is
 * also about to enqueue. Re-reading the token immediately before the write is what
 * closes that, and it is cheap because it only happens on the dispatch path.
 */
export async function holdsGoalLease(
  db: Database,
  ref: { siteId: string; goalId: string; token: string; now?: Date },
): Promise<boolean> {
  const now = ref.now ?? new Date();
  const [row] = await db
    .select({ by: agentGoals.dispatchLeaseBy, until: agentGoals.dispatchLeaseUntil })
    .from(agentGoals)
    .where(and(eq(agentGoals.siteId, ref.siteId), eq(agentGoals.id, ref.goalId)))
    .limit(1);
  if (!row || row.by !== ref.token || !row.until) return false;
  return row.until.getTime() > now.getTime();
}

export interface RepairArguments {
  collection: string;
  itemId: string;
  field: string;
  locale: string;
  versionKey: string;
}

/**
 * Derives the repair arguments for a translation drift.
 *
 * `ruleKey` is `${field}:${locale}` (see `DriftService.evaluateRules`), and
 * `detail.locale` carries the locale explicitly. The locale never contains a
 * colon, so splitting at the last one recovers a field name that does.
 * Returns null when the drift is not a translation drift.
 */
export function repairArgumentsForDrift(input: {
  ruleType: string;
  ruleKey: string;
  itemId: string;
  collection: string;
  fingerprint: string;
  detail: Record<string, unknown> | null;
}): RepairArguments | null {
  if (input.ruleType !== 'translations') return null;
  const separator = input.ruleKey.lastIndexOf(':');
  if (separator <= 0) return null;
  const field = input.ruleKey.slice(0, separator);
  const localeFromDetail = input.detail?.['locale'];
  const locale =
    typeof localeFromDetail === 'string' && localeFromDetail.length > 0
      ? localeFromDetail
      : input.ruleKey.slice(separator + 1);
  if (!field || !locale) return null;
  return {
    collection: input.collection,
    itemId: input.itemId,
    field,
    locale,
    versionKey: draftVersionKey(input.fingerprint),
  };
}

export interface GoalDispatchServiceDeps {
  db: Database;
  siteId: string;
  queue?: QueueProvider;
  /** Lease holder id; defaults to `${HOSTNAME}:${pid}`. Injected by tests. */
  instanceId?: string;
  /** Clock seam so the stale-queued window can be exercised without waiting. */
  now?: () => Date;
}

export interface GoalDispatchOutcome {
  goalId: string;
  action: GoalDispatchAction['action'];
  reason?: string;
  runId?: string;
}

export interface GoalDispatchResult {
  dispatched: number;
  completed: number;
  skipped: number;
  blocked: number;
  /** True when this runtime has no queue adapter, so nothing could be dispatched. */
  queueUnavailable?: boolean;
  /** True when the site kill switch is engaged — a deliberate stop, not a failure. */
  frozen?: boolean;
  outcomes: GoalDispatchOutcome[];
}

export class GoalDispatchService {
  /**
   * Identifies this holder in `dispatch_lease_by`.
   *
   * Only used to make a lease releasable by whoever took it (and to make a stuck
   * lease attributable in support). Correctness rests on the timestamp, not on
   * this being unique, so a collision costs nothing.
   */
  private readonly instanceId: string;

  constructor(private readonly deps: GoalDispatchServiceDeps) {
    this.instanceId =
      deps.instanceId ?? `${process.env['HOSTNAME'] ?? 'local'}:${process.pid}`;
  }

  /**
   * Advances every reconciler goal for this site by at most one step.
   *
   * @param limit maximum goals inspected in one pass
   */
  async dispatchReconcilerGoals(limit = 25): Promise<GoalDispatchResult> {
    const result: GoalDispatchResult = {
      dispatched: 0,
      completed: 0,
      skipped: 0,
      blocked: 0,
      outcomes: [],
    };

    // Kill switch (Req 14.4): a frozen site advances nothing. This is a stop the
    // operator asked for, so goals are left exactly as they are rather than
    // being blocked with a reason that would need clearing later.
    const killSwitch = new KillSwitchService({ db: this.deps.db, siteId: this.deps.siteId });
    if (await killSwitch.isSiteFrozen()) {
      return { ...result, frozen: true };
    }

    // Status is filtered IN SQL, and the order is OLDEST FIRST (reviewer R5).
    //
    // The previous query took the newest `limit * 4` reconciler goals and only
    // then filtered for `open`/`in_progress` in memory. A hundred newer terminal
    // goals were enough to push an older pending one out of every pass — it
    // simply stopped being dispatched, with nothing reporting that. Newest-first
    // also meant a burst of new goals could starve an older one indefinitely.
    //
    // Filtering in SQL means `limit` counts goals that are actually candidates,
    // and ascending `createdAt` makes the oldest waiting goal the first one
    // served. Goals waiting on a human (their run is `awaiting_approval`) still
    // occupy a slot for one pass, but they are skipped cheaply and the lease is
    // not taken, so they cannot hold the queue.
    const pending = await this.deps.db
      .select()
      .from(agentGoals)
      .where(
        and(
          eq(agentGoals.siteId, this.deps.siteId),
          eq(agentGoals.origin, 'reconciler'),
          inArray(agentGoals.status, DISPATCHABLE_GOAL_STATUSES),
          // Goals waiting on a human do not consume a slot (F5) — see
          // `noRunInFlight`. Without this, N goals parked for approval were
          // fetched, skipped and refetched on every tick while an actionable goal
          // behind them was never reached.
          noRunInFlight(this.deps.now?.() ?? new Date()),
          // A goal whose intent is paused or errored cannot move either, and it
          // used to take a slot and return `INTENT_NOT_ACTIVE` every tick (R3.3).
          intentDispatchable(),
        ),
      )
      // ROTATION, not just age (R3.3). Ordering purely by `createdAt` means the
      // front of the queue is re-read on every pass, so a prefix that keeps being
      // selected can keep the goals behind it from ever being considered — with
      // `limit = 1` that was measurable as "the same goal, twice, zero enqueues".
      // `dispatchAttemptedAt` is stamped whenever a goal is considered, so being
      // looked at costs it its place. Nulls first: a new goal outranks anything
      // already seen. `createdAt` remains the tie-break, which keeps the
      // oldest-first property within one rotation cycle.
      .orderBy(sql`${agentGoals.dispatchAttemptedAt} asc nulls first`, asc(agentGoals.createdAt))
      .limit(Math.max(1, Math.trunc(limit)));

    for (const goal of pending) {
      const outcome = await this.advanceGoal(goal, result);
      result.outcomes.push(outcome);
    }
    return result;
  }

  /**
   * Stamps a goal as considered, so the next pass prefers something else.
   *
   * Best-effort and bounded: if a dispatcher is inside its transaction for this
   * goal, waiting for the row lock would stall the pass, and the stamp is only a
   * fairness hint — losing one costs a place in the rotation, not correctness.
   */
  private async markConsidered(goalId: string): Promise<void> {
    const now = this.deps.now?.() ?? new Date();
    await withLockTimeout(
      this.deps.db,
      async (tx) => {
        await tx
          .update(agentGoals)
          .set({ dispatchAttemptedAt: now })
          .where(and(eq(agentGoals.siteId, this.deps.siteId), eq(agentGoals.id, goalId)));
        return undefined;
      },
      undefined,
    ).catch(() => undefined);
  }

  /** Advances a single goal. Exposed for the route that reconciles one intent. */
  async advanceGoalById(goalId: string): Promise<GoalDispatchOutcome | null> {
    const [goal] = await this.deps.db
      .select()
      .from(agentGoals)
      .where(and(eq(agentGoals.siteId, this.deps.siteId), eq(agentGoals.id, goalId)))
      .limit(1);
    if (!goal) return null;
    const result: GoalDispatchResult = {
      dispatched: 0,
      completed: 0,
      skipped: 0,
      blocked: 0,
      outcomes: [],
    };
    return this.advanceGoal(goal, result);
  }

  /** Claims the lease, returning this acquisition's token or null. */
  private claimGoal(goalId: string): Promise<string | null> {
    return claimGoalLease(this.deps.db, {
      siteId: this.deps.siteId,
      goalId,
      instanceId: this.instanceId,
      now: this.deps.now?.() ?? new Date(),
    });
  }

  private releaseGoalLease(goalId: string, token: string): Promise<void> {
    return releaseGoalLease(this.deps.db, { siteId: this.deps.siteId, goalId, token });
  }

  /** The fence: still ours, still unexpired? Checked before any side effect. */
  private holdsLease(goalId: string, token: string): Promise<boolean> {
    return holdsGoalLease(this.deps.db, {
      siteId: this.deps.siteId,
      goalId,
      token,
      now: this.deps.now?.() ?? new Date(),
    });
  }

  /**
   * Advances one goal under its dispatch lease.
   *
   * The lease is taken before any read that a decision depends on, and released
   * on every exit path. Two callers racing the same goal therefore serialize:
   * the loser sees `LEASE_HELD` and leaves the goal exactly as it was.
   */
  private async advanceGoal(
    goal: typeof agentGoals.$inferSelect,
    result: GoalDispatchResult,
  ): Promise<GoalDispatchOutcome> {
    // Stamped BEFORE the claim, and for every outcome including `LEASE_HELD`
    // (R3.3). The rotation has to record "this pass looked here", not "this pass
    // succeeded here" — otherwise a goal that always skips keeps its place at the
    // front and the goals behind it are never reached.
    await this.markConsidered(goal.id);

    const token = await this.claimGoal(goal.id);
    if (!token) {
      result.skipped += 1;
      return { goalId: goal.id, action: 'skip', reason: 'LEASE_HELD' };
    }
    try {
      return await this.advanceClaimedGoal(goal, result, token);
    } finally {
      // Releases only if this token is still the holder, so a pass that ran past
      // its lease cannot take the next holder's away.
      await this.releaseGoalLease(goal.id, token);
    }
  }

  private async advanceClaimedGoal(
    goal: typeof agentGoals.$inferSelect,
    result: GoalDispatchResult,
    leaseToken: string,
  ): Promise<GoalDispatchOutcome> {
    const metadata = (goal.metadata ?? {}) as Record<string, unknown>;
    const fingerprint = goal.driftFingerprint;
    if (!fingerprint || !goal.intentId) {
      result.blocked += 1;
      await this.blockGoal(goal.id, 'MISSING_LINEAGE');
      return { goalId: goal.id, action: 'block', reason: 'MISSING_LINEAGE' };
    }

    const [drift] = await this.deps.db
      .select()
      .from(contentDrifts)
      .where(
        and(
          eq(contentDrifts.siteId, this.deps.siteId),
          eq(contentDrifts.fingerprint, fingerprint),
        ),
      )
      .limit(1);

    const [latestRun] = await this.deps.db
      .select({
        id: agentRuns.id,
        status: agentRuns.status,
        metrics: agentRuns.metrics,
        createdAt: agentRuns.createdAt,
      })
      .from(agentRuns)
      .where(and(eq(agentRuns.siteId, this.deps.siteId), eq(agentRuns.goalId, goal.id)))
      .orderBy(desc(agentRuns.createdAt))
      .limit(1);

    const repair = drift
      ? repairArgumentsForDrift({
          ruleType: drift.ruleType,
          ruleKey: drift.ruleKey,
          itemId: drift.itemId,
          collection: String(metadata['collection'] ?? ''),
          fingerprint,
          detail: (drift.detail ?? null) as Record<string, unknown> | null,
        })
      : null;

    const phaseRaw = metadata['repairPhase'];
    const repairPhase: RepairPhase | null =
      phaseRaw === 'drafting' || phaseRaw === 'promoting' ? phaseRaw : null;

    const latestStopReason = latestRun
      ? ((latestRun.metrics ?? {}) as Record<string, unknown>)['stopReason']
      : null;

    const now = this.deps.now?.() ?? new Date();
    const queuedRunAgeMs =
      latestRun?.status === 'queued' && latestRun.createdAt
        ? now.getTime() - new Date(latestRun.createdAt).getTime()
        : undefined;

    const decision = decideGoalAction({
      latestRunStatus: latestRun?.status ?? null,
      latestRunStopReason: typeof latestStopReason === 'string' ? latestStopReason : null,
      queuedRunAgeMs,
      repairPhase,
      draftExists: repair ? await this.draftBranchExists(repair) : false,
      driftStatus: drift?.status ?? null,
    });

    switch (decision.action) {
      case 'skip':
        result.skipped += 1;
        return { goalId: goal.id, action: 'skip', reason: decision.reason };

      case 'block':
        result.blocked += 1;
        await this.blockGoal(goal.id, decision.reason);
        return { goalId: goal.id, action: 'block', reason: decision.reason };

      case 'complete':
        result.completed += 1;
        await this.completeGoal(goal.id);
        return { goalId: goal.id, action: 'complete' };

      case 'verify':
        return this.verifyGoal(goal, result);

      case 'dispatch_draft':
      case 'dispatch_promote': {
        if (!repair) {
          // Only translation drift has a wired repair path. Saying so on the
          // goal is the point: a silent skip would leave the drift assigned to a
          // goal nothing will ever advance, which is the bug this service fixes.
          result.blocked += 1;
          await this.blockGoal(goal.id, 'NO_REPAIR_SKILL');
          return { goalId: goal.id, action: 'block', reason: 'NO_REPAIR_SKILL' };
        }
        if (!this.deps.queue) {
          // Missing queue adapter is a runtime property, not a goal defect, so
          // the goal is left untouched and the caller is told plainly. Blocking
          // here would need a manual unblock on every goal once a queue exists.
          result.skipped += 1;
          result.queueUnavailable = true;
          return { goalId: goal.id, action: 'skip', reason: 'ASYNC_UNAVAILABLE' };
        }
        return this.dispatchPhase(
          goal,
          repair,
          decision.action === 'dispatch_draft' ? 'drafting' : 'promoting',
          result,
          leaseToken,
        );
      }
    }
  }

  /** True when the deterministic draft branch exists for this drift. */
  private async draftBranchExists(repair: RepairArguments): Promise<boolean> {
    const [collection] = await this.deps.db
      .select({ id: collections.id })
      .from(collections)
      .where(
        and(
          eq(collections.siteId, this.deps.siteId),
          eq(collections.name, repair.collection),
        ),
      )
      .limit(1);
    if (!collection) return false;
    const [row] = await this.deps.db
      .select({ id: contentVersions.id })
      .from(contentVersions)
      .where(
        and(
          eq(contentVersions.siteId, this.deps.siteId),
          eq(contentVersions.collectionId, collection.id),
          eq(contentVersions.itemId, repair.itemId),
          eq(contentVersions.key, repair.versionKey),
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  private async dispatchPhase(
    goal: typeof agentGoals.$inferSelect,
    repair: RepairArguments,
    phase: RepairPhase,
    result: GoalDispatchResult,
    leaseToken: string,
  ): Promise<GoalDispatchOutcome> {
    const [intent] = await this.deps.db
      .select({
        id: contentIntents.id,
        status: contentIntents.status,
        autonomyCap: contentIntents.autonomyCap,
        budget: contentIntents.budget,
      })
      .from(contentIntents)
      .where(
        and(
          eq(contentIntents.siteId, this.deps.siteId),
          eq(contentIntents.id, goal.intentId!),
        ),
      )
      .limit(1);
    if (!intent || intent.status !== 'active') {
      // A paused or errored intent must not keep spawning work. The breaker in
      // ReconcilerService flips the intent to `error`; honouring that here is
      // what makes the breaker effective for dispatch too, not just for goal
      // creation.
      result.skipped += 1;
      return { goalId: goal.id, action: 'skip', reason: 'INTENT_NOT_ACTIVE' };
    }

    const agentRole = goal.agentRole ?? goal.assigneeAgent;
    // The intent's budget travels with the run. `maxWritesPerMinute` is read from
    // `envelope.budget` inside the harness, so leaving it behind would store the
    // limit on the intent and enforce it nowhere.
    const budget = (intent.budget ?? {}) as Record<string, unknown>;

    // FENCE, INSIDE the transaction that writes (#481 R3.2).
    //
    // The previous version checked `holdsGoalLease` with a SELECT and then wrote
    // outside it — check-then-write, with the same race one level down. Measured:
    // A passed the check, B's clock advanced past A's lease, B claimed and
    // dispatched, A resumed and inserted anyway → **two runs, two jobs for one
    // goal/phase**. A second SELECT before the enqueue would not have helped; the
    // gap is structural, not a matter of checking more often.
    //
    // So the lease check and every write it authorises happen while this
    // transaction holds the goal row: `SELECT … FOR UPDATE` blocks the other
    // dispatcher at the row lock, and whichever gets it second reads the lease the
    // winner installed and leaves. The enqueue stays outside the transaction on
    // purpose — a queue call cannot be rolled back, so it must not run before the
    // rows it refers to are committed.
    const prepared = await withLockTimeout<AgentRunContext | null>(this.deps.db, async (tx) => {
      const now = this.deps.now?.() ?? new Date();
      const [locked] = await tx
        .select({
          leaseBy: agentGoals.dispatchLeaseBy,
          leaseUntil: agentGoals.dispatchLeaseUntil,
        })
        .from(agentGoals)
        .where(and(eq(agentGoals.siteId, this.deps.siteId), eq(agentGoals.id, goal.id)))
        // SKIP LOCKED, not a plain FOR UPDATE: if another dispatcher is inside this
        // section for the same goal, the right answer is "not now", not "wait".
        // Measured with a plain lock, the reviewer's interleaving probe stopped
        // making progress at all — the second caller blocked until the first
        // finished, which for a cron tick means the whole pass stalls behind one
        // goal. Skipping returns no row, which lands in the same `LEASE_LOST` exit
        // the lease check uses.
        .for('update', { skipLocked: true });

      if (
        !locked ||
        locked.leaseBy !== leaseToken ||
        !locked.leaseUntil ||
        locked.leaseUntil.getTime() <= now.getTime()
      ) {
        return null;
      }

      const txRunService = new AgentRunService(
        tx as unknown as Database,
        this.deps.siteId,
        this.deps.queue,
      );

      // Settle a run whose job was lost before creating its replacement (R4).
      // Leaving it `queued` would keep an unexecutable row in the goal's history and
      // make "is anything in flight" ambiguous for every later pass. `cancelled` with
      // an explicit reason says what happened; it is not a failure the operator has
      // to act on, so it must not be `failed`.
      const [orphan] = await tx
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.siteId, this.deps.siteId),
            eq(agentRuns.goalId, goal.id),
            eq(agentRuns.status, 'queued'),
          ),
        )
        .limit(1);
      if (orphan) {
        await txRunService.cancelRun(orphan.id, 'dispatch_lost');
      }

      const created = await txRunService.ensureRun({
        goalId: goal.id,
        agentName: agentRole,
        status: 'queued',
        origin: 'reconciler',
        intentId: intent.id,
        autonomyCap: intent.autonomyCap,
        agentRole,
        budget,
      });

      // Phase is recorded in the SAME transaction as the run. If this commits, the
      // next pass sees a phase with a matching run; if it rolls back, it sees
      // neither. Previously these were separate statements, so a crash between
      // them left a phase with no run — or a run with no phase, which the next
      // pass would answer by dispatching a second draft for the same drift.
      await this.setGoalMetadata(
        goal.id,
        {
          repairPhase: phase,
          draftVersionKey: repair.versionKey,
          dispatchedAt: now.toISOString(),
          blockedReason: null,
        },
        tx as unknown as Database,
      );
      await tx
        .update(agentGoals)
        .set({ status: 'in_progress', updatedAt: now })
        .where(and(eq(agentGoals.siteId, this.deps.siteId), eq(agentGoals.id, goal.id)));

      return created;
    }, null);

    if (!prepared) {
      result.skipped += 1;
      return { goalId: goal.id, action: 'skip', reason: 'LEASE_LOST' };
    }

    const runService = new AgentRunService(this.deps.db, this.deps.siteId, this.deps.queue);
    const run = prepared;

    const payload: AgentRunJobPayload =
      phase === 'drafting'
        ? {
            siteId: this.deps.siteId,
            goalId: goal.id,
            runId: run.runId,
            skillName: 'repairTranslation',
            arguments: {
              collection: repair.collection,
              itemId: repair.itemId,
              field: repair.field,
              locale: repair.locale,
              versionKey: repair.versionKey,
            },
            origin: 'reconciler',
            intentId: intent.id,
            driftFingerprint: goal.driftFingerprint,
            autonomyCap: intent.autonomyCap,
            agentRole,
            budget,
            contextMessage: goal.description ?? undefined,
          }
        : {
            siteId: this.deps.siteId,
            goalId: goal.id,
            runId: run.runId,
            skillName: 'promoteVersion',
            arguments: {
              collection: repair.collection,
              itemId: repair.itemId,
              key: repair.versionKey,
            },
            origin: 'reconciler',
            intentId: intent.id,
            driftFingerprint: goal.driftFingerprint,
            autonomyCap: intent.autonomyCap,
            agentRole,
            budget,
            contextMessage: goal.description ?? undefined,
          };

    try {
      await this.deps.queue!.enqueue(AGENT_RUNS_QUEUE, 'execute', payload);
    } catch (error) {
      // A queue that accepted the run row but refused the job would otherwise
      // leave the run `queued` with nothing to pick it up. Settle both sides.
      const message = error instanceof Error ? error.message : String(error);
      await runService.failRun(run.runId, `enqueue failed: ${message}`, {
        stopReason: 'enqueue_failed',
      });
      await this.blockGoal(goal.id, 'ENQUEUE_FAILED');
      result.blocked += 1;
      return { goalId: goal.id, action: 'block', reason: 'ENQUEUE_FAILED', runId: run.runId };
    }

    result.dispatched += 1;
    return {
      goalId: goal.id,
      action: phase === 'drafting' ? 'dispatch_draft' : 'dispatch_promote',
      runId: run.runId,
    };
  }

  /**
   * Re-evaluates the drift after a promote and settles the goal on the result.
   *
   * This is the "only verified content re-evaluation resolves the drift" rule:
   * the goal does not complete because a promote succeeded, it completes because
   * a fresh scan can no longer find the violation.
   */
  private async verifyGoal(
    goal: typeof agentGoals.$inferSelect,
    result: GoalDispatchResult,
  ): Promise<GoalDispatchOutcome> {
    const { DriftService } = await import('./drift-service');
    const drift = new DriftService({ db: this.deps.db, siteId: this.deps.siteId });
    try {
      await drift.scanIntent(goal.intentId!);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.blockGoal(goal.id, `VERIFY_SCAN_FAILED: ${message}`.slice(0, 200));
      result.blocked += 1;
      return { goalId: goal.id, action: 'block', reason: 'VERIFY_SCAN_FAILED' };
    }

    const [after] = await this.deps.db
      .select({ status: contentDrifts.status })
      .from(contentDrifts)
      .where(
        and(
          eq(contentDrifts.siteId, this.deps.siteId),
          eq(contentDrifts.fingerprint, goal.driftFingerprint!),
        ),
      )
      .limit(1);

    if (after?.status === 'resolved') {
      await this.completeGoal(goal.id);
      result.completed += 1;
      return { goalId: goal.id, action: 'complete' };
    }

    // Content was published and the violation is still there. Reporting success
    // here would be the worst outcome available: the drift would look repaired
    // while the reader still sees a missing translation.
    await this.blockGoal(goal.id, 'VERIFY_FAILED');
    result.blocked += 1;
    return { goalId: goal.id, action: 'block', reason: 'VERIFY_FAILED' };
  }

  private async completeGoal(goalId: string): Promise<void> {
    await this.setGoalMetadata(goalId, { blockedReason: null, completedAt: new Date().toISOString() });
    await this.deps.db
      .update(agentGoals)
      .set({ status: 'done', updatedAt: new Date() })
      .where(and(eq(agentGoals.siteId, this.deps.siteId), eq(agentGoals.id, goalId)));
  }

  private async blockGoal(goalId: string, reason: string): Promise<void> {
    await this.setGoalMetadata(goalId, { blockedReason: reason });
    await this.deps.db
      .update(agentGoals)
      .set({ status: 'blocked', updatedAt: new Date() })
      .where(and(eq(agentGoals.siteId, this.deps.siteId), eq(agentGoals.id, goalId)));
  }

  /**
   * Merges keys into `metadata`; a null value removes the key.
   *
   * @param db optional transaction handle, so a dispatch can record the phase in
   *   the same atomic unit as the run it describes (#481 R3.2)
   */
  private async setGoalMetadata(
    goalId: string,
    patch: Record<string, unknown>,
    db: Database = this.deps.db,
  ): Promise<void> {
    const [goal] = await db
      .select({ metadata: agentGoals.metadata })
      .from(agentGoals)
      .where(and(eq(agentGoals.siteId, this.deps.siteId), eq(agentGoals.id, goalId)))
      .limit(1);
    const merged: Record<string, unknown> = { ...((goal?.metadata ?? {}) as Record<string, unknown>) };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete merged[key];
      else merged[key] = value;
    }
    await db
      .update(agentGoals)
      .set({ metadata: merged, updatedAt: new Date() })
      .where(and(eq(agentGoals.siteId, this.deps.siteId), eq(agentGoals.id, goalId)));
  }
}

export interface GoalDispatchTickResult {
  sites: number;
  dispatched: number;
  completed: number;
  skipped: number;
  blocked: number;
}

/**
 * One dispatch pass across every tenant that has pending reconciler goals.
 *
 * Driven by cron on the Node/Docker runtime. Site discovery is derived from the
 * goals themselves rather than from the site list: a deployment with thousands
 * of tenants should touch only the ones with work waiting, and a tenant whose
 * goals are all settled costs nothing.
 *
 * Never throws — a single tenant's failure must not stop the others, and a cron
 * callback that rejects takes the tick down with it.
 */
export async function runGoalDispatchTick(deps: {
  db: Database;
  queue?: QueueProvider;
  limitPerSite?: number;
  /**
   * Max tenants inspected per tick.
   *
   * A per-tick budget, not a cutoff: tenants are visited least-recently-considered
   * first, so a deployment with more sites than this reaches the rest on later
   * ticks. Raising it makes each tick do more work; it is not required for
   * correctness (R3.3).
   */
  sitesLimit?: number;
  /** Clock seam, so rotation can be exercised without waiting. */
  now?: () => Date;
}): Promise<GoalDispatchTickResult> {
  const summary: GoalDispatchTickResult = {
    sites: 0,
    dispatched: 0,
    completed: 0,
    skipped: 0,
    blocked: 0,
  };
  const now = deps.now?.() ?? new Date();

  // Only sites with DISPATCHABLE goals, and ordered so the walk is stable
  // (reviewer R5). The previous query listed every site that had ever had a
  // reconciler goal, capped at 500 with no ordering and no pagination — so on a
  // deployment past that many tenants, whichever sites the planner happened to
  // return were the only ones ever served, and a tenant outside that set was
  // never dispatched at all.
  //
  // Filtering by status shrinks the set to sites with actual work, which is what
  // makes the cap a practical non-issue rather than a silent cutoff; ordering
  // makes the remainder deterministic instead of planner-dependent. `sitesLimit`
  // is exposed so an operator who does exceed it can raise it knowingly.
  const rows = await deps.db
    .select({
      siteId: agentGoals.siteId,
      // The tenant's rotation key: how long its least recently considered goal has
      // been waiting. A site that was just served sorts last.
      oldestAttempt: sql<Date | null>`min(${agentGoals.dispatchAttemptedAt})`,
    })
    .from(agentGoals)
    .where(
      and(
        eq(agentGoals.origin, 'reconciler'),
        inArray(agentGoals.status, DISPATCHABLE_GOAL_STATUSES),
        // Same rules as the per-site query: a tenant whose only reconciler goals
        // are waiting on a human, or belong to a paused intent, is not "work
        // waiting", and counting it against `sitesLimit` is how tenants past the
        // cap were starved (F5 / R3.3).
        noRunInFlight(now),
        intentDispatchable(),
      ),
    )
    .groupBy(agentGoals.siteId)
    // ROTATION across tenants (R3.3). Ordering by siteId meant the first
    // `sitesLimit` tenants alphabetically were the only ones ever served: with
    // `sitesLimit = 1` two consecutive ticks both visited the same site and the
    // other never ran. Least-recently-considered first, nulls (never considered)
    // ahead of everything, `siteId` only as a deterministic tie-break.
    .orderBy(sql`min(${agentGoals.dispatchAttemptedAt}) asc nulls first`, asc(agentGoals.siteId))
    .limit(Math.max(1, Math.trunc(deps.sitesLimit ?? 500)));

  for (const row of rows) {
    const service = new GoalDispatchService({
      db: deps.db,
      siteId: row.siteId,
      ...(deps.queue ? { queue: deps.queue } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });
    try {
      const result = await service.dispatchReconcilerGoals(deps.limitPerSite ?? 25);
      summary.sites += 1;
      summary.dispatched += result.dispatched;
      summary.completed += result.completed;
      summary.skipped += result.skipped;
      summary.blocked += result.blocked;
    } catch (error) {
      console.error(
        '[goal-dispatch] site pass failed',
        JSON.stringify({ siteId: row.siteId, error: error instanceof Error ? error.message : String(error) }),
      );
    }
  }
  return summary;
}
