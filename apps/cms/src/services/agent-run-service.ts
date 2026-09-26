import {
  activity,
  agentGoals,
  agentRuns,
  agentToolCalls,
  contentIntents,
  type Database,
} from '@lumibase/database';
import type { QueueProvider } from '@lumibase/runtime';
import { and, asc, desc, eq, inArray, isNotNull, lt, or, sql } from 'drizzle-orm';
import type { AgentNotifier } from '../modules/notifications/agent-notifications';
import type { ApprovalRequester } from './approval-requester';
import type { AgentRunJobPayload } from './agent-run-worker';
import type { AuthenticatedPrincipalRef } from './effective-capability-service';
import {
  agentDeadLettersTotal,
  agentRunsTotal,
  agentToolLatency,
  observeAgentCost,
} from './agent-metrics';

/**
 * How long a `running` run may go without finishing before it is treated as
 * abandoned and quarantined for a human.
 *
 * ## What this threshold does NOT authorise (#481 R3.1)
 *
 * It used to let another delivery **take over** such a run and execute the skill
 * again. Time cannot support that conclusion: a process can die *after* the
 * content write and *before* the terminal run row is saved, and the run then looks
 * identical to one that never did anything. Measured on Postgres with a fault
 * injected in exactly that window — one item written, run left `running`, age
 * pushed past this threshold, same job redelivered: **two items**. The CAS claim
 * stopped duplicate execution within seconds of each other and then this branch
 * reintroduced it fifteen minutes later.
 *
 * So the threshold now only decides when a run stops being believed to be alive.
 * An abandoned run is moved to `failed` with a reason an operator can act on
 * ({@link quarantineStaleRuns}); it is never replayed automatically, because
 * nothing here can prove the first attempt had no side effect.
 *
 * Fifteen minutes is far beyond any observed run (the harness caps tool calls and
 * the LLM has its own timeouts) and far below "forever".
 */
export const RUN_STALE_MS = 15 * 60_000;

/** `metrics.stopReason` for a run abandoned mid-flight; needs a human. */
export const STALE_RUN_STOP_REASON = 'stale_unverified';

export interface AgentRunEnvelope {
  goalId?: string;
  runId?: string;
  agentName?: string;
  provider?: string;
  model?: string;
  budget?: Record<string, unknown>;
  policySnapshotHash?: string;
  createdBy?: string | null;
  title?: string;
  contextMessage?: string;
  /**
   * Initial run status. `queued` is used by async execution — the run is
   * created immediately and picked up by a queue worker (Req 3.1/3.2).
   */
  status?: 'running' | 'queued';
  /**
   * Work origin (`user` | `reconciler` | …). Backpressure pauses
   * reconciler-origin work only — human-triggered runs are never
   * auto-paused (Req 9.4).
   */
  origin?: string;
  /** Governing content intent, when reconciler-originated (write budget scope). */
  intentId?: string;
  /** Autonomy ceiling from the governing intent (resolver input, Req 7.2). */
  autonomyCap?: number;
  /**
   * Role from the agent_roles library executing this run (Module C). When
   * set, the Harness narrows capabilities to role ∩ grant (Req 10.4).
   */
  agentRole?: string;
  /**
   * Who asked for this work, as a re-resolvable reference (#472).
   *
   * Recorded on any approval this run parks, so the requester's CURRENT rights
   * are re-read when a human finally approves — a revoked key or a demoted user
   * must not still get their parked action executed under the decider's rights.
   * Carries no capabilities on purpose; see `services/approval-requester.ts`.
   */
  requestedByPrincipal?: ApprovalRequester | null;
}

export interface AgentRunContext {
  goalId: string;
  runId: string;
  agentName: string;
}

export interface ToolCallInput {
  runId: string;
  toolName: string;
  input: Record<string, unknown>;
  status?: string;
  risk?: string;
  approvalId?: string | null;
}

const SECRET_KEY_RE = /(secret|token|password|api[_-]?key|authorization|credential)/i;

/** What {@link maskSecrets} writes in place of a secret-looking value. */
const MASKED_VALUE = '[masked]';

export function maskSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => maskSecrets(entry));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      SECRET_KEY_RE.test(key) ? MASKED_VALUE : maskSecrets(entry),
    ]),
  );
}

/** True when {@link maskSecrets} replaced something inside `value`. */
function containsMaskedValue(value: unknown): boolean {
  if (value === MASKED_VALUE) return true;
  if (Array.isArray(value)) return value.some((entry) => containsMaskedValue(entry));
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((entry) => containsMaskedValue(entry));
  }
  return false;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Postgres `unique_violation` (23505), possibly wrapped by drizzle. */
function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  const causeCode = (error as { cause?: { code?: unknown } })?.cause?.code;
  return code === '23505' || causeCode === '23505';
}

/** Postgres `lock_not_available` (55P03), possibly wrapped by drizzle. */
function isLockTimeout(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  const causeCode = (error as { cause?: { code?: unknown } })?.cause?.code;
  return code === '55P03' || causeCode === '55P03';
}

/**
 * Run states a human may retry: settled, and not successfully.
 *
 * `succeeded` is excluded on purpose. Retrying a success is "do it again", which
 * repeats a side effect that is known to have happened; that is a new request, not
 * a retry. Everything non-terminal is excluded because work may still be happening
 * under it.
 */
const RETRYABLE_RUN_STATES: readonly string[] = ['failed', 'cancelled'];

/** Run states in which work may still happen — the dispatcher's "in flight". */
const IN_FLIGHT_RUN_STATES = ['queued', 'running', 'awaiting_approval'];

/** Goal states after which nobody is waiting for another attempt. */
const CLOSED_GOAL_STATES = ['done', 'completed', 'failed'];

/**
 * How long a retry waits for the goal row lock.
 *
 * Same bound, same reason as dispatch (`DISPATCH_LOCK_TIMEOUT`): the lock is held
 * for a few statements, so reaching the bound means someone is mid-dispatch on this
 * goal, and an HTTP request must not hang behind them. Inlined into `SET LOCAL`,
 * which takes no bind parameters — a module constant, never caller input.
 */
const RETRY_LOCK_TIMEOUT = '2s';

/** Upper bound on the `retryOfRunId` walk when looking for the recorded task. */
const MAX_RETRY_CHAIN_DEPTH = 20;

/** Who is asking for a retry. The retry executes with this principal's rights. */
export interface RetryRequester {
  principal: AuthenticatedPrincipalRef;
  userId: string | null;
}

export type RetryRunRefusalCode =
  | 'NOT_FOUND'
  | 'RUN_NOT_RETRYABLE'
  | 'RUN_ACTIVE'
  | 'RETRY_SUPERSEDED'
  | 'GOAL_CLOSED'
  | 'GOAL_BUSY'
  | 'RETRY_UNRECOVERABLE'
  | 'INTENT_NOT_ACTIVE'
  | 'FROZEN'
  | 'ASYNC_UNAVAILABLE'
  | 'ENQUEUE_FAILED';

export interface RetryRunRefusal {
  ok: false;
  code: RetryRunRefusalCode;
  message: string;
}

export interface RetriedRun extends AgentRunContext {
  status: 'queued';
  retryOfRunId: string;
}

export type RetryRunResult = { ok: true; retry: RetriedRun } | RetryRunRefusal;

function refuse(code: RetryRunRefusalCode, message: string): RetryRunRefusal {
  return { ok: false, code, message };
}

/** The part of a job payload that describes WHAT to run, recovered from history. */
interface RecoveredTask {
  ok: true;
  skillName: string;
  arguments: Record<string, unknown>;
}

/** The governance envelope of a job payload, recovered from the goal and intent. */
type RecoveredGovernance = Pick<
  AgentRunJobPayload,
  'origin' | 'intentId' | 'driftFingerprint' | 'autonomyCap' | 'agentRole' | 'budget' | 'contextMessage'
> & { ok: true };

export class AgentRunService {
  constructor(
    private readonly db: Database,
    private readonly siteId: string,
    private readonly queue?: QueueProvider,
    /**
     * Optional push-notification sink (push-noti feature). When provided, run
     * completion/failure is pushed in-app / via Web Push. Best-effort.
     */
    private readonly notify?: AgentNotifier,
  ) {}

  async ensureRun(envelope: AgentRunEnvelope = {}): Promise<AgentRunContext> {
    const agentName = envelope.agentName ?? 'lumibase-copilot';

    if (envelope.goalId && envelope.runId) {
      return { goalId: envelope.goalId, runId: envelope.runId, agentName };
    }

    let goalId = envelope.goalId;
    if (!goalId) {
      const [goal] = await this.db
        .insert(agentGoals)
        .values({
          siteId: this.siteId,
          title: envelope.title ?? 'Transient agent task',
          description: envelope.contextMessage ?? null,
          source: 'api',
          createdBy: envelope.createdBy ?? null,
          assigneeAgent: agentName,
          status: 'in_progress',
          origin: envelope.origin ?? 'user',
          intentId: envelope.intentId ?? null,
          agentRole: envelope.agentRole ?? null,
          metadata: { transient: true },
        })
        .returning();
      goalId = goal!.id;
    }

    if (envelope.runId) {
      return { goalId, runId: envelope.runId, agentName };
    }

    const [run] = await this.db
      .insert(agentRuns)
      .values({
        goalId,
        siteId: this.siteId,
        agentName,
        provider: envelope.provider ?? 'local',
        model: envelope.model ?? 'tool-registry',
        budget: envelope.budget ?? {},
        policySnapshotHash: envelope.policySnapshotHash ?? null,
        status: envelope.status ?? 'running',
      })
      .returning();

    return { goalId, runId: run!.id, agentName };
  }

  async appendToolCall(input: ToolCallInput): Promise<string> {
    const [record] = await this.db
      .insert(agentToolCalls)
      .values({
        runId: input.runId,
        siteId: this.siteId,
        toolName: input.toolName,
        input: maskSecrets(input.input) as Record<string, unknown>,
        status: input.status ?? 'running',
        risk: input.risk ?? 'safe',
        approvalId: input.approvalId ?? null,
      })
      .returning();

    return record!.id;
  }

  async countToolCalls(runId: string): Promise<number> {
    const rows = await this.db
      .select({ id: agentToolCalls.id })
      .from(agentToolCalls)
      .where(and(eq(agentToolCalls.siteId, this.siteId), eq(agentToolCalls.runId, runId)))
      .limit(10_000);
    return rows.length;
  }

  async finishToolCall(
    toolCallId: string,
    patch: {
      status: 'executed' | 'pending_approval' | 'denied' | 'failed';
      output?: unknown;
      error?: string | null;
      approvalId?: string | null;
      latencyMs?: number;
      cost?: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.db
      .update(agentToolCalls)
      .set({
        status: patch.status,
        output: maskSecrets(patch.output ?? {}) as Record<string, unknown>,
        error: patch.error ?? null,
        approvalId: patch.approvalId ?? null,
        latencyMs: patch.latencyMs ?? null,
        cost: patch.cost ?? {},
        finishedAt: new Date(),
      })
      .where(
        and(
          eq(agentToolCalls.id, toolCallId),
          eq(agentToolCalls.siteId, this.siteId),
        ),
      );

    if (patch.latencyMs !== undefined) {
      agentToolLatency.observe(
        { tool: await this.toolNameForCall(toolCallId), status: patch.status },
        patch.latencyMs / 1000,
      );
    }
    observeAgentCost(await this.toolNameForCall(toolCallId), patch.cost);
  }

  async closeRun(runId: string, metrics: Record<string, unknown> = {}): Promise<void> {
    const [run] = await this.db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.siteId, this.siteId)));
    await this.db
      .update(agentRuns)
      .set({ status: 'succeeded', metrics, finishedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.siteId, this.siteId)));
    agentRunsTotal.inc({
      agent: run?.agentName ?? 'unknown',
      status: 'succeeded',
      stop_reason: String(metrics['stopReason'] ?? 'completed'),
    });
    this.notify?.({
      kind: 'run',
      severity: 'info',
      title: 'Agent run succeeded',
      body: `${run?.agentName ?? 'agent'} run completed`,
      deepLink: `/mission-control/runs`,
      entityId: runId,
    });
  }

  async failRun(runId: string, error: string, metrics: Record<string, unknown> = {}): Promise<void> {
    const [run] = await this.db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.siteId, this.siteId)));
    await this.db
      .update(agentRuns)
      .set({ status: 'failed', error, metrics, finishedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.siteId, this.siteId)));
    const stopReason = String(metrics['stopReason'] ?? 'error');
    agentRunsTotal.inc({
      agent: run?.agentName ?? 'unknown',
      status: 'failed',
      stop_reason: stopReason,
    });
    if (run) {
      await this.enqueueDeadLetterIfRepeatedFailure(run, error, stopReason);
    }
    this.notify?.({
      kind: 'run',
      severity: 'warning',
      title: 'Agent run failed',
      body: `${run?.agentName ?? 'agent'} run failed: ${error}`.slice(0, 240),
      deepLink: `/mission-control/runs`,
      entityId: runId,
    });
  }

  async getRun(runId: string) {
    const [run] = await this.db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.siteId, this.siteId)))
      .limit(1);
    return run ?? null;
  }

  /**
   * Claims a queued run for execution. Exactly one caller can succeed.
   *
   * ## Why this replaced `markRunning` on the worker path (#455 F3)
   *
   * The old helper read the status, then wrote — and it accepted `running` as a
   * valid starting point, returning `true`. Under at-least-once delivery that is
   * not a guard at all: two deliveries of the same job both saw a startable run
   * and both executed. Measured on Postgres, one job delivered twice
   * concurrently created **two items**; delivered again while the run sat in
   * `awaiting_approval` it created a **second pending approval** for the same
   * run. Comments elsewhere (including the dispatcher's) claimed the opposite,
   * so the R4 re-dispatch was resting on a property this method never had.
   *
   * One conditional UPDATE is the whole mechanism: the row lock serializes the
   * two deliveries and the loser's `WHERE` no longer matches.
   *
   * ## `queued` only, and why a stale `running` is not claimable (#481 R3.1)
   *
   * An earlier version also accepted a `running` row older than
   * {@link RUN_STALE_MS}, to recover from a crashed worker. That reopened the hole
   * it had just closed: a process can die after the content write and before the
   * terminal status is saved, so age says nothing about whether the skill already
   * had an effect. Measured: fault injected in that window, age pushed past the
   * threshold, job redelivered — the item was written **twice**.
   *
   * A `queued` run is different in kind, not degree: nothing has executed under
   * it yet (the worker's first action is this claim), so re-delivering it cannot
   * repeat a side effect. Abandoned `running` rows are handled by
   * {@link quarantineStaleRuns}, which asks a human instead of guessing.
   *
   * `awaiting_approval` is deliberately NOT claimable here: resuming a parked run
   * is the approval flow's job ({@link resumeApprovedRun}), and letting a queue
   * redelivery do it is exactly how the duplicate approval appeared.
   */
  async claimQueuedRun(runId: string): Promise<boolean> {
    const now = new Date();
    const claimed = await this.db
      .update(agentRuns)
      .set({ status: 'running', startedAt: now, updatedAt: now })
      .where(
        and(
          eq(agentRuns.id, runId),
          eq(agentRuns.siteId, this.siteId),
          eq(agentRuns.status, 'queued'),
        ),
      )
      .returning({ id: agentRuns.id });
    return claimed.length > 0;
  }

  /**
   * Moves abandoned `running` runs to `failed` so a human can decide about them.
   *
   * This is the other half of refusing to replay (#481 R3.1). Without it, a run
   * whose worker died would stay `running` forever: invisible to the dispatcher
   * (which reads it as in-flight) and invisible in the inbox (which shows
   * pending decisions). Quarantining makes the ambiguity a visible state with a
   * name — `stopReason: 'stale_unverified'` — rather than an automatic retry.
   *
   * `failed` and not `cancelled`: a lost *job* is nobody's decision and is
   * cancelled (see the dispatcher's `dispatch_lost`), but a run that started and
   * vanished may well have changed data. That needs looking at, which is what
   * `failed` means everywhere else in this service.
   *
   * One conditional UPDATE per row set, so two sweepers cannot both claim the
   * same run, and a run that finishes between the read and the write is left
   * alone.
   *
   * @param limit maximum rows quarantined per pass
   * @returns the runs that were quarantined
   */
  async quarantineStaleRuns(
    limit = 50,
    now: Date = new Date(),
  ): Promise<{ runId: string; goalId: string | null; agentName: string }[]> {
    const staleBefore = new Date(now.getTime() - RUN_STALE_MS);
    const candidates = await this.db
      .select({ id: agentRuns.id, goalId: agentRuns.goalId, agentName: agentRuns.agentName })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.siteId, this.siteId),
          eq(agentRuns.status, 'running'),
          // A `running` row with no `startedAt` cannot be aged, so it is left
          // alone rather than assumed stale — fail-closed on a shape that should
          // not occur.
          isNotNull(agentRuns.startedAt),
          lt(agentRuns.startedAt, staleBefore),
        ),
      )
      .limit(Math.max(1, Math.trunc(limit)));

    const quarantined: { runId: string; goalId: string | null; agentName: string }[] = [];
    for (const candidate of candidates) {
      const [row] = await this.db
        .update(agentRuns)
        .set({
          status: 'failed',
          finishedAt: now,
          updatedAt: now,
          error:
            'Run was abandoned while executing: it exceeded the stale window without ' +
            'reaching a terminal state. It is NOT retried automatically because its ' +
            'side effects cannot be verified — inspect the tool calls, then retry or cancel.',
          metrics: sql`coalesce(${agentRuns.metrics}, '{}'::jsonb) || ${JSON.stringify({
            stopReason: STALE_RUN_STOP_REASON,
            quarantinedAt: now.toISOString(),
          })}::jsonb`,
        })
        .where(
          and(
            eq(agentRuns.id, candidate.id),
            eq(agentRuns.siteId, this.siteId),
            // Re-checked in the write: the run may have finished normally in the
            // meantime, and overwriting a real outcome would be worse than
            // leaving it.
            eq(agentRuns.status, 'running'),
          ),
        )
        .returning({ id: agentRuns.id });
      if (row) {
        quarantined.push({
          runId: candidate.id,
          goalId: candidate.goalId,
          agentName: candidate.agentName,
        });
      }
    }
    return quarantined;
  }

  /**
   * Resumes a run that was parked for approval.
   *
   * Separate from {@link claimQueuedRun} because the legitimate transition is
   * `awaiting_approval → running` and the caller is the approval decision, not a
   * queue delivery. Also a conditional UPDATE, so two concurrent approve clicks
   * cannot both resume the same run (the approval claim in `agent_approvals`
   * already serializes the decision; this is the second door on the same lock).
   */
  async resumeApprovedRun(runId: string): Promise<boolean> {
    const now = new Date();
    const resumed = await this.db
      .update(agentRuns)
      .set({ status: 'running', updatedAt: now })
      .where(
        and(
          eq(agentRuns.id, runId),
          eq(agentRuns.siteId, this.siteId),
          or(eq(agentRuns.status, 'awaiting_approval'), eq(agentRuns.status, 'running')),
        ),
      )
      .returning({ id: agentRuns.id });
    return resumed.length > 0;
  }

  /** Parks a run while a dangerous action waits for an approval (Req 3.1). */
  async awaitApproval(runId: string): Promise<void> {
    await this.db
      .update(agentRuns)
      .set({ status: 'awaiting_approval', updatedAt: new Date() })
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.siteId, this.siteId)));
  }

  /**
   * Cancels a non-terminal run. Cancellation takes effect at the next
   * tool-call boundary — the harness re-checks the status before every
   * tool call (Req 3.5). Returns the updated run, or null when the run is
   * missing or already terminal.
   */
  async cancelRun(runId: string, reason = 'cancelled_by_user') {
    const run = await this.getRun(runId);
    if (!run || !['queued', 'running', 'awaiting_approval'].includes(run.status)) {
      return null;
    }
    const metrics = {
      ...(run.metrics as Record<string, unknown>),
      stopReason: reason,
    };
    const [updated] = await this.db
      .update(agentRuns)
      .set({ status: 'cancelled', metrics, finishedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.siteId, this.siteId)))
      .returning();
    agentRunsTotal.inc({
      agent: run.agentName,
      status: 'cancelled',
      stop_reason: reason,
    });
    return updated ?? null;
  }

  /** True when the run was cancelled (checked at tool-call boundaries). */
  async isCancelled(runId: string): Promise<boolean> {
    const run = await this.getRun(runId);
    return run?.status === 'cancelled';
  }

  /**
   * Re-executes a failed or cancelled run as a NEW run, on the queue path.
   *
   * ## What was broken
   *
   * This used to insert a row with `status: 'running'` and return. Nothing was
   * enqueued, so nothing executed; and because the row was `running`, not `queued`,
   * the worker's claim ({@link claimQueuedRun}) could never have taken it even if a
   * job had existed. The API answered 201 with a run id, the run sat `running`
   * until the stale sweep quarantined it as `failed` fifteen minutes later, and a
   * goal with a live run behind it could not be dispatched in the meantime.
   *
   * ## Why a retry is allowed to re-execute at all (#455 / #481 R3.1)
   *
   * An abandoned run is never replayed automatically, because nothing can prove the
   * first attempt had no side effect. A human who has inspected the tool calls and
   * asks for a retry is the sanctioned way past that — the quarantine message tells
   * them exactly that. So this method does not guess about the old run's effects;
   * it guarantees that ONE request produces AT MOST ONE new execution:
   *
   * - the retry row is inserted `queued`, so the worker's CAS claim owns the
   *   transition to `running` and a redelivered job is a no-op;
   * - the goal row is locked (`FOR UPDATE`) while deciding, so two concurrent
   *   retries serialize and the second sees the first's row;
   * - only the goal's LATEST attempt can be retried and only while nothing on the
   *   goal is in flight, so a run is retried at most once and double-clicks refuse;
   * - `agent_runs_one_active_per_goal_idx` backs all of that at the storage layer.
   *
   * ## Where the task comes from
   *
   * The job payload was never persisted. The harness records exactly what it
   * executed as the run's first tool call (`toolName` = skill, `input` = arguments),
   * so that is the source — walking `retryOfRunId` when an attempt was refused
   * before reaching the harness. Inputs are stored through {@link maskSecrets};
   * a masked value cannot be replayed faithfully, so that refuses rather than
   * sending `'[masked]'` into a skill. The governance envelope is re-derived from
   * the goal and its intent the same way dispatch builds it.
   *
   * ## Whose authority
   *
   * The requester's, re-resolved by the worker at pickup (#472). The original
   * requester's grant is not stored and must not be borrowed. For role-scoped work
   * the harness still narrows to role ∩ requester, and the intent's autonomy cap
   * still applies, so a retry can never exceed either.
   */
  async retryRun(runId: string, requester: RetryRequester): Promise<RetryRunResult> {
    const original = await this.getRun(runId);
    if (!original) {
      return refuse('NOT_FOUND', 'Run not found');
    }
    if (!RETRYABLE_RUN_STATES.includes(original.status)) {
      return refuse(
        'RUN_NOT_RETRYABLE',
        `Run is ${original.status}; only failed or cancelled runs can be retried.`,
      );
    }

    // No queue adapter: refuse before writing anything, as `POST /goals` does for
    // async execution. A retry row with no job is exactly the defect being fixed.
    const queue = this.queue;
    if (!queue) {
      return refuse(
        'ASYNC_UNAVAILABLE',
        'Retrying a run requires a queue adapter; this runtime has none.',
      );
    }

    // Same gate the harness applies at execution, checked up front so a frozen
    // agent does not get a row that is cancelled the moment it is picked up.
    const { KillSwitchService } = await import('./kill-switch-service');
    const frozenScope = await new KillSwitchService({ db: this.db, siteId: this.siteId })
      .frozenScopeFor(original.agentName);
    if (frozenScope) {
      return refuse(
        'FROZEN',
        `Agent runtime is frozen for this ${frozenScope}; lift the kill switch to retry.`,
      );
    }

    const [goal] = await this.db
      .select()
      .from(agentGoals)
      .where(and(eq(agentGoals.siteId, this.siteId), eq(agentGoals.id, original.goalId)))
      .limit(1);
    if (!goal) {
      return refuse('RETRY_UNRECOVERABLE', 'The run no longer has a goal to retry under.');
    }
    if (CLOSED_GOAL_STATES.includes(goal.status)) {
      return refuse('GOAL_CLOSED', `Goal is ${goal.status}; there is nothing left to retry for.`);
    }

    const task = await this.recoverRetryTask(original);
    if (!task.ok) return task;
    const governance = await this.recoverRetryGovernance(goal, original);
    if (!governance.ok) return governance;

    let retryRunId: string;
    try {
      const prepared = await this.db.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${RETRY_LOCK_TIMEOUT}'`));
        const now = new Date();

        // The serialization point: every retry of this goal, and every dispatch
        // write, goes through this row lock. Whoever gets it second reads what the
        // first one committed.
        const [locked] = await tx
          .select({
            status: agentGoals.status,
            leaseUntil: agentGoals.dispatchLeaseUntil,
          })
          .from(agentGoals)
          .where(and(eq(agentGoals.siteId, this.siteId), eq(agentGoals.id, goal.id)))
          .for('update');
        if (!locked) {
          return refuse('RETRY_UNRECOVERABLE', 'The run no longer has a goal to retry under.');
        }
        if (CLOSED_GOAL_STATES.includes(locked.status)) {
          return refuse('GOAL_CLOSED', `Goal is ${locked.status}; there is nothing left to retry for.`);
        }
        // A dispatcher holding the lease has read this goal's state and may be
        // about to act on it; a retry now would race that decision.
        if (locked.leaseUntil && locked.leaseUntil.getTime() > now.getTime()) {
          return refuse('GOAL_BUSY', 'The goal is being dispatched right now; try again shortly.');
        }

        const [current] = await tx
          .select({ status: agentRuns.status })
          .from(agentRuns)
          .where(and(eq(agentRuns.siteId, this.siteId), eq(agentRuns.id, original.id)))
          .limit(1);
        if (!current || !RETRYABLE_RUN_STATES.includes(current.status)) {
          return refuse(
            'RUN_NOT_RETRYABLE',
            `Run is ${current?.status ?? 'gone'}; only failed or cancelled runs can be retried.`,
          );
        }

        const [inFlight] = await tx
          .select({ id: agentRuns.id, status: agentRuns.status })
          .from(agentRuns)
          .where(
            and(
              eq(agentRuns.siteId, this.siteId),
              eq(agentRuns.goalId, goal.id),
              inArray(agentRuns.status, IN_FLIGHT_RUN_STATES),
            ),
          )
          .limit(1);
        if (inFlight) {
          return refuse(
            'RUN_ACTIVE',
            `Goal already has an in-flight run (${inFlight.id}, ${inFlight.status}).`,
          );
        }

        const [latest] = await tx
          .select({ id: agentRuns.id, status: agentRuns.status })
          .from(agentRuns)
          .where(and(eq(agentRuns.siteId, this.siteId), eq(agentRuns.goalId, goal.id)))
          .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id))
          .limit(1);
        if (latest && latest.id !== original.id) {
          return refuse(
            'RETRY_SUPERSEDED',
            `Run ${original.id} is not the goal's latest attempt; retry ${latest.id} (${latest.status}) instead.`,
          );
        }

        const [retry] = await tx
          .insert(agentRuns)
          .values({
            goalId: goal.id,
            siteId: this.siteId,
            agentName: original.agentName,
            provider: original.provider,
            model: original.model,
            budget: original.budget as Record<string, unknown>,
            policySnapshotHash: original.policySnapshotHash,
            retryOfRunId: original.id,
            // `queued`, never `running`: the worker's claim is the only thing
            // allowed to start a run, which is what makes redelivery harmless.
            status: 'queued',
          })
          .returning({ id: agentRuns.id });

        // Dispatch blocks a reconciler goal when its run fails and never retries
        // on its own. Once a human retries, the goal is live again — the same
        // transition dispatch makes when it issues a run — so the next pass can
        // carry the repair forward instead of leaving it blocked behind a stale
        // reason. Dispatch re-derives everything from the runs, so this is safe.
        if (goal.origin === 'reconciler' && locked.status === 'blocked') {
          await tx
            .update(agentGoals)
            .set({
              status: 'in_progress',
              metadata: sql`coalesce(${agentGoals.metadata}, '{}'::jsonb) - 'blockedReason'`,
              updatedAt: now,
            })
            .where(and(eq(agentGoals.siteId, this.siteId), eq(agentGoals.id, goal.id)));
        }

        // The retry is a human decision to possibly repeat a side effect; who
        // made it is recorded with the row it created, atomically.
        await tx.insert(activity).values({
          siteId: this.siteId,
          action: 'agent_run.retried',
          userId: requester.userId,
          payload: {
            runId: retry!.id,
            retryOfRunId: original.id,
            goalId: goal.id,
            agentName: original.agentName,
            skillName: task.skillName,
            requestedBy: requester.principal,
          },
        });

        return { ok: true as const, runId: retry!.id };
      });
      if (!prepared.ok) return prepared;
      retryRunId = prepared.runId;
    } catch (error) {
      if (isLockTimeout(error)) {
        return refuse('GOAL_BUSY', 'The goal is being dispatched right now; try again shortly.');
      }
      // The partial unique index on in-flight runs caught what the checks above
      // could not see (a writer that does not take the goal lock).
      if (isUniqueViolation(error)) {
        return refuse('RUN_ACTIVE', 'Goal already has an in-flight run.');
      }
      throw error;
    }

    const { AGENT_RUNS_QUEUE } = await import('./agent-run-worker');
    const payload: AgentRunJobPayload = {
      siteId: this.siteId,
      goalId: goal.id,
      runId: retryRunId,
      skillName: task.skillName,
      arguments: task.arguments,
      principal: requester.principal,
      userId: requester.userId,
      ...(governance.contextMessage !== undefined ? { contextMessage: governance.contextMessage } : {}),
      ...(governance.origin !== undefined ? { origin: governance.origin } : {}),
      ...(governance.intentId !== undefined ? { intentId: governance.intentId } : {}),
      ...(governance.driftFingerprint !== undefined
        ? { driftFingerprint: governance.driftFingerprint }
        : {}),
      ...(governance.autonomyCap !== undefined ? { autonomyCap: governance.autonomyCap } : {}),
      ...(governance.agentRole !== undefined ? { agentRole: governance.agentRole } : {}),
      ...(governance.budget !== undefined ? { budget: governance.budget } : {}),
    };

    try {
      // Outside the transaction on purpose: a queue call cannot be rolled back,
      // so it must not run before the row it refers to is committed.
      await queue.enqueue(AGENT_RUNS_QUEUE, 'execute', payload);
    } catch (error) {
      // Settle the row, or it stays `queued` with no job and — being in flight —
      // blocks every later retry of this goal. `failed` makes it retryable.
      const message = error instanceof Error ? error.message : String(error);
      await this.failRun(retryRunId, `enqueue failed: ${message}`, {
        stopReason: 'enqueue_failed',
      }).catch(() => undefined);
      return refuse('ENQUEUE_FAILED', `The retry could not be queued: ${message}`);
    }

    return {
      ok: true,
      retry: {
        goalId: goal.id,
        runId: retryRunId,
        agentName: original.agentName,
        status: 'queued',
        retryOfRunId: original.id,
      },
    };
  }

  /**
   * Finds the skill and arguments a run executed, from its recorded tool call.
   *
   * An attempt refused before the harness (frozen, capabilities denied at pickup)
   * records no tool call; its task is its predecessor's by construction, so the
   * `retryOfRunId` chain is walked — bounded, and never across goals.
   */
  private async recoverRetryTask(
    run: typeof agentRuns.$inferSelect,
  ): Promise<RecoveredTask | RetryRunRefusal> {
    let cursor: { id: string; goalId: string; retryOfRunId: string | null } | undefined = run;
    for (let depth = 0; cursor && depth < MAX_RETRY_CHAIN_DEPTH; depth += 1) {
      const [call] = await this.db
        .select({ toolName: agentToolCalls.toolName, input: agentToolCalls.input })
        .from(agentToolCalls)
        .where(and(eq(agentToolCalls.siteId, this.siteId), eq(agentToolCalls.runId, cursor.id)))
        .orderBy(asc(agentToolCalls.createdAt), asc(agentToolCalls.id))
        .limit(1);
      if (call) {
        if (!isPlainRecord(call.input)) {
          return refuse(
            'RETRY_UNRECOVERABLE',
            `The recorded input of "${call.toolName}" is not an argument object; it cannot be replayed.`,
          );
        }
        if (containsMaskedValue(call.input)) {
          return refuse(
            'RETRY_UNRECOVERABLE',
            `The recorded input of "${call.toolName}" has masked secret values, so it cannot be ` +
              'replayed faithfully; issue the request again instead.',
          );
        }
        return { ok: true, skillName: call.toolName, arguments: call.input };
      }
      if (!cursor.retryOfRunId) break;
      const [previous] = await this.db
        .select({ id: agentRuns.id, goalId: agentRuns.goalId, retryOfRunId: agentRuns.retryOfRunId })
        .from(agentRuns)
        .where(and(eq(agentRuns.siteId, this.siteId), eq(agentRuns.id, cursor.retryOfRunId)))
        .limit(1);
      cursor = previous && previous.goalId === run.goalId ? previous : undefined;
    }
    return refuse(
      'RETRY_UNRECOVERABLE',
      'The run recorded no tool call, so there is no task to re-execute; create a new goal instead.',
    );
  }

  /**
   * Rebuilds the governance envelope a job for this goal carries.
   *
   * Mirrors the two enqueue sites: reconciler goals get the envelope dispatch
   * builds (origin, intent, drift fingerprint, autonomy cap, role), everything
   * else gets what `POST /goals` sends. Every recovered field can only narrow what
   * the run may do — a role intersects the grant, a cap lowers the level, a budget
   * limits — so omitting one would widen the retry, and a missing intent refuses.
   */
  private async recoverRetryGovernance(
    goal: typeof agentGoals.$inferSelect,
    run: typeof agentRuns.$inferSelect,
  ): Promise<RecoveredGovernance | RetryRunRefusal> {
    const reconciler = goal.origin === 'reconciler';
    if (reconciler && !goal.intentId) {
      return refuse(
        'RETRY_UNRECOVERABLE',
        'The reconciler goal has no governing intent, so its autonomy cap cannot be recovered.',
      );
    }

    let intentFields: Pick<RecoveredGovernance, 'intentId' | 'autonomyCap'> = {};
    if (goal.intentId) {
      const [intent] = await this.db
        .select({
          id: contentIntents.id,
          status: contentIntents.status,
          autonomyCap: contentIntents.autonomyCap,
        })
        .from(contentIntents)
        .where(and(eq(contentIntents.siteId, this.siteId), eq(contentIntents.id, goal.intentId)))
        .limit(1);
      if (!intent) {
        return refuse(
          'RETRY_UNRECOVERABLE',
          'The goal\'s governing intent no longer exists, so its autonomy cap cannot be recovered.',
        );
      }
      // A paused or errored intent must not spawn work — the rule dispatch
      // applies, and what keeps the reconciler's breaker effective.
      if (intent.status !== 'active') {
        return refuse(
          'INTENT_NOT_ACTIVE',
          `The goal's intent is ${intent.status}; resume it before retrying.`,
        );
      }
      intentFields = { intentId: intent.id, autonomyCap: intent.autonomyCap };
    }

    const agentRole = goal.agentRole ?? (reconciler ? goal.assigneeAgent : null);
    const budget = isPlainRecord(run.budget) && Object.keys(run.budget).length > 0
      ? run.budget
      : undefined;

    return {
      ok: true,
      ...intentFields,
      ...(reconciler ? { origin: 'reconciler' } : {}),
      ...(reconciler && goal.driftFingerprint ? { driftFingerprint: goal.driftFingerprint } : {}),
      ...(agentRole ? { agentRole } : {}),
      ...(budget ? { budget } : {}),
      ...(goal.description ? { contextMessage: goal.description } : {}),
    };
  }

  async listRuns(limit = 50) {
    return this.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.siteId, this.siteId))
      .orderBy(desc(agentRuns.createdAt))
      .limit(limit);
  }

  private async toolNameForCall(toolCallId: string): Promise<string> {
    const [call] = await this.db
      .select({ toolName: agentToolCalls.toolName })
      .from(agentToolCalls)
      .where(and(eq(agentToolCalls.id, toolCallId), eq(agentToolCalls.siteId, this.siteId)))
      .limit(1);
    return call?.toolName ?? 'unknown';
  }

  private async enqueueDeadLetterIfRepeatedFailure(
    run: typeof agentRuns.$inferSelect,
    error: string,
    stopReason: string,
  ): Promise<void> {
    if (!this.queue) return;

    const failedRuns = await this.db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.siteId, this.siteId),
          eq(agentRuns.goalId, run.goalId),
          eq(agentRuns.status, 'failed'),
        ),
      )
      .limit(3);

    if (failedRuns.length < 3) return;

    await this.queue.enqueue('agent-dead-letter', 'run.failed', {
      siteId: this.siteId,
      goalId: run.goalId,
      runId: run.id,
      agentName: run.agentName,
      error,
      stopReason,
      failedRuns: failedRuns.length,
      enqueuedAt: new Date().toISOString(),
    });
    agentDeadLettersTotal.inc({ agent: run.agentName, reason: stopReason });
  }
}

export interface StaleRunSweepResult {
  siteId: string;
  runId: string;
  goalId: string | null;
  agentName: string;
}

/**
 * Quarantines abandoned `running` runs across every tenant that has one.
 *
 * Driven by the `agent-run-stale-sweep` cron on the Node/Docker runtime. It is the
 * companion to `claimQueuedRun` refusing to replay a stale run (#481 R3.1): the
 * claim no longer takes such a run over, so something has to stop it from sitting
 * `running` forever — invisible to the dispatcher, which reads it as in-flight,
 * and invisible in the approvals inbox, which only lists pending decisions.
 *
 * Site discovery comes from the runs themselves, so a deployment with thousands of
 * tenants touches only the ones that actually have a stuck run.
 *
 * Never throws: one tenant's failure must not stop the others, and a cron callback
 * that rejects takes the tick down with it.
 */
export async function sweepStaleRuns(deps: {
  db: Database;
  limitPerSite?: number;
  sitesLimit?: number;
  now?: () => Date;
}): Promise<StaleRunSweepResult[]> {
  const now = deps.now?.() ?? new Date();
  const staleBefore = new Date(now.getTime() - RUN_STALE_MS);
  const sites = await deps.db
    .selectDistinct({ siteId: agentRuns.siteId })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.status, 'running'),
        isNotNull(agentRuns.startedAt),
        lt(agentRuns.startedAt, staleBefore),
      ),
    )
    .orderBy(asc(agentRuns.siteId))
    .limit(Math.max(1, Math.trunc(deps.sitesLimit ?? 500)));

  const swept: StaleRunSweepResult[] = [];
  for (const site of sites) {
    try {
      const service = new AgentRunService(deps.db, site.siteId);
      const quarantined = await service.quarantineStaleRuns(deps.limitPerSite ?? 50, now);
      for (const run of quarantined) swept.push({ siteId: site.siteId, ...run });
    } catch (error) {
      console.error(
        '[agent-run-stale-sweep] site pass failed',
        JSON.stringify({
          siteId: site.siteId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
  return swept;
}
