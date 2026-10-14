import { useCallback, useEffect, useRef, useState } from 'react';
import {
  LumiError,
  decisionErrorCode,
  reviewDraft,
  submitReviewFeedback,
  type ReviewProfile,
  type ReviewRun,
  type ReviewVerdict,
} from '@lumibase/sdk';
// SDK commands are invoked as `command(getApiClient())`, never through the
// client's `request` method: the Studio client is extended with `legacyRest()`,
// whose backward-compatible `request` is `rawRequest` and would treat the
// command as a path.
import { getApiClient } from '@/lib/api';
import { canonicalReviewJson, draftReviewHash } from './draft-review-hash';

/**
 * State machine for the Studio draft review panel (Jev J08, #515).
 *
 *   idle ─run→ loading ─→ success | abstained | stale | disabled | unconfigured | error(code)
 *   loading ─cancel/unmount→ idle (the request is aborted)
 *   success | abstained ─reviewed content changed→ stale
 *
 * A review only suggests. Nothing here writes to an item: feedback goes to
 * `POST /ai/reviews/:id/feedback`, and applying a value is the editor's own
 * form state, saved later through the existing draft save. An error is never
 * reported as a pass — every failure maps to an explicit state.
 */

export type DraftReviewErrorCode =
  | 'forbidden'
  | 'quota'
  | 'timeout'
  | 'unavailable'
  | 'field_not_allowed'
  | 'too_large'
  | 'not_found'
  | 'failed';

export type DraftReviewState =
  | { status: 'idle' }
  | { status: 'disabled' }
  | { status: 'unconfigured' }
  | { status: 'loading' }
  | { status: 'success'; run: ReviewRun }
  | { status: 'abstained'; run: ReviewRun }
  | { status: 'stale'; run: ReviewRun | null }
  | { status: 'error'; code: DraftReviewErrorCode; retryAfter: number | null };

/**
 * What to review. `itemId` without `snapshot` reviews the saved item (the CMS
 * reads it under the caller's permissions and records its revision);
 * `snapshot` reviews unsaved values. `projected` is exactly the content the
 * review covers, used to detect a change after the request started.
 */
export interface DraftReviewTarget {
  itemId?: string;
  snapshot?: Record<string, unknown>;
  projected: Record<string, unknown>;
}

export interface DraftReviewFeedbackState {
  verdict: ReviewVerdict;
  status: 'pending' | 'saved' | 'error';
}

/** Maps a decision/review error code (and HTTP status when there is none) to a panel state. */
export function stateFromErrorCode(
  code: string | null,
  options: { status?: number; retryAfter?: number | null } = {},
): DraftReviewState {
  const retryAfter = options.retryAfter ?? null;
  const error = (c: DraftReviewErrorCode): DraftReviewState => ({ status: 'error', code: c, retryAfter });
  switch (code) {
    case 'DECISION_DISABLED':
      return { status: 'disabled' };
    case 'DECISION_NOT_CONFIGURED':
    case 'REVIEW_PROFILE_NOT_FOUND':
      return { status: 'unconfigured' };
    case 'REVIEW_STALE':
      return { status: 'stale', run: null };
    case 'FORBIDDEN':
      return error('forbidden');
    case 'DECISION_QUOTA_EXCEEDED':
    case 'DECISION_CONCURRENCY_LIMITED':
    case 'DECISION_RATE_LIMITED':
      return error('quota');
    case 'DECISION_TIMEOUT':
      return error('timeout');
    case 'DECISION_UNAVAILABLE':
    case 'DECISION_UPSTREAM':
    case 'DECISION_AUTH':
    case 'DECISION_PARSE_FAILED':
    case 'DECISION_VALIDATION':
    case 'DECISION_QUOTA_UNAVAILABLE':
      return error('unavailable');
    case 'DECISION_FIELD_NOT_ALLOWED':
    case 'REVIEW_FIELD_NOT_ALLOWED':
    case 'REVIEW_COLLECTION_MISMATCH':
      return error('field_not_allowed');
    case 'DECISION_INPUT_TOO_LARGE':
      return error('too_large');
    case 'REVIEW_ITEM_NOT_FOUND':
    case 'REVIEW_RUN_NOT_FOUND':
      return error('not_found');
    default:
      break;
  }
  switch (options.status) {
    case 403:
      return error('forbidden');
    case 429:
      return error('quota');
    case 503:
      return error('unavailable');
    case 504:
      return error('timeout');
    default:
      return error('failed');
  }
}

/** The panel state for a run the CMS returned (a fresh run or a replay). */
export function stateFromRun(run: ReviewRun): DraftReviewState {
  if (run.status === 'error') return stateFromErrorCode(run.errorCode);
  if (run.status === 'running' || !run.answers) return { status: 'error', code: 'failed', retryAfter: null };
  if (run.stale) return { status: 'stale', run };
  return run.status === 'abstained' ? { status: 'abstained', run } : { status: 'success', run };
}

/** A rejected SDK call → panel state. */
export function stateFromError(err: unknown): DraftReviewState {
  if (err instanceof LumiError) {
    return stateFromErrorCode(decisionErrorCode(err), { status: err.status, retryAfter: err.retryAfter });
  }
  return { status: 'error', code: 'failed', retryAfter: null };
}

function isAbort(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}

function randomSalt(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * `Idempotency-Key` for one Run click. It covers the profile version, the
 * collection and item (so two items with equal content never share a run),
 * the reviewed content, and a per-panel salt plus click counter (so an
 * errored or stale run is never replayed by the next click). A double submit
 * of the same click still resolves to one run.
 */
async function idempotencyKey(parts: Record<string, unknown>): Promise<string> {
  const hash = await draftReviewHash(parts);
  return `studio-${hash.slice(7, 47)}`;
}

type Internal = { state: DraftReviewState; base: string | null };

export function useDraftReview({
  collection,
  profile,
  target,
}: {
  collection: string;
  profile: ReviewProfile | null;
  target: DraftReviewTarget;
}) {
  const [internal, setInternal] = useState<Internal>({ state: { status: 'idle' }, base: null });
  const [feedback, setFeedback] = useState<Record<string, DraftReviewFeedbackState>>({});
  const abortRef = useRef<AbortController | null>(null);
  const saltRef = useRef<string>(randomSalt());
  const attemptRef = useRef(0);
  const targetRef = useRef(target);
  targetRef.current = target;

  const current = canonicalReviewJson(target.projected);
  const changed = internal.base !== null && current !== internal.base;

  // Abort an in-flight review when the editor unmounts (navigation away).
  useEffect(() => () => abortRef.current?.abort(), []);

  const run = useCallback(async () => {
    if (!profile) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const reviewed = targetRef.current;
    const base = canonicalReviewJson(reviewed.projected);
    attemptRef.current += 1;
    setFeedback({});
    setInternal({ state: { status: 'loading' }, base });
    try {
      const key = await idempotencyKey({
        salt: saltRef.current,
        attempt: attemptRef.current,
        profile: profile.key,
        version: profile.version,
        collection,
        itemId: reviewed.itemId ?? null,
        mode: reviewed.snapshot ? 'snapshot' : 'item',
        content: base,
      });
      const result = await reviewDraft(
          {
            profile: profile.key,
            profileVersion: profile.version,
            collection,
            ...(reviewed.itemId ? { itemId: reviewed.itemId } : {}),
            ...(reviewed.snapshot ? { snapshot: reviewed.snapshot } : {}),
            idempotencyKey: key,
          },
          { signal: controller.signal },
        )(getApiClient());
      if (controller.signal.aborted) return;
      setInternal({ state: stateFromRun(result), base });
    } catch (err) {
      if (controller.signal.aborted || isAbort(err)) return;
      setInternal({ state: stateFromError(err), base });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [collection, profile]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setInternal({ state: { status: 'idle' }, base: null });
  }, []);

  const runOf = (s: DraftReviewState): ReviewRun | null =>
    s.status === 'success' || s.status === 'abstained' || s.status === 'stale' ? s.run : null;

  /**
   * Records one verdict, once per `runId:questionKey`. Resolves `true` only
   * when the CMS stored it — the caller applies a value after that, never
   * before. A changed draft, or 409 `REVIEW_STALE`, turns the panel stale and
   * resolves `false` without recording anything.
   */
  const submitFeedback = useCallback(
    async (questionKey: string, verdict: ReviewVerdict, editedValue?: unknown): Promise<boolean> => {
      const reviewRun = runOf(internal.state);
      if (!reviewRun) return false;
      const key = `${reviewRun.id}:${questionKey}`;
      const existing = feedback[key];
      if (existing && existing.status !== 'error') return false;
      const now = canonicalReviewJson(targetRef.current.projected);
      if (verdict !== 'reject' && (internal.state.status === 'stale' || (internal.base !== null && now !== internal.base))) {
        setInternal((prev) => ({ ...prev, state: { status: 'stale', run: reviewRun } }));
        return false;
      }
      setFeedback((prev) => ({ ...prev, [key]: { verdict, status: 'pending' } }));
      try {
        const contentHash =
          reviewRun.source === 'snapshot' ? await draftReviewHash(targetRef.current.projected) : undefined;
        await submitReviewFeedback(reviewRun.id, {
          entries: [{ questionKey, verdict, ...(verdict === 'edit' ? { editedValue } : {}) }],
          ...(contentHash ? { contentHash } : {}),
        })(getApiClient());
        setFeedback((prev) => ({ ...prev, [key]: { verdict, status: 'saved' } }));
        return true;
      } catch (err) {
        if (err instanceof LumiError && decisionErrorCode(err) === 'REVIEW_STALE') {
          setFeedback((prev) => {
            const next = { ...prev };
            delete next[key];
            return next;
          });
          setInternal((prev) => ({ ...prev, state: { status: 'stale', run: reviewRun } }));
          return false;
        }
        setFeedback((prev) => ({ ...prev, [key]: { verdict, status: 'error' } }));
        return false;
      }
    },
    [internal, feedback],
  );

  let state = internal.state;
  if ((state.status === 'success' || state.status === 'abstained') && changed) {
    state = { status: 'stale', run: state.run };
  }

  const feedbackFor = (questionKey: string): DraftReviewFeedbackState | undefined => {
    const reviewRun = runOf(state);
    return reviewRun ? feedback[`${reviewRun.id}:${questionKey}`] : undefined;
  };

  return { state, run, cancel, submitFeedback, feedbackFor, hasRun: attemptRef.current > 0 };
}
