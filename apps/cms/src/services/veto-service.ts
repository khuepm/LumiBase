import {
  activity,
  agentApprovals,
  collections,
  items,
  revisions,
  type Database,
} from '@lumibase/database';
import { and, asc, eq, gte, isNull, lte, ne } from 'drizzle-orm';
import type { AgentNotifier } from '../modules/notifications/agent-notifications';
import { agentVetoesTotal, agentVetoStagingsTotal } from './agent-metrics';
import { AutonomyService } from './autonomy-service';
import { ItemService, type ItemProvenance } from './item-service';

/**
 * VetoService — the L3 veto window (Content OS task 14).
 *
 * At autonomy level 3 a dangerous item write executes into a *staged
 * revision* instead of live content, paired with a `kind='veto'` approval
 * whose `autoCommitAt` marks the deadline. Silence means consent: the
 * commit job promotes the staging to live at the deadline. A human veto
 * before the deadline discards the staging, opens a `veto` incident and
 * feeds the automatic demotion path. A field pinned by a human *after*
 * staging wins at commit time — the pinned part of the patch is dropped,
 * never overwritten (Req 8.6).
 */

// ---------------------------------------------------------------------------
// Pure decision helpers (Property 6)
// ---------------------------------------------------------------------------

/**
 * Splits a staged patch against the item's current pinned fields. The
 * applied part never touches a pinned field; nothing is lost silently —
 * dropped fields are reported for the audit trail.
 */
export function filterPinnedPatch(
  patch: Record<string, unknown>,
  pinnedFields: readonly string[],
): { applied: Record<string, unknown>; dropped: string[] } {
  const pinned = new Set(pinnedFields);
  const applied: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [field, value] of Object.entries(patch)) {
    if (pinned.has(field)) {
      dropped.push(field);
    } else {
      applied[field] = value;
    }
  }
  return { applied, dropped };
}

export type VetoCommitDecision = 'commit' | 'wait' | 'skip';

/**
 * Commit-job decision: a veto (or any non-pending status) always wins; a
 * staging never commits before its deadline.
 */
export function decideVetoCommit(
  approvalStatus: string,
  autoCommitAt: Date | null,
  now: Date,
): VetoCommitDecision {
  if (approvalStatus !== 'pending') return 'skip';
  if (!autoCommitAt) return 'skip';
  if (now.getTime() < autoCommitAt.getTime()) return 'wait';
  return 'commit';
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export const DEFAULT_VETO_WINDOW_MS = 4 * 60 * 60 * 1000;
export const VETO_COMMIT_MAX_ATTEMPTS = 5;

export class VetoServiceError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
    this.name = 'VetoServiceError';
  }
}

export interface VetoServiceDeps {
  db: Database;
  siteId: string;
  /** Window length override; defaults to 4 hours. */
  vetoWindowMs?: number;
  /**
   * Optional push-notification sink (push-noti feature). Request-context
   * callers pass a notifier so reviewers are reached in-app / via Web Push
   * the moment a write is staged; background callers omit it and rely on the
   * Mission-Control inbox poll. Best-effort — never blocks staging.
   */
  notify?: AgentNotifier;
}

export interface StagedWrite {
  approvalId: string;
  revisionId: string;
  autoCommitAt: Date;
  /** Deep-link for reviewers (Req 13.2). */
  reviewPath: string;
}

interface StageItemPatchInput {
  runId: string;
  agentRole: string;
  capability: string;
  collection: string;
  itemId: string;
  patch: Record<string, unknown>;
  provenance?: Pick<ItemProvenance, 'model' | 'constitutionHash' | 'sources' | 'confidence'>;
}

export class VetoService {
  private readonly vetoWindowMs: number;

  constructor(private readonly deps: VetoServiceDeps) {
    this.vetoWindowMs = Math.max(60_000, deps.vetoWindowMs ?? DEFAULT_VETO_WINDOW_MS);
  }

  /**
   * Stages a dangerous item patch instead of executing it (Req 13.1).
   * Live content is untouched; the staging revision carries the before/after
   * delta, provenance and the auto-commit deadline.
   */
  async stageItemPatch(input: StageItemPatchInput): Promise<StagedWrite> {
    const [collection] = await this.deps.db
      .select({ id: collections.id })
      .from(collections)
      .where(and(eq(collections.siteId, this.deps.siteId), eq(collections.name, input.collection)))
      .limit(1);
    if (!collection) {
      throw new VetoServiceError('COLLECTION_NOT_FOUND', `Collection "${input.collection}" not found.`, 404);
    }

    const [item] = await this.deps.db
      .select({ id: items.id, data: items.data })
      .from(items)
      .where(
        and(
          eq(items.siteId, this.deps.siteId),
          eq(items.collectionId, collection.id),
          eq(items.id, input.itemId),
          isNull(items.deletedAt),
        ),
      )
      .limit(1);
    if (!item) {
      throw new VetoServiceError('NOT_FOUND', `Item "${input.itemId}" not found.`, 404);
    }

    const before = (item.data ?? {}) as Record<string, unknown>;
    const autoCommitAt = new Date(Date.now() + this.vetoWindowMs);

    const [staging] = await this.deps.db
      .insert(revisions)
      .values({
        siteId: this.deps.siteId,
        collectionId: collection.id,
        itemId: input.itemId,
        delta: { before, after: { ...before, ...input.patch }, patch: input.patch },
        authorType: 'agent',
        createdByRunId: input.runId,
        model: input.provenance?.model ?? null,
        constitutionHash: input.provenance?.constitutionHash ?? null,
        sources: input.provenance?.sources ?? null,
        confidence: input.provenance?.confidence ?? null,
        staged: true,
        autoCommitAt,
      })
      .returning();

    const [approval] = await this.deps.db
      .insert(agentApprovals)
      .values({
        runId: input.runId,
        siteId: this.deps.siteId,
        subjectType: 'staged_revision',
        subjectId: staging!.id,
        status: 'pending',
        approvalPolicy: 'veto_window',
        kind: 'veto',
        autoCommitAt,
        requestedByAgent: input.agentRole,
        decisionReason: null,
      })
      .returning();

    agentVetoStagingsTotal.inc();
    const reviewPath = `/agent/staged/${approval!.id}`;
    // Notify reviewers (Req 13.2): audited activity entry the exception
    // inbox surfaces immediately; channel fan-out hangs off the same event.
    await this.deps.db.insert(activity).values({
      siteId: this.deps.siteId,
      action: 'veto.staged',
      collection: input.collection,
      itemId: input.itemId,
      payload: {
        approvalId: approval!.id,
        revisionId: staging!.id,
        agentRole: input.agentRole,
        capability: input.capability,
        autoCommitAt: autoCommitAt.toISOString(),
        reviewPath,
      },
    });

    this.deps.notify?.({
      kind: 'veto',
      severity: 'warning',
      title: 'Veto window open',
      body: `Staged change on ${input.collection}/${input.itemId} auto-commits at ${autoCommitAt.toISOString()}`,
      deepLink: `/mission-control/inbox?entry=veto:${approval!.id}`,
      entityId: approval!.id,
    });

    return { approvalId: approval!.id, revisionId: staging!.id, autoCommitAt, reviewPath };
  }

  /**
   * Schedules the commit job at the deadline (Req 13.3). Without a queue
   * adapter the periodic sweep picks the staging up instead — staging never
   * depends on the queue being present.
   */
  async scheduleCommit(staged: StagedWrite, queue?: { enqueue<T>(q: string, j: string, d: T, o?: { delay?: number }): Promise<string> }): Promise<void> {
    if (!queue) return;
    try {
      await queue.enqueue(
        'agent-veto-commits',
        'commit',
        { siteId: this.deps.siteId, approvalId: staged.approvalId, attempt: 1 },
        { delay: Math.max(0, staged.autoCommitAt.getTime() - Date.now()) },
      );
    } catch {
      // Sweep is the safety net; a failed enqueue must not fail the staging.
    }
  }

  /** Stagings still inside their veto window (Req 13.6). */
  /**
   * Stagings inside their veto window, soonest deadline first — enriched
   * with the staged revision's context (content-os-ui Req 8): the inbox
   * needs collection/item/patch to render a real diff, and the approval
   * row alone doesn't carry them. Left joins so a broken staging degrades
   * to null fields instead of emptying the list.
   */
  async listPending() {
    const rows = await this.deps.db
      .select({
        approval: agentApprovals,
        revisionItemId: revisions.itemId,
        revisionDelta: revisions.delta,
        collectionName: collections.name,
      })
      .from(agentApprovals)
      .leftJoin(
        revisions,
        and(eq(revisions.id, agentApprovals.subjectId), eq(revisions.siteId, agentApprovals.siteId)),
      )
      .leftJoin(
        collections,
        and(eq(collections.id, revisions.collectionId), eq(collections.siteId, agentApprovals.siteId)),
      )
      .where(
        and(
          eq(agentApprovals.siteId, this.deps.siteId),
          eq(agentApprovals.kind, 'veto'),
          eq(agentApprovals.status, 'pending'),
        ),
      )
      .orderBy(asc(agentApprovals.autoCommitAt))
      .limit(200);

    return rows.map(({ approval, revisionItemId, revisionDelta, collectionName }) => ({
      ...approval,
      approvalId: approval.id,
      agentRole: approval.requestedByAgent,
      collection: collectionName ?? null,
      itemId: revisionItemId ?? null,
      patch:
        (revisionDelta as { patch?: Record<string, unknown> } | null)?.patch ?? null,
    }));
  }

  /**
   * Human veto (Req 13.4): discards the staging — live content was never
   * touched — and records a `veto` incident, which demotes the agent role
   * on that capability automatically.
   */
  async veto(approvalId: string, userId: string | null, reason?: string) {
    const approval = await this.getVetoApproval(approvalId);
    if (approval.status !== 'pending') {
      throw new VetoServiceError('ALREADY_DECIDED', 'Staging already committed or vetoed.', 409);
    }
    // Guarded on `pending` (B131): an auto-commit holding the `deciding` claim
    // owns the row, so a veto that lost the race reports it instead of
    // overwriting a commit that is already applying the patch.
    const rejected = await this.deps.db
      .update(agentApprovals)
      .set({
        status: 'rejected',
        decidedBy: userId,
        decisionReason: reason ?? 'vetoed',
        decidedAt: new Date(),
      })
      .where(
        and(
          eq(agentApprovals.id, approvalId),
          eq(agentApprovals.siteId, this.deps.siteId),
          eq(agentApprovals.status, 'pending'),
        ),
      )
      .returning({ id: agentApprovals.id });
    if (rejected.length === 0) {
      throw new VetoServiceError('ALREADY_DECIDED', 'Staging already committed or vetoed.', 409);
    }
    agentVetoesTotal.inc();

    await this.discardStaging(approval.subjectId);

    const staging = await this.getStaging(approval.subjectId);
    const capability = await this.capabilityOf(approval.subjectId);
    const autonomy = new AutonomyService({ db: this.deps.db, siteId: this.deps.siteId });
    const { demotedTo } = await autonomy.recordIncident({
      agentRole: approval.requestedByAgent,
      capability,
      source: 'veto',
      severity: 'medium',
      runId: approval.runId,
      detail: { approvalId, revisionId: approval.subjectId, itemId: staging?.itemId, reason: reason ?? null },
    });

    return { vetoed: true, demotedTo };
  }

  /**
   * Commits one due staging to live content (Req 13.3). Pin-after-staging
   * wins: fields pinned since staging are dropped from the applied patch
   * (Req 8.6). Returns the terminal outcome for the job runner.
   */
  async commit(approvalId: string, itemService: ItemService): Promise<{
    outcome: 'committed' | 'noop' | 'skipped' | 'waiting';
    droppedPinned?: string[];
  }> {
    const approval = await this.getVetoApproval(approvalId);
    const decision = decideVetoCommit(approval.status, approval.autoCommitAt, new Date());
    if (decision === 'skip') return { outcome: 'skipped' };
    if (decision === 'wait') return { outcome: 'waiting' };

    // CLAIM before applying anything (B131), the same `pending → deciding`
    // conditional UPDATE the harness uses (#453). The queue job and the sweep
    // both reach here, and on Workers two sweeps can overlap with no leader
    // lock; reading `pending` and then acting let both apply the patch. The
    // database picks one winner. A process that dies holding the claim is
    // moved to `failed` by the approval-claim sweep, never silently retried.
    const claimed = await this.deps.db
      .update(agentApprovals)
      .set({ status: 'deciding', decidedAt: new Date() })
      .where(
        and(
          eq(agentApprovals.id, approval.id),
          eq(agentApprovals.siteId, this.deps.siteId),
          eq(agentApprovals.status, 'pending'),
        ),
      )
      .returning({ id: agentApprovals.id });
    if (claimed.length === 0) return { outcome: 'skipped' };

    const progress = { applied: false };
    try {
      return await this.commitClaimed(approval, itemService, progress);
    } catch (err) {
      if (!progress.applied) {
        // Nothing reached live content (Req 13.5): hand the row back so the
        // worker's backoff retry and the sweep can try again.
        await this.releaseCommitClaim(approval.id);
      } else {
        // The patch is live; only the bookkeeping failed. Returning the row to
        // `pending` would let the next sweep apply the staging a second time,
        // so record it as the commit it was. If even that write fails the row
        // stays `deciding`, out of the sweep's reach, and the approval-claim
        // sweep hands it to a human as `failed`.
        await this.settleAppliedClaim(approval.id, approval.subjectId).catch((settleErr: unknown) => {
          console.error('[veto-commit] applied patch left claimed', {
            approvalId: approval.id,
            error: settleErr instanceof Error ? settleErr.message : String(settleErr),
          });
        });
      }
      throw err;
    }
  }

  private async commitClaimed(
    approval: Awaited<ReturnType<VetoService['getVetoApproval']>>,
    itemService: ItemService,
    progress: { applied: boolean },
  ): Promise<{ outcome: 'committed' | 'noop' | 'skipped'; droppedPinned?: string[] }> {
    const staging = await this.getStaging(approval.subjectId);
    if (!staging || !staging.staged) {
      await this.releaseCommitClaim(approval.id);
      return { outcome: 'skipped' };
    }

    const delta = (staging.delta ?? {}) as { patch?: Record<string, unknown> };
    const patch = delta.patch ?? {};

    const [item] = await this.deps.db
      .select({ pinnedFields: items.pinnedFields })
      .from(items)
      .where(
        and(
          eq(items.siteId, this.deps.siteId),
          eq(items.id, staging.itemId),
          isNull(items.deletedAt),
        ),
      )
      .limit(1);
    if (!item) {
      // Item vanished while staged — nothing to commit.
      await this.finalizeCommit(approval.id, staging.id, 'auto_commit_target_missing');
      return { outcome: 'noop' };
    }

    const pinned = Array.isArray(item.pinnedFields) ? (item.pinnedFields as string[]) : [];
    const { applied, dropped } = filterPinnedPatch(patch, pinned);

    if (Object.keys(applied).length === 0) {
      await this.finalizeCommit(approval.id, staging.id, 'auto_commit_all_pinned');
      return { outcome: 'noop', droppedPinned: dropped };
    }

    const collectionName = await this.collectionNameOf(staging.collectionId);
    itemService.setProvenance({
      authorType: 'agent',
      runId: approval.runId,
      model: staging.model,
      constitutionHash: staging.constitutionHash,
      sources: staging.sources as unknown[] | null,
      confidence: staging.confidence,
    });
    await itemService.patch(collectionName, staging.itemId, { data: applied });
    progress.applied = true;

    await this.finalizeCommit(
      approval.id,
      staging.id,
      dropped.length > 0 ? `auto_commit_partial:dropped=${dropped.join(',')}` : 'auto_commit',
    );
    return { outcome: 'committed', droppedPinned: dropped };
  }

  /**
   * Whether a veto staging's patch may already be live (B131).
   *
   * A commit that dies between `itemService.patch` and finalizing leaves the
   * row `deciding`; the approval-claim sweep then moves it to `failed`, and
   * reopening it would let the sweep apply the staging a second time. Two
   * traces say the patch ran: the staging is no longer staged (finalize got
   * far enough to discard it), or the item has a live revision written by the
   * approval's run after the staging was created (`createdByRunId`, stamped
   * by the commit's provenance). Either one answers yes.
   */
  async isStagingApplied(approvalId: string): Promise<boolean> {
    const approval = await this.getVetoApproval(approvalId);
    const staging = await this.getStaging(approval.subjectId);
    if (!staging) return false;
    if (!staging.staged) return true;
    if (!approval.runId) return false;
    const [live] = await this.deps.db
      .select({ id: revisions.id })
      .from(revisions)
      .where(
        and(
          eq(revisions.siteId, this.deps.siteId),
          eq(revisions.itemId, staging.itemId),
          eq(revisions.staged, false),
          eq(revisions.createdByRunId, approval.runId),
          ne(revisions.id, staging.id),
          gte(revisions.createdAt, staging.createdAt),
        ),
      )
      .limit(1);
    return !!live;
  }

  /** Due stagings for the sweep/queue runner. */
  async listDue(now = new Date()) {
    return this.deps.db
      .select({ id: agentApprovals.id })
      .from(agentApprovals)
      .where(
        and(
          eq(agentApprovals.siteId, this.deps.siteId),
          eq(agentApprovals.kind, 'veto'),
          eq(agentApprovals.status, 'pending'),
          lte(agentApprovals.autoCommitAt, now),
        ),
      )
      .orderBy(asc(agentApprovals.autoCommitAt))
      .limit(50);
  }

  /** Records a commit-job failure; opens an incident after max attempts (Req 13.5). */
  async recordCommitFailure(approvalId: string, attempt: number, error: string): Promise<void> {
    if (attempt < VETO_COMMIT_MAX_ATTEMPTS) return;
    const approval = await this.getVetoApproval(approvalId);
    const autonomy = new AutonomyService({ db: this.deps.db, siteId: this.deps.siteId });
    await autonomy.recordIncident({
      agentRole: approval.requestedByAgent,
      source: 'runtime_error',
      severity: 'medium',
      runId: approval.runId,
      detail: { reason: 'veto_commit_failed', approvalId, attempt, error: error.slice(0, 500) },
    });
  }

  // ---------- internals ----------

  private async getVetoApproval(approvalId: string) {
    const [approval] = await this.deps.db
      .select()
      .from(agentApprovals)
      .where(
        and(
          eq(agentApprovals.id, approvalId),
          eq(agentApprovals.siteId, this.deps.siteId),
          eq(agentApprovals.kind, 'veto'),
        ),
      )
      .limit(1);
    if (!approval) {
      throw new VetoServiceError('NOT_FOUND', 'Veto approval not found.', 404);
    }
    return approval;
  }

  private async getStaging(revisionId: string) {
    const [staging] = await this.deps.db
      .select()
      .from(revisions)
      .where(and(eq(revisions.id, revisionId), eq(revisions.siteId, this.deps.siteId)))
      .limit(1);
    return staging ?? null;
  }

  /** Terminal: the staging becomes a plain audit revision. */
  private async discardStaging(revisionId: string): Promise<void> {
    await this.deps.db
      .update(revisions)
      .set({ staged: false, autoCommitAt: null })
      .where(and(eq(revisions.id, revisionId), eq(revisions.siteId, this.deps.siteId)));
  }

  private async finalizeCommit(approvalId: string, revisionId: string, reason: string): Promise<void> {
    // Only the claim holder finalizes.
    await this.deps.db
      .update(agentApprovals)
      .set({ status: 'approved', decisionReason: reason, decidedAt: new Date() })
      .where(
        and(
          eq(agentApprovals.id, approvalId),
          eq(agentApprovals.siteId, this.deps.siteId),
          eq(agentApprovals.status, 'deciding'),
        ),
      );
    await this.discardStaging(revisionId);
  }

  /**
   * Settles a claim whose patch already reached live content after finalizing
   * failed. Terminal and truthful (`approved`), never `pending`, so no later
   * sweep re-applies it; guarded on `deciding` like every claim write.
   */
  private async settleAppliedClaim(approvalId: string, revisionId: string): Promise<void> {
    await this.deps.db
      .update(agentApprovals)
      .set({
        status: 'approved',
        decisionReason: 'auto_commit (applied; finalize failed and was recovered)',
        decidedAt: new Date(),
      })
      .where(
        and(
          eq(agentApprovals.id, approvalId),
          eq(agentApprovals.siteId, this.deps.siteId),
          eq(agentApprovals.status, 'deciding'),
        ),
      );
    await this.discardStaging(revisionId);
  }

  /** Returns this caller's `deciding` claim to `pending`; a row decided elsewhere is left alone. */
  private async releaseCommitClaim(approvalId: string): Promise<void> {
    await this.deps.db
      .update(agentApprovals)
      .set({ status: 'pending', decidedAt: null })
      .where(
        and(
          eq(agentApprovals.id, approvalId),
          eq(agentApprovals.siteId, this.deps.siteId),
          eq(agentApprovals.status, 'deciding'),
        ),
      );
  }

  private async capabilityOf(revisionId: string): Promise<string | null> {
    const staging = await this.getStaging(revisionId);
    if (!staging) return null;
    // Item-write stagings demote the items:update capability.
    return 'items:update';
  }

  private async collectionNameOf(collectionId: string): Promise<string> {
    const [collection] = await this.deps.db
      .select({ name: collections.name })
      .from(collections)
      .where(and(eq(collections.siteId, this.deps.siteId), eq(collections.id, collectionId)))
      .limit(1);
    if (!collection) {
      throw new VetoServiceError('COLLECTION_NOT_FOUND', 'Collection of staging not found.', 404);
    }
    return collection.name;
  }
}
