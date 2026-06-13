import { agentAutonomyGrants, agentIncidents, type Database } from '@lumibase/database';
import { and, desc, eq, isNull } from 'drizzle-orm';

/**
 * AutonomyService — earned-autonomy trust ledger (L0-L4).
 *
 * Level semantics enforced at the harness risk decision:
 * - L0 shadow: run, but outputs land in artifacts only — no side effects.
 * - L1 propose: every action creates an approval (full HITL).
 * - L2 co-sign: safe actions execute, dangerous actions await approval.
 * - L3 veto-window: dangerous actions execute into staging and auto-commit
 *   after a veto window unless a human vetoes.
 * - L4 autopilot: execute within capability and budget; kill switch applies.
 *
 * Promotion requires human approval (it is itself an approval); demotion is
 * automatic and immediate on incidents. Irreversible actions never run above
 * the hard ceiling (L2) regardless of grants.
 */

export const AUTONOMY_LEVELS = {
  SHADOW: 0,
  PROPOSE: 1,
  CO_SIGN: 2,
  VETO_WINDOW: 3,
  AUTOPILOT: 4,
} as const;

export type AutonomyLevel = 0 | 1 | 2 | 3 | 4;

/** Hard ceiling for irreversible actions (Req 12.7). */
export const IRREVERSIBLE_HARD_CEILING: AutonomyLevel = AUTONOMY_LEVELS.CO_SIGN;

export interface ResolveAutonomyInput {
  /** Grant level for (site, role, capability); undefined when no grant exists. */
  grantLevel?: number | null;
  /** True when the capability/skill is classified dangerous. */
  dangerous: boolean;
  /** Optional ceiling from the governing content intent (autonomyCap). */
  intentCap?: number | null;
  /** True for actions that cannot be reverted (hard delete, outbound sends). */
  irreversible?: boolean;
}

function clampLevel(value: number): AutonomyLevel {
  return Math.min(4, Math.max(0, Math.trunc(value))) as AutonomyLevel;
}

/**
 * Pure resolver: effective level = min(grant-or-default, intentCap, hard
 * ceiling for irreversible actions). Defaults without a grant: L2 for safe
 * capabilities, L1 for dangerous ones (Req 12.2).
 */
export function resolveAutonomy(input: ResolveAutonomyInput): AutonomyLevel {
  const fallback: AutonomyLevel = input.dangerous
    ? AUTONOMY_LEVELS.PROPOSE
    : AUTONOMY_LEVELS.CO_SIGN;
  let level: AutonomyLevel =
    input.grantLevel === undefined || input.grantLevel === null
      ? fallback
      : clampLevel(input.grantLevel);

  if (input.intentCap !== undefined && input.intentCap !== null) {
    level = clampLevel(Math.min(level, input.intentCap));
  }
  if (input.irreversible) {
    level = clampLevel(Math.min(level, IRREVERSIBLE_HARD_CEILING));
  }
  return level;
}

/** Demotion policy: high severity drops straight to L1, otherwise -1 (Req 12.6). */
export function demotedLevel(current: number, severity: 'low' | 'medium' | 'high'): AutonomyLevel {
  if (severity === 'high') {
    return clampLevel(Math.min(current, AUTONOMY_LEVELS.PROPOSE));
  }
  return clampLevel(current - 1);
}

export interface AutonomyServiceDeps {
  db: Database;
  siteId: string;
}

export interface IncidentInput {
  agentRole: string;
  capability?: string | null;
  source: 'veto' | 'eval_fail' | 'human_report' | 'load_guard' | 'runtime_error';
  severity?: 'low' | 'medium' | 'high';
  runId?: string | null;
  detail?: Record<string, unknown>;
}

export class AutonomyService {
  constructor(private readonly deps: AutonomyServiceDeps) {}

  /** Effective grant level for (role, capability), ignoring expired grants. */
  async getGrantLevel(agentRole: string, capability: string): Promise<number | null> {
    const [grant] = await this.deps.db
      .select()
      .from(agentAutonomyGrants)
      .where(
        and(
          eq(agentAutonomyGrants.siteId, this.deps.siteId),
          eq(agentAutonomyGrants.agentRole, agentRole),
          eq(agentAutonomyGrants.capability, capability),
        ),
      )
      .limit(1);
    if (!grant) return null;
    if (grant.expiresAt && grant.expiresAt <= new Date()) return null;
    return grant.level;
  }

  /** Resolves the effective autonomy level for an action. */
  async resolve(
    agentRole: string,
    capability: string,
    options: { dangerous: boolean; intentCap?: number | null; irreversible?: boolean },
  ): Promise<AutonomyLevel> {
    const grantLevel = await this.getGrantLevel(agentRole, capability);
    return resolveAutonomy({ grantLevel, ...options });
  }

  async listGrants() {
    return this.deps.db
      .select()
      .from(agentAutonomyGrants)
      .where(eq(agentAutonomyGrants.siteId, this.deps.siteId))
      .orderBy(desc(agentAutonomyGrants.updatedAt))
      .limit(500);
  }

  /**
   * Sets a grant level. Callers must route promotions through an approval —
   * this method records the decision once a human has approved (Req 12.5);
   * demotions call it directly via `recordIncident`.
   */
  async setGrant(
    agentRole: string,
    capability: string,
    level: AutonomyLevel,
    options: { grantedBy?: string | null; evidence?: Record<string, unknown>; expiresAt?: Date | null } = {},
  ) {
    const existing = await this.deps.db
      .select({ id: agentAutonomyGrants.id })
      .from(agentAutonomyGrants)
      .where(
        and(
          eq(agentAutonomyGrants.siteId, this.deps.siteId),
          eq(agentAutonomyGrants.agentRole, agentRole),
          eq(agentAutonomyGrants.capability, capability),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      const [updated] = await this.deps.db
        .update(agentAutonomyGrants)
        .set({
          level,
          grantedBy: options.grantedBy ?? null,
          grantedAt: new Date(),
          evidence: options.evidence ?? {},
          expiresAt: options.expiresAt ?? null,
          updatedAt: new Date(),
        })
        .where(eq(agentAutonomyGrants.id, existing[0]!.id))
        .returning();
      return updated!;
    }

    const [created] = await this.deps.db
      .insert(agentAutonomyGrants)
      .values({
        siteId: this.deps.siteId,
        agentRole,
        capability,
        level,
        grantedBy: options.grantedBy ?? null,
        evidence: options.evidence ?? {},
        expiresAt: options.expiresAt ?? null,
      })
      .returning();
    return created!;
  }

  /**
   * Records an incident and applies automatic, immediate demotion to the
   * matching grant (Req 12.6). Returns the incident and the new level when
   * a demotion occurred.
   */
  async recordIncident(input: IncidentInput): Promise<{
    incidentId: string;
    demotedTo: AutonomyLevel | null;
  }> {
    const severity = input.severity ?? 'medium';
    const [incident] = await this.deps.db
      .insert(agentIncidents)
      .values({
        siteId: this.deps.siteId,
        agentRole: input.agentRole,
        capability: input.capability ?? null,
        source: input.source,
        severity,
        runId: input.runId ?? null,
        detail: input.detail ?? {},
      })
      .returning();

    let demotedTo: AutonomyLevel | null = null;
    if (input.capability) {
      const current = await this.getGrantLevel(input.agentRole, input.capability);
      if (current !== null) {
        const next = demotedLevel(current, severity);
        if (next < current) {
          await this.setGrant(input.agentRole, input.capability, next, {
            evidence: { demotion: { incidentId: incident!.id, from: current, severity } },
          });
          demotedTo = next;
        }
      }
    }
    return { incidentId: incident!.id, demotedTo };
  }

  async listIncidents(options: { openOnly?: boolean } = {}) {
    const where = options.openOnly
      ? and(eq(agentIncidents.siteId, this.deps.siteId), isNull(agentIncidents.resolvedAt))
      : eq(agentIncidents.siteId, this.deps.siteId);
    return this.deps.db
      .select()
      .from(agentIncidents)
      .where(where)
      .orderBy(desc(agentIncidents.createdAt))
      .limit(200);
  }

  async resolveIncident(id: string, resolvedBy: string | null) {
    const [incident] = await this.deps.db
      .update(agentIncidents)
      .set({ resolvedAt: new Date(), resolvedBy })
      .where(and(eq(agentIncidents.siteId, this.deps.siteId), eq(agentIncidents.id, id)))
      .returning();
    return incident ?? null;
  }
}
