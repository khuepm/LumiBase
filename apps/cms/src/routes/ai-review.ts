/**
 * Draft review routes (Jev J05, #512), mounted under `/api/v1/ai` next to
 * `aiRouter`.
 *
 *   GET  /review-profiles[?collection=]        ai:decide
 *   GET  /review-profiles/:key[?version=]      ai:decide
 *   POST /review-profiles                      admin
 *   POST /review-profiles/:key/versions        admin
 *   POST /reviews                              ai:decide (+ governed decision gates)
 *   GET  /reviews?collection=&itemId=          ai:decide
 *   GET  /reviews/:id                          ai:decide
 *   POST /reviews/:id/feedback                 ai:decide
 *
 * Reviews only suggest: no route here writes to an item.
 */

import {
  ReviewFeedbackRequestSchema,
  ReviewProfileCreateInputSchema,
  ReviewProfileKeySchema,
  ReviewProfileVersionInputSchema,
  ReviewRunRequestSchema,
} from '@lumibase/contracts/schemas';
import { formatSafeError } from '@lumibase/contracts/utils';
import { Hono, type Context } from 'hono';
import type { ZodError } from 'zod';
import type { AppEnv } from '../env';
import { createDecisionProvider, type DecisionProviderEnv } from '../services/decision-provider';
import {
  authorizeDecision,
  decisionQuotaFromEnv,
  readDecisionSettings,
  runGovernedDecision,
  writeDecisionAudit,
  type DecisionAuditContext,
  type DecisionGovernanceError,
  type DecisionQuotaEnv,
} from '../services/decision-governance';
import { principalRefFromAuth, resolveRequestCapabilities } from '../services/governed-capabilities';
import { reviewContentAccessForRequest } from '../services/review-content-access';
import { ReviewService, ReviewServiceError, type ReviewPrincipal } from '../services/review-service';
import { reviewStoreFor } from '../services/review-store';

export const aiReviewRouter = new Hono<AppEnv>();

type Gate = { principal: ReviewPrincipal } | { denied: Response };

function auditContext(c: Context<AppEnv>): DecisionAuditContext {
  const siteId = c.get('siteId');
  return {
    db: c.get('db'),
    siteId,
    requestId: c.get('requestId') ?? null,
    principal: principalRefFromAuth(c.get('auth'), siteId),
  };
}

function forbidden(c: Context<AppEnv>, message: string): Response {
  return c.json({ errors: [{ code: 'FORBIDDEN', message }] }, 403);
}

/**
 * Resolves the caller once. `admin` routes need a control-plane admin;
 * `decide` routes need `ai:decide` (admins satisfy it). Both run before the
 * body is read.
 */
async function gate(c: Context<AppEnv>, need: 'decide' | 'admin', audit = false): Promise<Gate> {
  const grant = await resolveRequestCapabilities(c);
  const ref = principalRefFromAuth(c.get('auth'), c.get('siteId'));
  if (need === 'admin') {
    if (!grant.allowed || !grant.controlPlaneAdmin || !ref) return { denied: forbidden(c, 'Admin role required.') };
  } else {
    let message: string | null = null;
    try {
      authorizeDecision(grant);
    } catch (err) {
      message = (err as DecisionGovernanceError).message;
    }
    if (message !== null || !ref) {
      if (audit) await writeDecisionAudit(auditContext(c), { outcome: 'FORBIDDEN', status: 403, startedAt: Date.now() });
      return { denied: forbidden(c, message ?? 'The ai:decide capability is required.') };
    }
  }
  if (!ref) return { denied: forbidden(c, 'Admin role required.') };
  const id = ref.type === 'user' ? ref.userId : ref.type === 'api_key' ? ref.apiKeyId : 'dev';
  return { principal: { type: ref.type, id, admin: grant.controlPlaneAdmin } };
}

function service(c: Context<AppEnv>): ReviewService {
  const db = c.get('db');
  const siteId = c.get('siteId');
  const env = c.env as unknown as DecisionProviderEnv & DecisionQuotaEnv;
  const configured = createDecisionProvider(env);
  const audit = auditContext(c);
  return new ReviewService({
    store: reviewStoreFor(db),
    siteId,
    content: reviewContentAccessForRequest(c),
    decide: (request, { signal }) =>
      runGovernedDecision(
        async () => ({
          configured,
          settings: await readDecisionSettings(db, siteId),
          quota: decisionQuotaFromEnv(env),
          cache: c.get('runtime').cache,
          siteId,
        }),
        request,
        { signal, audit },
      ),
  });
}

function validationError(c: Context<AppEnv>, error: ZodError): Response {
  return c.json(
    {
      errors: error.issues.map((issue) => ({
        code: 'VALIDATION',
        message: issue.message,
        path: issue.path.map(String),
      })),
    },
    400,
  );
}

function failure(c: Context<AppEnv>, err: unknown): Response {
  if (err instanceof ReviewServiceError) {
    return c.json({ errors: [{ code: err.code, message: err.message }] }, err.status);
  }
  console.error('[ai/reviews] error', formatSafeError(err));
  return c.json({ errors: [{ code: 'INTERNAL', message: 'Review request failed.' }] }, 500);
}

async function body(c: Context<AppEnv>): Promise<unknown> {
  return c.req.json().catch(() => null);
}

function parseVersion(raw: string | undefined): number | undefined | null {
  if (raw === undefined) return undefined;
  return /^[1-9]\d{0,8}$/.test(raw) ? Number(raw) : null;
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

aiReviewRouter.get('/review-profiles', async (c) => {
  const g = await gate(c, 'decide');
  if ('denied' in g) return g.denied;
  try {
    return c.json({ data: await service(c).listProfiles(c.req.query('collection') || undefined) });
  } catch (err) {
    return failure(c, err);
  }
});

aiReviewRouter.get('/review-profiles/:key', async (c) => {
  const g = await gate(c, 'decide');
  if ('denied' in g) return g.denied;
  const version = parseVersion(c.req.query('version'));
  if (version === null) {
    return c.json({ errors: [{ code: 'VALIDATION', message: 'version must be a positive integer.' }] }, 400);
  }
  try {
    return c.json({ data: await service(c).getProfile(c.req.param('key'), version) });
  } catch (err) {
    return failure(c, err);
  }
});

aiReviewRouter.post('/review-profiles', async (c) => {
  const g = await gate(c, 'admin');
  if ('denied' in g) return g.denied;
  const parsed = ReviewProfileCreateInputSchema.safeParse(await body(c));
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    return c.json({ data: await service(c).createProfile(parsed.data, g.principal) }, 201);
  } catch (err) {
    return failure(c, err);
  }
});

aiReviewRouter.post('/review-profiles/:key/versions', async (c) => {
  const g = await gate(c, 'admin');
  if ('denied' in g) return g.denied;
  const key = ReviewProfileKeySchema.safeParse(c.req.param('key'));
  if (!key.success) return validationError(c, key.error);
  const parsed = ReviewProfileVersionInputSchema.safeParse(await body(c));
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    return c.json({ data: await service(c).createProfileVersion(key.data, parsed.data, g.principal) }, 201);
  } catch (err) {
    return failure(c, err);
  }
});

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

aiReviewRouter.post('/reviews', async (c) => {
  const g = await gate(c, 'decide', true);
  if ('denied' in g) return g.denied;
  const header = c.req.header('idempotency-key');
  if (header !== undefined && (header.length < 8 || header.length > 128)) {
    return c.json({ errors: [{ code: 'VALIDATION', message: 'Idempotency-Key must be 8-128 characters.' }] }, 400);
  }
  const parsed = ReviewRunRequestSchema.safeParse(await body(c));
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    const result = await service(c).runReview(parsed.data, {
      principal: g.principal,
      // Client disconnect aborts the upstream call and suppresses retries.
      signal: c.req.raw.signal,
      idempotencyKey: header,
    });
    if (result.ok) return c.json({ data: result.run }, result.created ? 201 : 200);
    const { outcome } = result;
    if (outcome.retryAfterSeconds !== undefined) c.header('Retry-After', String(outcome.retryAfterSeconds));
    return c.json(outcome.body, outcome.status);
  } catch (err) {
    return failure(c, err);
  }
});

aiReviewRouter.get('/reviews', async (c) => {
  const g = await gate(c, 'decide');
  if ('denied' in g) return g.denied;
  const collection = c.req.query('collection');
  const itemId = c.req.query('itemId');
  if (!collection || !itemId) {
    return c.json({ errors: [{ code: 'VALIDATION', message: 'collection and itemId are required.' }] }, 400);
  }
  try {
    return c.json({ data: await service(c).listRuns(collection, itemId, g.principal) });
  } catch (err) {
    return failure(c, err);
  }
});

aiReviewRouter.get('/reviews/:id', async (c) => {
  const g = await gate(c, 'decide');
  if ('denied' in g) return g.denied;
  try {
    return c.json({ data: await service(c).getRun(c.req.param('id'), g.principal) });
  } catch (err) {
    return failure(c, err);
  }
});

aiReviewRouter.post('/reviews/:id/feedback', async (c) => {
  const g = await gate(c, 'decide');
  if ('denied' in g) return g.denied;
  const parsed = ReviewFeedbackRequestSchema.safeParse(await body(c));
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    return c.json({ data: await service(c).submitFeedback(c.req.param('id'), parsed.data, g.principal) }, 201);
  } catch (err) {
    return failure(c, err);
  }
});
