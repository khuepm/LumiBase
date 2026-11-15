/**
 * One-shot translation generator for a new locale (#714, epic #671 A06).
 * Mounted at `/api/v1/locale-generation` — a control-plane prefix (site
 * administrators): it spends MT budget and queues content changes.
 *
 *   POST /jobs                         start a job (202); runs now, the minute tick resumes it
 *   GET  /jobs, /jobs/:id              progress, counters, review state
 *   POST /jobs/:id/cancel | /resume
 *   GET  /suggestions                  the review queue (`?locale&status&jobId&collection`)
 *   POST /suggestions/:id/decide       approve (optionally edited) / reject
 *   POST /suggestions/decide-bulk      up to 200 at a time
 *
 * Approving writes through the reviewer's own ItemService (RBAC, validation,
 * pinned fields, revision + audit). Machine output never reaches content
 * without that step.
 */

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { runDetached } from '../lib/detached';
import { itemServiceForRequest } from '../services/item-service-factory';
import {
  LocaleGenerationError,
  cancelLocaleJob,
  createLocaleJob,
  decideSuggestion,
  driveLocaleJob,
  getLocaleJob,
  listLocaleJobs,
  listSuggestions,
  pendingSuggestionIds,
  resumeLocaleJob,
  toLocaleJobView,
  type LocaleJobDeps,
  type ReviewItemAccess,
} from '../services/locale-generation-service';
import { buildProviders } from './translation-memory';
import { formatSafeError } from '@lumibase/contracts/utils';

export const localeGenerationRouter = new Hono<AppEnv>();

/** Time a request spends driving its job before the tick takes over. */
const FIRST_RUN_BUDGET_MS = 20_000;
export const BULK_DECIDE_MAX = 200;

export function localeJobDeps(db: LocaleJobDeps['db'], env: AppEnv['Bindings']): LocaleJobDeps {
  const providers = buildProviders(env);
  return {
    db,
    providers,
    defaultProvider: providers.has('workers-ai') ? 'workers-ai' : [...providers.keys()][0]!,
  };
}

function fail(c: Context<AppEnv>, err: unknown) {
  if (err instanceof LocaleGenerationError) {
    return c.json({ errors: [{ code: err.code, message: err.message }] }, err.status);
  }
  throw err;
}

function validation(c: Context<AppEnv>, error: z.ZodError) {
  return c.json({ errors: error.issues.map((i) => ({ code: 'VALIDATION', message: `${i.path.join('.')}: ${i.message}` })) }, 400);
}

function reviewAccess(c: Context<AppEnv>): ReviewItemAccess {
  const service = itemServiceForRequest(c);
  return {
    detail: (collection, id) => service.detail(collection, id),
    patch: (collection, id, patch) => service.patch(collection, id, patch),
  };
}

const createSchema = z
  .object({
    locale: z.string().min(2).max(20),
    sourceLocale: z.string().min(2).max(20).default('en'),
    collections: z.array(z.string().min(1).max(100)).max(50).default([]),
    includeUi: z.boolean().default(true),
    provider: z.string().min(1).max(40).optional(),
  })
  .strict();

localeGenerationRouter.post('/jobs', async (c) => {
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return validation(c, parsed.error);
  const db = c.get('db');
  const deps = localeJobDeps(db, c.env);
  if (parsed.data.provider && !deps.providers.has(parsed.data.provider)) {
    return c.json({ errors: [{ code: 'PROVIDER_UNAVAILABLE', message: `MT provider not configured: ${parsed.data.provider}` }] }, 400);
  }
  // The `echo` fallback exists so developers can exercise the pipeline; it is
  // never chosen implicitly, or a site without MT would queue placeholders.
  if (!parsed.data.provider && deps.defaultProvider === 'echo') {
    return c.json(
      { errors: [{ code: 'PROVIDER_UNAVAILABLE', message: 'No MT provider is configured (DEEPL_API_KEY, OPENAI_API_KEY or the Workers AI binding). Pass provider "echo" to test the pipeline.' }] },
      400,
    );
  }
  try {
    const job = await createLocaleJob(db, c.get('siteId'), parsed.data, c.get('auth')?.userId ?? null);
    runDetached(
      c,
      driveLocaleJob(deps, job.id, FIRST_RUN_BUDGET_MS).catch((err) =>
        console.error('[locale-generation] first run failed', { jobId: job.id, err: formatSafeError(err) }),
      ),
    );
    return c.json({ data: toLocaleJobView(job) }, 202);
  } catch (err) {
    return fail(c, err);
  }
});

localeGenerationRouter.get('/jobs', async (c) => c.json({ data: await listLocaleJobs(c.get('db'), c.get('siteId')) }));

localeGenerationRouter.get('/jobs/:id', async (c) => {
  try {
    return c.json({ data: await getLocaleJob(c.get('db'), c.get('siteId'), c.req.param('id')) });
  } catch (err) {
    return fail(c, err);
  }
});

localeGenerationRouter.post('/jobs/:id/cancel', async (c) => {
  try {
    return c.json({ data: await cancelLocaleJob(c.get('db'), c.get('siteId'), c.req.param('id')) });
  } catch (err) {
    return fail(c, err);
  }
});

localeGenerationRouter.post('/jobs/:id/resume', async (c) => {
  try {
    const job = await resumeLocaleJob(c.get('db'), c.get('siteId'), c.req.param('id'));
    runDetached(
      c,
      driveLocaleJob(localeJobDeps(c.get('db'), c.env), job.id, FIRST_RUN_BUDGET_MS).catch((err) =>
        console.error('[locale-generation] resume failed', { jobId: job.id, err: formatSafeError(err) }),
      ),
    );
    return c.json({ data: job }, 202);
  } catch (err) {
    return fail(c, err);
  }
});

const listSchema = z.object({
  locale: z.string().max(20).optional(),
  status: z.enum(['pending', 'approved', 'rejected', 'stale']).optional(),
  jobId: z.string().max(64).optional(),
  collection: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

localeGenerationRouter.get('/suggestions', async (c) => {
  const parsed = listSchema.safeParse(c.req.query());
  if (!parsed.success) return validation(c, parsed.error);
  const { rows, total } = await listSuggestions(c.get('db'), c.get('siteId'), parsed.data);
  return c.json({ data: rows, meta: { total, limit: parsed.data.limit, offset: parsed.data.offset } });
});

const decideSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('approve'), text: z.string().max(20_000).optional() }).strict(),
  z.object({ decision: z.literal('reject') }).strict(),
]);

function reviewerOf(c: Context<AppEnv>) {
  return { userId: c.get('auth')?.userId ?? null };
}

/** A refused content write (permission, validation, pinned field) leaves the suggestion pending. */
function writeError(err: unknown): { code: string; message: string } {
  const code = (err as { code?: unknown })?.code;
  return { code: typeof code === 'string' ? code : 'WRITE_REFUSED', message: err instanceof Error ? err.message : String(err) };
}

localeGenerationRouter.post('/suggestions/:id/decide', async (c) => {
  const parsed = decideSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return validation(c, parsed.error);
  try {
    const result = await decideSuggestion(c.get('db'), c.get('siteId'), c.req.param('id'), parsed.data, reviewerOf(c), reviewAccess(c));
    return c.json({ data: result });
  } catch (err) {
    if (err instanceof LocaleGenerationError) return fail(c, err);
    return c.json({ errors: [writeError(err)] }, 422);
  }
});

const bulkSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    locale: z.string().min(2).max(20),
    ids: z.array(z.string().max(64)).max(BULK_DECIDE_MAX).optional(),
    jobId: z.string().max(64).optional(),
    collection: z.string().max(100).optional(),
    limit: z.number().int().min(1).max(BULK_DECIDE_MAX).default(BULK_DECIDE_MAX),
  })
  .strict();

localeGenerationRouter.post('/suggestions/decide-bulk', async (c) => {
  const parsed = bulkSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return validation(c, parsed.error);
  const db = c.get('db');
  const siteId = c.get('siteId');
  const input = parsed.data;
  const ids =
    input.ids ??
    (await pendingSuggestionIds(db, siteId, { locale: input.locale, jobId: input.jobId, collection: input.collection }, input.limit));
  const access = reviewAccess(c);
  const reviewer = reviewerOf(c);
  const summary = { approved: 0, rejected: 0, stale: 0, failed: 0 };
  const failures: Array<{ id: string; code: string; message: string }> = [];
  for (const id of ids) {
    try {
      const result = await decideSuggestion(db, siteId, id, { decision: input.decision }, reviewer, access);
      summary[result.status] += 1;
    } catch (err) {
      summary.failed += 1;
      failures.push({ id, ...(err instanceof LocaleGenerationError ? { code: err.code, message: err.message } : writeError(err)) });
    }
  }
  return c.json({ data: { ...summary, processed: ids.length, failures: failures.slice(0, 50) } });
});
