import { aiApprovals, type Database } from '@lumibase/database';
import { and, desc, eq } from 'drizzle-orm';
import { parseApprovalRequester, type ApprovalRequester } from '../approval-requester';

/**
 * Pending deploy approvals (#743), stored in the site's HITL approval table
 * (`lumibase_ai_approvals`, CLAUDE.md rule 4) — the same table and the same
 * pending → decided state machine the organization operations reuse
 * (`organization-harness.ts`). The rows carry `agentName = 'lumibase-deployments'`
 * and a `skillName` of `deploy:trigger` / `deploy:promote`, which is not an AI
 * skill: the AI approval inbox (`GET /ai/approvals`) only lists rows whose skill
 * the harness knows, and `POST /ai/approvals/:id/decide` refuses the rest, so a
 * deploy approval can only be decided through `/deployments/approvals`.
 *
 * Every read and write is scoped by `site_id`.
 */

export const DEPLOY_APPROVAL_AGENT = 'lumibase-deployments';
export const DEPLOY_APPROVAL_SKILLS = ['deploy:trigger', 'deploy:promote'] as const;
export type DeployApprovalSkill = (typeof DEPLOY_APPROVAL_SKILLS)[number];

/** How long a parked deploy may wait for a decision. */
export const DEPLOY_APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type DeployApprovalStatus = 'pending' | 'deciding' | 'approved' | 'rejected' | 'expired' | 'failed';

/** What will be dispatched once approved. Server-built; never from a request body. */
export interface DeployApprovalPlan {
  kind: 'trigger' | 'promote';
  /** `environment`: deploy every target of the environment; `target`: one target. */
  scope: 'environment' | 'target';
  /** Environment whose gate this is (the destination for a promotion). */
  environment: string;
  /** Promotion only: the environment the build comes from. */
  sourceEnvironment?: string;
  /** Promotion only: the ready deployment being promoted. */
  sourceDeploymentId?: string;
  targetIds: string[];
  branch?: string;
  reason?: string;
  requestedBy: ApprovalRequester;
  expiresAt: string;
}

export interface DeployApprovalView {
  id: string;
  kind: DeployApprovalPlan['kind'];
  scope: DeployApprovalPlan['scope'];
  environment: string;
  sourceEnvironment: string | null;
  sourceDeploymentId: string | null;
  targetIds: string[];
  branch: string | null;
  reason: string | null;
  status: string;
  requestedBy: { type: string; id: string | null } | null;
  createdAt: Date;
  expiresAt: string;
  decidedAt: Date | null;
  decidedBy: string | null;
  result: unknown;
}

type Row = typeof aiApprovals.$inferSelect;

/** Parse a stored plan; null when the row is not a well-formed deploy approval. */
export function parseDeployPlan(row: Pick<Row, 'skillName' | 'arguments'>): DeployApprovalPlan | null {
  if (!(DEPLOY_APPROVAL_SKILLS as readonly string[]).includes(row.skillName)) return null;
  const a = row.arguments as Record<string, unknown> | null;
  if (!a || typeof a !== 'object') return null;
  const requestedBy = parseApprovalRequester(a['requestedBy']);
  if (!requestedBy) return null;
  if (a['kind'] !== 'trigger' && a['kind'] !== 'promote') return null;
  if (a['scope'] !== 'environment' && a['scope'] !== 'target') return null;
  if (typeof a['environment'] !== 'string' || typeof a['expiresAt'] !== 'string') return null;
  const targetIds = a['targetIds'];
  if (!Array.isArray(targetIds) || !targetIds.every((t) => typeof t === 'string')) return null;
  const str = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : undefined);
  return {
    kind: a['kind'],
    scope: a['scope'],
    environment: a['environment'],
    sourceEnvironment: str('sourceEnvironment'),
    sourceDeploymentId: str('sourceDeploymentId'),
    targetIds: targetIds as string[],
    branch: str('branch'),
    reason: str('reason'),
    requestedBy,
    expiresAt: a['expiresAt'],
  };
}

function requesterView(requester: ApprovalRequester): DeployApprovalView['requestedBy'] {
  if (requester.kind !== 'principal') return { type: 'agent', id: requester.role };
  const ref = requester.ref;
  if (ref.type === 'user') return { type: 'user', id: ref.userId };
  if (ref.type === 'api_key') return { type: 'api_key', id: ref.apiKeyId };
  return { type: 'dev', id: null };
}

export function toApprovalView(row: Row): DeployApprovalView | null {
  const plan = parseDeployPlan(row);
  if (!plan) return null;
  return {
    id: row.id,
    kind: plan.kind,
    scope: plan.scope,
    environment: plan.environment,
    sourceEnvironment: plan.sourceEnvironment ?? null,
    sourceDeploymentId: plan.sourceDeploymentId ?? null,
    targetIds: plan.targetIds,
    branch: plan.branch ?? null,
    reason: plan.reason ?? null,
    status: row.status,
    requestedBy: requesterView(plan.requestedBy),
    createdAt: row.createdAt,
    expiresAt: plan.expiresAt,
    decidedAt: row.decidedAt,
    decidedBy: row.decidedBy,
    result: row.result ?? null,
  };
}

export class DeployApprovalStore {
  constructor(private readonly deps: { db: Database; siteId: string }) {}

  private scoped(id: string) {
    return and(
      eq(aiApprovals.siteId, this.deps.siteId),
      eq(aiApprovals.id, id),
      eq(aiApprovals.agentName, DEPLOY_APPROVAL_AGENT),
    );
  }

  async create(plan: DeployApprovalPlan): Promise<Row> {
    const [row] = await this.deps.db
      .insert(aiApprovals)
      .values({
        siteId: this.deps.siteId,
        agentName: DEPLOY_APPROVAL_AGENT,
        skillName: plan.kind === 'promote' ? 'deploy:promote' : 'deploy:trigger',
        arguments: plan,
        status: 'pending',
        context: plan.reason ?? null,
      })
      .returning();
    return row!;
  }

  async get(id: string): Promise<Row | undefined> {
    const [row] = await this.deps.db.select().from(aiApprovals).where(this.scoped(id));
    return row;
  }

  async list(status?: string): Promise<Row[]> {
    const conds = [
      eq(aiApprovals.siteId, this.deps.siteId),
      eq(aiApprovals.agentName, DEPLOY_APPROVAL_AGENT),
    ];
    if (status) conds.push(eq(aiApprovals.status, status));
    return this.deps.db
      .select()
      .from(aiApprovals)
      .where(and(...conds))
      .orderBy(desc(aiApprovals.createdAt))
      .limit(100);
  }

  /**
   * Atomic status move `from` → `to`. Returns the updated row, or undefined
   * when the row was not in `from` — that is what makes a double decision (two
   * approvers clicking at once) dispatch at most once.
   */
  async transition(
    id: string,
    from: DeployApprovalStatus,
    to: DeployApprovalStatus,
    extra: { decidedBy?: string | null; result?: unknown } = {},
  ): Promise<Row | undefined> {
    const terminal = to !== 'deciding';
    const [row] = await this.deps.db
      .update(aiApprovals)
      .set({
        status: to,
        ...(terminal ? { decidedAt: new Date() } : {}),
        ...(extra.decidedBy !== undefined ? { decidedBy: extra.decidedBy } : {}),
        ...(extra.result !== undefined ? { result: extra.result } : {}),
      })
      .where(and(this.scoped(id), eq(aiApprovals.status, from)))
      .returning();
    return row;
  }
}
