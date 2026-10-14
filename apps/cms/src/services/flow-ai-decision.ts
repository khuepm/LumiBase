/**
 * Flows `ai:decision` operation (Jev J10, #517).
 *
 * One governed decision about one saved item, made with a pinned review
 * profile version, that picks the next branch of the flow:
 *
 *   noul question   'true'  when noul ≥ noulThreshold
 *                   'false' when noul ≤ 1 − noulThreshold
 *                   'unknown' in between
 *   choice question the chosen option key, or 'unknown' when the model
 *                   abstained (`other`/`unknown`), its confidence is below
 *                   minConfidence, or the run reads as stale on replay
 *   any failure     'error' when the node maps an `error` branch; otherwise
 *                   the operation throws and the runner takes `onError`
 *
 * A failure (forbidden, disabled, quota, timeout, cancel, provider error,
 * missing profile or item) is never turned into 'true' or any other answer.
 *
 * Every gate is evaluated when the node executes, not when the run was
 * queued: the principal is re-resolved from the database (a revoked role or
 * key is honoured), `ai:decide` is checked on that live grant, and the site
 * switches (`aiDecisions.enabled` + `aiDecisions.flows`) are re-read, so an
 * admin who turns decisions off stops queued and in-flight runs too. The
 * decision itself goes through the same ReviewService + governed decision
 * path (quota, field allowlist, audit) as `POST /ai/reviews`.
 *
 * Idempotency: the review run key is `flow:<flowRunId>:<nodeId>`, scoped to
 * the principal. Re-executing the same flow run (a redelivered job) replays
 * the stored decision and makes no second provider call. A run that ended in
 * `error` is reclaimed by the review store and tried again, by design of J05.
 * The runner has no step-level resume, so nodes downstream of a decision
 * must themselves be idempotent.
 */

import { z } from 'zod';
import { formatSafeError } from '@lumibase/contracts/utils';
import type { Database } from '@lumibase/database';
import type { CacheProvider, KeyProvider } from '@lumibase/runtime';
import {
  authorizeDecision,
  decisionQuotaFromEnv,
  DECISION_SETTINGS_KEY,
  flowDecisionsEnabled,
  readDecisionSettings,
  runGovernedDecision,
  type DecisionAuditContext,
  type DecisionQuotaEnv,
  type DecisionSiteSettings,
} from './decision-governance';
import { createDecisionProvider, type DecisionAnswer, type DecisionProviderEnv } from './decision-provider';
import { EffectiveCapabilityService, type AuthenticatedPrincipalRef } from './effective-capability-service';
import type { FlowNode, FlowRunContext } from './flow-service';
import { resolvePrincipalCapabilities, type GovernedCapabilityResolution } from './governed-capabilities';
import type { MagicContext } from './permission-dsl';
import { reviewContentAccessForPrincipal } from './review-content-access';
import { ReviewService, ReviewServiceError, type ReviewPrincipal } from './review-service';
import { reviewStoreFor } from './review-store';

export const AI_DECISION_OPERATION = 'ai:decision';

/** The branches the editor draws for an `ai:decision` node. Choice keys are added on top. */
export const AI_DECISION_BRANCHES = ['true', 'false', 'unknown', 'error'] as const;

export type AiDecisionErrorCode =
  | 'VALIDATION'
  | 'FORBIDDEN'
  | 'DECISION_DISABLED'
  | 'DECISION_FLOW_MISCONFIGURED'
  | 'DECISION_NOT_COMPLETE'
  | 'INTERNAL'
  | string;

/** Thrown when the decision failed and the node maps no `error` branch (→ `onError`). */
export class FlowDecisionError extends Error {
  readonly code: AiDecisionErrorCode;

  constructor(code: AiDecisionErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'FlowDecisionError';
    this.code = code;
  }
}

export type UnknownReason = 'between_thresholds' | 'abstained' | 'low_confidence' | 'stale';

export interface AiDecisionRecord {
  profileKey: string;
  profileVersion: number;
  questionKey: string;
  questionType: 'noul' | 'choice';
  /** The noul probability, or the chosen option key. */
  value: number | string;
  /** Choice confidence; null for noul. */
  confidence: number | null;
  /** The threshold that applied: noulThreshold or minConfidence. */
  threshold: number;
  /** Why the branch is `unknown`; null otherwise. */
  unknownReason: UnknownReason | null;
  provider: string | null;
  model: string | null;
  calibrated: boolean | null;
}

/** What the node stores in the flow run's steps (shown in run history). */
export interface AiDecisionOutput {
  branch: string;
  /** Review run id (provenance), null when the failure happened before a run existed. */
  runId: string | null;
  /** True when this execution replayed a stored decision (no provider call). */
  replayed: boolean;
  decision: AiDecisionRecord | null;
  /** Set on the `error` branch. */
  errorCode?: string;
  message?: string;
}

const optionsSchema = z
  .object({
    profileKey: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'profileKey must be a review profile key'),
    profileVersion: z.number().int().positive(),
    collection: z.string().min(1).max(128),
    itemId: z.string().min(1).max(128).optional(),
    questionKey: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'questionKey must be a profile question key'),
    noulThreshold: z.number().min(0.5).max(1).optional(),
    minConfidence: z.number().min(0).max(1).optional(),
    /** Editor-only hint: extra choice-key handles to draw. Ignored at run time. */
    choices: z.array(z.string()).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Runtime wiring
// ---------------------------------------------------------------------------

/** What the node needs from the platform; tests substitute it. */
export interface AiDecisionRuntime {
  db: Database | undefined;
  siteId: string;
  /** Live grant for `principal`, resolved now (not when the run was queued). */
  resolveGrant(principal: AuthenticatedPrincipalRef): Promise<GovernedCapabilityResolution>;
  readSettings(): Promise<DecisionSiteSettings>;
  /** A ReviewService that reads content as `permissionContext` and decides through governance. */
  reviewService(permissionContext: MagicContext, audit: DecisionAuditContext): ReviewService;
}

/**
 * Builds the runtime from the flow run environment. `db` and `siteId` come
 * from the runner; `principal` from the trigger (manual runs only); `cache`
 * (quota counters), `keys` and `processEnv` (provider config) from the
 * runtime. A missing cache fails closed inside governance.
 */
export function aiDecisionRuntimeFromEnv(env: Record<string, unknown>): AiDecisionRuntime {
  const db = env['db'] as Database | undefined;
  const siteId = env['siteId'];
  if (!db || typeof siteId !== 'string') {
    throw new FlowDecisionError('DECISION_FLOW_MISCONFIGURED', 'ai:decision requires env.db and env.siteId.');
  }
  const cache = env['cache'] as CacheProvider | undefined;
  const keys = env['keys'] as KeyProvider | undefined;
  const processEnv = (env['processEnv'] ?? {}) as Record<string, string | undefined>;

  return {
    db,
    siteId,
    resolveGrant: (principal) => {
      const deps: ConstructorParameters<typeof EffectiveCapabilityService>[0] = { db, siteId };
      if (cache) deps.cache = cache;
      const environment = processEnv['LUMIBASE_ENV'] ?? processEnv['NODE_ENV'];
      if (environment !== undefined) deps.environment = environment;
      return resolvePrincipalCapabilities(new EffectiveCapabilityService(deps), principal);
    },
    readSettings: () => readDecisionSettings(db, siteId),
    reviewService: (permissionContext, audit) => {
      const providerEnv = processEnv as DecisionProviderEnv & DecisionQuotaEnv;
      return new ReviewService({
        store: reviewStoreFor(db),
        siteId,
        content: reviewContentAccessForPrincipal({
          db,
          permissionContext,
          cache,
          keys,
          encryptionKey: processEnv['ENCRYPTION_KEY'],
        }),
        decide: (request, { signal }) =>
          runGovernedDecision(
            async () => {
              if (!cache) throw new Error('ai:decision has no cache for quota accounting');
              return {
                configured: createDecisionProvider(providerEnv),
                // Re-read at call time: the kill switch applies up to the provider call.
                settings: await readDecisionSettings(db, siteId),
                quota: decisionQuotaFromEnv(providerEnv),
                cache,
                siteId,
              };
            },
            request,
            { signal, audit },
          ),
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Branch mapping
// ---------------------------------------------------------------------------

/**
 * The branch for one answer. Pure; exported for tests. `abstained` is the
 * review run's own verdict (every choice `other`/`unknown`, or a confidence
 * below the profile's minConfidence) and only applies to choice questions.
 */
export function decisionBranch(
  answer: DecisionAnswer,
  options: { noulThreshold?: number; minConfidence?: number; abstained: boolean; stale: boolean },
): { branch: string; value: number | string; confidence: number | null; unknownReason: UnknownReason | null } {
  if (answer.type === 'noul') {
    const t = options.noulThreshold!;
    const value = answer.noul;
    if (options.stale) return { branch: 'unknown', value, confidence: null, unknownReason: 'stale' };
    if (value >= t) return { branch: 'true', value, confidence: null, unknownReason: null };
    // `1 - value >= t`, not `value <= 1 - t`: with t = 0.8, 1 - t is 0.19999…, so 0.2 would miss.
    if (1 - value >= t) return { branch: 'false', value, confidence: null, unknownReason: null };
    return { branch: 'unknown', value, confidence: null, unknownReason: 'between_thresholds' };
  }
  if (answer.type === 'choice') {
    const value = answer.choice;
    const confidence = answer.confidence;
    const unknown = (unknownReason: UnknownReason) => ({ branch: 'unknown', value, confidence, unknownReason });
    if (options.stale) return unknown('stale');
    // `error` is reserved for failures, so a choice named `error` can never take that branch.
    if (options.abstained || value === 'other' || value === 'unknown' || value === 'error') return unknown('abstained');
    if (confidence < options.minConfidence!) return unknown('low_confidence');
    return { branch: value, value, confidence, unknownReason: null };
  }
  throw new FlowDecisionError('VALIDATION', 'Score questions cannot drive a branch.');
}

// ---------------------------------------------------------------------------
// Operation
// ---------------------------------------------------------------------------

function principalOf(value: unknown): AuthenticatedPrincipalRef | null {
  if (!value || typeof value !== 'object') return null;
  const ref = value as Partial<AuthenticatedPrincipalRef> & Record<string, unknown>;
  if (typeof ref.siteId !== 'string') return null;
  if (ref.type === 'user' && typeof ref.userId === 'string') return ref as AuthenticatedPrincipalRef;
  if (ref.type === 'api_key' && typeof ref.apiKeyId === 'string') return ref as AuthenticatedPrincipalRef;
  if (ref.type === 'dev' && Array.isArray(ref.roles)) return ref as AuthenticatedPrincipalRef;
  return null;
}

function reviewPrincipalOf(ref: AuthenticatedPrincipalRef, admin: boolean): ReviewPrincipal {
  const id = ref.type === 'user' ? ref.userId : ref.type === 'api_key' ? ref.apiKeyId : 'dev';
  return { type: ref.type, id, admin };
}

export async function runAiDecisionNode(
  ctx: FlowRunContext,
  rawOptions: Record<string, unknown>,
  node: FlowNode | undefined,
  runtimeOverride?: AiDecisionRuntime,
): Promise<AiDecisionOutput> {
  if (!node) {
    throw new FlowDecisionError('DECISION_FLOW_MISCONFIGURED', 'ai:decision runs only as a node of a flow graph.');
  }
  // Without branches the runner would follow `next` whatever was decided.
  if (!node.branches || Object.keys(node.branches).length === 0) {
    throw new FlowDecisionError(
      'DECISION_FLOW_MISCONFIGURED',
      `Node ${node.id} (ai:decision) needs branch edges (true/false/unknown/error).`,
    );
  }
  const errorMapped = Object.prototype.hasOwnProperty.call(node.branches, 'error');
  let reviewRunId: string | null = null;
  const fail = (code: string, message: string): AiDecisionOutput => {
    if (!errorMapped) throw new FlowDecisionError(code, message);
    return { branch: 'error', runId: reviewRunId, replayed: false, decision: null, errorCode: code, message };
  };

  const parsed = optionsSchema.safeParse(rawOptions);
  if (!parsed.success) {
    return fail('VALIDATION', parsed.error.issues.map((i) => `${i.path.join('.') || 'options'}: ${i.message}`).join('; '));
  }
  const options = parsed.data;
  const itemId = options.itemId ?? (typeof ctx.input['itemId'] === 'string' ? (ctx.input['itemId'] as string) : null);
  if (!itemId) return fail('VALIDATION', 'ai:decision needs options.itemId or input.itemId.');

  const flowRunId = ctx.env['runId'];
  if (typeof flowRunId !== 'string' || flowRunId.length === 0) {
    return fail('DECISION_FLOW_MISCONFIGURED', 'ai:decision needs a flow run id for idempotency.');
  }

  // Only manual runs carry a principal today. Event, schedule and webhook runs
  // have no one to decide on behalf of, so they are refused, not run as system.
  const principal = principalOf(ctx.env['principal']);
  if (!principal) {
    return fail('FORBIDDEN', 'This flow run has no principal to decide for. ai:decision runs only in manual runs.');
  }

  try {
    const runtime = runtimeOverride ?? aiDecisionRuntimeFromEnv(ctx.env);

    // 1. Who: re-resolve the live grant and require ai:decide on it.
    const grant = await runtime.resolveGrant(principal);
    if (!grant.allowed || !grant.permissionContext) {
      return fail('FORBIDDEN', grant.message ?? 'The principal of this run could not be resolved.');
    }
    try {
      authorizeDecision(grant);
    } catch (err) {
      return fail('FORBIDDEN', (err as Error).message);
    }

    // 2. Whether: the site switches, read now.
    if (!flowDecisionsEnabled(await runtime.readSettings())) {
      return fail(
        'DECISION_DISABLED',
        `Flow decisions are off for this site. A site admin enables "${DECISION_SETTINGS_KEY}.enabled" and "${DECISION_SETTINGS_KEY}.flows".`,
      );
    }

    // 3. What: the pinned profile version and its question.
    const audit: DecisionAuditContext = {
      db: runtime.db,
      siteId: runtime.siteId,
      requestId: `flow:${flowRunId}`,
      principal,
    };
    const service = runtime.reviewService(grant.permissionContext, audit);
    const profile = await service.getProfile(options.profileKey, options.profileVersion);
    const question = profile.questions[options.questionKey];
    if (!question) {
      return fail('VALIDATION', `Profile "${profile.key}" v${profile.version} has no question "${options.questionKey}".`);
    }
    if (question.type === 'score') return fail('VALIDATION', 'Score questions cannot drive a branch.');
    if (question.type === 'noul' && options.noulThreshold === undefined) {
      return fail('VALIDATION', 'A noul question needs options.noulThreshold (0.5–1).');
    }
    if (question.type === 'choice' && options.minConfidence === undefined) {
      return fail('VALIDATION', 'A choice question needs options.minConfidence (0–1).');
    }

    // 4. The governed decision, idempotent per flow run and node.
    const signal = ctx.env['_signal'] as AbortSignal | undefined;
    const result = await service.runReview(
      { profile: options.profileKey, profileVersion: options.profileVersion, collection: options.collection, itemId },
      {
        principal: reviewPrincipalOf(principal, grant.controlPlaneAdmin),
        signal,
        idempotencyKey: `flow:${flowRunId}:${node.id}`,
      },
    );
    reviewRunId = result.run.id;
    if (!result.ok) {
      const body = result.outcome.body;
      const code = 'errors' in body ? (body.errors[0]?.code ?? 'INTERNAL') : 'INTERNAL';
      const message = 'errors' in body ? (body.errors[0]?.message ?? 'Decision failed.') : 'Decision failed.';
      return fail(code, message);
    }
    const run = result.run;
    if (run.status !== 'success' && run.status !== 'abstained') {
      // A replay of a run still in flight elsewhere, or one that failed.
      return fail(run.errorCode ?? 'DECISION_NOT_COMPLETE', `Review run ${run.id} has no answers (status ${run.status}).`);
    }
    const answer = (run.answers as Record<string, DecisionAnswer> | null)?.[options.questionKey];
    if (!answer) return fail('DECISION_NOT_COMPLETE', `Review run ${run.id} did not answer "${options.questionKey}".`);

    const mapped = decisionBranch(answer, {
      noulThreshold: options.noulThreshold,
      minConfidence: options.minConfidence,
      abstained: run.status === 'abstained',
      stale: run.stale,
    });
    return {
      branch: mapped.branch,
      runId: run.id,
      replayed: !result.created,
      decision: {
        profileKey: run.profileKey,
        profileVersion: run.profileVersion,
        questionKey: options.questionKey,
        questionType: question.type,
        value: mapped.value,
        confidence: mapped.confidence,
        threshold: question.type === 'noul' ? options.noulThreshold! : options.minConfidence!,
        unknownReason: mapped.unknownReason,
        provider: run.provider,
        model: run.model,
        calibrated: run.calibrated,
      },
    };
  } catch (err) {
    if (err instanceof ReviewServiceError) return fail(err.code, err.message);
    if (err instanceof FlowDecisionError) return fail(err.code, err.message.replace(/^[A-Z_]+: /, ''));
    console.error('[flow:ai-decision] failed', formatSafeError(err));
    return fail('INTERNAL', 'Decision failed.');
  }
}
