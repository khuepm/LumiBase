/**
 * The semantic pass of a Content Intent drift scan (Jev J12, #519).
 *
 * Deterministic rules (`required_fields`, `freshness`, `glossary_compliance`…)
 * stay in `evaluateRules`. Semantic rules run here, after them, in a separate
 * pass with its own budget (`maxItems` items and a deadline) and its own
 * cursor on the intent, because every evaluation is a governed provider call.
 *
 * For each item and semantic rule:
 *   1. The fields judged are the rule's fields (default: the profile's) minus
 *      the item's pinned fields. All pinned → skipped, like a deterministic
 *      field-scoped rule. The `field:<name>` context field is added as the
 *      reference; nothing is ever written to it.
 *   2. The content hash of exactly what is sent becomes part of the
 *      fingerprint (`semanticRuleKey`), and of the review idempotency key, so
 *      a retry on unchanged content replays the stored run (no second
 *      provider call, no duplicate drift, no duplicate goal) while a changed
 *      rule version, profile version or content is a new evaluation.
 *   3. The review goes through `ReviewService.runReview`, the same governed
 *      path as `POST /ai/reviews` (site opt-in, allowlist, quota, audit).
 *   4. drift → an `open` drift row (the reconciler turns it into a review
 *      goal); clean → nothing, and earlier rows of the rule resolve;
 *      anything else → an `unevaluated` row. An unevaluated outcome protects
 *      every existing row of that rule on that item from being resolved.
 *
 * The pass only detects. It never edits content or publishes.
 */

import { contentDrifts, contentIntents, items, type Database } from '@lumibase/database';
import { formatSafeError } from '@lumibase/contracts/utils';
import { and, asc, eq, gt, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import type { CacheProvider, KeyProvider } from '@lumibase/runtime';
import {
  decisionQuotaFromEnv,
  driftDecisionsEnabled,
  readDecisionSettings,
  runGovernedDecision,
  type DecisionQuotaEnv,
  type DecisionSiteSettings,
} from './decision-governance';
import { createDecisionProvider, type DecisionAnswer, type DecisionProviderEnv } from './decision-provider';
import { diffDrifts, driftFingerprint } from './drift-service';
import { reviewContentAccessForDriftScan } from './review-content-access';
import {
  reviewContentHash,
  ReviewService,
  ReviewServiceError,
  type ReviewContentAccess,
  type ReviewPrincipal,
} from './review-service';
import { reviewStoreFor } from './review-store';
import {
  semanticContextField,
  semanticOutcome,
  semanticRuleIdentity,
  semanticRuleKey,
  semanticRuleKeyMatches,
  type SemanticRule,
} from './semantic-drift';

/** The principal recorded on review runs made by the scan. Not a valid user id (contains a colon). */
export const SEMANTIC_DRIFT_PRINCIPAL: ReviewPrincipal = { type: 'system', id: 'system:drift-scan', admin: false };

export const DEFAULT_MAX_SEMANTIC_ITEMS = 25;
export const MAX_SEMANTIC_ITEMS = 500;

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/** What the pass needs from the platform. `semanticDriftRuntimeFromEnv` builds the real one. */
export interface SemanticDriftRuntime {
  readSettings(): Promise<DecisionSiteSettings>;
  /**
   * A ReviewService (and its content access) that reads only `include` of an
   * item, as the system, and decides through governance. `requestId` goes on
   * the `ai_decision` audit events.
   */
  review(include: readonly string[], requestId: string): { service: ReviewService; content: ReviewContentAccess };
}

export interface SemanticDriftRow {
  itemId: string;
  fingerprint: string;
  ruleKey: string;
  status: string;
}

export interface SemanticDriftInsert {
  itemId: string;
  ruleKey: string;
  fingerprint: string;
  status: 'open' | 'unevaluated';
  detail: Record<string, unknown>;
}

/** Site-scoped persistence for the pass. `semanticDriftStoreFor` is the Drizzle one. */
export interface SemanticDriftStore {
  /** Live items of the collection after `cursor` (exclusive), ordered by id. */
  listItems(collectionId: string, cursor: string | null, limit: number): Promise<Array<{ id: string; pinnedFields: string[] }>>;
  /** Semantic drift rows of the intent for these items. */
  existing(intentId: string, itemIds: readonly string[]): Promise<SemanticDriftRow[]>;
  /** Inserts new rows; a fingerprint that already exists is left alone (a concurrent scan won). */
  insert(intentId: string, rows: readonly SemanticDriftInsert[]): Promise<void>;
  /** Reopens resolved/stale/unevaluated rows as `open` with the latest detail. */
  reopen(fingerprint: string, detail: Record<string, unknown>): Promise<void>;
  /** Keeps an `unevaluated` row and records the latest attempt. */
  updateDetail(fingerprint: string, detail: Record<string, unknown>): Promise<void>;
  resolve(fingerprints: readonly string[]): Promise<void>;
  /**
   * Resolves open/assigned/unevaluated semantic rows of the intent whose rule
   * key is none of `liveKeys` (the rule was removed). No judgement is
   * involved, so this runs whether or not the semantic pass may run.
   * Returns how many rows it resolved.
   */
  resolveOrphans(intentId: string, liveKeys: readonly string[]): Promise<number>;
  saveCursor(intentId: string, cursor: string | null): Promise<void>;
}

export function semanticDriftStoreFor(db: Database, siteId: string): SemanticDriftStore {
  const site = eq(contentDrifts.siteId, siteId);
  return {
    async listItems(collectionId, cursor, limit) {
      const rows = await db
        .select({ id: items.id, pinnedFields: items.pinnedFields })
        .from(items)
        .where(
          and(
            eq(items.siteId, siteId),
            eq(items.collectionId, collectionId),
            isNull(items.deletedAt),
            cursor ? gt(items.id, cursor) : undefined,
          ),
        )
        .orderBy(asc(items.id))
        .limit(limit);
      return rows.map((row) => ({ id: row.id, pinnedFields: Array.isArray(row.pinnedFields) ? (row.pinnedFields as string[]) : [] }));
    },
    async existing(intentId, itemIds) {
      if (itemIds.length === 0) return [];
      return db
        .select({
          itemId: contentDrifts.itemId,
          fingerprint: contentDrifts.fingerprint,
          ruleKey: contentDrifts.ruleKey,
          status: contentDrifts.status,
        })
        .from(contentDrifts)
        .where(
          and(
            site,
            eq(contentDrifts.intentId, intentId),
            eq(contentDrifts.ruleType, 'semantic'),
            inArray(contentDrifts.itemId, [...itemIds]),
          ),
        );
    },
    async insert(intentId, rows) {
      if (rows.length === 0) return;
      await db
        .insert(contentDrifts)
        .values(rows.map((row) => ({ siteId, intentId, ruleType: 'semantic', ...row })))
        .onConflictDoNothing();
    },
    async reopen(fingerprint, detail) {
      await db
        .update(contentDrifts)
        .set({ status: 'open', goalId: null, resolvedAt: null, detail, updatedAt: new Date() })
        .where(and(site, eq(contentDrifts.fingerprint, fingerprint)));
    },
    async updateDetail(fingerprint, detail) {
      await db
        .update(contentDrifts)
        .set({ detail, updatedAt: new Date() })
        .where(and(site, eq(contentDrifts.fingerprint, fingerprint), eq(contentDrifts.status, 'unevaluated')));
    },
    async resolve(fingerprints) {
      if (fingerprints.length === 0) return;
      await db
        .update(contentDrifts)
        .set({ status: 'resolved', resolvedAt: new Date(), updatedAt: new Date() })
        .where(and(site, inArray(contentDrifts.fingerprint, [...fingerprints])));
    },
    async resolveOrphans(intentId, liveKeys) {
      const rows = await db
        .update(contentDrifts)
        .set({ status: 'resolved', resolvedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            site,
            eq(contentDrifts.intentId, intentId),
            eq(contentDrifts.ruleType, 'semantic'),
            inArray(contentDrifts.status, ['open', 'assigned', 'unevaluated']),
            // The rule key is `<key>@v…`; keys cannot contain "@".
            liveKeys.length > 0 ? notInArray(sql`split_part(${contentDrifts.ruleKey}, '@', 1)`, [...liveKeys]) : undefined,
          ),
        )
        .returning({ id: contentDrifts.id });
      return rows.length;
    },
    async saveCursor(intentId, cursor) {
      await db
        .update(contentIntents)
        .set({ semanticScanCursor: cursor })
        .where(and(eq(contentIntents.siteId, siteId), eq(contentIntents.id, intentId)));
    },
  };
}

/**
 * The real runtime. Null without a cache: the decision quota lives in the
 * cache, so the pass reports `unavailable` instead of failing every item.
 * `processEnv` carries the provider and quota configuration (`DECISION_*`)
 * and `ENCRYPTION_KEY`.
 */
export function semanticDriftRuntimeFromEnv(deps: {
  db: Database;
  siteId: string;
  cache?: CacheProvider;
  keys?: KeyProvider;
  processEnv?: Record<string, string | undefined>;
}): SemanticDriftRuntime | null {
  const { db, siteId, cache } = deps;
  if (!cache) return null;
  const processEnv = deps.processEnv ?? {};
  const providerEnv = processEnv as DecisionProviderEnv & DecisionQuotaEnv;
  return {
    readSettings: () => readDecisionSettings(db, siteId),
    review(include, requestId) {
      const content = reviewContentAccessForDriftScan({
        db,
        siteId,
        include,
        cache,
        keys: deps.keys,
        encryptionKey: processEnv['ENCRYPTION_KEY'],
      });
      const service = new ReviewService({
        store: reviewStoreFor(db),
        siteId,
        content,
        decide: (request, { signal }) =>
          runGovernedDecision(
            async () => ({
              configured: createDecisionProvider(providerEnv),
              // Re-read at call time: the kill switch applies up to the provider
              // call, and so does `aiDecisions.drift` — turning it off alone
              // denies the call (DECISION_DISABLED) like the site switch does.
              settings: await readDecisionSettings(db, siteId).then((settings) => ({
                ...settings,
                enabled: driftDecisionsEnabled(settings),
              })),
              quota: decisionQuotaFromEnv(providerEnv),
              cache,
              siteId,
            }),
            request,
            // No person is behind the scan; the audit event records principal null.
            { signal, audit: { db, siteId, requestId, principal: null } },
          ),
      });
      return { service, content };
    },
  };
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface SemanticScanResult {
  /**
   * `ran`: the pass evaluated items. `off`: `aiDecisions.enabled` +
   * `aiDecisions.drift` are not both on. `unavailable`: this runtime cannot
   * reach the decision path (no cache for quota). For `off` and
   * `unavailable` nothing was read, sent or changed, and existing semantic
   * drift rows are exactly as they were: not clean, just not re-evaluated.
   */
  status: 'ran' | 'off' | 'unavailable';
  rules: number;
  /** Items visited this pass (≤ maxItems). */
  items: number;
  drift: number;
  clean: number;
  unevaluated: number;
  /** (item, rule) pairs not judged: every judged field pinned, or nothing to judge. */
  skipped: number;
  opened: number;
  reopened: number;
  resolved: number;
  /**
   * False when the item budget, the deadline or drift decisions being
   * switched off mid-pass stopped it; `cursor` resumes it.
   */
  completed: boolean;
  cursor: string | null;
}

// ---------------------------------------------------------------------------
// Pass
// ---------------------------------------------------------------------------

export interface SemanticPassInput {
  siteId: string;
  intent: { id: string; collection: string; semanticScanCursor: string | null };
  collectionId: string;
  rules: readonly SemanticRule[];
  store: SemanticDriftStore;
  runtime: SemanticDriftRuntime | null | undefined;
  maxItems?: number;
  /** Wall-clock deadline (ms since epoch); checked between items. */
  deadline: number;
  now?: () => number;
}

type Evaluation =
  | { kind: 'drift' | 'unevaluated'; fingerprint: string; ruleKey: string; detail: Record<string, unknown> }
  | { kind: 'clean' }
  | { kind: 'skipped' };

/**
 * Stands in for the content hash when the content could not be read (profile
 * missing, item gone). The row is still visible as `unevaluated`, and the
 * next conclusive evaluation resolves it.
 */
const UNREAD = 'unread';

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function errorCodeOf(body: unknown): string {
  if (body && typeof body === 'object' && 'errors' in body) {
    const errors = (body as { errors?: Array<{ code?: string }> }).errors;
    return errors?.[0]?.code ?? 'INTERNAL';
  }
  return 'INTERNAL';
}

function hasValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

export async function runSemanticPass(input: SemanticPassInput): Promise<SemanticScanResult> {
  const now = input.now ?? Date.now;
  const result: SemanticScanResult = {
    status: 'ran',
    rules: input.rules.length,
    items: 0,
    drift: 0,
    clean: 0,
    unevaluated: 0,
    skipped: 0,
    opened: 0,
    reopened: 0,
    resolved: 0,
    completed: false,
    cursor: input.intent.semanticScanCursor,
  };
  if (!input.runtime) return { ...result, status: 'unavailable' };
  const runtime = input.runtime;
  if (!driftDecisionsEnabled(await runtime.readSettings())) return { ...result, status: 'off' };

  const maxItems = Math.min(Math.max(Math.trunc(input.maxItems ?? DEFAULT_MAX_SEMANTIC_ITEMS), 1), MAX_SEMANTIC_ITEMS);
  const intentId = input.intent.id;
  const requestId = `drift:${intentId}`;
  const profiles = new Map<string, Promise<Awaited<ReturnType<ReviewService['getProfile']>> | ReviewServiceError>>();

  const evaluate = async (rule: SemanticRule, item: { id: string; pinnedFields: string[] }): Promise<Evaluation> => {
    const base = {
      rule: rule.key,
      ruleVersion: rule.version,
      profileKey: rule.profileKey,
      profileVersion: rule.profileVersion,
      questionKey: rule.questionKey,
      threshold: rule.threshold,
      contextSource: rule.contextSource,
    };
    const unread = (reason: string): Evaluation => {
      const ruleKey = semanticRuleKey(rule, UNREAD);
      return {
        kind: 'unevaluated',
        fingerprint: driftFingerprint(intentId, item.id, 'semantic', ruleKey),
        ruleKey,
        detail: { ...base, contentHash: null, reason },
      };
    };
    const profileKey = `${rule.profileKey}@${rule.profileVersion}`;
    if (!profiles.has(profileKey)) {
      profiles.set(
        profileKey,
        runtime
          .review([], requestId)
          .service.getProfile(rule.profileKey, rule.profileVersion)
          .catch((error: unknown) => {
            if (error instanceof ReviewServiceError) return error;
            throw error;
          }),
      );
    }
    const profile = await profiles.get(profileKey)!;
    if (profile instanceof ReviewServiceError) return unread(profile.code);

    const pinned = new Set(item.pinnedFields);
    const subject = (rule.fields ?? profile.fields).filter((field) => profile.fields.includes(field) && !pinned.has(field));
    if (subject.length === 0) return { kind: 'skipped' };
    const contextField = semanticContextField(rule.contextSource);
    if (contextField !== null && !profile.fields.includes(contextField)) return unread('context_missing');
    const include = contextField === null ? subject : [...new Set([...subject, contextField])];
    const { service, content } = runtime.review(include, requestId);

    let values: Record<string, unknown>;
    try {
      values = (await content.readItem(input.intent.collection, item.id, profile.fields)).values;
    } catch (error) {
      if (error instanceof ReviewServiceError) return unread(error.code);
      throw error;
    }
    if (!subject.some((field) => hasValue(values[field]))) return { kind: 'skipped' };

    const contentHash = await reviewContentHash(values);
    const ruleKey = semanticRuleKey(rule, contentHash);
    const fingerprint = driftFingerprint(intentId, item.id, 'semantic', ruleKey);
    const keyed = { ...base, contentHash };
    const unevaluated = (reason: string, extra: Record<string, unknown> = {}): Evaluation => ({
      kind: 'unevaluated',
      fingerprint,
      ruleKey,
      detail: { ...keyed, ...extra, reason },
    });

    if (contextField !== null && !hasValue(values[contextField])) return unevaluated('context_missing');
    if (profile.questions[rule.questionKey]?.type !== 'noul') return unevaluated('question_not_noul');

    let review: Awaited<ReturnType<ReviewService['runReview']>>;
    try {
      review = await service.runReview(
        { profile: rule.profileKey, profileVersion: rule.profileVersion, collection: input.intent.collection, itemId: item.id },
        {
          principal: SEMANTIC_DRIFT_PRINCIPAL,
          // The definition is part of the key: a rule re-added with another
          // profile under the same key and version is a new review run.
          idempotencyKey: `drift:${(await sha256Hex(`${fingerprint}|${semanticRuleIdentity(rule)}`)).slice(0, 48)}`,
        },
      );
    } catch (error) {
      if (error instanceof ReviewServiceError) return unevaluated(error.code);
      console.error('[drift:semantic] review failed', formatSafeError(error));
      return unevaluated('INTERNAL');
    }
    const run = review.run;
    const provenance = {
      runId: run.id,
      revisionId: run.revisionId,
      provider: run.provider,
      model: run.model,
      calibrated: run.calibrated,
      replayed: review.ok ? !review.created : false,
    };
    if (!review.ok) return unevaluated(errorCodeOf(review.outcome.body), provenance);
    if (run.status !== 'success' && run.status !== 'abstained') {
      return unevaluated(run.errorCode ?? 'DECISION_NOT_COMPLETE', provenance);
    }
    if (run.stale && run.staleReason === 'content_changed') return unevaluated('stale', provenance);

    const answer = (run.answers as Record<string, DecisionAnswer> | null)?.[rule.questionKey];
    const outcome = semanticOutcome(answer?.type === 'noul' ? answer.noul : null, rule.threshold);
    if (outcome.kind === 'clean') return { kind: 'clean' };
    if (outcome.kind === 'unevaluated') return unevaluated(outcome.reason, { ...provenance, noul: outcome.noul });
    return { kind: 'drift', fingerprint, ruleKey, detail: { ...keyed, ...provenance, noul: outcome.noul } };
  };

  let cursor = input.intent.semanticScanCursor;
  let budgetHit = false;
  while (!budgetHit) {
    const limit = Math.min(50, maxItems - result.items);
    const batch = await input.store.listItems(input.collectionId, cursor, limit);
    if (batch.length === 0) {
      result.completed = true;
      cursor = null;
      break;
    }

    const existingRows = await input.store.existing(intentId, batch.map((item) => item.id));
    const existing = new Map(existingRows.map((row) => [row.fingerprint, row]));
    const detected = new Set<string>();
    const protectedFingerprints = new Set<string>();
    const details = new Map<string, { itemId: string; ruleKey: string; detail: Record<string, unknown>; status: 'open' | 'unevaluated' }>();

    let visited = 0;
    for (const item of batch) {
      if (now() >= input.deadline) {
        budgetHit = true;
        break;
      }
      // Switching drift decisions off stops a running pass at the next item;
      // the cursor keeps the place for when it is switched back on.
      if (visited > 0 || result.items > 0) {
        if (!driftDecisionsEnabled(await runtime.readSettings())) {
          budgetHit = true;
          break;
        }
      }
      visited += 1;
      for (const rule of input.rules) {
        const evaluation = await evaluate(rule, item);
        if (evaluation.kind === 'skipped') {
          result.skipped += 1;
          continue;
        }
        if (evaluation.kind === 'clean') {
          result.clean += 1;
          continue;
        }
        if (evaluation.kind === 'drift') result.drift += 1;
        else result.unevaluated += 1;
        if (evaluation.kind !== 'drift') {
          // Uncertain: nothing this rule recorded for this item may resolve.
          for (const row of existingRows) {
            if (row.itemId === item.id && semanticRuleKeyMatches(row.ruleKey, rule.key)) protectedFingerprints.add(row.fingerprint);
          }
        }
        if (evaluation.kind === 'drift') detected.add(evaluation.fingerprint);
        else protectedFingerprints.add(evaluation.fingerprint);
        details.set(evaluation.fingerprint, {
          itemId: item.id,
          ruleKey: evaluation.ruleKey,
          detail: evaluation.detail,
          status: evaluation.kind === 'drift' ? 'open' : 'unevaluated',
        });
      }
    }

    const visitedIds = new Set(batch.slice(0, visited).map((item) => item.id));
    // Only items judged this pass take part; the rest wait for the cursor.
    const scoped = new Map([...existing].filter(([, row]) => visitedIds.has(row.itemId)));
    const { toOpen, toReopen, toResolve } = diffDrifts(scoped, detected, protectedFingerprints);

    const inserts: SemanticDriftInsert[] = [];
    for (const fingerprint of toOpen) {
      const entry = details.get(fingerprint)!;
      inserts.push({ itemId: entry.itemId, ruleKey: entry.ruleKey, fingerprint, status: 'open', detail: entry.detail });
    }
    for (const [fingerprint, entry] of details) {
      if (entry.status !== 'unevaluated') continue;
      if (!existing.has(fingerprint)) {
        inserts.push({ itemId: entry.itemId, ruleKey: entry.ruleKey, fingerprint, status: 'unevaluated', detail: entry.detail });
      } else if (existing.get(fingerprint)!.status === 'unevaluated') {
        await input.store.updateDetail(fingerprint, entry.detail);
      }
    }
    await input.store.insert(intentId, inserts);
    for (const fingerprint of toReopen) await input.store.reopen(fingerprint, details.get(fingerprint)!.detail);
    await input.store.resolve(toResolve);

    result.opened += toOpen.length;
    result.reopened += toReopen.length;
    result.resolved += toResolve.length;
    result.items += visited;
    if (visited > 0) cursor = batch[visited - 1]!.id;

    if (budgetHit) break;
    if (batch.length < limit) {
      result.completed = true;
      cursor = null;
      break;
    }
    if (result.items >= maxItems) budgetHit = true;
  }

  result.cursor = cursor;
  await input.store.saveCursor(intentId, cursor);
  return result;
}
