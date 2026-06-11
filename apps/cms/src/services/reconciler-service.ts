import {
  agentGoals,
  contentDrifts,
  contentIntents,
  type Database,
} from '@lumibase/database';
import { and, asc, desc, eq, isNotNull } from 'drizzle-orm';
import { AutonomyService } from './autonomy-service';

/**
 * ReconcilerService — turns open drift into agent goals (Content OS task 7).
 *
 * Every generated goal records `source='reconciler'` plus the intent id and
 * drift fingerprint in metadata for audit (Req 7.4). Goal creation is
 * bounded by the intent's `maxGoalsPerCycle` budget (Property 11) and a
 * drift never has two open goals at once — assignment flips the drift to
 * `assigned` and stores the goalId (Property 4 / Req 7.1).
 *
 * Circuit breaker: when the most recent N reconciler goals of an intent all
 * failed, the intent flips to `error`, an incident is recorded and no new
 * goals are generated until a human resumes it (Req 7.3).
 */

/** ruleType → default agent role (Req 7.2). Roles ship in Module C. */
export const RULE_ROLE_ROUTING: Record<string, string> = {
  required_fields: 'writer',
  freshness: 'writer',
  translations: 'translator',
  link_health: 'librarian',
  field_constraint: 'writer',
  glossary_compliance: 'taxonomist',
};

export function routeRole(ruleType: string): string {
  return RULE_ROLE_ROUTING[ruleType] ?? 'writer';
}

export interface ReconcilableDrift {
  id: string;
  fingerprint: string;
  ruleType: string;
  ruleKey: string;
  itemId: string;
  status: string;
  goalId: string | null;
}

export interface ReconciliationPlan {
  /** Drifts selected for goal creation this cycle (≤ maxGoalsPerCycle). */
  selected: ReconcilableDrift[];
  /** Open drifts deferred to the next cycle by the budget. */
  deferred: number;
}

/**
 * Pure planner: only `open` drifts without a goal are eligible (a drift
 * never gets a second concurrent goal), capped at maxGoalsPerCycle.
 */
export function planReconciliation(
  drifts: readonly ReconcilableDrift[],
  maxGoalsPerCycle: number,
): ReconciliationPlan {
  const cap = Math.max(0, Math.trunc(maxGoalsPerCycle));
  const eligible: ReconcilableDrift[] = [];
  const seen = new Set<string>();
  for (const drift of drifts) {
    if (drift.status !== 'open' || drift.goalId) continue;
    if (seen.has(drift.fingerprint)) continue;
    seen.add(drift.fingerprint);
    eligible.push(drift);
  }
  return {
    selected: eligible.slice(0, cap),
    deferred: Math.max(0, eligible.length - cap),
  };
}

export interface ReconcileResult {
  goalsCreated: number;
  deferred: number;
  breakerTripped: boolean;
}

export interface ReconcilerServiceDeps {
  db: Database;
  siteId: string;
  /** Consecutive failed goals before the breaker trips. */
  breakerThreshold?: number;
}

export class ReconcilerService {
  private readonly breakerThreshold: number;

  constructor(private readonly deps: ReconcilerServiceDeps) {
    this.breakerThreshold = Math.max(1, deps.breakerThreshold ?? 3);
  }

  async reconcileIntent(intentId: string): Promise<ReconcileResult> {
    const [intent] = await this.deps.db
      .select()
      .from(contentIntents)
      .where(and(eq(contentIntents.siteId, this.deps.siteId), eq(contentIntents.id, intentId)))
      .limit(1);
    if (!intent || intent.status !== 'active') {
      return { goalsCreated: 0, deferred: 0, breakerTripped: false };
    }

    if (await this.breakerShouldTrip(intentId)) {
      await this.tripBreaker(intentId);
      return { goalsCreated: 0, deferred: 0, breakerTripped: true };
    }

    const budget = (intent.budget ?? {}) as { maxGoalsPerCycle?: number };
    const maxGoalsPerCycle = budget.maxGoalsPerCycle ?? 10;

    const openDrifts = await this.deps.db
      .select({
        id: contentDrifts.id,
        fingerprint: contentDrifts.fingerprint,
        ruleType: contentDrifts.ruleType,
        ruleKey: contentDrifts.ruleKey,
        itemId: contentDrifts.itemId,
        status: contentDrifts.status,
        goalId: contentDrifts.goalId,
        detail: contentDrifts.detail,
      })
      .from(contentDrifts)
      .where(
        and(
          eq(contentDrifts.siteId, this.deps.siteId),
          eq(contentDrifts.intentId, intentId),
          eq(contentDrifts.status, 'open'),
        ),
      )
      .orderBy(asc(contentDrifts.createdAt))
      .limit(Math.max(maxGoalsPerCycle * 2, 50));

    const plan = planReconciliation(openDrifts as ReconcilableDrift[], maxGoalsPerCycle);

    let goalsCreated = 0;
    for (const drift of plan.selected) {
      const role = routeRole(drift.ruleType);
      const [goal] = await this.deps.db
        .insert(agentGoals)
        .values({
          siteId: this.deps.siteId,
          title: `Fix ${drift.ruleType} on ${intent.collection}/${drift.itemId}`,
          description: `Drift ${drift.ruleKey} detected by intent "${intent.name}".`,
          source: 'reconciler',
          assigneeAgent: role,
          priority: 'normal',
          status: 'open',
          successCriteria: { driftResolved: drift.fingerprint },
          metadata: {
            origin: 'reconciler',
            intentId,
            driftFingerprint: drift.fingerprint,
            ruleType: drift.ruleType,
            ruleKey: drift.ruleKey,
            itemId: drift.itemId,
            collection: intent.collection,
            // Effective autonomy at execution = min(cap, grant) via the
            // resolver; the cap travels with the goal (Req 7.2).
            autonomyCap: intent.autonomyCap,
          },
        })
        .returning();

      await this.deps.db
        .update(contentDrifts)
        .set({ status: 'assigned', goalId: goal!.id, updatedAt: new Date() })
        .where(and(eq(contentDrifts.siteId, this.deps.siteId), eq(contentDrifts.id, drift.id)));
      goalsCreated += 1;
    }

    return { goalsCreated, deferred: plan.deferred, breakerTripped: false };
  }

  /**
   * True when the most recent `breakerThreshold` goals generated for this
   * intent all failed (Req 7.3).
   */
  private async breakerShouldTrip(intentId: string): Promise<boolean> {
    const recent = await this.deps.db
      .select({ goalId: contentDrifts.goalId, updatedAt: contentDrifts.updatedAt })
      .from(contentDrifts)
      .where(
        and(
          eq(contentDrifts.siteId, this.deps.siteId),
          eq(contentDrifts.intentId, intentId),
          isNotNull(contentDrifts.goalId),
        ),
      )
      .orderBy(desc(contentDrifts.updatedAt))
      .limit(this.breakerThreshold);

    if (recent.length < this.breakerThreshold) return false;

    const goalIds = recent.map((row) => row.goalId).filter((id): id is string => Boolean(id));
    if (goalIds.length < this.breakerThreshold) return false;

    let failed = 0;
    for (const goalId of goalIds) {
      const [goal] = await this.deps.db
        .select({ status: agentGoals.status })
        .from(agentGoals)
        .where(and(eq(agentGoals.siteId, this.deps.siteId), eq(agentGoals.id, goalId)))
        .limit(1);
      if (goal?.status === 'failed') failed += 1;
    }
    return failed >= this.breakerThreshold;
  }

  private async tripBreaker(intentId: string): Promise<void> {
    const reason = `Circuit breaker: last ${this.breakerThreshold} reconciler goals failed.`;
    await this.deps.db
      .update(contentIntents)
      .set({ status: 'error', statusReason: reason, updatedAt: new Date() })
      .where(and(eq(contentIntents.siteId, this.deps.siteId), eq(contentIntents.id, intentId)));

    const autonomy = new AutonomyService({ db: this.deps.db, siteId: this.deps.siteId });
    await autonomy.recordIncident({
      agentRole: 'reconciler',
      source: 'runtime_error',
      severity: 'medium',
      detail: { reason: 'circuit_breaker', intentId, threshold: this.breakerThreshold },
    });
  }
}
