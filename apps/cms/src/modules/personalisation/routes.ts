/**
 * Admin API for personalisation (#762), mounted at `/api/v1/personalisation`.
 * Site admins only: audiences decide what every visitor of the site sees.
 *
 * Every write drops the cached audience list and purges the site's delivery
 * caches (app cache + edge), so a change is live on the next request.
 */
import { Hono, type Context } from 'hono';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { items, pages } from '@lumibase/database';
import type { AppEnv } from '../../env';
import { requireSiteAdmin } from '../../middleware/site-admin';
import { invalidateDeliverTag } from '../../services/content-invalidation';
import { patchSchema } from '../../utils/patch-schema';
import { audiencesCacheKey } from './delivery';
import { PersonalisationRepository, isUniqueViolation, type AudienceRecord, type VariantRecord } from './repo';
import { audienceRulesSchema, rulesNeedConsent } from './rules';

export const personalisationRouter = new Hono<AppEnv>();
personalisationRouter.use('*', requireSiteAdmin());

type ErrStatus = 400 | 404 | 409 | 413;
const fail = (c: Context<AppEnv>, status: ErrStatus, code: string, message: string, details?: Record<string, unknown>) =>
  c.json({ errors: [{ code, message, ...(details ? { details } : {}) }] }, status);

const repoOf = (c: Context<AppEnv>) => new PersonalisationRepository(c.get('db'), c.get('siteId'));

async function invalidate(c: Context<AppEnv>): Promise<void> {
  const runtime = c.get('runtime');
  const siteId = c.get('siteId');
  await runtime?.cache?.delete(audiencesCacheKey(siteId)).catch(() => undefined);
  await invalidateDeliverTag(runtime?.cache, siteId, runtime?.edgeCache).catch(() => undefined);
}

async function body(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return Symbol.for('invalid-json');
  }
}

function zodFail(c: Context<AppEnv>, err: z.ZodError) {
  return c.json({ errors: err.issues.map((i) => ({ code: 'VALIDATION', message: `${i.path.join('.') || 'body'}: ${i.message}` })) }, 400);
}

const presentAudience = (a: AudienceRecord) => ({ ...a, needsConsent: rulesNeedConsent(audienceRulesSchema.parse(a.rules)) });

// --- audiences ---------------------------------------------------------------

/** `default` and `_` are reserved: they name "no audience matched". */
const audienceKey = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'Key must be 1–40 lowercase letters, digits or dashes.')
  .refine((k) => k !== 'default', 'Key "default" is reserved.');

const audienceSchema = z
  .object({
    key: audienceKey,
    name: z.string().trim().min(1).max(120),
    description: z.string().max(1000).nullable().optional(),
    rules: audienceRulesSchema,
    priority: z.number().int().min(0).max(10_000).default(100),
    enabled: z.boolean().default(true),
  })
  .strict();
const audiencePatchSchema = patchSchema(audienceSchema);

personalisationRouter.get('/audiences', async (c) => {
  const rows = await repoOf(c).listAudiences();
  return c.json({ data: rows.map(presentAudience) });
});

personalisationRouter.post('/audiences', async (c) => {
  const parsed = audienceSchema.safeParse(await body(c));
  if (!parsed.success) return zodFail(c, parsed.error);
  try {
    const row = await repoOf(c).createAudience(parsed.data);
    await invalidate(c);
    return c.json({ data: presentAudience(row) }, 201);
  } catch (err) {
    if (isUniqueViolation(err)) return fail(c, 409, 'AUDIENCE_EXISTS', `An audience with key "${parsed.data.key}" already exists.`);
    throw err;
  }
});

personalisationRouter.patch('/audiences/:id', async (c) => {
  const parsed = audiencePatchSchema.safeParse(await body(c));
  if (!parsed.success) return zodFail(c, parsed.error);
  if (Object.keys(parsed.data).length === 0) return fail(c, 400, 'VALIDATION', 'Nothing to update.');
  try {
    const row = await repoOf(c).updateAudience(c.req.param('id'), parsed.data);
    if (!row) return fail(c, 404, 'NOT_FOUND', 'Audience not found.');
    await invalidate(c);
    return c.json({ data: presentAudience(row) });
  } catch (err) {
    if (isUniqueViolation(err)) return fail(c, 409, 'AUDIENCE_EXISTS', 'Another audience already uses that key.');
    throw err;
  }
});

/** Deleting an audience deletes its variants (FK cascade). */
personalisationRouter.delete('/audiences/:id', async (c) => {
  if (!(await repoOf(c).deleteAudience(c.req.param('id')))) return fail(c, 404, 'NOT_FOUND', 'Audience not found.');
  await invalidate(c);
  return c.json({ data: null });
});

// --- variants ----------------------------------------------------------------

/** Item fields a variant may never override (identity and lifecycle). */
const RESERVED_ITEM_FIELDS = ['id', 'status', 'sort', 'createdAt', 'updatedAt'];
const MAX_OVERRIDES_BYTES = 64 * 1024;

const pageOverridesSchema = z
  .object({
    title: z.string().trim().min(1).max(500).optional(),
    layoutConfig: z.object({ sections: z.array(z.record(z.string(), z.unknown())).max(100) }).passthrough().optional(),
  })
  .strict()
  .refine((o) => o.title !== undefined || o.layoutConfig !== undefined, 'A page variant overrides `title` and/or `layoutConfig`.');

const itemOverridesSchema = z
  .record(z.string().min(1).max(100), z.unknown())
  .refine((o) => Object.keys(o).length > 0, 'An item variant overrides at least one field.')
  .refine((o) => !Object.keys(o).some((k) => RESERVED_ITEM_FIELDS.includes(k)), {
    message: `These fields cannot be overridden: ${RESERVED_ITEM_FIELDS.join(', ')}.`,
  });

const variantSchema = z
  .object({
    subjectType: z.enum(['page', 'item']),
    subjectId: z.string().min(1).max(200),
    audienceId: z.string().min(1),
    overrides: z.unknown(),
    status: z.enum(['draft', 'published']).default('draft'),
  })
  .strict();
const variantPatchSchema = z
  .object({ overrides: z.unknown().optional(), status: z.enum(['draft', 'published']).optional() })
  .strict();

function validateOverrides(subjectType: 'page' | 'item', overrides: unknown) {
  const schema = subjectType === 'page' ? pageOverridesSchema : itemOverridesSchema;
  return schema.safeParse(overrides);
}

async function subjectExists(c: Context<AppEnv>, subjectType: 'page' | 'item', subjectId: string): Promise<boolean> {
  const db = c.get('db');
  const siteId = c.get('siteId');
  if (subjectType === 'page') {
    const [row] = await db
      .select({ id: pages.id })
      .from(pages)
      .where(and(eq(pages.siteId, siteId), eq(pages.id, subjectId)))
      .limit(1);
    return Boolean(row);
  }
  const [row] = await db
    .select({ id: items.id })
    .from(items)
    .where(and(eq(items.siteId, siteId), eq(items.id, subjectId)))
    .limit(1);
  return Boolean(row);
}

const tooLarge = (o: unknown) => JSON.stringify(o ?? null).length > MAX_OVERRIDES_BYTES;
const presentVariant = (v: VariantRecord) => v;

personalisationRouter.get('/variants', async (c) => {
  const q = c.req.query();
  const subjectType = q.subjectType === 'page' || q.subjectType === 'item' ? q.subjectType : undefined;
  const rows = await repoOf(c).listVariants({ subjectType, subjectId: q.subjectId || undefined, audienceId: q.audienceId || undefined });
  return c.json({ data: rows.map(presentVariant) });
});

personalisationRouter.post('/variants', async (c) => {
  const parsed = variantSchema.safeParse(await body(c));
  if (!parsed.success) return zodFail(c, parsed.error);
  const input = parsed.data;
  if (tooLarge(input.overrides)) return fail(c, 413, 'OVERRIDES_TOO_LARGE', `Overrides are limited to ${MAX_OVERRIDES_BYTES} bytes.`);
  const overrides = validateOverrides(input.subjectType, input.overrides);
  if (!overrides.success) return zodFail(c, overrides.error);
  const repo = repoOf(c);
  if (!(await repo.getAudience(input.audienceId))) return fail(c, 404, 'AUDIENCE_NOT_FOUND', 'Audience not found.');
  if (!(await subjectExists(c, input.subjectType, input.subjectId))) {
    return fail(c, 404, 'SUBJECT_NOT_FOUND', `${input.subjectType === 'page' ? 'Page' : 'Item'} not found.`);
  }
  try {
    const row = await repo.createVariant({ ...input, overrides: overrides.data, createdBy: c.get('auth')?.userId ?? null });
    await invalidate(c);
    return c.json({ data: presentVariant(row) }, 201);
  } catch (err) {
    if (isUniqueViolation(err)) return fail(c, 409, 'VARIANT_EXISTS', 'This page or item already has a variant for that audience.');
    throw err;
  }
});

personalisationRouter.patch('/variants/:id', async (c) => {
  const parsed = variantPatchSchema.safeParse(await body(c));
  if (!parsed.success) return zodFail(c, parsed.error);
  if (parsed.data.overrides === undefined && parsed.data.status === undefined) return fail(c, 400, 'VALIDATION', 'Nothing to update.');
  const repo = repoOf(c);
  const current = await repo.getVariant(c.req.param('id'));
  if (!current) return fail(c, 404, 'NOT_FOUND', 'Variant not found.');
  const patch: { overrides?: unknown; status?: string } = {};
  if (parsed.data.overrides !== undefined) {
    if (tooLarge(parsed.data.overrides)) return fail(c, 413, 'OVERRIDES_TOO_LARGE', `Overrides are limited to ${MAX_OVERRIDES_BYTES} bytes.`);
    const o = validateOverrides(current.subjectType as 'page' | 'item', parsed.data.overrides);
    if (!o.success) return zodFail(c, o.error);
    patch.overrides = o.data;
  }
  if (parsed.data.status !== undefined) patch.status = parsed.data.status;
  const row = await repo.updateVariant(current.id, patch);
  if (!row) return fail(c, 404, 'NOT_FOUND', 'Variant not found.');
  await invalidate(c);
  return c.json({ data: presentVariant(row) });
});

personalisationRouter.delete('/variants/:id', async (c) => {
  if (!(await repoOf(c).deleteVariant(c.req.param('id')))) return fail(c, 404, 'NOT_FOUND', 'Variant not found.');
  await invalidate(c);
  return c.json({ data: null });
});

// --- exposures ---------------------------------------------------------------

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const MAX_RANGE_DAYS = 366;

/** Daily exposure counts per page and audience, plus totals per audience. */
personalisationRouter.get('/exposures', async (c) => {
  const q = c.req.query();
  const today = new Date();
  const to = q.to ?? today.toISOString().slice(0, 10);
  const from = q.from ?? new Date(today.getTime() - 29 * 86_400_000).toISOString().slice(0, 10);
  if (!day.safeParse(from).success || !day.safeParse(to).success) return fail(c, 400, 'VALIDATION', 'from/to must be YYYY-MM-DD.');
  const span = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  if (!(span >= 0) || span > MAX_RANGE_DAYS) return fail(c, 400, 'VALIDATION', `The range must be 0–${MAX_RANGE_DAYS} days.`);
  const subjectType = q.subjectType === 'page' || q.subjectType === 'item' ? q.subjectType : undefined;
  const rows = await repoOf(c).exposures({ from, to, subjectType, subjectId: q.subjectId || undefined });
  const totals: Record<string, number> = {};
  for (const r of rows) totals[r.audienceKey] = (totals[r.audienceKey] ?? 0) + r.count;
  return c.json({ data: rows, meta: { from, to, totals } });
});
