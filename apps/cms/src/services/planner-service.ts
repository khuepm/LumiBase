import { agentGoals } from '@lumibase/database';
import type { Database } from '@lumibase/database';
import { and, asc, eq } from 'drizzle-orm';
import type { AgentNotifier } from '../modules/notifications/agent-notifications';

/**
 * Planner delegation (content-os task 10.3; Req 10.1, 10.4, 10.5).
 *
 * The Planner role decomposes a goal into role-scoped sub-goals. Sub-goals:
 * - link back via `parentGoalId` (goal tree), `origin='planner'`;
 * - inherit the parent's REMAINING budget — the planner can split what is
 *   left but never mint new budget;
 * - carry the parent's intent lineage (intentId, driftFingerprint) and
 *   autonomy cap so guards resolve identically down the tree.
 *
 * Settlement: a parent goal completes only when every sub-goal completed;
 * one failed sub-goal fails the parent (acceptance unmet, Req 10.5).
 */

export interface SubGoalSpec {
  title: string;
  description?: string;
  /** Role from the agent_roles library that should execute this sub-goal. */
  agentRole: string;
  /** Acceptance criteria recorded on the sub-goal's successCriteria. */
  acceptance?: Record<string, unknown>;
}

export interface GoalBudget {
  maxToolCalls?: number;
  [key: string]: unknown;
}

export class PlannerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
    this.name = 'PlannerError';
  }
}

/**
 * Splits the remaining tool-call budget across `count` sub-goals — exported
 * pure for tests. Every sub-goal gets at least 1 call; the sum never
 * exceeds `remaining` (budget is inherited, never minted).
 */
export function splitBudget(remaining: number, count: number): number[] {
  if (count <= 0) return [];
  if (remaining < count) {
    throw new PlannerError(
      'INSUFFICIENT_BUDGET',
      `Remaining budget ${remaining} cannot fund ${count} sub-goals (1 tool call minimum each).`,
      422,
    );
  }
  const base = Math.floor(remaining / count);
  const extra = remaining % count;
  return Array.from({ length: count }, (_, i) => base + (i < extra ? 1 : 0));
}

export interface PlannerServiceDeps {
  db: Database;
  siteId: string;
  /**
   * Optional push-notification sink (push-noti feature). When provided, a
   * parent goal settling to completed/failed is pushed. Best-effort.
   */
  notify?: AgentNotifier;
}

export class PlannerService {
  constructor(private readonly deps: PlannerServiceDeps) {}

  /**
   * Creates sub-goals under `parentGoalId`. The parent moves to
   * `in_progress`; each sub-goal inherits a fair share of the parent's
   * remaining `maxToolCalls` budget.
   */
  async decompose(parentGoalId: string, specs: SubGoalSpec[]) {
    if (specs.length === 0) {
      throw new PlannerError('VALIDATION', 'At least one sub-goal is required.');
    }
    const parent = await this.getGoal(parentGoalId);
    if (!parent) {
      throw new PlannerError('NOT_FOUND', 'Parent goal not found.', 404);
    }
    if (parent.status === 'completed' || parent.status === 'failed') {
      throw new PlannerError('CONFLICT', `Parent goal is already ${parent.status}.`, 409);
    }

    const metadata = (parent.metadata ?? {}) as Record<string, unknown>;
    const parentBudget = (metadata['budget'] ?? {}) as GoalBudget;
    const totalBudget = typeof parentBudget.maxToolCalls === 'number' ? parentBudget.maxToolCalls : null;

    // Remaining = parent's total minus what earlier decompositions already
    // handed out. The planner can only re-slice what is left (Req 10.1).
    let shares: Array<number | null> = specs.map(() => null);
    if (totalBudget !== null) {
      const existingChildren = await this.listChildren(parentGoalId);
      const allocated = existingChildren.reduce((sum, child) => {
        const childBudget = ((child.metadata ?? {}) as Record<string, unknown>)['budget'] as
          | GoalBudget
          | undefined;
        return sum + (typeof childBudget?.maxToolCalls === 'number' ? childBudget.maxToolCalls : 0);
      }, 0);
      shares = splitBudget(Math.max(totalBudget - allocated, 0), specs.length);
    }

    const rows = await this.deps.db
      .insert(agentGoals)
      .values(
        specs.map((spec, i) => ({
          siteId: this.deps.siteId,
          title: spec.title,
          description: spec.description ?? null,
          source: parent.source,
          createdBy: parent.createdBy,
          assigneeAgent: spec.agentRole,
          priority: parent.priority,
          status: 'open',
          successCriteria: spec.acceptance ?? {},
          parentGoalId,
          origin: 'planner',
          intentId: parent.intentId,
          driftFingerprint: parent.driftFingerprint,
          agentRole: spec.agentRole,
          metadata: {
            ...(shares[i] !== null ? { budget: { ...parentBudget, maxToolCalls: shares[i] } } : {}),
            autonomyCap: metadata['autonomyCap'],
            plannedBy: 'planner',
          },
        })),
      )
      .returning();

    if (parent.status === 'open') {
      await this.deps.db
        .update(agentGoals)
        .set({ status: 'in_progress', updatedAt: new Date() })
        .where(and(eq(agentGoals.siteId, this.deps.siteId), eq(agentGoals.id, parentGoalId)));
    }
    return rows;
  }

  /**
   * Settles a parent from its children's terminal states (Req 10.5):
   * any failed child → parent `failed` (acceptance unmet); all children
   * completed → parent `completed`; otherwise the parent stays put.
   */
  async settleParent(
    parentGoalId: string,
  ): Promise<{ status: string; settled: boolean; children: number }> {
    const parent = await this.getGoal(parentGoalId);
    if (!parent) {
      throw new PlannerError('NOT_FOUND', 'Parent goal not found.', 404);
    }
    const children = await this.listChildren(parentGoalId);
    if (children.length === 0) {
      return { status: parent.status, settled: false, children: 0 };
    }

    const anyFailed = children.some((child) => child.status === 'failed');
    const allCompleted = children.every((child) => child.status === 'completed');
    if (!anyFailed && !allCompleted) {
      return { status: parent.status, settled: false, children: children.length };
    }

    const nextStatus = anyFailed ? 'failed' : 'completed';
    await this.deps.db
      .update(agentGoals)
      .set({
        status: nextStatus,
        updatedAt: new Date(),
        metadata: {
          ...((parent.metadata ?? {}) as Record<string, unknown>),
          settledFromChildren: true,
          ...(anyFailed ? { failureReason: 'sub_goal_failed' } : {}),
        },
      })
      .where(and(eq(agentGoals.siteId, this.deps.siteId), eq(agentGoals.id, parentGoalId)));

    this.deps.notify?.({
      kind: 'goal',
      severity: nextStatus === 'failed' ? 'warning' : 'info',
      title: `Goal ${nextStatus}`,
      body: `"${parent.title}" ${nextStatus} (${children.length} sub-goals)`,
      deepLink: `/mission-control/goals`,
      entityId: parentGoalId,
    });

    return { status: nextStatus, settled: true, children: children.length };
  }

  async listChildren(parentGoalId: string) {
    return this.deps.db
      .select()
      .from(agentGoals)
      .where(
        and(eq(agentGoals.siteId, this.deps.siteId), eq(agentGoals.parentGoalId, parentGoalId)),
      )
      .orderBy(asc(agentGoals.createdAt));
  }

  private async getGoal(goalId: string) {
    const [row] = await this.deps.db
      .select()
      .from(agentGoals)
      .where(and(eq(agentGoals.siteId, this.deps.siteId), eq(agentGoals.id, goalId)))
      .limit(1);
    return row;
  }
}
