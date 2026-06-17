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
