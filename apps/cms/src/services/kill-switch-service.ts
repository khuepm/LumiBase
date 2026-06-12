import { activity, agentFreezes, type Database } from '@lumibase/database';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { AgentRunService } from './agent-run-service';

/**
 * KillSwitchService — the "stop" right of the human control plane
 * (Content OS task 15). Four escalating scopes:
 *
 * - **cancel run** — delegates to AgentRunService.cancelRun (boundary
 *   semantics from task 3).
 * - **pause intent** — delegates to the intent status machine.
 * - **freeze role** — every new tool call of that agent role is blocked at
 *   the tool-call boundary; in-flight handlers finish, the run is then
 *   cancelled with stopReason `frozen`.
 * - **freeze site** — same, for every agent role on the site. New goal/run
 *   creation is rejected with FROZEN; reads keep working (Req 14.4).
 *
 * `agent_freezes` rows are the audit trail (actor, scope, reason,
 * timestamps); lifting sets `liftedAt`/`liftedBy` instead of deleting.
 */

export interface FreezeView {
  scope: 'site' | 'role';
  targetRole: string | null;
  liftedAt: Date | null;
}

/**
 * Pure freeze resolution: a site freeze dominates everything; a role freeze
 * blocks exactly that role; lifted freezes never block.
 */
export function resolveFreezeScope(
  freezes: readonly FreezeView[],
  agentRole: string,
): 'site' | 'role' | null {
  let roleHit = false;
  for (const freeze of freezes) {
    if (freeze.liftedAt) continue;
    if (freeze.scope === 'site') return 'site';
    if (freeze.scope === 'role' && freeze.targetRole === agentRole) roleHit = true;
  }
  return roleHit ? 'role' : null;
}

export class KillSwitchError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
    this.name = 'KillSwitchError';
  }
}

export interface KillSwitchServiceDeps {
  db: Database;
  siteId: string;
}

export class KillSwitchService {
  constructor(private readonly deps: KillSwitchServiceDeps) {}

  /** Active freezes for this site (audit history excluded). */
  async listActive() {
    return this.deps.db
      .select()
      .from(agentFreezes)
      .where(and(eq(agentFreezes.siteId, this.deps.siteId), isNull(agentFreezes.liftedAt)))
      .orderBy(desc(agentFreezes.createdAt))
      .limit(100);
  }

  /** Freeze + lift history, newest first (Req 14.5). */
  async listHistory(limit = 100) {
    return this.deps.db
      .select()
      .from(agentFreezes)
      .where(eq(agentFreezes.siteId, this.deps.siteId))
      .orderBy(desc(agentFreezes.createdAt))
      .limit(limit);
  }

  /**
   * The freeze scope blocking this agent role right now, or null.
   * Checked by the harness at every tool-call boundary (Req 14.2).
   */
  async frozenScopeFor(agentRole: string): Promise<'site' | 'role' | null> {
    const active = await this.listActive();
    return resolveFreezeScope(
      active.map((row) => ({
        scope: row.scope as 'site' | 'role',
        targetRole: row.targetRole,
        liftedAt: row.liftedAt,
      })),
      agentRole,
    );
  }

  async isSiteFrozen(): Promise<boolean> {
    const active = await this.listActive();
    return active.some((row) => row.scope === 'site');
  }

  async freeze(
    scope: 'site' | 'role',
    options: { targetRole?: string; reason?: string; actor?: string | null } = {},
  ) {
    if (scope === 'role' && !options.targetRole) {
      throw new KillSwitchError('VALIDATION', 'targetRole is required to freeze a role.');
    }
    // Idempotent: an identical active freeze is returned, not duplicated.
    const active = await this.listActive();
    const existing = active.find(
      (row) => row.scope === scope && (scope === 'site' || row.targetRole === options.targetRole),
    );
    if (existing) return existing;

    const [freeze] = await this.deps.db
      .insert(agentFreezes)
      .values({
        siteId: this.deps.siteId,
        scope,
        targetRole: scope === 'role' ? options.targetRole : null,
        reason: options.reason ?? null,
        frozenBy: options.actor ?? null,
      })
      .returning();

    await this.audit('kill_switch.freeze', {
      freezeId: freeze!.id,
      scope,
      targetRole: freeze!.targetRole,
      reason: options.reason ?? null,
    }, options.actor ?? null);
    return freeze!;
  }

  async lift(
    scope: 'site' | 'role',
    options: { targetRole?: string; actor?: string | null } = {},
  ) {
    const active = await this.listActive();
    const matching = active.filter(
      (row) => row.scope === scope && (scope === 'site' || row.targetRole === options.targetRole),
    );
    if (matching.length === 0) {
      throw new KillSwitchError('NOT_FROZEN', 'No active freeze for that scope.', 404);
    }
    for (const freeze of matching) {
      await this.deps.db
        .update(agentFreezes)
        .set({ liftedAt: new Date(), liftedBy: options.actor ?? null })
        .where(and(eq(agentFreezes.id, freeze.id), eq(agentFreezes.siteId, this.deps.siteId)));
      await this.audit('kill_switch.lift', {
        freezeId: freeze.id,
        scope,
        targetRole: freeze.targetRole,
      }, options.actor ?? null);
    }
    return { lifted: matching.length };
  }

  /** Scope dispatcher backing POST /api/v1/agent/kill-switch (Req 14.1). */
  async activate(
    input: { scope: 'run' | 'intent' | 'role' | 'site'; targetId?: string; reason?: string },
    actor: string | null,
  ): Promise<Record<string, unknown>> {
    switch (input.scope) {
      case 'run': {
        if (!input.targetId) throw new KillSwitchError('VALIDATION', 'targetId (runId) is required.');
        const runService = new AgentRunService(this.deps.db, this.deps.siteId);
        const cancelled = await runService.cancelRun(input.targetId, 'killed_by_user');
        if (!cancelled) {
          throw new KillSwitchError('NOT_CANCELLABLE', 'Run not found or already terminal.', 409);
        }
        await this.audit('kill_switch.cancel_run', { runId: input.targetId, reason: input.reason ?? null }, actor);
        return { scope: 'run', runId: input.targetId, status: 'cancelled' };
      }
      case 'intent': {
        if (!input.targetId) throw new KillSwitchError('VALIDATION', 'targetId (intentId) is required.');
        const { IntentService } = await import('./intent-service');
        const intents = new IntentService({ db: this.deps.db, siteId: this.deps.siteId });
        const intent = await intents.pause(input.targetId);
        await this.audit('kill_switch.pause_intent', { intentId: input.targetId, reason: input.reason ?? null }, actor);
        return { scope: 'intent', intentId: intent.id, status: intent.status };
      }
      case 'role': {
        const freeze = await this.freeze('role', {
          targetRole: input.targetId,
          reason: input.reason,
          actor,
        });
        return { scope: 'role', targetRole: freeze.targetRole, freezeId: freeze.id, status: 'frozen' };
      }
      case 'site': {
        const freeze = await this.freeze('site', { reason: input.reason, actor });
        return { scope: 'site', freezeId: freeze.id, status: 'frozen' };
      }
    }
  }

  private async audit(action: string, payload: Record<string, unknown>, actor: string | null): Promise<void> {
    await this.deps.db.insert(activity).values({
      siteId: this.deps.siteId,
      action,
      userId: actor,
      payload,
    });
  }
}
