/**
 * Draft review (Jev J05, #512): run a versioned review profile against one
 * item (or an unsaved snapshot) through the governed decision path, record
 * provenance, detect staleness, and collect editor feedback.
 *
 * Trust boundaries:
 *   - Content is read with the caller's own row/field RBAC (`ReviewContentAccess`
 *     is built from the request context). Fields the caller cannot read are
 *     dropped and listed in `omittedFields`, never sent.
 *   - Content goes only in `state`. The questions come from the stored profile,
 *     so text inside the content cannot change what is asked.
 *   - The provider call goes through J04's governed path (capability checked by
 *     the route, then opt-in, field allowlist, quota, audit).
 *   - A review only suggests. Nothing here writes to an item.
 */

import type {
  ReviewFeedback,
  ReviewFeedbackRequest,
  ReviewPilotMode,
  ReviewProfile,
  ReviewProfileCreateInput,
  ReviewProfileVersionInput,
  ReviewQuestion,
  ReviewRun,
  ReviewRunRequest,
  ReviewSession,
  ReviewSessionRequest,
  ReviewStaleReason,
} from '@lumibase/contracts/schemas';
import { nanoid } from 'nanoid';
import { v7 as uuidv7 } from 'uuid';
import type { GovernedDecisionOutcome } from './decision-governance';
import type { DecisionAnswer, DecisionRequest } from './decision-provider';
import { buildPresetProfile } from './review-presets';
import type {
  ReviewProfileInsert,
  ReviewProfileRecord,
  ReviewRunRecord,
  ReviewStore,
} from './review-store';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ReviewServiceErrorCode =
  | 'VALIDATION'
  | 'FORBIDDEN'
  | 'REVIEW_PROFILE_NOT_FOUND'
  | 'REVIEW_PROFILE_EXISTS'
  | 'REVIEW_PROFILE_CONFLICT'
  | 'REVIEW_ITEM_NOT_FOUND'
  | 'REVIEW_RUN_NOT_FOUND'
  | 'REVIEW_FIELD_NOT_ALLOWED'
  | 'REVIEW_COLLECTION_MISMATCH'
  | 'REVIEW_NOT_COMPLETE'
  | 'REVIEW_STALE'
  | 'REVIEW_SESSION_MODE_MISMATCH'
  | 'REVIEW_SESSION_RUN_INVALID';

export const REVIEW_ERROR_STATUS: Record<ReviewServiceErrorCode, 400 | 403 | 404 | 409 | 422> = {
  VALIDATION: 400,
  FORBIDDEN: 403,
  REVIEW_PROFILE_NOT_FOUND: 404,
  REVIEW_PROFILE_EXISTS: 409,
  REVIEW_PROFILE_CONFLICT: 409,
  REVIEW_ITEM_NOT_FOUND: 404,
  REVIEW_RUN_NOT_FOUND: 404,
  REVIEW_FIELD_NOT_ALLOWED: 422,
  REVIEW_COLLECTION_MISMATCH: 422,
  REVIEW_NOT_COMPLETE: 409,
  REVIEW_STALE: 409,
  REVIEW_SESSION_MODE_MISMATCH: 409,
  REVIEW_SESSION_RUN_INVALID: 422,
};

export class ReviewServiceError extends Error {
  readonly code: ReviewServiceErrorCode;
  readonly status: 400 | 403 | 404 | 409 | 422;

  constructor(code: ReviewServiceErrorCode, message: string) {
    super(message);
    this.name = 'ReviewServiceError';
    this.code = code;
    this.status = REVIEW_ERROR_STATUS[code];
  }
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** Reads content as the caller. Built per request (see `review-content-access.ts`). */
export interface ReviewContentAccess {
  /**
   * Reads `fields` of one item with the caller's row/field RBAC. Returns only
   * readable fields; the rest are listed in `omittedFields`. Throws
   * `REVIEW_ITEM_NOT_FOUND` (missing, hidden by a row rule, or unknown
   * collection) or `FORBIDDEN` (no read permission on the collection).
   */
  readItem(
    collection: string,
    itemId: string,
    fields: readonly string[],
  ): Promise<{ values: Record<string, unknown>; omittedFields: string[] }>;
  /** Keys of `keys` the caller may not both read and write (`create` or `update`) in `collection`. */
  deniedSnapshotFields(collection: string, keys: readonly string[], action: 'create' | 'update'): Promise<string[]>;
  /** Latest revision id of the item, or null when it has none. */
  latestRevisionId(itemId: string): Promise<string | null>;
}

export interface ReviewPrincipal {
  /** `system`: the semantic drift scan (J12, #519); no person is behind it. */
  type: 'user' | 'api_key' | 'dev' | 'system';
  id: string;
  /** Control-plane admin: may manage profiles and see every run of the site. */
  admin: boolean;
}

/** The governed decision call (J04), already bound to the request's audit context. */
export type GovernedDecide = (
  request: DecisionRequest,
  options: { signal?: AbortSignal },
) => Promise<GovernedDecisionOutcome>;

export interface ReviewServiceDeps {
  store: ReviewStore;
  siteId: string;
  content: ReviewContentAccess;
  decide: GovernedDecide;
  now?: () => number;
  /** uuidv7 for runs and feedback. */
  newId?: () => string;
}

export type RunReviewResult =
  | { ok: true; run: ReviewRun; created: boolean }
  /** The governed call failed; `outcome` carries the HTTP status/body (and Retry-After). */
  | { ok: false; run: ReviewRun; outcome: GovernedDecisionOutcome };

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

/** Plain JSON with sorted keys (dates serialised, undefined dropped). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(JSON.parse(JSON.stringify(value ?? null))));
}

/** `sha256:<64 hex>` of the canonical JSON of the projected fields. */
export async function reviewContentHash(values: Record<string, unknown>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(values))));
  return `sha256:${[...digest].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** Choice answers that mean "the model did not pick a real option". */
const ABSTAIN_CHOICES = new Set(['other', 'unknown']);

/**
 * `abstained` when every choice answer is `other`/`unknown`, or when any
 * answer's confidence is below the profile's `minConfidence`.
 */
export function reviewOutcomeStatus(
  answers: Record<string, DecisionAnswer>,
  minConfidence: number | null,
): 'success' | 'abstained' {
  const list = Object.values(answers);
  const choices = list.filter((answer) => answer.type === 'choice');
  if (choices.length > 0 && choices.every((answer) => ABSTAIN_CHOICES.has(answer.choice))) return 'abstained';
  if (minConfidence !== null) {
    for (const answer of list) {
      if (answer.type !== 'noul' && answer.confidence < minConfidence) return 'abstained';
    }
  }
  return 'success';
}

function pick(values: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) if (field in values) out[field] = values[field];
  return out;
}

function toProfile(row: ReviewProfileRecord): ReviewProfile {
  return {
    id: row.id,
    key: row.key,
    version: row.version,
    status: row.status === 'archived' ? 'archived' : 'active',
    collection: row.collection,
    preset: (row.preset as ReviewProfile['preset']) ?? null,
    fields: row.fields as string[],
    questions: row.questions as Record<string, ReviewQuestion>,
    sourceField: row.sourceField,
    minConfidence: row.minConfidence,
    note: row.note,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

function toRun(
  row: ReviewRunRecord,
  stale: { stale: boolean; staleReason: ReviewStaleReason | null },
  note: string | null,
): ReviewRun {
  return {
    id: row.id,
    profileId: row.profileId,
    profileKey: row.profileKey,
    profileVersion: row.profileVersion,
    collection: row.collection,
    itemId: row.itemId,
    revisionId: row.revisionId,
    contentHash: row.contentHash,
    source: row.source === 'snapshot' ? 'snapshot' : 'item',
    omittedFields: row.omittedFields as string[],
    status: row.status as ReviewRun['status'],
    provider: row.provider,
    model: row.model,
    calibrated: row.calibrated,
    answers: (row.answers as Record<string, unknown> | null) ?? null,
    usage: (row.usage as ReviewRun['usage']) ?? null,
    latencyMs: row.latencyMs,
    errorCode: row.errorCode,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    ...stale,
    note,
  };
}

const FRESH = { stale: false, staleReason: null } as const;
const COMPLETE = new Set(['success', 'abstained']);

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

type ItemRead = { values: Record<string, unknown>; omittedFields: string[] } | 'unavailable';

export class ReviewService {
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly deps: ReviewServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? uuidv7;
  }

  // ---- profiles -----------------------------------------------------------

  async listProfiles(collection?: string): Promise<ReviewProfile[]> {
    return (await this.deps.store.listActiveProfiles(this.deps.siteId, collection)).map(toProfile);
  }

  async getProfile(key: string, version?: number): Promise<ReviewProfile> {
    return toProfile(await this.requireProfile(key, version));
  }

  async createProfile(input: ReviewProfileCreateInput, principal: ReviewPrincipal): Promise<ReviewProfile> {
    const row = await this.deps.store.insertFirstProfile(this.profileRow(input.key, 1, input, principal));
    if (!row) {
      throw new ReviewServiceError(
        'REVIEW_PROFILE_EXISTS',
        `Profile "${input.key}" already exists. Publish a new version with POST /ai/review-profiles/${input.key}/versions.`,
      );
    }
    return toProfile(row);
  }

  async createProfileVersion(
    key: string,
    input: ReviewProfileVersionInput,
    principal: ReviewPrincipal,
  ): Promise<ReviewProfile> {
    // Build once up front so an invalid body fails before the transaction.
    this.profileRow(key, 1, input, principal);
    const result = await this.deps.store.insertNextProfileVersion(this.deps.siteId, key, (version) =>
      this.profileRow(key, version, input, principal),
    );
    if (result === 'not_found') throw new ReviewServiceError('REVIEW_PROFILE_NOT_FOUND', `Profile "${key}" not found.`);
    if (result === 'conflict') {
      throw new ReviewServiceError('REVIEW_PROFILE_CONFLICT', `Another version of "${key}" was published at the same time. Retry.`);
    }
    return toProfile(result);
  }

  private profileRow(
    key: string,
    version: number,
    input: ReviewProfileVersionInput,
    principal: ReviewPrincipal,
  ): ReviewProfileInsert {
    const preset = input.preset
      ? buildPresetProfile({ preset: input.preset, options: input.presetOptions, sourceField: input.sourceField })
      : null;
    const questions = { ...(preset?.questions ?? {}), ...(input.questions ?? {}) };
    if (Object.keys(questions).length > 32) {
      throw new ReviewServiceError('VALIDATION', 'A profile may ask at most 32 questions, preset questions included.');
    }
    return {
      id: nanoid(),
      siteId: this.deps.siteId,
      collection: input.collection ?? null,
      key,
      version,
      preset: input.preset ?? null,
      fields: input.fields,
      questions,
      sourceField: input.sourceField ?? null,
      minConfidence: input.minConfidence ?? null,
      note: preset?.note ?? null,
      createdBy: principal.id,
    };
  }

  private async requireProfile(key: string, version?: number): Promise<ReviewProfileRecord> {
    const row = await this.deps.store.getProfile(this.deps.siteId, key, version);
    if (!row) {
      throw new ReviewServiceError(
        'REVIEW_PROFILE_NOT_FOUND',
        version === undefined ? `Profile "${key}" not found.` : `Profile "${key}" version ${version} not found.`,
      );
    }
    return row;
  }

  // ---- runs ---------------------------------------------------------------

  async runReview(
    request: ReviewRunRequest,
    options: { principal: ReviewPrincipal; signal?: AbortSignal; idempotencyKey?: string },
  ): Promise<RunReviewResult> {
    const { store, siteId, content } = this.deps;
    const profile = await this.requireProfile(request.profile, request.profileVersion);
    if (profile.collection !== null && profile.collection !== request.collection) {
      throw new ReviewServiceError(
        'REVIEW_COLLECTION_MISMATCH',
        `Profile "${profile.key}" reviews the "${profile.collection}" collection, not "${request.collection}".`,
      );
    }
    const fields = profile.fields as string[];

    let values: Record<string, unknown>;
    let omittedFields: string[] = [];
    let revisionId: string | null = null;
    if (request.snapshot !== undefined) {
      const keys = Object.keys(request.snapshot);
      const unlisted = keys.filter((key) => !fields.includes(key));
      if (unlisted.length > 0) {
        throw new ReviewServiceError(
          'REVIEW_FIELD_NOT_ALLOWED',
          `Snapshot fields not in profile "${profile.key}": ${unlisted.join(', ')}.`,
        );
      }
      const denied = await content.deniedSnapshotFields(
        request.collection,
        keys,
        request.itemId === undefined ? 'create' : 'update',
      );
      if (denied.length > 0) {
        throw new ReviewServiceError(
          'REVIEW_FIELD_NOT_ALLOWED',
          `You may not read and write these snapshot fields: ${denied.join(', ')}.`,
        );
      }
      values = request.snapshot;
    } else {
      const read = await content.readItem(request.collection, request.itemId!, fields);
      values = read.values;
      omittedFields = read.omittedFields;
      revisionId = await content.latestRevisionId(request.itemId!);
    }
    const state = JSON.parse(JSON.stringify(values)) as Record<string, unknown>;
    if (Object.keys(state).length === 0) {
      throw new ReviewServiceError(
        'REVIEW_FIELD_NOT_ALLOWED',
        `None of the fields of profile "${profile.key}" is readable or present, so there is nothing to review.`,
      );
    }

    const { run, created } = await store.claimRun({
      id: this.newId(),
      siteId,
      profileId: profile.id,
      profileKey: profile.key,
      profileVersion: profile.version,
      collection: request.collection,
      itemId: request.itemId ?? null,
      revisionId,
      contentHash: await reviewContentHash(state),
      source: request.snapshot !== undefined ? 'snapshot' : 'item',
      omittedFields,
      principalType: options.principal.type,
      principalId: options.principal.id,
      status: 'running',
      idempotencyKey: options.idempotencyKey ?? request.idempotencyKey ?? this.newId(),
    });
    if (!created) {
      // A replay reports the run as stored, so assess it against the profile
      // version it was answered with, not the one this request resolved.
      const runProfile =
        run.profileId === profile.id ? profile : await store.getProfileById(siteId, run.profileId);
      const view = runProfile ? await this.assess(run, runProfile, options.principal, new Map()) : null;
      if (!view) throw new ReviewServiceError('REVIEW_RUN_NOT_FOUND', 'Review run not found.');
      return { ok: true, run: view, created: false };
    }

    const startedAt = this.now();
    const outcome = await this.deps.decide(
      { state, questions: profile.questions as DecisionRequest['questions'] },
      { signal: options.signal },
    );
    const latencyMs = this.now() - startedAt;
    const result = outcome.result;

    // `completeRun` writes only while this attempt's claim holds. When it did
    // not (the call outlived the orphan timeout and a retry reclaimed the
    // run), return the run as stored now instead of this attempt's answers.
    const current = async () => (await store.getRun(siteId, run.id)) ?? run;
    if (result?.ok) {
      const completed = await store.completeRun(siteId, run.id, {
        status: reviewOutcomeStatus(result.data.answers, profile.minConfidence),
        provider: result.data.provider,
        model: result.data.model,
        calibrated: result.data.calibrated,
        answers: result.data.answers,
        usage: result.data.usage,
        latencyMs,
        errorCode: null,
      }, run.createdAt);
      return { ok: true, run: toRun(completed ?? (await current()), FRESH, profile.note), created: true };
    }

    const errorCode = 'errors' in outcome.body ? (outcome.body.errors[0]?.code ?? 'INTERNAL') : 'INTERNAL';
    const failed = await store.completeRun(siteId, run.id, {
      status: 'error',
      provider: null,
      model: null,
      calibrated: null,
      answers: null,
      usage: null,
      latencyMs,
      errorCode,
    }, run.createdAt);
    return { ok: false, run: toRun(failed ?? (await current()), FRESH, profile.note), outcome };
  }

  async getRun(id: string, principal: ReviewPrincipal): Promise<ReviewRun> {
    const run = await this.deps.store.getRun(this.deps.siteId, id);
    const profile = run ? await this.deps.store.getProfileById(this.deps.siteId, run.profileId) : null;
    const view = run && profile ? await this.assess(run, profile, principal, new Map()) : null;
    if (!view) throw new ReviewServiceError('REVIEW_RUN_NOT_FOUND', `Review run "${id}" not found.`);
    return view;
  }

  async listRuns(collection: string, itemId: string, principal: ReviewPrincipal): Promise<ReviewRun[]> {
    // Fails with REVIEW_ITEM_NOT_FOUND / FORBIDDEN when the caller cannot read the item.
    await this.deps.content.readItem(collection, itemId, []);
    const runs = await this.deps.store.listRuns(this.deps.siteId, { collection, itemId, limit: 50 });
    const reads = new Map<string, Promise<ItemRead>>();
    const profiles = new Map<string, Promise<ReviewProfileRecord | null>>();
    const views: ReviewRun[] = [];
    for (const run of runs) {
      if (!profiles.has(run.profileId)) {
        profiles.set(run.profileId, this.deps.store.getProfileById(this.deps.siteId, run.profileId));
      }
      const profile = await profiles.get(run.profileId)!;
      const view = profile ? await this.assess(run, profile, principal, reads) : null;
      if (view) views.push(view);
    }
    return views;
  }

  /**
   * The run as `principal` may see it, with staleness, or null when hidden.
   *
   * Item runs are visible to whoever can currently read every field the run
   * read; staleness compares the current content hash and latest revision.
   * Snapshot runs hold answers about content only their author saw, so only
   * the author and admins see them; their staleness is checked on feedback.
   */
  private async assess(
    run: ReviewRunRecord,
    profile: ReviewProfileRecord,
    principal: ReviewPrincipal,
    reads: Map<string, Promise<ItemRead>>,
  ): Promise<ReviewRun | null> {
    const own = run.principalId === principal.id || principal.admin;
    if (run.source === 'snapshot' || run.itemId === null) return own ? toRun(run, FRESH, profile.note) : null;

    const omitted = run.omittedFields as string[];
    const runFields = (profile.fields as string[]).filter((field) => !omitted.includes(field));
    const cacheKey = (profile.fields as string[]).join('\u0000');
    if (!reads.has(cacheKey)) {
      reads.set(
        cacheKey,
        this.deps.content.readItem(run.collection, run.itemId, profile.fields as string[]).catch((error: unknown) => {
          if (error instanceof ReviewServiceError) return 'unavailable' as const;
          throw error;
        }),
      );
    }
    const read = await reads.get(cacheKey)!;
    if (read === 'unavailable') {
      return own ? toRun(run, { stale: true, staleReason: 'item_unavailable' }, profile.note) : null;
    }
    // A caller who cannot read a field the run read must not see answers about it.
    if (!own && runFields.some((field) => read.omittedFields.includes(field))) return null;

    const current = JSON.parse(JSON.stringify(pick(read.values, runFields))) as Record<string, unknown>;
    if ((await reviewContentHash(current)) !== run.contentHash) {
      return toRun(run, { stale: true, staleReason: 'content_changed' }, profile.note);
    }
    if (run.revisionId !== null) {
      const latest = await this.deps.content.latestRevisionId(run.itemId);
      if (latest !== run.revisionId) return toRun(run, { stale: true, staleReason: 'revision_changed' }, profile.note);
    }
    return toRun(run, FRESH, profile.note);
  }

  // ---- feedback -----------------------------------------------------------

  async submitFeedback(
    runId: string,
    request: ReviewFeedbackRequest,
    principal: ReviewPrincipal,
  ): Promise<ReviewFeedback[]> {
    const run = await this.getRun(runId, principal);
    if (!COMPLETE.has(run.status)) {
      throw new ReviewServiceError('REVIEW_NOT_COMPLETE', `Review run "${runId}" has no answers to give feedback on.`);
    }
    const unknown = request.entries.filter((entry) => !run.answers || !(entry.questionKey in run.answers));
    if (unknown.length > 0) {
      throw new ReviewServiceError(
        'VALIDATION',
        `Questions not in this run: ${unknown.map((entry) => entry.questionKey).join(', ')}.`,
      );
    }

    const applies = request.entries.some((entry) => entry.verdict !== 'reject');
    if (applies && !request.acknowledgeStale) {
      const draftChanged =
        run.source === 'snapshot' && request.contentHash !== undefined && request.contentHash !== run.contentHash;
      if (run.stale || draftChanged) {
        throw new ReviewServiceError(
          'REVIEW_STALE',
          `The content changed since this review (${run.staleReason ?? 'content_changed'}). Re-run the review, or send acknowledgeStale: true to record the verdict anyway.`,
        );
      }
    }

    const rows = await this.deps.store.insertFeedback(
      this.deps.siteId,
      run.id,
      principal.id,
      request.entries.map((entry) => ({
        id: this.newId(),
        siteId: this.deps.siteId,
        runId: run.id,
        questionKey: entry.questionKey,
        verdict: entry.verdict,
        editedValue: entry.verdict === 'edit' ? (entry.editedValue ?? null) : null,
        principalType: principal.type,
        principalId: principal.id,
      })),
    );
    return rows.map((row) => ({
      id: row.id,
      runId: row.runId,
      questionKey: row.questionKey,
      verdict: row.verdict as ReviewFeedback['verdict'],
      editedValue: row.editedValue,
      principalType: row.principalType,
      principalId: row.principalId,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  // ---- pilot sessions (J09, #516) ------------------------------------------

  /**
   * Records one editor session on a pilot collection. Only `user` principals
   * may record one (403 `FORBIDDEN` otherwise). `currentMode` is the
   * collection's rollout mode now; a session of another mode is refused so
   * baseline and assisted samples never mix. A referenced run must be the
   * caller's own completed run on the same collection (and item, when both
   * are known), and every viewed question must be one it answered.
   */
  async recordSession(
    request: ReviewSessionRequest,
    principal: ReviewPrincipal,
    currentMode: ReviewPilotMode,
  ): Promise<ReviewSession> {
    // Sessions are editor time. An API key or the dev principal is not an
    // editor, so its "sessions" would count machine activity as user value.
    if (principal.type !== 'user') {
      throw new ReviewServiceError('FORBIDDEN', 'Only signed-in editors record review sessions.');
    }
    if (request.mode !== currentMode) {
      throw new ReviewServiceError(
        'REVIEW_SESSION_MODE_MISMATCH',
        `This collection is in ${currentMode} mode; a ${request.mode} session is not recorded.`,
      );
    }
    const viewed = request.viewedQuestions ?? [];
    if (request.runId !== undefined) {
      const run = await this.deps.store.getRun(this.deps.siteId, request.runId);
      const invalid = (message: string) => new ReviewServiceError('REVIEW_SESSION_RUN_INVALID', message);
      if (!run || run.principalId !== principal.id || run.principalType !== principal.type) {
        throw invalid(`Review run "${request.runId}" is not one of your runs on this site.`);
      }
      if (run.collection !== request.collection) throw invalid('The review run belongs to another collection.');
      if (request.itemId !== undefined && run.itemId !== null && run.itemId !== request.itemId) {
        throw invalid('The review run belongs to another item.');
      }
      const answers = (run.answers as Record<string, unknown> | null) ?? {};
      if (viewed.length > 0 && !COMPLETE.has(run.status)) throw invalid('The review run has no answers to view.');
      const unknown = viewed.filter((key) => !(key in answers));
      if (unknown.length > 0) throw invalid(`Questions not in this run: ${unknown.join(', ')}.`);
    }

    const row = await this.deps.store.insertSession({
      id: this.newId(),
      siteId: this.deps.siteId,
      collection: request.collection,
      itemId: request.itemId ?? null,
      mode: request.mode,
      runId: request.runId ?? null,
      viewedQuestions: viewed,
      principalType: principal.type,
      principalId: principal.id,
      durationMs: request.durationMs,
      locale: request.locale ?? null,
    });
    return {
      id: row.id,
      collection: row.collection,
      itemId: row.itemId,
      mode: row.mode as ReviewPilotMode,
      runId: row.runId,
      viewedQuestions: row.viewedQuestions as string[],
      principalType: row.principalType,
      principalId: row.principalId,
      durationMs: row.durationMs,
      locale: row.locale,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
