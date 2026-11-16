/**
 * SDK commands for draft review (#512): read the site's versioned review
 * profiles, review a saved item or an unsaved draft, read a run with its
 * staleness, and record editor feedback. Command factories
 * `(client) => Promise<T>`, like {@link decide}.
 *
 * A review only suggests. None of these calls writes to an item; applying a
 * suggestion is the caller's own item update, under its own permissions.
 *
 * The SDK has no runtime dependencies, so these types mirror the CMS
 * contracts (`@lumibase/contracts` `decision-review.ts`). A type-equality test
 * (`__tests__/reviews.contract.test.ts`) fails the SDK typecheck when the two
 * drift. Provider keys stay on the CMS; the client only sends its usual
 * bearer and `X-Lumi-Site` headers.
 */

import type { LumiClient } from "../client";
import type { DecisionAnswer, DecisionQuestion } from "./decisions";

export type ReviewPreset = "taxonomy" | "brand-voice" | "brief-alignment";

export type ReviewRunStatus = "running" | "success" | "abstained" | "error";

export type ReviewVerdict = "accept" | "edit" | "reject";

/** `content_changed` / `revision_changed`: the item moved on; `item_unavailable`: it is gone or unreadable. */
export type ReviewStaleReason = "content_changed" | "revision_changed" | "item_unavailable";

/** A versioned review profile. Rows are immutable; a new version archives the previous one. */
export interface ReviewProfile {
  id: string;
  key: string;
  version: number;
  status: "active" | "archived";
  /** Collection the profile applies to; `null` = any collection. */
  collection: string | null;
  preset: ReviewPreset | null;
  /** Top-level item fields the review reads. */
  fields: string[];
  questions: Record<string, DecisionQuestion>;
  sourceField: string | null;
  minConfidence: number | null;
  /** Caveat, e.g. "no source — not a fact-check". */
  note: string | null;
  createdBy: string | null;
  createdAt: string;
}

/** `POST /ai/reviews`. Give exactly one of `itemId` (saved item) or `snapshot` (unsaved draft). */
export interface ReviewRunRequest {
  /** Profile key. */
  profile: string;
  /** Defaults to the active version. */
  profileVersion?: number;
  collection: string;
  itemId?: string;
  /** Unsaved field values. Every key must be a profile field the caller may read and write. */
  snapshot?: Record<string, unknown>;
  /**
   * 8–128 chars. Same key from the same principal → the stored run, no second
   * provider call, whatever the content now is. The key must therefore change
   * when the content or profile version does: build it from
   * {@link reviewContentHash} and the profile version, never from a fixed id.
   */
  idempotencyKey?: string;
}

export interface ReviewRun {
  /** uuidv7. */
  id: string;
  profileId: string;
  profileKey: string;
  profileVersion: number;
  collection: string;
  itemId: string | null;
  revisionId: string | null;
  /** `sha256:<hex>` of the canonical JSON of the reviewed fields. */
  contentHash: string;
  source: "item" | "snapshot";
  /** Profile fields the caller could not read; they were not sent. */
  omittedFields: string[];
  /** `abstained`: every choice was `other`/`unknown`, or a confidence fell below the profile minimum. */
  status: ReviewRunStatus;
  provider: string | null;
  model: string | null;
  /** `null` until the run completes; `false` when the CMS answers with `DECISION_PROVIDER=llm`. */
  calibrated: boolean | null;
  /** Keyed by question; `null` until the run completes or when it failed. */
  answers: Record<string, DecisionAnswer> | null;
  /** `null` until the run completes; a `null` count is unknown, not zero. */
  usage: { inputTokens: number | null; outputTokens: number | null } | null;
  latencyMs: number | null;
  /** The decision error code when `status` is `error`. */
  errorCode: string | null;
  createdAt: string;
  completedAt: string | null;
  /** Item runs: the item changed since the run. Snapshot runs report `false` (checked on feedback). */
  stale: boolean;
  staleReason: ReviewStaleReason | null;
  note: string | null;
}

export interface ReviewFeedbackEntry {
  questionKey: string;
  verdict: ReviewVerdict;
  /** Required for `edit`: the value the editor chose instead. */
  editedValue?: unknown;
}

/** `POST /ai/reviews/:id/feedback`. One entry per question. */
export interface ReviewFeedbackRequest {
  entries: ReviewFeedbackEntry[];
  /** Accept/edit on a stale run is refused (409 `REVIEW_STALE`) unless this is `true`. */
  acknowledgeStale?: boolean;
  /**
   * Snapshot runs: {@link reviewContentHash} of the draft the editor sees now.
   * A value other than `run.contentHash` makes accept/edit fail with 409
   * `REVIEW_STALE`. Without it (or with `run.contentHash` itself) a changed
   * draft is not detected, because the CMS cannot re-read an unsaved draft.
   */
  contentHash?: string;
}

/** Stored feedback. The first verdict per run, question and principal is final. */
export interface ReviewFeedback {
  id: string;
  runId: string;
  questionKey: string;
  verdict: ReviewVerdict;
  editedValue: unknown;
  principalType: string;
  principalId: string;
  createdAt: string;
}

export interface ReviewRequestOptions {
  /** Aborts the HTTP request; the promise rejects with the fetch `AbortError`. */
  signal?: AbortSignal;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

/**
 * `sha256:<64 hex>` of the canonical JSON (sorted keys, dates serialised,
 * `undefined` dropped) of `values`, computed exactly as the CMS computes
 * `ReviewRun.contentHash`. Uses WebCrypto (`crypto.subtle`), so it runs in
 * browsers, Node 18+ and Workers.
 *
 * Use it on the draft the editor sees now:
 * - pass it as `contentHash` to {@link submitReviewFeedback} on a snapshot run,
 *   so the CMS answers 409 `REVIEW_STALE` when the draft changed after the
 *   review. Sending the run's own `contentHash` back disables that check;
 * - build the `idempotencyKey` of {@link reviewDraft} from it, so a changed
 *   draft gets a new run instead of a replay of the old one.
 *
 * For a snapshot run, hash the same fields you sent as `snapshot`.
 */
export async function reviewContentHash(values: Record<string, unknown>): Promise<string> {
  const canonical = JSON.stringify(canonicalize(JSON.parse(JSON.stringify(values ?? null))));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
  return `sha256:${Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const BASE = "/api/v1/ai";

function withQuery(path: string, params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) qs.set(key, value);
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}

/** Active profiles of the site; with `collection`, those bound to it or to any collection. Needs `ai:decide`. */
export function listReviewProfiles(params: { collection?: string } = {}, options: ReviewRequestOptions = {}) {
  return async (client: LumiClient): Promise<ReviewProfile[]> => {
    const res = await client.rawRequest<ReviewProfile[]>(
      withQuery(`${BASE}/review-profiles`, { collection: params.collection }),
      { signal: options.signal },
    );
    return res.data;
  };
}

/** One profile: the active version, or `version`. 404 `REVIEW_PROFILE_NOT_FOUND`. */
export function getReviewProfile(key: string, params: { version?: number } = {}, options: ReviewRequestOptions = {}) {
  return async (client: LumiClient): Promise<ReviewProfile> => {
    const res = await client.rawRequest<ReviewProfile>(
      withQuery(`${BASE}/review-profiles/${encodeURIComponent(key)}`, {
        version: params.version === undefined ? undefined : String(params.version),
      }),
      { signal: options.signal },
    );
    return res.data;
  };
}

/**
 * Review a saved item (`itemId`) or an unsaved draft (`snapshot`) with a
 * profile. Runs the governed decision path: rejects with `LumiError` carrying
 * the same codes as {@link decide} (403 `DECISION_DISABLED`, 429 with
 * `retryAfter`, 504 `DECISION_TIMEOUT`, …) plus 422 `REVIEW_FIELD_NOT_ALLOWED`
 * for a snapshot field outside the profile or the caller's permissions.
 * Resolves with the run — a replay of the same `idempotencyKey` returns the
 * stored run without a second provider call.
 */
export function reviewDraft(request: ReviewRunRequest, options: ReviewRequestOptions = {}) {
  return async (client: LumiClient): Promise<ReviewRun> => {
    const res = await client.rawRequest<ReviewRun>(`${BASE}/reviews`, {
      method: "POST",
      body: JSON.stringify(request),
      signal: options.signal,
    });
    return res.data;
  };
}

/** A run with its current staleness. 404 `REVIEW_RUN_NOT_FOUND` also when the caller cannot read what it reviewed. */
export function getReview(id: string, options: ReviewRequestOptions = {}) {
  return async (client: LumiClient): Promise<ReviewRun> => {
    const res = await client.rawRequest<ReviewRun>(`${BASE}/reviews/${encodeURIComponent(id)}`, {
      signal: options.signal,
    });
    return res.data;
  };
}

/** Runs of one item the caller may see, newest first (50 at most). */
export function listReviews(params: { collection: string; itemId: string }, options: ReviewRequestOptions = {}) {
  return async (client: LumiClient): Promise<ReviewRun[]> => {
    const res = await client.rawRequest<ReviewRun[]>(
      withQuery(`${BASE}/reviews`, { collection: params.collection, itemId: params.itemId }),
      { signal: options.signal },
    );
    return res.data;
  };
}

/**
 * Record accept / edit / reject on a run's answers. A retry returns the
 * stored rows and adds none. `accept`/`edit` on a stale run rejects with 409
 * `REVIEW_STALE` unless `acknowledgeStale: true`. Never changes the item.
 */
export function submitReviewFeedback(
  runId: string,
  request: ReviewFeedbackRequest,
  options: ReviewRequestOptions = {},
) {
  return async (client: LumiClient): Promise<ReviewFeedback[]> => {
    const res = await client.rawRequest<ReviewFeedback[]>(`${BASE}/reviews/${encodeURIComponent(runId)}/feedback`, {
      method: "POST",
      body: JSON.stringify(request),
      signal: options.signal,
    });
    return res.data;
  };
}
