/**
 * Jev metadata automation routes (J11, #518), mounted under `/api/v1/ai`.
 * Control plane: `/api/v1/ai/automation` is in the control-plane backstop
 * list, and every route below also requires a control-plane admin.
 *
 *   GET  /automation/templates                 template catalogue
 *   POST /automation/templates/:key/build      build a draft flow from parameters (no write)
 *   GET  /automation/actions                   action history (?collection&itemId&status&mode&action&limit)
 *   GET  /automation/actions/:id               one action with its audit chain
 *   POST /automation/actions/:id/feedback      accept / override (edit) / reject the decision behind it
 *   POST /automation/actions/:id/revert        restore the value before an applied action
 *   GET  /automation/metrics?from=&to=         shadow precision/coverage in the auto-action zone
 *
 * Nothing here turns automation on. The mode lives in the admin-only
 * `aiDecisions.automation` setting and is re-read when each node executes.
 */

import { ReviewVerdictSchema } from '@lumibase/contracts/schemas';
import { formatSafeError } from '@lumibase/contracts/utils';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { parseAutomationSettings } from '../services/ai-automation';
import { computeAutomationMetrics } from '../services/ai-automation-metrics';
import {
  AutomationRevertError,
  reconcileAutomationAction,
  revertAutomationAction,
} from '../services/ai-automation-ops';
import {
  automationActionStoreFor,
  type AutomationActionRecord,
  type AutomationActionStore,
  type AutomationFeedbackRecord,
} from '../services/ai-automation-store';
import { readDecisionSettings } from '../services/decision-governance';
import { principalRefFromAuth, resolveRequestCapabilities } from '../services/governed-capabilities';
import { itemServiceForRequest } from '../services/item-service-factory';
import {
  AutomationTemplateError,
  buildAutomationTemplate,
  isAutomationTemplateKey,
  listAutomationTemplates,
} from '../services/jev-automation-templates';
import { reviewContentAccessForRequest } from '../services/review-content-access';
import { ReviewService, ReviewServiceError, type ReviewPrincipal } from '../services/review-service';
import { reviewStoreFor } from '../services/review-store';

export const aiAutomationRouter = new Hono<AppEnv>();

/** Swappable in route tests. */
export const automationRouteDeps = {
  store: (c: Context<AppEnv>): AutomationActionStore => automationActionStoreFor(c.get('db')),
};

function forbidden(c: Context<AppEnv>): Response {
  return c.json({ errors: [{ code: 'FORBIDDEN', message: 'Admin role required.' }] }, 403);
}

async function admin(c: Context<AppEnv>): Promise<ReviewPrincipal | null> {
  const grant = await resolveRequestCapabilities(c);
  const ref = principalRefFromAuth(c.get('auth'), c.get('siteId'));
  if (!grant.allowed || !grant.controlPlaneAdmin || !ref) return null;
  const id = ref.type === 'user' ? ref.userId : ref.type === 'api_key' ? ref.apiKeyId : 'dev';
  return { type: ref.type, id, admin: true };
}

function validation(c: Context<AppEnv>, message: string, path: string[] = []): Response {
  return c.json({ errors: [{ code: 'VALIDATION', message, path }] }, 400);
}

function failure(c: Context<AppEnv>, err: unknown): Response {
  if (err instanceof AutomationRevertError || err instanceof ReviewServiceError) {
    return c.json({ errors: [{ code: err.code, message: err.message }] }, err.status);
  }
  console.error('[ai/automation] error', formatSafeError(err));
  return c.json({ errors: [{ code: 'INTERNAL', message: 'Automation request failed.' }] }, 500);
}

/** One action as the API returns it, with the audit chain by id. */
function actionView(row: AutomationActionRecord, feedback: readonly AutomationFeedbackRecord[]) {
  const own = feedback.filter((f) => f.runId === row.reviewRunId && f.questionKey === row.questionKey);
  return {
    id: row.id,
    action: row.action,
    mode: row.mode,
    status: row.status,
    reason: row.reason,
    collection: row.collection,
    itemId: row.itemId,
    questionKey: row.questionKey,
    locale: row.locale,
    provider: row.provider,
    model: row.model,
    profileKey: row.profileKey,
    profileVersion: row.profileVersion,
    confidence: row.confidence,
    inZone: row.inZone,
    proposed: row.proposed,
    previous: row.previous,
    applied: row.applied,
    approvalId: row.approvalId,
    principalType: row.principalType,
    principalId: row.principalId,
    revertedAt: row.revertedAt ? row.revertedAt.toISOString() : null,
    revertedBy: row.revertedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    chain: {
      revisionId: row.revisionId,
      contentHash: row.contentHash,
      reviewRunId: row.reviewRunId,
      flowRunId: row.flowRunId,
      nodeId: row.nodeId,
      actionId: row.id,
      approvalId: row.approvalId,
      feedback: own.map((f) => ({
        verdict: f.verdict,
        editedValue: f.editedValue,
        principalType: f.principalType,
        principalId: f.principalId,
        createdAt: f.createdAt.toISOString(),
      })),
    },
  };
}

async function viewsOf(store: AutomationActionStore, siteId: string, rows: AutomationActionRecord[]) {
  const reconciled = await Promise.all(rows.map((row) => reconcileAutomationAction(store, row)));
  const runIds = [...new Set(reconciled.flatMap((row) => (row.reviewRunId ? [row.reviewRunId] : [])))];
  const feedback = await store.feedbackForRuns(siteId, runIds);
  return reconciled.map((row) => actionView(row, feedback));
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

aiAutomationRouter.get('/automation/templates', async (c) => {
  if (!(await admin(c))) return forbidden(c);
  return c.json({ data: listAutomationTemplates() });
});

aiAutomationRouter.post('/automation/templates/:key/build', async (c) => {
  if (!(await admin(c))) return forbidden(c);
  const key = c.req.param('key');
  if (!isAutomationTemplateKey(key)) {
    return c.json({ errors: [{ code: 'AUTOMATION_TEMPLATE_NOT_FOUND', message: `Template "${key}" not found.` }] }, 404);
  }
  try {
    return c.json({ data: buildAutomationTemplate(key, await c.req.json().catch(() => null)) });
  } catch (err) {
    if (err instanceof AutomationTemplateError) {
      return c.json({ errors: err.issues.map((issue) => ({ code: 'VALIDATION', ...issue })) }, 400);
    }
    return failure(c, err);
  }
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const listQuery = z.object({
  collection: z.string().min(1).max(128).optional(),
  itemId: z.string().min(1).max(128).optional(),
  status: z.string().min(1).max(32).optional(),
  mode: z.enum(['shadow', 'live']).optional(),
  action: z.enum(['tag', 'route']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

aiAutomationRouter.get('/automation/actions', async (c) => {
  if (!(await admin(c))) return forbidden(c);
  const parsed = listQuery.safeParse(c.req.query());
  if (!parsed.success) return validation(c, parsed.error.issues[0]?.message ?? 'Invalid query.');
  try {
    const siteId = c.get('siteId');
    const store = automationRouteDeps.store(c);
    const rows = await store.list(siteId, parsed.data);
    return c.json({ data: await viewsOf(store, siteId, rows) });
  } catch (err) {
    return failure(c, err);
  }
});

const DAY_MS = 86_400_000;
const MAX_METRICS_DAYS = 366;
const METRICS_ROW_LIMIT = 5_000;

function parseInstant(raw: string | undefined): Date | undefined | null {
  if (raw === undefined || raw === '') return undefined;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

aiAutomationRouter.get('/automation/metrics', async (c) => {
  if (!(await admin(c))) return forbidden(c);
  const to = parseInstant(c.req.query('to'));
  const from = parseInstant(c.req.query('from'));
  if (to === null || from === null) return validation(c, 'from and to must be ISO 8601 dates.');
  const end = to ?? new Date();
  const start = from ?? new Date(end.getTime() - 30 * DAY_MS);
  if (start >= end || end.getTime() - start.getTime() > MAX_METRICS_DAYS * DAY_MS) {
    return validation(c, `from must be before to, at most ${MAX_METRICS_DAYS} days apart.`);
  }
  try {
    const siteId = c.get('siteId');
    const store = automationRouteDeps.store(c);
    const loaded = await store.list(siteId, { from: start, to: end, limit: METRICS_ROW_LIMIT + 1 });
    const truncated = loaded.length > METRICS_ROW_LIMIT;
    const rows = await Promise.all(
      loaded.slice(0, METRICS_ROW_LIMIT).map((row) => reconcileAutomationAction(store, row)),
    );
    const runIds = [...new Set(rows.flatMap((row) => (row.reviewRunId ? [row.reviewRunId] : [])))];
    const feedback = await store.feedbackForRuns(siteId, runIds);
    const settings = parseAutomationSettings(await readDecisionSettings(c.get('db'), siteId));
    return c.json({
      data: computeAutomationMetrics({ rows, feedback, settings, window: { from: start, to: end }, truncated }),
    });
  } catch (err) {
    return failure(c, err);
  }
});

aiAutomationRouter.get('/automation/actions/:id', async (c) => {
  if (!(await admin(c))) return forbidden(c);
  try {
    const siteId = c.get('siteId');
    const store = automationRouteDeps.store(c);
    const row = await store.get(siteId, c.req.param('id'));
    if (!row) {
      return c.json({ errors: [{ code: 'AUTOMATION_ACTION_NOT_FOUND', message: 'Automation action not found.' }] }, 404);
    }
    const [view] = await viewsOf(store, siteId, [row]);
    return c.json({ data: view });
  } catch (err) {
    return failure(c, err);
  }
});

const feedbackBody = z
  .object({
    verdict: ReviewVerdictSchema,
    /** Required for `edit` (override): the value the editor chose instead. */
    editedValue: z.unknown().optional(),
    acknowledgeStale: z.boolean().optional(),
  })
  .strict()
  .refine((value) => value.verdict !== 'edit' || value.editedValue !== undefined, {
    message: 'An override (edit) needs editedValue.',
    path: ['editedValue'],
  });

aiAutomationRouter.post('/automation/actions/:id/feedback', async (c) => {
  const principal = await admin(c);
  if (!principal) return forbidden(c);
  const parsed = feedbackBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return validation(c, parsed.error.issues[0]?.message ?? 'Invalid body.');
  try {
    const siteId = c.get('siteId');
    const store = automationRouteDeps.store(c);
    const row = await store.get(siteId, c.req.param('id'));
    if (!row) {
      return c.json({ errors: [{ code: 'AUTOMATION_ACTION_NOT_FOUND', message: 'Automation action not found.' }] }, 404);
    }
    if (!row.reviewRunId || !row.questionKey) {
      return c.json(
        { errors: [{ code: 'AUTOMATION_NO_DECISION', message: 'This action has no decision to give feedback on.' }] },
        409,
      );
    }
    const reviews = new ReviewService({
      store: reviewStoreFor(c.get('db')),
      siteId,
      content: reviewContentAccessForRequest(c),
      // Feedback never calls the provider.
      decide: async () => {
        throw new Error('decide is not used for feedback');
      },
    });
    const entry =
      parsed.data.verdict === 'edit'
        ? { questionKey: row.questionKey, verdict: 'edit' as const, editedValue: parsed.data.editedValue }
        : { questionKey: row.questionKey, verdict: parsed.data.verdict };
    const saved = await reviews.submitFeedback(
      row.reviewRunId,
      { entries: [entry], ...(parsed.data.acknowledgeStale ? { acknowledgeStale: true } : {}) },
      principal,
    );
    return c.json({ data: saved }, 201);
  } catch (err) {
    return failure(c, err);
  }
});

aiAutomationRouter.post('/automation/actions/:id/revert', async (c) => {
  const principal = await admin(c);
  if (!principal) return forbidden(c);
  try {
    const siteId = c.get('siteId');
    const store = automationRouteDeps.store(c);
    const items = itemServiceForRequest(c);
    const reverted = await revertAutomationAction(
      {
        store,
        siteId,
        readField: async (collection, itemId, field) =>
          ((await items.detail(collection, itemId, [field])) as Record<string, unknown>)[field],
        writeField: async (collection, itemId, field, value) => {
          await items.patch(collection, itemId, { data: { [field]: value } });
        },
      },
      c.req.param('id'),
      principal.id,
    );
    const [view] = await viewsOf(store, siteId, [reverted]);
    return c.json({ data: view });
  } catch (err) {
    return failure(c, err);
  }
});
