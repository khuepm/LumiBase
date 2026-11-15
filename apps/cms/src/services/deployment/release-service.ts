import type { deployments } from '@lumibase/database';
import type { ApprovalRequester } from '../approval-requester';
import type { ApprovalDecider } from '../external-action-audit';
import {
  DEPLOY_APPROVAL_TTL_MS,
  parseDeployPlan,
  toApprovalView,
  type DeployApprovalPlan,
  type DeployApprovalStore,
  type DeployApprovalView,
} from './deploy-approvals';
import { DeploymentError, type DeploymentService } from './deployment-service';
import {
  canApproveEnvironment,
  canTriggerEnvironment,
  canTriggerTarget,
  environmentsForTarget,
  gatingEnvironmentForTarget,
  type DeploymentEnvironment,
  type DeploymentEnvironmentStore,
} from './environments';

/**
 * Environment deploys, promotion and the approval gate (#743).
 *
 * Request side: the caller's live capabilities decide whether they may ask at
 * all (`deploy:trigger:<env|target|*>`). An environment with
 * `requiresApproval` then parks the request as a pending approval instead of
 * dispatching; everything else dispatches immediately.
 *
 * Decision side: only a signed-in human holding `deploy:approve:<env|*>` who is
 * NOT the requester may approve. At approval the requester's grant is resolved
 * again (a demoted requester's parked deploy does not go out) and the plan is
 * re-checked against the current environment map, then dispatched exactly once
 * (atomic `pending → deciding` claim). The requester may withdraw (reject)
 * their own request.
 *
 * Every refusal, request, approval and rejection is audited.
 */

type DeploymentRow = typeof deployments.$inferSelect;

export interface DeployCaller {
  /** Live capabilities (`admin` marker for a site admin). */
  capabilities: string[];
  /** Persistable identity; null when the caller cannot be identified. */
  requester: ApprovalRequester | null;
  /** Who would be deciding, from trusted auth only. */
  decider: ApprovalDecider;
  actorEmail?: string;
  /** `users.id` / run id recorded on dispatched deployments. */
  triggeredBy?: string;
}

export interface DispatchResult {
  targetId: string;
  ok: boolean;
  deployment: DeploymentRow | null;
  /** Promotion only. */
  mode?: 'native' | 'retrigger';
  error?: { code: string; message: string };
}

export type DeployRequestOutcome =
  | { status: 'dispatched'; environment: string | null; results: DispatchResult[] }
  | { status: 'pending_approval'; environment: string; approval: DeployApprovalView };

export type AuditFn = (event: string, metadata: Record<string, unknown>, actorEmail?: string) => void;

export interface DeploymentReleaseServiceDeps {
  deployments: DeploymentService;
  environments: DeploymentEnvironmentStore;
  approvals: DeployApprovalStore;
  audit: AuditFn;
  now?: () => Date;
}

function sameRequester(a: ApprovalRequester, decider: ApprovalDecider): boolean {
  return (
    a.kind === 'principal' &&
    a.ref.type === 'user' &&
    decider.kind === 'human' &&
    typeof decider.userId === 'string' &&
    a.ref.userId === decider.userId
  );
}

function requesterEquals(a: ApprovalRequester, b: ApprovalRequester | null): boolean {
  if (!b || a.kind !== 'principal' || b.kind !== 'principal') return false;
  if (a.ref.type !== b.ref.type || a.ref.siteId !== b.ref.siteId) return false;
  if (a.ref.type === 'user' && b.ref.type === 'user') return a.ref.userId === b.ref.userId;
  if (a.ref.type === 'api_key' && b.ref.type === 'api_key') return a.ref.apiKeyId === b.ref.apiKeyId;
  return false;
}

export class DeploymentReleaseService {
  constructor(private readonly deps: DeploymentReleaseServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private deny(event: string, metadata: Record<string, unknown>, caller: DeployCaller, code: string, message: string): never {
    this.deps.audit(event, { ...metadata, code }, caller.actorEmail);
    throw new DeploymentError(code, message);
  }

  listEnvironments(): Promise<DeploymentEnvironment[]> {
    return this.deps.environments.read();
  }

  /** Replace the environment map (site admin only — enforced by the route). */
  async updateEnvironments(
    environments: DeploymentEnvironment[],
    actorEmail?: string,
  ): Promise<DeploymentEnvironment[]> {
    const known = new Set((await this.deps.deployments.listTargets()).map((t) => t.id));
    const unknown = environments.flatMap((env) => env.targetIds.filter((id) => !known.has(id)));
    if (unknown.length > 0) {
      throw new DeploymentError('UNKNOWN_TARGET', `Unknown deployment target(s): ${[...new Set(unknown)].join(', ')}.`);
    }
    const saved = await this.deps.environments.write(environments);
    this.deps.audit('deployment.environments.updated', {
      environments: saved.map((env) => ({
        key: env.key,
        targetIds: env.targetIds,
        requiresApproval: env.requiresApproval,
        promotesTo: env.promotesTo,
      })),
    }, actorEmail);
    return saved;
  }

  async environment(key: string): Promise<DeploymentEnvironment> {
    const env = (await this.deps.environments.read()).find((e) => e.key === key);
    if (!env) throw new DeploymentError('ENVIRONMENT_NOT_FOUND', `Unknown environment '${key}'.`);
    return env;
  }

  // ── Requests ─────────────────────────────────────────────────────────────

  /** Deploy every target of an environment (or park it for approval). */
  async requestEnvironmentDeploy(
    caller: DeployCaller,
    envKey: string,
    opts: { branch?: string; reason?: string },
  ): Promise<DeployRequestOutcome> {
    const env = await this.environment(envKey);
    if (!canTriggerEnvironment(caller.capabilities, env)) {
      this.deny('deployment.trigger.denied', { environment: env.key }, caller, 'FORBIDDEN',
        `Capability deploy:trigger:${env.key} is required.`);
    }
    if (env.targetIds.length === 0) {
      throw new DeploymentError('NO_TARGETS', `Environment '${env.key}' has no deployment targets.`);
    }
    if (env.requiresApproval) {
      return this.park(caller, {
        kind: 'trigger',
        scope: 'environment',
        environment: env.key,
        targetIds: [...env.targetIds],
        branch: opts.branch,
        reason: opts.reason,
      });
    }
    const results = await this.dispatchTrigger(env.targetIds, opts, caller.triggeredBy);
    return { status: 'dispatched', environment: env.key, results };
  }

  /**
   * Deploy one target directly. Governed by the environments it belongs to: if
   * any of them requires approval, the request is parked under that one.
   * Returns the raw deployment row on dispatch (the pre-#743 contract).
   */
  async requestTargetDeploy(
    caller: DeployCaller,
    targetId: string,
    opts: { branch?: string; reason?: string },
  ): Promise<{ status: 'dispatched'; deployment: DeploymentRow } | Extract<DeployRequestOutcome, { status: 'pending_approval' }>> {
    const environments = await this.deps.environments.read();
    const governing = environmentsForTarget(environments, targetId);
    if (!canTriggerTarget(caller.capabilities, targetId, governing)) {
      this.deny('deployment.trigger.denied', { targetId, environments: governing.map((e) => e.key) }, caller,
        'FORBIDDEN', `Capability deploy:trigger:${governing[0]?.key ?? targetId} is required.`);
    }
    const gate = gatingEnvironmentForTarget(environments, targetId);
    if (gate) {
      return this.park(caller, {
        kind: 'trigger',
        scope: 'target',
        environment: gate.key,
        targetIds: [targetId],
        branch: opts.branch,
        reason: opts.reason,
      });
    }
    const deployment = await this.deps.deployments.trigger(targetId, {
      branch: opts.branch,
      reason: opts.reason,
      source: 'manual',
      triggeredBy: caller.triggeredBy,
    });
    return { status: 'dispatched', deployment };
  }

  /** Promote `sourceKey`'s ready build into the environment it promotes to. */
  async requestPromotion(
    caller: DeployCaller,
    sourceKey: string,
    opts: { deploymentId?: string; reason?: string },
  ): Promise<DeployRequestOutcome> {
    const environments = await this.deps.environments.read();
    const source = environments.find((e) => e.key === sourceKey);
    if (!source) throw new DeploymentError('ENVIRONMENT_NOT_FOUND', `Unknown environment '${sourceKey}'.`);
    const dest = source.promotesTo ? environments.find((e) => e.key === source.promotesTo) : undefined;
    if (!dest) {
      throw new DeploymentError('NO_PROMOTION_TARGET', `Environment '${source.key}' does not promote anywhere.`);
    }
    // Promotion is a deploy INTO the destination: that is the grant that counts.
    if (!canTriggerEnvironment(caller.capabilities, dest)) {
      this.deny('deployment.trigger.denied', { environment: dest.key, sourceEnvironment: source.key, kind: 'promote' },
        caller, 'FORBIDDEN', `Capability deploy:trigger:${dest.key} is required.`);
    }
    if (dest.targetIds.length === 0) {
      throw new DeploymentError('NO_TARGETS', `Environment '${dest.key}' has no deployment targets.`);
    }
    const build = await this.sourceBuild(source, opts.deploymentId);
    const plan = {
      kind: 'promote' as const,
      scope: 'environment' as const,
      environment: dest.key,
      sourceEnvironment: source.key,
      sourceDeploymentId: build.id,
      targetIds: [...dest.targetIds],
      branch: build.branch ?? undefined,
      reason: opts.reason,
    };
    if (dest.requiresApproval) return this.park(caller, plan);
    const results = await this.dispatchPromotion(build.id, dest.targetIds, opts.reason, caller.triggeredBy);
    return { status: 'dispatched', environment: dest.key, results };
  }

  /** The build to promote: the named one (must be ready, in `source`) or the newest ready one. */
  private async sourceBuild(source: DeploymentEnvironment, deploymentId?: string): Promise<DeploymentRow> {
    if (deploymentId) {
      const row = await this.deps.deployments.getDeployment(deploymentId);
      if (!row || !source.targetIds.includes(row.targetId)) {
        throw new DeploymentError('NOT_FOUND', `Deployment not found in environment '${source.key}'.`);
      }
      if (row.status !== 'ready') throw new DeploymentError('SOURCE_NOT_READY', 'Only a ready deployment can be promoted.');
      return row;
    }
    let newest: DeploymentRow | undefined;
    for (const targetId of source.targetIds) {
      const [row] = await this.deps.deployments.listDeployments({ targetId, status: 'ready', limit: 1 });
      if (row && (!newest || row.createdAt > newest.createdAt)) newest = row;
    }
    if (!newest) {
      throw new DeploymentError('SOURCE_NOT_READY', `Environment '${source.key}' has no ready deployment to promote.`);
    }
    return newest;
  }

  private async park(
    caller: DeployCaller,
    plan: Omit<DeployApprovalPlan, 'requestedBy' | 'expiresAt'>,
  ): Promise<Extract<DeployRequestOutcome, { status: 'pending_approval' }>> {
    // An unidentifiable caller cannot park work that later runs under an
    // approver's rights — and could never be re-checked at approval.
    if (!caller.requester) {
      this.deny('deployment.approval.refused', { environment: plan.environment }, caller, 'PRINCIPAL_UNRESOLVED',
        'The request has no principal an approval can be recorded for.');
    }
    const full: DeployApprovalPlan = {
      ...plan,
      requestedBy: caller.requester!,
      expiresAt: new Date(this.now().getTime() + DEPLOY_APPROVAL_TTL_MS).toISOString(),
    };
    const row = await this.deps.approvals.create(full);
    this.deps.audit('deployment.approval.requested', {
      approvalId: row.id,
      kind: plan.kind,
      environment: plan.environment,
      sourceEnvironment: plan.sourceEnvironment,
      sourceDeploymentId: plan.sourceDeploymentId,
      targetIds: plan.targetIds,
    }, caller.actorEmail);
    return { status: 'pending_approval', environment: plan.environment, approval: toApprovalView(row)! };
  }

  // ── Dispatch ─────────────────────────────────────────────────────────────

  private async dispatchTrigger(
    targetIds: readonly string[],
    opts: { branch?: string; reason?: string },
    triggeredBy?: string,
  ): Promise<DispatchResult[]> {
    const results: DispatchResult[] = [];
    for (const targetId of targetIds) {
      try {
        const deployment = await this.deps.deployments.trigger(targetId, {
          branch: opts.branch,
          reason: opts.reason,
          source: 'manual',
          triggeredBy,
        });
        results.push({ targetId, ok: true, deployment });
      } catch (err) {
        results.push(failure(targetId, err));
      }
    }
    return results;
  }

  private async dispatchPromotion(
    sourceDeploymentId: string,
    targetIds: readonly string[],
    reason: string | undefined,
    triggeredBy?: string,
  ): Promise<DispatchResult[]> {
    const results: DispatchResult[] = [];
    for (const targetId of targetIds) {
      try {
        const { deployment, mode } = await this.deps.deployments.promote(sourceDeploymentId, targetId, {
          reason,
          triggeredBy,
        });
        results.push({ targetId, ok: true, deployment, mode });
      } catch (err) {
        results.push(failure(targetId, err));
      }
    }
    return results;
  }

  // ── Approvals ────────────────────────────────────────────────────────────

  async listApprovals(caller: DeployCaller, status?: string): Promise<Array<DeployApprovalView & { canDecide: boolean }>> {
    const rows = await this.deps.approvals.list(status);
    const out: Array<DeployApprovalView & { canDecide: boolean }> = [];
    for (const row of rows) {
      const view = toApprovalView(row);
      const plan = parseDeployPlan(row);
      if (!view || !plan) continue;
      const canDecide =
        row.status === 'pending' &&
        caller.decider.kind === 'human' &&
        !sameRequester(plan.requestedBy, caller.decider) &&
        canApproveEnvironment(caller.capabilities, plan.environment);
      out.push({ ...view, canDecide });
    }
    return out;
  }

  /**
   * Approve or reject a pending deploy approval.
   *
   * `requesterCapabilities` re-resolves the original requester's live grant;
   * null means the requester can no longer be resolved (revoked, removed).
   */
  async decide(
    caller: DeployCaller,
    approvalId: string,
    decision: 'approved' | 'rejected',
    reason: string | undefined,
    requesterCapabilities: (requester: ApprovalRequester) => Promise<string[] | null>,
  ): Promise<DeployApprovalView & { results?: DispatchResult[] }> {
    const row = await this.deps.approvals.get(approvalId);
    const plan = row ? parseDeployPlan(row) : null;
    if (!row || !plan) throw new DeploymentError('NOT_FOUND', 'Approval not found.');
    const meta = { approvalId, environment: plan.environment, kind: plan.kind, decision };

    if (row.status !== 'pending') {
      this.deny('deployment.approval.refused', meta, caller, 'APPROVAL_ALREADY_DECIDED', `Approval is already ${row.status}.`);
    }

    const ownRequest = requesterEquals(plan.requestedBy, caller.requester) || sameRequester(plan.requestedBy, caller.decider);

    if (decision === 'rejected' && ownRequest) {
      // Withdrawing your own request needs no approve grant.
      return this.finishRejection(caller, approvalId, plan, reason, 'withdrawn');
    }

    if (caller.decider.kind !== 'human') {
      this.deny('deployment.approval.refused', meta, caller, 'HUMAN_APPROVER_REQUIRED',
        'Deploy approvals must be decided by a signed-in person, not an API key or agent.');
    }
    if (ownRequest) {
      this.deny('deployment.approval.refused', meta, caller, 'SELF_APPROVAL_FORBIDDEN',
        'The requester cannot approve their own deploy request.');
    }
    if (!canApproveEnvironment(caller.capabilities, plan.environment)) {
      this.deny('deployment.approval.refused', meta, caller, 'FORBIDDEN',
        `Capability deploy:approve:${plan.environment} is required.`);
    }

    if (decision === 'rejected') return this.finishRejection(caller, approvalId, plan, reason, 'rejected');

    if (Date.parse(plan.expiresAt) <= this.now().getTime()) {
      await this.deps.approvals.transition(approvalId, 'pending', 'expired');
      this.deny('deployment.approval.expired', meta, caller, 'APPROVAL_EXPIRED', 'This approval has expired; request the deploy again.');
    }

    // The plan must still describe the current environment map: a target an
    // admin removed from the environment since the request is not deployed.
    const env = (await this.deps.environments.read()).find((e) => e.key === plan.environment);
    const targetIds = env ? plan.targetIds.filter((id) => env.targetIds.includes(id)) : [];
    if (!env || targetIds.length === 0) {
      await this.deps.approvals.transition(approvalId, 'pending', 'failed', {
        decidedBy: caller.decider.userId ?? null,
        result: { code: 'PLAN_STALE' },
      });
      this.deny('deployment.approval.refused', meta, caller, 'PLAN_STALE',
        'The environment no longer maps the requested targets; request the deploy again.');
    }

    // Re-read the requester's grant: approval does not launder a revoked one.
    const requesterCaps = await requesterCapabilities(plan.requestedBy);
    const requesterStillAllowed =
      requesterCaps !== null &&
      (plan.scope === 'target'
        ? canTriggerTarget(requesterCaps, plan.targetIds[0]!, env ? [env] : [])
        : canTriggerEnvironment(requesterCaps, { key: plan.environment, targetIds }));
    if (!requesterStillAllowed) {
      this.deny('deployment.approval.refused', meta, caller, 'REQUESTER_REVOKED',
        'The requester no longer holds the deploy grant this request needs.');
    }

    // Claim: exactly one decision dispatches.
    const claimed = await this.deps.approvals.transition(approvalId, 'pending', 'deciding');
    if (!claimed) {
      this.deny('deployment.approval.refused', meta, caller, 'APPROVAL_ALREADY_DECIDED', 'Approval was decided concurrently.');
    }

    let results: DispatchResult[];
    try {
      results =
        plan.kind === 'promote' && plan.sourceDeploymentId
          ? await this.dispatchPromotion(plan.sourceDeploymentId, targetIds, plan.reason, caller.triggeredBy)
          : await this.dispatchTrigger(targetIds, { branch: plan.branch, reason: plan.reason }, caller.triggeredBy);
    } catch (err) {
      await this.deps.approvals.transition(approvalId, 'deciding', 'failed', {
        decidedBy: caller.decider.userId ?? null,
        result: { code: 'DISPATCH_FAILED' },
      });
      throw err;
    }

    const summary = results.map((r) => ({
      targetId: r.targetId,
      ok: r.ok,
      deploymentId: r.deployment?.id ?? null,
      ...(r.mode ? { mode: r.mode } : {}),
      ...(r.error ? { error: r.error.code } : {}),
    }));
    const saved = await this.deps.approvals.transition(approvalId, 'deciding', 'approved', {
      decidedBy: caller.decider.userId ?? null,
      result: { reason: reason ?? null, results: summary },
    });
    this.deps.audit('deployment.approval.approved', { ...meta, targetIds, results: summary }, caller.actorEmail);
    return { ...toApprovalView(saved ?? claimed!)!, results };
  }

  private async finishRejection(
    caller: DeployCaller,
    approvalId: string,
    plan: DeployApprovalPlan,
    reason: string | undefined,
    how: 'rejected' | 'withdrawn',
  ): Promise<DeployApprovalView> {
    const saved = await this.deps.approvals.transition(approvalId, 'pending', 'rejected', {
      decidedBy: caller.decider.kind === 'human' ? caller.decider.userId ?? null : null,
      result: { reason: reason ?? null, how },
    });
    if (!saved) {
      throw new DeploymentError('APPROVAL_ALREADY_DECIDED', 'Approval was decided concurrently.');
    }
    this.deps.audit('deployment.approval.rejected', {
      approvalId,
      environment: plan.environment,
      kind: plan.kind,
      how,
    }, caller.actorEmail);
    return toApprovalView(saved)!;
  }
}

function failure(targetId: string, err: unknown): DispatchResult {
  if (err instanceof DeploymentError) {
    return {
      targetId,
      ok: false,
      deployment: err.deployment ?? null,
      error: { code: err.code, message: err.message },
    };
  }
  return {
    targetId,
    ok: false,
    deployment: null,
    error: { code: 'INTERNAL', message: err instanceof Error ? err.message : 'Unexpected error.' },
  };
}
