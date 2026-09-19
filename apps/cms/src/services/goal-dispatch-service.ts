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
import { and, desc, eq } from 'drizzle-orm';
import { AgentRunService } from './agent-run-service';
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
  constructor(private readonly deps: GoalDispatchServiceDeps) {}

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

    const goals = await this.deps.db
      .select()
      .from(agentGoals)
      .where(
        and(
          eq(agentGoals.siteId, this.deps.siteId),
          eq(agentGoals.origin, 'reconciler'),
        ),
      )
      .orderBy(desc(agentGoals.createdAt))
      .limit(Math.max(1, Math.trunc(limit)) * 4);

    const pending = goals.filter((goal) => goal.status === 'open' || goal.status === 'in_progress');

    for (const goal of pending.slice(0, Math.max(1, Math.trunc(limit)))) {
      const outcome = await this.advanceGoal(goal, result);
      result.outcomes.push(outcome);
    }
    return result;
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

  private async advanceGoal(
    goal: typeof agentGoals.$inferSelect,
    result: GoalDispatchResult,
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
      .select({ id: agentRuns.id, status: agentRuns.status, metrics: agentRuns.metrics })
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

    const decision = decideGoalAction({
      latestRunStatus: latestRun?.status ?? null,
      latestRunStopReason: typeof latestStopReason === 'string' ? latestStopReason : null,
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

    const runService = new AgentRunService(this.deps.db, this.deps.siteId, this.deps.queue);
    const agentRole = goal.agentRole ?? goal.assigneeAgent;
    // The intent's budget travels with the run. `maxWritesPerMinute` is read from
    // `envelope.budget` inside the harness, so leaving it behind would store the
    // limit on the intent and enforce it nowhere.
    const budget = (intent.budget ?? {}) as Record<string, unknown>;
    const run = await runService.ensureRun({
      goalId: goal.id,
      agentName: agentRole,
      status: 'queued',
      origin: 'reconciler',
      intentId: intent.id,
      autonomyCap: intent.autonomyCap,
      agentRole,
      budget,
    });

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

    // Phase is recorded BEFORE the enqueue. If the process dies between the two,
    // the next pass sees `drafting` with no active run and blocks with a reason
    // a human can act on. Recording it after would leave phase null, and the
    // next pass would dispatch a second draft for the same drift.
    await this.setGoalMetadata(goal.id, {
      repairPhase: phase,
      draftVersionKey: repair.versionKey,
      dispatchedAt: new Date().toISOString(),
      blockedReason: null,
    });
    await this.deps.db
      .update(agentGoals)
      .set({ status: 'in_progress', updatedAt: new Date() })
      .where(and(eq(agentGoals.siteId, this.deps.siteId), eq(agentGoals.id, goal.id)));

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

  /** Merges keys into `metadata`; a null value removes the key. */
  private async setGoalMetadata(goalId: string, patch: Record<string, unknown>): Promise<void> {
    const [goal] = await this.deps.db
      .select({ metadata: agentGoals.metadata })
      .from(agentGoals)
      .where(and(eq(agentGoals.siteId, this.deps.siteId), eq(agentGoals.id, goalId)))
      .limit(1);
    const merged: Record<string, unknown> = { ...((goal?.metadata ?? {}) as Record<string, unknown>) };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete merged[key];
      else merged[key] = value;
    }
    await this.deps.db
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
}): Promise<GoalDispatchTickResult> {
  const summary: GoalDispatchTickResult = {
    sites: 0,
    dispatched: 0,
    completed: 0,
    skipped: 0,
    blocked: 0,
  };

  const rows = await deps.db
    .selectDistinct({ siteId: agentGoals.siteId })
    .from(agentGoals)
    .where(eq(agentGoals.origin, 'reconciler'))
    .limit(500);

  for (const row of rows) {
    const service = new GoalDispatchService({
      db: deps.db,
      siteId: row.siteId,
      ...(deps.queue ? { queue: deps.queue } : {}),
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
