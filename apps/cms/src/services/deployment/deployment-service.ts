import { and, eq, inArray } from 'drizzle-orm';
import { deploymentTargets, deployments, type Database } from '@lumibase/database';
import type { KeyProvider } from '@lumibase/runtime';
import { AuditLogger } from '../../modules/audit/logger';
import { getProvider, TERMINAL_STATUSES, type DeploymentRef, type ProviderTarget } from './providers';
import { decryptToken, encryptToken } from './token-vault';
import '../deployment/providers/index';

/**
 * DeploymentService (spec: deployment-integrations, design §6). Orchestrates
 * target lifecycle, trigger, status sync and log retrieval. Every method is
 * `siteId`-scoped; Provider tokens are decrypted only at the moment of an
 * outbound call and never logged or returned.
 */

export type TriggerSource = 'manual' | 'auto' | 'agent';

export interface DeploymentServiceDeps {
  db: Database;
  siteId: string;
  keys: KeyProvider;
}

export interface CreateTargetInput {
  provider: string;
  name: string;
  projectId: string;
  token: string;
  defaultBranch?: string | null;
  productionUrl?: string | null;
}

/** Public-safe target view — never includes token columns. */
export interface PublicTarget {
  id: string;
  provider: string;
  name: string;
  projectId: string;
  defaultBranch: string | null;
  productionUrl: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Max bytes of build log we persist as an excerpt (design §3.2). */
const LOG_EXCERPT_MAX = 16_000;

/** Common secret shapes to scrub from log excerpts before persisting. */
function maskLog(raw: string): string {
  return raw
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1***')
    .replace(/((?:token|secret|api[_-]?key)["']?\s*[:=]\s*["']?)[A-Za-z0-9._-]+/gi, '$1***');
}

function toPublic(row: typeof deploymentTargets.$inferSelect): PublicTarget {
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    projectId: row.projectId,
    defaultBranch: row.defaultBranch,
    productionUrl: row.productionUrl,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function providerTarget(row: typeof deploymentTargets.$inferSelect): ProviderTarget {
  return { provider: row.provider, projectId: row.projectId, defaultBranch: row.defaultBranch };
}

export class DeploymentService {
  constructor(private readonly deps: DeploymentServiceDeps) {}

  private audit(event: string, metadata: Record<string, unknown>, actorEmail?: string): void {
    // Fire-and-forget; AuditLogger.write never throws and masks secrets.
    void new AuditLogger({ db: this.deps.db, siteId: this.deps.siteId }).write({
      event,
      actorEmail: actorEmail ?? null,
      metadata,
    });
  }

  // ── Targets ──────────────────────────────────────────────────────────────

  async listTargets(): Promise<PublicTarget[]> {
    const rows = await this.deps.db
      .select()
      .from(deploymentTargets)
      .where(eq(deploymentTargets.siteId, this.deps.siteId));
    return rows.map(toPublic);
  }

  async createTarget(input: CreateTargetInput, actorEmail?: string): Promise<PublicTarget> {
    const provider = getProvider(input.provider);
    if (!provider) throw new DeploymentError('UNKNOWN_PROVIDER', `Unknown provider '${input.provider}'.`);

    // Verify the token before persisting anything (Req 1.4).
    const target: ProviderTarget = {
      provider: input.provider,
      projectId: input.projectId,
      defaultBranch: input.defaultBranch,
    };
    const verify = await provider.verifyToken(input.token, target);
    if (!verify.ok) throw new DeploymentError('TOKEN_INVALID', verify.reason ?? 'Token verification failed.');

    const enc = await encryptToken(this.deps.keys, input.token, this.deps.siteId);

    const [row] = await this.deps.db
      .insert(deploymentTargets)
      .values({
        siteId: this.deps.siteId,
        provider: input.provider,
        name: input.name,
        projectId: input.projectId,
        tokenCiphertext: enc.ciphertext,
        tokenKeyId: enc.keyId,
        defaultBranch: input.defaultBranch ?? null,
        productionUrl: input.productionUrl ?? null,
      })
      .returning();

    this.audit('deployment.target.created', { targetId: row!.id, provider: input.provider }, actorEmail);
    return toPublic(row!);
  }

  async updateTarget(
    id: string,
    patch: Partial<CreateTargetInput> & { status?: string },
    actorEmail?: string,
  ): Promise<PublicTarget | null> {
    const existing = await this.getTargetRow(id);
    if (!existing) return null;

    const values: Partial<typeof deploymentTargets.$inferInsert> = { updatedAt: new Date() };
    if (patch.name !== undefined) values.name = patch.name;
    if (patch.projectId !== undefined) values.projectId = patch.projectId;
    if (patch.defaultBranch !== undefined) values.defaultBranch = patch.defaultBranch ?? null;
    if (patch.productionUrl !== undefined) values.productionUrl = patch.productionUrl ?? null;
    if (patch.status !== undefined) values.status = patch.status;

    // Re-verify and re-encrypt only when the token is being rotated (Req 1.4).
    if (patch.token) {
      const provider = getProvider(patch.provider ?? existing.provider);
      if (!provider) throw new DeploymentError('UNKNOWN_PROVIDER', 'Unknown provider.');
      const verify = await provider.verifyToken(patch.token, providerTarget(existing));
      if (!verify.ok) throw new DeploymentError('TOKEN_INVALID', verify.reason ?? 'Token verification failed.');
      const enc = await encryptToken(this.deps.keys, patch.token, this.deps.siteId);
      values.tokenCiphertext = enc.ciphertext;
      values.tokenKeyId = enc.keyId;
    }

    const [row] = await this.deps.db
      .update(deploymentTargets)
      .set(values)
      .where(and(eq(deploymentTargets.siteId, this.deps.siteId), eq(deploymentTargets.id, id)))
      .returning();
    if (!row) return null;
    this.audit('deployment.target.updated', { targetId: id }, actorEmail);
    return toPublic(row);
  }

  async deleteTarget(id: string, actorEmail?: string): Promise<boolean> {
    const [row] = await this.deps.db
      .delete(deploymentTargets)
      .where(and(eq(deploymentTargets.siteId, this.deps.siteId), eq(deploymentTargets.id, id)))
      .returning();
    if (!row) return false;
    this.audit('deployment.target.deleted', { targetId: id }, actorEmail);
    return true;
  }

  private async getTargetRow(id: string): Promise<typeof deploymentTargets.$inferSelect | undefined> {
    const [row] = await this.deps.db
      .select()
      .from(deploymentTargets)
      .where(and(eq(deploymentTargets.siteId, this.deps.siteId), eq(deploymentTargets.id, id)));
    return row;
  }

  // ── Trigger ────────────────────────────────────────────────────────────────

  async trigger(
    targetId: string,
    opts: { branch?: string; reason?: string; source?: TriggerSource; triggeredBy?: string },
  ): Promise<typeof deployments.$inferSelect> {
    const target = await this.getTargetRow(targetId);
    if (!target) throw new DeploymentError('NOT_FOUND', 'Deployment target not found.');
    if (target.status !== 'active') throw new DeploymentError('TARGET_INACTIVE', 'Deployment target is inactive.');

    const provider = getProvider(target.provider);
    if (!provider) throw new DeploymentError('UNKNOWN_PROVIDER', `Unknown provider '${target.provider}'.`);

    const source: TriggerSource = opts.source ?? 'manual';
    let ref: DeploymentRef | null = null;
    let errorMessage: string | null = null;
    try {
      const token = await decryptToken(this.deps.keys, target.tokenCiphertext, this.deps.siteId);
      ref = await provider.trigger(token, providerTarget(target), {
        branch: opts.branch,
        reason: opts.reason,
      });
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    }

    const [row] = await this.deps.db
      .insert(deployments)
      .values({
        siteId: this.deps.siteId,
        targetId,
        provider: target.provider,
        providerDeploymentId: ref?.providerDeploymentId ?? null,
        status: ref ? ref.status : 'error',
        branch: opts.branch ?? target.defaultBranch ?? null,
        commitSha: ref?.commitSha ?? null,
        commitMessage: ref?.commitMessage ?? null,
        url: ref?.url ?? null,
        triggeredBy: opts.triggeredBy ?? null,
        triggerSource: source,
        errorMessage,
        completedAt: errorMessage ? new Date() : null,
      })
      .returning();

    this.audit(
      'deployment.triggered',
      { targetId, provider: target.provider, source, reason: opts.reason, ok: !errorMessage },
      opts.source === 'manual' ? opts.triggeredBy ?? undefined : undefined,
    );

    if (errorMessage) throw new DeploymentError('TRIGGER_FAILED', errorMessage, row);
    return row!;
  }

  // ── Status sync ──────────────────────────────────────────────────────────

  async listDeployments(filter: { targetId?: string; status?: string; limit?: number } = {}) {
    const conds = [eq(deployments.siteId, this.deps.siteId)];
    if (filter.targetId) conds.push(eq(deployments.targetId, filter.targetId));
    if (filter.status) conds.push(eq(deployments.status, filter.status));
    return this.deps.db
      .select()
      .from(deployments)
      .where(and(...conds))
      .limit(Math.min(200, filter.limit ?? 50));
  }

  async getDeployment(id: string): Promise<typeof deployments.$inferSelect | undefined> {
    const [row] = await this.deps.db
      .select()
      .from(deployments)
      .where(and(eq(deployments.siteId, this.deps.siteId), eq(deployments.id, id)));
    return row;
  }

  /** Sync one deployment's status from its Provider (refresh / poller). */
  async syncDeployment(id: string): Promise<typeof deployments.$inferSelect | undefined> {
    const dep = await this.getDeployment(id);
    if (!dep || !dep.providerDeploymentId) return dep;
    if (TERMINAL_STATUSES.has(dep.status as never)) return dep; // already terminal

    const target = await this.getTargetRow(dep.targetId);
    const provider = target ? getProvider(target.provider) : undefined;
    if (!target || !provider) return dep;

    const token = await decryptToken(this.deps.keys, target.tokenCiphertext, this.deps.siteId);
    const ref = await provider.getStatus(token, providerTarget(target), dep.providerDeploymentId);
    return this.applyRef(dep, ref, provider, target);
  }

  /** Apply a normalized ref to a deployment row, fetching a log excerpt on error. */
  private async applyRef(
    dep: typeof deployments.$inferSelect,
    ref: DeploymentRef,
    provider = getProvider(dep.provider),
    target?: typeof deploymentTargets.$inferSelect,
  ): Promise<typeof deployments.$inferSelect | undefined> {
    let logExcerpt: string | null = dep.logExcerpt;
    if (ref.status === 'error' && provider && ref.providerDeploymentId) {
      const t = target ?? (await this.getTargetRow(dep.targetId));
      if (t) {
        try {
          const token = await decryptToken(this.deps.keys, t.tokenCiphertext, this.deps.siteId);
          const log = await provider.getLogs(token, providerTarget(t), ref.providerDeploymentId);
          logExcerpt = maskLog(log).slice(-LOG_EXCERPT_MAX);
        } catch {
          // Log fetch is best-effort; the status transition still commits.
        }
      }
    }

    // Idempotent conditional update: only flip a non-terminal row.
    const [row] = await this.deps.db
      .update(deployments)
      .set({
        status: ref.status,
        url: ref.url ?? dep.url,
        branch: ref.branch ?? dep.branch,
        commitSha: ref.commitSha ?? dep.commitSha,
        commitMessage: ref.commitMessage ?? dep.commitMessage,
        errorMessage: ref.errorMessage ?? dep.errorMessage,
        logExcerpt,
        completedAt: TERMINAL_STATUSES.has(ref.status) ? (ref.completedAt ?? new Date()) : dep.completedAt,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(deployments.siteId, this.deps.siteId),
          eq(deployments.id, dep.id),
          inArray(deployments.status, ['queued', 'building']),
        ),
      )
      .returning();
    return row ?? dep;
  }

  /** Apply an inbound-webhook ref by matching on providerDeploymentId. */
  async applyWebhookRef(ref: DeploymentRef): Promise<void> {
    if (!ref.providerDeploymentId) return;
    const [dep] = await this.deps.db
      .select()
      .from(deployments)
      .where(
        and(
          eq(deployments.siteId, this.deps.siteId),
          eq(deployments.providerDeploymentId, ref.providerDeploymentId),
        ),
      );
    if (!dep) return;
    await this.applyRef(dep, ref);
  }

  /** Build log on demand (debug). */
  async fetchLogs(id: string): Promise<string> {
    const dep = await this.getDeployment(id);
    if (!dep || !dep.providerDeploymentId) throw new DeploymentError('NOT_FOUND', 'Deployment not found.');
    const target = await this.getTargetRow(dep.targetId);
    const provider = target ? getProvider(target.provider) : undefined;
    if (!target || !provider) throw new DeploymentError('UNKNOWN_PROVIDER', 'Provider unavailable.');
    const token = await decryptToken(this.deps.keys, target.tokenCiphertext, this.deps.siteId);
    const log = await provider.getLogs(token, providerTarget(target), dep.providerDeploymentId);
    return maskLog(log);
  }

  /** Ids of deployments still in a non-terminal state (poller input). */
  async pendingDeploymentIds(): Promise<string[]> {
    const rows = await this.deps.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(and(eq(deployments.siteId, this.deps.siteId), inArray(deployments.status, ['queued', 'building'])));
    return rows.map((r) => r.id);
  }
}

export class DeploymentError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly deployment?: typeof deployments.$inferSelect,
  ) {
    super(message);
    this.name = 'DeploymentError';
  }
}
