/**
 * Editorial workflow state machine (regulated-content-readiness Req 8, 9).
 *
 * This is the centralised transition table (Req 8.4) and the mapping between
 * the editorial state and the existing `items.status` column (Req 8.1). It is
 * deliberately pure so the rules can be unit-tested without a database; the
 * route layer composes it with `content_reviews` writes and audit logging.
 *
 * Boundary with the AI veto-window (Req 9.5): this service governs *human*
 * editorial sign-off and never touches `agent_approvals` / the veto-window,
 * which gates AI writes. The two are independent.
 */

import { and, desc, eq } from 'drizzle-orm';
import {
  collections,
  contentReviews,
  items,
  revisions,
  scopeSite,
  type Database,
} from '@lumibase/database';
import { AuditLogger } from '../modules/audit/logger';

export type EditorialState =
  | 'draft'
  | 'in_review'
  | 'approved'
  | 'scheduled'
  | 'published'
  | 'rejected';

/** Existing item lifecycle column values. */
export type ItemStatus = 'draft' | 'published' | 'archived';

export type EditorialAction =
  | 'submit_review'
  | 'approve'
  | 'reject'
  | 'withdraw'
  | 'schedule'
  | 'publish'
  | 'unpublish'
  | 'revise';

export class EditorialError extends Error {
  constructor(public code: string, message: string, public status = 409) {
    super(message);
    this.name = 'EditorialError';
  }
}

/**
 * Allowed transitions keyed by action. Each maps the required `from` state to
 * the resulting `to` state. Any (action, from) pair not listed is invalid.
 */
const TRANSITIONS: Record<EditorialAction, Partial<Record<EditorialState, EditorialState>>> = {
  submit_review: { draft: 'in_review', rejected: 'in_review' },
  approve: { in_review: 'approved' },
  reject: { in_review: 'rejected' },
  withdraw: { in_review: 'draft' },
  schedule: { approved: 'scheduled' },
  publish: { approved: 'published', scheduled: 'published' },
  unpublish: { published: 'draft' },
  revise: { rejected: 'draft', published: 'draft' },
};

/** Map an editorial state to the concrete `items.status` (Req 8.1). */
export function statusForEditorialState(state: EditorialState): ItemStatus {
  return state === 'published' ? 'published' : 'draft';
}

/**
 * Derive the editorial state for an item that has none yet (workflow newly
 * enabled), from its current `status`.
 */
export function editorialStateFromStatus(status: ItemStatus): EditorialState {
  switch (status) {
    case 'published':
      return 'published';
    case 'archived':
      return 'draft';
    default:
      return 'draft';
  }
}

/** Whether `action` is permitted from `from`. */
export function canTransition(from: EditorialState, action: EditorialAction): boolean {
  return TRANSITIONS[action]?.[from] !== undefined;
}

/**
 * Apply an editorial action, returning the resulting state. Throws
 * INVALID_TRANSITION (409) when the action is not allowed from `from`.
 */
export function applyTransition(from: EditorialState, action: EditorialAction): EditorialState {
  const to = TRANSITIONS[action]?.[from];
  if (to === undefined) {
    throw new EditorialError(
      'INVALID_TRANSITION',
      `Cannot ${action} from "${from}".`,
      409,
    );
  }
  return to;
}

/**
 * Enforce the editorial gate (Req 8.2): when a collection has
 * `editorialWorkflow=true`, an item may only become `published` via the
 * `approved` (or `scheduled`) state. A direct draft→published is rejected with
 * EDITORIAL_GATE_REQUIRED (409).
 *
 * @param current the item's current editorial state (or derived from status)
 * @param nextStatus the requested target `items.status`
 */
export function assertEditorialGate(current: EditorialState, nextStatus: ItemStatus): void {
  if (nextStatus !== 'published') return;
  if (current !== 'approved' && current !== 'scheduled' && current !== 'published') {
    throw new EditorialError(
      'EDITORIAL_GATE_REQUIRED',
      'Item must be approved before it can be published.',
      409,
    );
  }
}

export interface EditorialServiceDeps {
  db: Database;
  siteId: string;
  /** Acting user id; recorded on reviews and audit. */
  userId?: string | null;
  actorEmail?: string | null;
}

/**
 * Database-backed orchestration of the editorial workflow: persists
 * `items.editorial_state`, manages `content_reviews`, enforces the gate and
 * the separate-reviewer rule, and audits every transition. Human sign-off only
 * — never touches `agent_approvals` (Req 9.5).
 */
export class EditorialService {
  constructor(private readonly deps: EditorialServiceDeps) {}

  private async resolve(collectionName: string, itemId: string) {
    const [coll] = await this.deps.db
      .select()
      .from(collections)
      .where(and(scopeSite(collections.siteId, this.deps.siteId), eq(collections.name, collectionName)))
      .limit(1);
    if (!coll) throw new EditorialError('NOT_FOUND', `Collection "${collectionName}" not found.`, 404);

    const [item] = await this.deps.db
      .select()
      .from(items)
      .where(and(scopeSite(items.siteId, this.deps.siteId), eq(items.collectionId, coll.id), eq(items.id, itemId)))
      .limit(1);
    if (!item) throw new EditorialError('NOT_FOUND', `Item "${itemId}" not found.`, 404);

    const current = (item.editorialState as EditorialState | null) ??
      editorialStateFromStatus(item.status as ItemStatus);
    return { coll, item, current };
  }

  private async latestRevisionId(itemId: string): Promise<string | null> {
    const [rev] = await this.deps.db
      .select({ id: revisions.id })
      .from(revisions)
      .where(and(scopeSite(revisions.siteId, this.deps.siteId), eq(revisions.itemId, itemId)))
      .orderBy(desc(revisions.createdAt))
      .limit(1);
    return rev?.id ?? null;
  }

  private async applyAndPersist(
    collectionName: string,
    itemId: string,
    current: EditorialState,
    action: EditorialAction,
    collId: string,
  ): Promise<EditorialState> {
    const next = applyTransition(current, action);
    await this.deps.db
      .update(items)
      .set({ editorialState: next, status: statusForEditorialState(next), updatedAt: new Date() })
      .where(and(scopeSite(items.siteId, this.deps.siteId), eq(items.collectionId, collId), eq(items.id, itemId)));
    await this.audit(collectionName, itemId, current, next, action);
    return next;
  }

  private async audit(
    collection: string,
    itemId: string,
    from: EditorialState,
    to: EditorialState,
    action: EditorialAction,
  ): Promise<void> {
    await new AuditLogger({ db: this.deps.db, siteId: this.deps.siteId }).write({
      event: 'editorial_transition',
      actorEmail: this.deps.actorEmail ?? null,
      requestId: null,
      metadata: { siteId: this.deps.siteId, collection, itemId, from, to, action, actor: this.deps.userId ?? null },
    });
  }

  /** Submit an item for review (Req 9.1): create a pending Content_Review. */
  async submitReview(collectionName: string, itemId: string, opts: { assignedTo?: string | null } = {}) {
    const { coll, item, current } = await this.resolve(collectionName, itemId);
    const revisionId = await this.latestRevisionId(itemId);
    const next = await this.applyAndPersist(collectionName, itemId, current, 'submit_review', coll.id);
    const [review] = await this.deps.db
      .insert(contentReviews)
      .values({
        siteId: this.deps.siteId,
        itemId: item.id,
        revisionId,
        requestedBy: this.deps.userId ?? null,
        assignedTo: opts.assignedTo ?? null,
        status: 'pending',
      })
      .returning();
    return { review, editorialState: next };
  }

  /** Approve the pending review (Req 9.3); enforces requireSeparateReviewer. */
  async approve(collectionName: string, itemId: string, opts: { reason?: string } = {}) {
    return this.decide(collectionName, itemId, 'approve', 'approved', opts.reason);
  }

  /** Reject the pending review with a reason (Req 9.4). */
  async reject(collectionName: string, itemId: string, opts: { reason?: string } = {}) {
    return this.decide(collectionName, itemId, 'reject', 'rejected', opts.reason);
  }

  private async decide(
    collectionName: string,
    itemId: string,
    action: 'approve' | 'reject',
    reviewStatus: 'approved' | 'rejected',
    reason?: string,
  ) {
    const { coll, current } = await this.resolve(collectionName, itemId);

    const [pending] = await this.deps.db
      .select()
      .from(contentReviews)
      .where(
        and(
          scopeSite(contentReviews.siteId, this.deps.siteId),
          eq(contentReviews.itemId, itemId),
          eq(contentReviews.status, 'pending'),
        ),
      )
      .orderBy(desc(contentReviews.createdAt))
      .limit(1);
    if (!pending) throw new EditorialError('NO_PENDING_REVIEW', 'No pending review for this item.', 409);

    // Separate-reviewer rule (Req 9.3).
    const meta = (coll.meta as Record<string, unknown> | null) ?? {};
    if (
      meta.requireSeparateReviewer === true &&
      pending.requestedBy &&
      this.deps.userId &&
      pending.requestedBy === this.deps.userId
    ) {
      throw new EditorialError(
        'SEPARATE_REVIEWER_REQUIRED',
        'The reviewer must be different from the author.',
        409,
      );
    }

    const next = await this.applyAndPersist(collectionName, itemId, current, action, coll.id);
    await this.deps.db
      .update(contentReviews)
      .set({
        status: reviewStatus,
        reason: reason ?? null,
        decidedBy: this.deps.userId ?? null,
        decidedAt: new Date(),
      })
      .where(eq(contentReviews.id, pending.id));
    return { editorialState: next, reviewId: pending.id };
  }
}
