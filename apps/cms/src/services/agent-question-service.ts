import {
  activity,
  agentApprovals,
  agentGoals,
  agentRuns,
  agentToolCalls,
  type Database,
} from '@lumibase/database';
import type { CacheProvider } from '@lumibase/runtime';
import { ASK_USER_DEFAULT_TIMEOUT_MINUTES, ASK_USER_LIMITS } from '@lumibase/contracts';
import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import {
  agentRunsTotal,
  metricAgent,
  observeQuestionSettled,
} from './agent-metrics';
import { maskSecrets, WAITING_USER_RUN_STATUS } from './agent-run-service';
import { parseApprovalRequester, resolveApprovalRequester, type ApprovalRequester } from './approval-requester';
import { UNTRUSTED_CONTENT_RULE, untrustedBlock } from './llm-provider';

/**
 * `askUser` — the clarification tool of the governed harness (#710).
 *
 * ## Lifecycle, and why it reuses the approval machinery
 *
 * A question is a human decision that a run waits on, which is exactly what an
 * approval already is. So it is stored as an `agent_approvals` row with
 * `kind = 'question'` (next to `approval`, `veto`, `promotion`), parked with the
 * same guarded transition the HITL path uses, and carries the same `#472`
 * provenance (`requested_by_principal`). Nothing new to migrate, to put under
 * RLS or to sweep for tenancy: the table is already site-scoped and listed.
 *
 *   ask      run `queued|running → waiting_user`, question `pending`, tool call
 *            `waiting_user` — one transaction, then the notifier fires.
 *   answer   question `pending → answered`, run `waiting_user → succeeded`, tool
 *            call `executed` with the answer as its result, audit row — one
 *            transaction, so a second answer finds nothing to claim (409).
 *   timeout  question `pending → expired`, run `→ failed` (`question_timeout`),
 *            tool call `failed` — the 5-minute sweep, or the answer route when
 *            it meets an overdue question first.
 *   cancel   run cancel / kill switch: run `→ cancelled`, question `cancelled`.
 *
 * A waiting run holds no queue worker (the worker returns as soon as the
 * harness has parked it) and no database lock (every step is one short
 * transaction). Where each column lives:
 *
 * - question, options, context, timeout: the `askUser` tool call's `input`;
 * - answer: `decision_reason` (raw, shown to operators), mirrored into the tool
 *   call `output` wrapped as untrusted data for the model;
 * - who answered and when: `decided_by`, `decided_at`, plus the audit row;
 * - deadline: `expires_at`.
 */

export const ASK_USER_SKILL = 'askUser';
export const GET_USER_ANSWER_SKILL = 'getUserAnswer';
export const QUESTION_KIND = 'question';
export const QUESTION_TIMEOUT_STOP_REASON = 'question_timeout';
export const ANSWERED_STOP_REASON = 'answered';

/** Label of the untrusted block an answer travels in when it reaches a model. */
export const ANSWER_UNTRUSTED_LABEL = 'ask-user-answer';

export type QuestionStatus = 'pending' | 'answered' | 'expired' | 'cancelled';

export interface QuestionView {
  id: string;
  runId: string;
  goalId: string | null;
  toolCallId: string;
  agentName: string;
  question: string;
  options: string[];
  allowFreeText: boolean;
  context: string | null;
  status: string;
  expiresAt: string | null;
  createdAt: string;
  answer: string | null;
  answeredAt: string | null;
  answeredBy: string | null;
}

export interface AskUserInput {
  question: string;
  options?: string[] | undefined;
  allowFreeText?: boolean | undefined;
  context?: string | undefined;
  timeoutMinutes?: number | undefined;
}

export type QuestionRefusalCode =
  | 'NOT_FOUND'
  | 'ALREADY_ANSWERED'
  | 'QUESTION_CLOSED'
  | 'EXPIRED'
  | 'ANSWER_INVALID'
  | 'ANSWER_NOT_AN_OPTION'
  | 'FROZEN'
  | 'RUN_NOT_WAITING'
  | 'REQUESTER_REVOKED';

export const QUESTION_REFUSAL_STATUS: Record<QuestionRefusalCode, 400 | 404 | 409 | 423> = {
  NOT_FOUND: 404,
  ALREADY_ANSWERED: 409,
  QUESTION_CLOSED: 409,
  EXPIRED: 409,
  ANSWER_INVALID: 400,
  ANSWER_NOT_AN_OPTION: 400,
  FROZEN: 423,
  RUN_NOT_WAITING: 409,
  REQUESTER_REVOKED: 409,
};

export type AnswerResult =
  | { ok: true; question: QuestionView }
  | { ok: false; code: QuestionRefusalCode; message: string };

type QuestionRow = typeof agentApprovals.$inferSelect;

/** Thrown inside a transaction to roll it back with a refusal. */
class QuestionRefusal extends Error {
  constructor(readonly code: QuestionRefusalCode, message: string) {
    super(message);
  }
}

function refuse(code: QuestionRefusalCode, message: string): AnswerResult {
  return { ok: false, code, message };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Reads the question fields back from the `askUser` tool call input. */
export function questionFieldsFromInput(input: unknown): {
  question: string;
  options: string[];
  allowFreeText: boolean;
  context: string | null;
} {
  const record = asRecord(input);
  const options = Array.isArray(record['options'])
    ? record['options'].filter((option): option is string => typeof option === 'string')
    : [];
  return {
    question: typeof record['question'] === 'string' ? record['question'] : '',
    options,
    // Free text is the default; it is off only when the agent said so AND
    // there are options to choose from.
    allowFreeText: !(record['allowFreeText'] === false && options.length > 0),
    context: typeof record['context'] === 'string' ? record['context'] : null,
  };
}

/** The deadline for a question asked at `now`. */
export function questionDeadline(timeoutMinutes: number | undefined, now: Date): Date {
  const minutes = Number.isInteger(timeoutMinutes) && timeoutMinutes! >= 1
    ? Math.min(timeoutMinutes!, ASK_USER_LIMITS.timeoutMinutes)
    : ASK_USER_DEFAULT_TIMEOUT_MINUTES;
  return new Date(now.getTime() + minutes * 60_000);
}

/**
 * The answer as the model sees it: inside an untrusted block, with the rule
 * that says so. A person typed it, but it reaches the model as tool output and
 * an answer box is an input like any other — it may quote content, paste a
 * prompt or simply be wrong. It informs the agent's next call; the harness
 * still authorizes that call on its own.
 */
export function answerForModel(answer: string): { answer: string; rule: string } {
  return { answer: untrustedBlock(ANSWER_UNTRUSTED_LABEL, answer), rule: UNTRUSTED_CONTENT_RULE };
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function toView(
  row: QuestionRow,
  call: { input: unknown } | undefined,
  goalId: string | null,
): QuestionView {
  const fields = questionFieldsFromInput(call?.input);
  return {
    id: row.id,
    runId: row.runId,
    goalId,
    toolCallId: row.subjectId,
    agentName: row.requestedByAgent,
    question: fields.question,
    options: fields.options,
    allowFreeText: fields.allowFreeText,
    context: fields.context,
    status: row.status,
    expiresAt: iso(row.expiresAt),
    createdAt: row.createdAt.toISOString(),
    answer: row.status === 'answered' ? row.decisionReason : null,
    answeredAt: row.status === 'answered' ? iso(row.decidedAt) : null,
    answeredBy: row.status === 'answered' ? row.decidedBy : null,
  };
}

/**
 * Closes every open question of a run that was just cancelled.
 *
 * Called by `AgentRunService.cancelRun`, which covers the run kill switch, the
 * role/site/intent freezes (they cancel waiting runs through it) and a human
 * cancel. Idempotent: it only touches `pending` rows.
 */
export async function closeOpenQuestionsForRun(
  db: Database,
  siteId: string,
  runId: string,
  reason: string,
): Promise<number> {
  const now = new Date();
  const closed = await db
    .update(agentApprovals)
    .set({ status: 'cancelled', decidedAt: now, decisionReason: `run cancelled: ${reason}`.slice(0, 1000) })
    .where(
      and(
        eq(agentApprovals.siteId, siteId),
        eq(agentApprovals.runId, runId),
        eq(agentApprovals.kind, QUESTION_KIND),
        eq(agentApprovals.status, 'pending'),
      ),
    )
    .returning({ id: agentApprovals.id, subjectId: agentApprovals.subjectId, createdAt: agentApprovals.createdAt });
  for (const question of closed) {
    await db
      .update(agentToolCalls)
      .set({ status: 'denied', error: `Run was cancelled (${reason}) before the question was answered.`, finishedAt: now })
      .where(and(eq(agentToolCalls.siteId, siteId), eq(agentToolCalls.id, question.subjectId)));
    await db.insert(activity).values({
      siteId,
      action: 'agent_question.cancelled',
      payload: { questionId: question.id, runId, reason },
    });
    observeQuestionSettled('cancelled', question.createdAt, now);
  }
  return closed.length;
}

export interface AgentQuestionServiceDeps {
  db: Database;
  siteId: string;
  cache?: CacheProvider | undefined;
  environment?: string | undefined;
}

export class AgentQuestionService {
  constructor(private readonly deps: AgentQuestionServiceDeps) {}

  private get db(): Database {
    return this.deps.db;
  }

  private get siteId(): string {
    return this.deps.siteId;
  }

  /**
   * Parks `runId` on a new question, atomically. Returns null when the run is
   * no longer in flight (cancelled while the harness was recording the call),
   * in which case nothing was written.
   */
  async ask(input: {
    runId: string;
    agentName: string;
    toolCallId: string;
    args: AskUserInput;
    requestedByPrincipal: ApprovalRequester | null;
    now?: Date;
  }): Promise<{ id: string; expiresAt: Date } | null> {
    const now = input.now ?? new Date();
    const expiresAt = questionDeadline(input.args.timeoutMinutes, now);
    const { AgentRunService } = await import('./agent-run-service');
    const runs = new AgentRunService(this.db, this.siteId);

    const created = await this.db.transaction(async (tx) => {
      if (!(await runs.awaitUser(input.runId, tx))) return null;
      const [row] = await tx
        .insert(agentApprovals)
        .values({
          runId: input.runId,
          siteId: this.siteId,
          subjectType: 'tool_call',
          subjectId: input.toolCallId,
          status: 'pending',
          kind: QUESTION_KIND,
          approvalPolicy: 'answer_required',
          requestedByAgent: input.agentName,
          requestedByPrincipal: input.requestedByPrincipal ?? null,
          expiresAt,
        })
        .returning({ id: agentApprovals.id });
      await tx.insert(activity).values({
        siteId: this.siteId,
        action: 'agent_question.asked',
        payload: {
          questionId: row!.id,
          runId: input.runId,
          toolCallId: input.toolCallId,
          agentName: input.agentName,
          expiresAt: expiresAt.toISOString(),
          optionCount: input.args.options?.length ?? 0,
          requestedBy: input.requestedByPrincipal ?? null,
        },
      });
      return { id: row!.id, expiresAt };
    });
    return created;
  }

  async get(questionId: string): Promise<QuestionView | null> {
    const row = await this.loadRow(questionId);
    if (!row) return null;
    return this.view(row);
  }

  /** Questions of this site, newest first. `status` narrows; omit for all. */
  async list(status?: QuestionStatus, limit = 100): Promise<QuestionView[]> {
    const rows = await this.db
      .select()
      .from(agentApprovals)
      .where(
        and(
          eq(agentApprovals.siteId, this.siteId),
          eq(agentApprovals.kind, QUESTION_KIND),
          ...(status ? [eq(agentApprovals.status, status)] : []),
        ),
      )
      .orderBy(desc(agentApprovals.createdAt))
      .limit(Math.max(1, Math.min(200, Math.trunc(limit))));
    if (rows.length === 0) return [];

    const calls = await this.db
      .select({ id: agentToolCalls.id, input: agentToolCalls.input })
      .from(agentToolCalls)
      .where(and(eq(agentToolCalls.siteId, this.siteId), inArray(agentToolCalls.id, rows.map((row) => row.subjectId))));
    const runs = await this.db
      .select({ id: agentRuns.id, goalId: agentRuns.goalId })
      .from(agentRuns)
      .where(and(eq(agentRuns.siteId, this.siteId), inArray(agentRuns.id, rows.map((row) => row.runId))));
    const callById = new Map(calls.map((call) => [call.id, call]));
    const goalByRun = new Map(runs.map((run) => [run.id, run.goalId]));
    return rows.map((row) => toView(row, callById.get(row.subjectId), goalByRun.get(row.runId) ?? null));
  }

  /** The question row, only if it is a question of this site. */
  async loadRow(questionId: string): Promise<QuestionRow | null> {
    const [row] = await this.db
      .select()
      .from(agentApprovals)
      .where(
        and(
          eq(agentApprovals.id, questionId),
          eq(agentApprovals.siteId, this.siteId),
          eq(agentApprovals.kind, QUESTION_KIND),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  private async view(row: QuestionRow): Promise<QuestionView> {
    const [call] = await this.db
      .select({ input: agentToolCalls.input })
      .from(agentToolCalls)
      .where(and(eq(agentToolCalls.siteId, this.siteId), eq(agentToolCalls.id, row.subjectId)))
      .limit(1);
    const [run] = await this.db
      .select({ goalId: agentRuns.goalId })
      .from(agentRuns)
      .where(and(eq(agentRuns.siteId, this.siteId), eq(agentRuns.id, row.runId)))
      .limit(1);
    return toView(row, call, run?.goalId ?? null);
  }

  /**
   * Answers a question and resumes its run. The caller has already decided the
   * principal may answer (see `routes/agent.ts`); this enforces everything that
   * depends on state rather than on who is asking.
   *
   * Resuming means the parked `askUser` tool call completes with the answer as
   * its result and the run settles `succeeded`. A run is one governed tool call
   * in this harness, so that IS the rest of the run; whatever the agent does
   * with the answer is its next tool call, authorized on its own.
   */
  async answer(input: {
    questionId: string;
    answer: string;
    answeredBy: string | null;
    via: 'requester' | 'approver';
    now?: Date;
  }): Promise<AnswerResult> {
    const now = input.now ?? new Date();
    const answer = input.answer.trim();
    if (answer.length === 0 || answer.length > ASK_USER_LIMITS.answer) {
      return refuse('ANSWER_INVALID', `The answer must be 1-${ASK_USER_LIMITS.answer} characters.`);
    }

    const row = await this.loadRow(input.questionId);
    if (!row) return refuse('NOT_FOUND', 'Question not found');
    const closed = this.closedRefusal(row);
    if (closed) return closed;

    if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) {
      // Settle it now rather than leaving it for the sweep: the operator is
      // looking at it, and the run should not stay `waiting_user` behind a
      // question nobody can answer any more.
      await this.expire(row.id, now);
      return refuse('EXPIRED', 'The question expired before it was answered.');
    }

    const view = await this.view(row);
    if (!view.allowFreeText && !view.options.includes(answer)) {
      return refuse('ANSWER_NOT_AN_OPTION', 'The answer must be one of the offered options.');
    }

    const [run] = await this.db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.siteId, this.siteId), eq(agentRuns.id, row.runId)))
      .limit(1);
    if (!run || run.status !== WAITING_USER_RUN_STATUS) {
      return refuse('RUN_NOT_WAITING', `The run is ${run?.status ?? 'gone'}; it is not waiting for an answer.`);
    }

    // The kill switch ends waiting runs too. A freeze issued after the
    // question was asked has already cancelled it; this covers an answer that
    // arrives between the freeze row and that cancellation.
    const { AgentRunService } = await import('./agent-run-service');
    const runs = new AgentRunService(this.db, this.siteId);
    const { KillSwitchService } = await import('./kill-switch-service');
    const frozenScope = await new KillSwitchService({ db: this.db, siteId: this.siteId }).frozenScopeFor(run.agentName);
    if (frozenScope) {
      await runs.cancelRun(run.id, 'frozen');
      return refuse('FROZEN', `Agent runtime is frozen for this ${frozenScope}; the run was cancelled.`);
    }

    // #472: the run resumes on behalf of whoever asked for it. If that
    // principal (or agent role) can no longer act on this site, the run does
    // not resume — the same rule an approval applies before executing.
    const requester = parseApprovalRequester(row.requestedByPrincipal);
    if (requester) {
      const resolution = await resolveApprovalRequester(
        { db: this.db, siteId: this.siteId, cache: this.deps.cache, environment: this.deps.environment },
        requester,
      );
      if (!resolution.allowed) {
        await runs.failRun(run.id, resolution.message, { stopReason: 'requester_revoked', questionId: row.id });
        await closeOpenQuestionsForRun(this.db, this.siteId, run.id, 'requester_revoked');
        return refuse('REQUESTER_REVOKED', resolution.message);
      }
    }

    const waitedMs = now.getTime() - row.createdAt.getTime();
    try {
      await this.db.transaction(async (tx) => {
        const [claimed] = await tx
          .update(agentApprovals)
          .set({ status: 'answered', decidedAt: now, decidedBy: input.answeredBy, decisionReason: answer })
          .where(
            and(
              eq(agentApprovals.id, row.id),
              eq(agentApprovals.siteId, this.siteId),
              eq(agentApprovals.kind, QUESTION_KIND),
              eq(agentApprovals.status, 'pending'),
              or(isNull(agentApprovals.expiresAt), gt(agentApprovals.expiresAt, now)),
            ),
          )
          .returning({ id: agentApprovals.id });
        if (!claimed) throw new QuestionRefusal('ALREADY_ANSWERED', 'Question already answered or closed');

        const [resumed] = await tx
          .update(agentRuns)
          .set({
            status: 'succeeded',
            finishedAt: now,
            updatedAt: now,
            metrics: sql`coalesce(${agentRuns.metrics}, '{}'::jsonb) || ${JSON.stringify({
              stopReason: ANSWERED_STOP_REASON,
              toolCalls: 1,
              questionId: row.id,
              resumedAt: now.toISOString(),
              waitedMs,
            })}::jsonb`,
          })
          .where(
            and(
              eq(agentRuns.id, row.runId),
              eq(agentRuns.siteId, this.siteId),
              eq(agentRuns.status, WAITING_USER_RUN_STATUS),
            ),
          )
          .returning({ id: agentRuns.id });
        if (!resumed) throw new QuestionRefusal('RUN_NOT_WAITING', 'The run is no longer waiting for an answer.');

        await tx
          .update(agentToolCalls)
          .set({
            status: 'executed',
            error: null,
            finishedAt: now,
            output: maskSecrets({ questionId: row.id, answered: true, ...answerForModel(answer) }) as Record<string, unknown>,
          })
          .where(and(eq(agentToolCalls.siteId, this.siteId), eq(agentToolCalls.id, row.subjectId)));

        await tx.insert(activity).values({
          siteId: this.siteId,
          action: 'agent_question.answered',
          userId: input.answeredBy,
          payload: {
            questionId: row.id,
            runId: row.runId,
            toolCallId: row.subjectId,
            via: input.via,
            answerLength: answer.length,
            waitedMs,
          },
        });
      });
    } catch (error) {
      if (error instanceof QuestionRefusal) {
        // Lost a race: re-read so the code says what actually happened.
        const current = await this.loadRow(row.id);
        const reason = current ? this.closedRefusal(current) : null;
        return reason ?? refuse(error.code, error.message);
      }
      throw error;
    }

    agentRunsTotal.inc({ agent: metricAgent(run.agentName), status: 'succeeded', stop_reason: ANSWERED_STOP_REASON });
    observeQuestionSettled('answered', row.createdAt, now);
    const settled = await this.loadRow(row.id);
    return { ok: true, question: await this.view(settled ?? row) };
  }

  /**
   * Times one question out: question `expired`, its run `failed` with
   * `question_timeout`. Guarded on `pending` and on the deadline, so it never
   * overrides an answer that landed first. Returns false when it changed nothing.
   */
  async expire(questionId: string, now = new Date()): Promise<boolean> {
    const result = await this.db.transaction(async (tx) => {
      const [expired] = await tx
        .update(agentApprovals)
        .set({ status: 'expired', decidedAt: now, decisionReason: 'No answer before the deadline.' })
        .where(
          and(
            eq(agentApprovals.id, questionId),
            eq(agentApprovals.siteId, this.siteId),
            eq(agentApprovals.kind, QUESTION_KIND),
            eq(agentApprovals.status, 'pending'),
            lte(agentApprovals.expiresAt, now),
          ),
        )
        .returning();
      if (!expired) return null;

      const message = 'The question was not answered before its deadline.';
      const [run] = await tx
        .update(agentRuns)
        .set({
          status: 'failed',
          error: message,
          finishedAt: now,
          updatedAt: now,
          metrics: sql`coalesce(${agentRuns.metrics}, '{}'::jsonb) || ${JSON.stringify({
            stopReason: QUESTION_TIMEOUT_STOP_REASON,
            questionId,
          })}::jsonb`,
        })
        .where(
          and(
            eq(agentRuns.id, expired.runId),
            eq(agentRuns.siteId, this.siteId),
            eq(agentRuns.status, WAITING_USER_RUN_STATUS),
          ),
        )
        .returning({ id: agentRuns.id, agentName: agentRuns.agentName });
      await tx
        .update(agentToolCalls)
        .set({ status: 'failed', error: message, finishedAt: now })
        .where(and(eq(agentToolCalls.siteId, this.siteId), eq(agentToolCalls.id, expired.subjectId)));
      await tx.insert(activity).values({
        siteId: this.siteId,
        action: 'agent_question.expired',
        payload: { questionId, runId: expired.runId, expiresAt: iso(expired.expiresAt), runFailed: Boolean(run) },
      });
      return { createdAt: expired.createdAt, agentName: run?.agentName ?? null };
    });
    if (!result) return false;
    if (result.agentName) {
      agentRunsTotal.inc({ agent: metricAgent(result.agentName), status: 'failed', stop_reason: QUESTION_TIMEOUT_STOP_REASON });
    }
    observeQuestionSettled('expired', result.createdAt, now);
    return true;
  }

  /**
   * Cancels runs parked on a question when a kill switch freezes their scope.
   * The harness only meets a freeze at its next tool-call boundary, and a
   * waiting run has none, so without this a frozen agent's question could still
   * be answered and its run resumed.
   */
  async cancelWaitingRuns(scope: { kind: 'site' } | { kind: 'role'; role: string } | { kind: 'intent'; intentId: string }): Promise<string[]> {
    const conditions = [eq(agentRuns.siteId, this.siteId), eq(agentRuns.status, WAITING_USER_RUN_STATUS)];
    let rows: Array<{ id: string }>;
    if (scope.kind === 'intent') {
      rows = await this.db
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .innerJoin(agentGoals, and(eq(agentGoals.id, agentRuns.goalId), eq(agentGoals.siteId, agentRuns.siteId)))
        .where(and(...conditions, eq(agentGoals.intentId, scope.intentId)))
        .limit(500);
    } else {
      rows = await this.db
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(and(...conditions, ...(scope.kind === 'role' ? [eq(agentRuns.agentName, scope.role)] : [])))
        .limit(500);
    }
    const { AgentRunService } = await import('./agent-run-service');
    const runs = new AgentRunService(this.db, this.siteId);
    const cancelled: string[] = [];
    for (const row of rows) {
      if (await runs.cancelRun(row.id, 'frozen')) cancelled.push(row.id);
    }
    return cancelled;
  }

  private closedRefusal(row: QuestionRow): AnswerResult | null {
    if (row.status === 'pending') return null;
    if (row.status === 'answered') return refuse('ALREADY_ANSWERED', 'Question already answered');
    if (row.status === 'expired') return refuse('EXPIRED', 'The question expired before it was answered.');
    return refuse('QUESTION_CLOSED', `Question is ${row.status}`);
  }
}

export interface ExpiredQuestionSweepResult {
  siteId: string;
  questionId: string;
}

/**
 * Times out overdue questions across tenants. Driven by the 5-minute tick on
 * both runtimes (`serve.ts` cron, `cloudflare.ts` scheduled). Each row is
 * settled within its own site scope; one failure does not stop the others,
 * and the function never throws (a rejected cron callback takes the tick down).
 */
export async function sweepExpiredQuestions(deps: {
  db: Database;
  now?: () => Date;
  limit?: number;
}): Promise<ExpiredQuestionSweepResult[]> {
  const now = deps.now?.() ?? new Date();
  const swept: ExpiredQuestionSweepResult[] = [];
  let due: Array<{ id: string; siteId: string }>;
  try {
    due = await deps.db
      .select({ id: agentApprovals.id, siteId: agentApprovals.siteId })
      .from(agentApprovals)
      .where(
        and(
          eq(agentApprovals.kind, QUESTION_KIND),
          eq(agentApprovals.status, 'pending'),
          lte(agentApprovals.expiresAt, now),
        ),
      )
      .orderBy(asc(agentApprovals.expiresAt))
      .limit(Math.max(1, Math.trunc(deps.limit ?? 100)));
  } catch (error) {
    console.error('[agent-question-sweep] scan failed', error instanceof Error ? error.message : String(error));
    return swept;
  }
  for (const row of due) {
    try {
      if (await new AgentQuestionService({ db: deps.db, siteId: row.siteId }).expire(row.id, now)) {
        swept.push({ siteId: row.siteId, questionId: row.id });
      }
    } catch (error) {
      console.error(
        '[agent-question-sweep] expire failed',
        JSON.stringify({ siteId: row.siteId, questionId: row.id, error: error instanceof Error ? error.message : String(error) }),
      );
    }
  }
  return swept;
}
