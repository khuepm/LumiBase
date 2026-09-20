import {
  agentGoals,
  agentRuns,
  agentToolCalls,
  type Database,
} from '@lumibase/database';
import type { QueueProvider } from '@lumibase/runtime';
import { and, desc, eq, isNotNull, lt, or } from 'drizzle-orm';
import type { AgentNotifier } from '../modules/notifications/agent-notifications';
import type { ApprovalRequester } from './approval-requester';
import {
  agentDeadLettersTotal,
  agentRunsTotal,
  agentToolLatency,
  observeAgentCost,
} from './agent-metrics';

/**
 * How long a `running` run may go without finishing before another worker may
 * take it over.
 *
 * The number is a trade between two failures, and both are real: too short and a
 * long legitimate run is executed twice; too long and a run orphaned by a crashed
 * process is stuck until someone notices. Fifteen minutes is far beyond any
 * observed run (the harness caps tool calls and the LLM has its own timeouts) and
 * far below "forever".
 */
export const RUN_STALE_MS = 15 * 60_000;

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
      SECRET_KEY_RE.test(key) ? '[masked]' : maskSecrets(entry),
    ]),
  );
}

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
   * ## Crash recovery, without reopening the hole
   *
   * A worker killed mid-run would otherwise leave the run `running` forever with
   * nobody able to claim it. Reclaiming is therefore allowed, but only for a run
   * whose `startedAt` is older than {@link RUN_STALE_MS} — long enough that a
   * live run is never stolen, short enough that a crash is not permanent. A
   * duplicate arriving seconds later is refused, because the claim it would need
   * to steal was stamped just now.
   *
   * `awaiting_approval` is deliberately NOT claimable here: resuming a parked run
   * is the approval flow's job ({@link resumeApprovedRun}), and letting a queue
   * redelivery do it is exactly how the duplicate approval appeared.
   */
  async claimQueuedRun(runId: string): Promise<boolean> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - RUN_STALE_MS);
    const claimed = await this.db
      .update(agentRuns)
      .set({ status: 'running', startedAt: now, updatedAt: now })
      .where(
        and(
          eq(agentRuns.id, runId),
          eq(agentRuns.siteId, this.siteId),
          or(
            eq(agentRuns.status, 'queued'),
            and(
              eq(agentRuns.status, 'running'),
              // A `running` row with no `startedAt` cannot be aged, so it is left
              // alone rather than treated as stale — fail-closed on a shape that
              // should not occur.
              isNotNull(agentRuns.startedAt),
              lt(agentRuns.startedAt, staleBefore),
            ),
          ),
        ),
      )
      .returning({ id: agentRuns.id });
    return claimed.length > 0;
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

  async retryRun(runId: string): Promise<AgentRunContext | null> {
    const [existing] = await this.db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.siteId, this.siteId)));

    if (!existing) {
      return null;
    }

    const [retry] = await this.db
      .insert(agentRuns)
      .values({
        goalId: existing.goalId,
        siteId: this.siteId,
        agentName: existing.agentName,
        provider: existing.provider,
        model: existing.model,
        budget: existing.budget as Record<string, unknown>,
        policySnapshotHash: existing.policySnapshotHash,
        retryOfRunId: existing.id,
        status: 'running',
      })
      .returning();

    return { goalId: existing.goalId, runId: retry!.id, agentName: existing.agentName };
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
