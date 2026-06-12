import {
  activity,
  agentApprovals,
  agentIncidents,
  agentRuns,
  type Database,
} from '@lumibase/database';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { AgentRunService } from './agent-run-service';
import {
  AutonomyService,
  type AutonomyLevel,
} from './autonomy-service';

/**
 * TrustLedgerService — the promotion half of earned autonomy
 * (Content OS task 13.1 / Req 12.5).
 *
 * Promotion is asymmetric by design: demotion is automatic and immediate
 * (AutonomyService.recordIncident), but a promotion is only ever a
 * *proposal* — an approval record a human must decide. The evidence
 * (run-success streak, approval approve-rate, zero open incidents) is
 * computed from the harness audit tables and attached to the proposal;
 * nothing changes until a person approves it.
 */

// ---------------------------------------------------------------------------
// Pure evidence evaluation (Property 7, promotion half)
// ---------------------------------------------------------------------------

export interface PromotionThresholds {
  /** Consecutive most-recent runs that must have succeeded. */
  streak: number;
  /** Minimum decided approvals before the rate is meaningful. */
  minDecided: number;
  /** Required approved/(approved+rejected) ratio. */
  approveRate: number;
}

export const DEFAULT_PROMOTION_THRESHOLDS: PromotionThresholds = {
  streak: 10,
  minDecided: 5,
  approveRate: 0.9,
};

export interface PromotionEvidenceInput {
  currentLevel: number;
  /** Most-recent-first run statuses for the role. */
  runStatuses: string[];
  approvalsDecided: { approved: number; rejected: number };
  openIncidents: number;
  thresholds: PromotionThresholds;
}

export interface PromotionEvaluation {
  eligible: boolean;
  targetLevel: AutonomyLevel;
  reasons: string[];
}

/**
 * A candidate is eligible only when every condition holds: below L4, a
 * full success streak, enough decided approvals at the required rate, and
 * zero open incidents. The target is always exactly one level up.
 */
export function evaluatePromotionEvidence(input: PromotionEvidenceInput): PromotionEvaluation {
  const reasons: string[] = [];
  const current = Math.min(4, Math.max(0, Math.trunc(input.currentLevel)));
  const targetLevel = Math.min(4, current + 1) as AutonomyLevel;

  if (current >= 4) {
    reasons.push('already at L4');
  }

  const streakWindow = input.runStatuses.slice(0, input.thresholds.streak);
  if (streakWindow.length < input.thresholds.streak) {
    reasons.push(`needs ${input.thresholds.streak} recent runs, has ${streakWindow.length}`);
  } else if (!streakWindow.every((status) => status === 'succeeded')) {
    reasons.push('success streak broken');
  }

  const decided = input.approvalsDecided.approved + input.approvalsDecided.rejected;
  if (decided < input.thresholds.minDecided) {
    reasons.push(`needs ${input.thresholds.minDecided} decided approvals, has ${decided}`);
  } else {
    const rate = input.approvalsDecided.approved / decided;
    if (rate < input.thresholds.approveRate) {
      reasons.push(`approve rate ${(rate * 100).toFixed(0)}% below ${input.thresholds.approveRate * 100}%`);
    }
  }

  if (input.openIncidents > 0) {
    reasons.push(`${input.openIncidents} open incident(s)`);
  }

  return { eligible: reasons.length === 0, targetLevel, reasons };
}

/**
 * A promotion proposal may only be applied by a human decision on a
 * pending promotion approval — there is no auto-commit path (Req 12.5).
 */
export function validatePromotionApplication(
  approval: { kind: string; status: string } | null | undefined,
  userId: string | null | undefined,
): { ok: true } | { ok: false; code: string } {
  if (!approval) return { ok: false, code: 'NOT_FOUND' };
  if (approval.kind !== 'promotion') return { ok: false, code: 'NOT_A_PROMOTION' };
  if (approval.status !== 'pending') return { ok: false, code: 'ALREADY_DECIDED' };
  if (!userId) return { ok: false, code: 'HUMAN_REQUIRED' };
  return { ok: true };
}

/** Mirror of the resolver defaults: dangerous capabilities start at L1. */
export function defaultLevelFor(capability: string): AutonomyLevel {
  const dangerous = /^schema:(?!read)/.test(capability) || /:delete$/.test(capability);
  return dangerous ? 1 : 2;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class TrustLedgerError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
    this.name = 'TrustLedgerError';
  }
}

export interface TrustLedgerServiceDeps {
  db: Database;
  siteId: string;
  thresholds?: Partial<PromotionThresholds>;
}

interface PromotionProposalMeta {
  agentRole: string;
  capability: string;
  fromLevel: number;
  targetLevel: number;
  evidence: Record<string, unknown>;
}

export class TrustLedgerService {
  private readonly thresholds: PromotionThresholds;
  private readonly autonomy: AutonomyService;

  constructor(private readonly deps: TrustLedgerServiceDeps) {
    this.thresholds = { ...DEFAULT_PROMOTION_THRESHOLDS, ...deps.thresholds };
    this.autonomy = new AutonomyService({ db: deps.db, siteId: deps.siteId });
  }

  /** Gathers evidence for (role, capability) from the harness audit tables. */
  async evaluateCandidate(agentRole: string, capability: string): Promise<
    PromotionEvaluation & { currentLevel: number; evidence: Record<string, unknown> }
  > {
    const grantLevel = await this.autonomy.getGrantLevel(agentRole, capability);
    const currentLevel = grantLevel ?? defaultLevelFor(capability);

    const runs = await this.deps.db
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(and(eq(agentRuns.siteId, this.deps.siteId), eq(agentRuns.agentName, agentRole)))
      .orderBy(desc(agentRuns.createdAt))
      .limit(this.thresholds.streak);

    const decidedRows = await this.deps.db
      .select({ status: agentApprovals.status })
      .from(agentApprovals)
      .where(
        and(
          eq(agentApprovals.siteId, this.deps.siteId),
          eq(agentApprovals.requestedByAgent, agentRole),
          eq(agentApprovals.kind, 'approval'),
        ),
      )
      .orderBy(desc(agentApprovals.createdAt))
      .limit(200);
    const approvalsDecided = {
      approved: decidedRows.filter((row) => row.status === 'approved').length,
      rejected: decidedRows.filter((row) => row.status === 'rejected').length,
    };

    const incidents = await this.deps.db
      .select({ id: agentIncidents.id })
      .from(agentIncidents)
      .where(
        and(
          eq(agentIncidents.siteId, this.deps.siteId),
          eq(agentIncidents.agentRole, agentRole),
          isNull(agentIncidents.resolvedAt),
        ),
      )
      .limit(50);

    const input: PromotionEvidenceInput = {
      currentLevel,
      runStatuses: runs.map((row) => row.status),
      approvalsDecided,
      openIncidents: incidents.length,
      thresholds: this.thresholds,
    };
    const evaluation = evaluatePromotionEvidence(input);
    return {
      ...evaluation,
      currentLevel,
      evidence: {
        runStatuses: input.runStatuses,
        approvalsDecided,
        openIncidents: incidents.length,
        thresholds: this.thresholds,
      },
    };
  }

  /**
   * Creates a promotion proposal (a `kind='promotion'` approval) when the
   * candidate is eligible and no proposal is already pending. The grant is
   * untouched until a human approves (Req 12.5).
   */
  async proposePromotion(agentRole: string, capability: string): Promise<
    { proposed: false; reasons: string[] } | { proposed: true; approvalId: string; targetLevel: number }
  > {
    const evaluation = await this.evaluateCandidate(agentRole, capability);
    if (!evaluation.eligible) {
      return { proposed: false, reasons: evaluation.reasons };
    }

    const pending = await this.listPendingProposals();
    const meta: PromotionProposalMeta = {
      agentRole,
      capability,
      fromLevel: evaluation.currentLevel,
      targetLevel: evaluation.targetLevel,
      evidence: evaluation.evidence,
    };
    const duplicate = pending.find((row) => {
      const existing = row.proposal;
      return existing?.agentRole === agentRole && existing?.capability === capability;
    });
    if (duplicate) {
      return { proposed: false, reasons: ['proposal already pending'] };
    }

    // The proposal rides on a transient trust-ledger run whose metrics
    // carry the full evidence — auditable and replayable.
    const runService = new AgentRunService(this.deps.db, this.deps.siteId);
    const run = await runService.ensureRun({
      agentName: 'trust-ledger',
      title: `Promote ${agentRole} on ${capability} to L${evaluation.targetLevel}`,
    });
    await runService.closeRun(run.runId, { promotion: meta as unknown as Record<string, unknown> });

    const [approval] = await this.deps.db
      .insert(agentApprovals)
      .values({
        runId: run.runId,
        siteId: this.deps.siteId,
        subjectType: 'autonomy_grant',
        subjectId: `${agentRole}|${capability}`,
        status: 'pending',
        approvalPolicy: 'before_commit',
        kind: 'promotion',
        requestedByAgent: 'trust-ledger',
      })
      .returning();

    await this.deps.db.insert(activity).values({
      siteId: this.deps.siteId,
      action: 'trust_ledger.promotion_proposed',
      payload: { approvalId: approval!.id, ...meta },
    });

    return { proposed: true, approvalId: approval!.id, targetLevel: evaluation.targetLevel };
  }

  /** Pending promotion proposals with their evidence. */
  async listPendingProposals(): Promise<
    Array<{ approval: typeof agentApprovals.$inferSelect; proposal: PromotionProposalMeta | null }>
  > {
    const rows = await this.deps.db
      .select()
      .from(agentApprovals)
      .where(
        and(
          eq(agentApprovals.siteId, this.deps.siteId),
          eq(agentApprovals.kind, 'promotion'),
          eq(agentApprovals.status, 'pending'),
        ),
      )
      .orderBy(desc(agentApprovals.createdAt))
      .limit(100);

    const result = [] as Array<{ approval: typeof agentApprovals.$inferSelect; proposal: PromotionProposalMeta | null }>;
    for (const approval of rows) {
      result.push({ approval, proposal: await this.proposalMeta(approval.runId) });
    }
    return result;
  }

  /**
   * Applies or rejects a promotion proposal. Only a human decision on a
   * pending `kind='promotion'` approval can change the grant (Req 12.5).
   */
  async decidePromotion(
    approvalId: string,
    decision: 'approved' | 'rejected',
    userId: string | null,
    reason?: string,
  ): Promise<{ decision: string; newLevel?: number }> {
    const [approval] = await this.deps.db
      .select()
      .from(agentApprovals)
      .where(and(eq(agentApprovals.id, approvalId), eq(agentApprovals.siteId, this.deps.siteId)))
      .limit(1);

    const validation = validatePromotionApplication(approval, userId);
    if (!validation.ok) {
      throw new TrustLedgerError(validation.code, `Cannot decide promotion: ${validation.code}`, validation.code === 'NOT_FOUND' ? 404 : 409);
    }

    await this.deps.db
      .update(agentApprovals)
      .set({ status: decision, decidedBy: userId, decisionReason: reason ?? null, decidedAt: new Date() })
      .where(and(eq(agentApprovals.id, approvalId), eq(agentApprovals.siteId, this.deps.siteId)));

    if (decision === 'rejected') {
      await this.deps.db.insert(activity).values({
        siteId: this.deps.siteId,
        action: 'trust_ledger.promotion_rejected',
        userId,
        payload: { approvalId, reason: reason ?? null },
      });
      return { decision };
    }

    const proposal = await this.proposalMeta(approval!.runId);
    if (!proposal) {
      throw new TrustLedgerError('PROPOSAL_LOST', 'Promotion proposal metadata missing.', 500);
    }
    await this.autonomy.setGrant(
      proposal.agentRole,
      proposal.capability,
      Math.min(4, Math.max(0, proposal.targetLevel)) as AutonomyLevel,
      { grantedBy: userId, evidence: { promotion: proposal } },
    );
    await this.deps.db.insert(activity).values({
      siteId: this.deps.siteId,
      action: 'trust_ledger.promotion_applied',
      userId,
      payload: { approvalId, ...proposal },
    });
    return { decision, newLevel: proposal.targetLevel };
  }

  /**
   * Periodic sweep (Flows `trust-promote-check`): evaluates every existing
   * grant below L4 and proposes promotions for eligible candidates.
   */
  async sweepPromotions(): Promise<{ checked: number; proposed: number }> {
    const grants = await this.autonomy.listGrants();
    let proposed = 0;
    for (const grant of grants) {
      if (grant.level >= 4) continue;
      const result = await this.proposePromotion(grant.agentRole, grant.capability);
      if (result.proposed) proposed += 1;
    }
    return { checked: grants.length, proposed };
  }

  private async proposalMeta(runId: string): Promise<PromotionProposalMeta | null> {
    const [run] = await this.deps.db
      .select({ metrics: agentRuns.metrics })
      .from(agentRuns)
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.siteId, this.deps.siteId)))
      .limit(1);
    const metrics = (run?.metrics ?? {}) as { promotion?: PromotionProposalMeta };
    return metrics.promotion ?? null;
  }
}
