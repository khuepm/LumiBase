import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { requireSiteAdmin } from '../middleware/site-admin';
import { AuditLogger } from '../modules/audit/logger';
import { itemServiceForRequest } from '../services/item-service-factory';
import {
  BackendTemplateCatalogService,
  CatalogError,
  type CaptureItemReader,
} from '../services/backend-templates/catalog-service';
import { resolveBuildMetadata } from './system';
import { TemplatePlanInputSchema } from '@lumibase/contracts/backend-templates';
import { scopedDbFor } from '../middleware/db';
import { isSiteAdmin } from '../middleware/site-admin';
import { BackendTemplatePlanner, PlanError } from '../services/backend-templates/planner';

/**
 * `/api/v1/backend-templates` — the site's private template catalog (#902,
 * epic #900 BT02).
 *
 * Site admins only in v1 (`requireSiteAdmin`): authoring, publishing and
 * capturing a template reads or describes the whole schema of the site.
 * Seed capture additionally reads items through the caller's own item
 * permissions. Every route is scoped to the request's site; another site's
 * templates are not found, whatever id or slug is guessed.
 *
 * Planning and installing a template are separate routes (#903, #904).
 */
export const backendTemplatesRouter = new Hono<AppEnv>();
backendTemplatesRouter.use('*', requireSiteAdmin());

const service = (c: Context<AppEnv>) =>
  new BackendTemplateCatalogService({ db: c.get('db'), siteId: c.get('siteId'), userId: c.get('auth').userId ?? null });

const validation = (issues: z.ZodIssue[]) => ({
  errors: issues.map((issue) => ({ code: 'VALIDATION', message: issue.message, path: issue.path.map(String) })),
});

function fail(c: Context<AppEnv>, err: unknown): Response {
  if (err instanceof CatalogError) {
    const errors = err.details?.errors?.length
      ? err.details.errors.map((e) => ({ code: e.code, message: e.message, path: e.path }))
      : [{ code: err.code, message: err.message, ...(err.details?.missing ? { missing: err.details.missing } : {}) }];
    return c.json({ errors }, err.status);
  }
  throw err;
}

async function audit(c: Context<AppEnv>, event: string, metadata: Record<string, unknown>) {
  await new AuditLogger({ db: c.get('db'), siteId: c.get('siteId') }).write({
    siteId: c.get('siteId'),
    event,
    actorEmail: c.get('auth').email ?? null,
    metadata: { ...metadata, actorUserId: c.get('auth').userId ?? null },
    requestId: c.get('requestId') ?? null,
  });
}

/** A document is a JSON object, or raw JSON text (checked for duplicate keys). */
const documentSchema = z.union([z.record(z.string(), z.unknown()), z.string().min(2)]);

backendTemplatesRouter.get('/', async (c) => {
  const limit = Number(c.req.query('limit') ?? 50);
  const offset = Number(c.req.query('offset') ?? 0);
  if (!Number.isInteger(limit) || !Number.isInteger(offset)) return c.json({ errors: [{ code: 'VALIDATION', message: 'limit and offset are integers.' }] }, 400);
  const result = await service(c).list({ limit, offset });
  return c.json(result);
});

backendTemplatesRouter.get('/official', (c) => c.json({ data: service(c).listOfficial() }));

backendTemplatesRouter.post('/', async (c) => {
  const parsed = z.object({ document: documentSchema }).strict().safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(validation(parsed.error.issues), 400);
  try {
    const created = await service(c).createDraft(parsed.data.document);
    await audit(c, 'backend_template_created', { templateId: created.id, slug: created.slug });
    return c.json({ data: created }, 201);
  } catch (err) {
    return fail(c, err);
  }
});

const captureSchema = z.object({
  collections: z.array(z.string().min(1)).min(1).max(100),
  slug: z.string().min(1).max(64),
  displayName: z.string().trim().min(1).max(120),
  templateVersion: z.string().max(128).optional(),
  description: z.string().max(4000).optional(),
  seed: z.object({
    pack: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).optional(),
    collections: z.array(z.string().min(1)).min(1).max(100),
    maxRecordsPerCollection: z.number().int().min(1).max(1000).optional(),
  }).strict().optional(),
}).strict();

backendTemplatesRouter.post('/capture', async (c) => {
  const parsed = captureSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(validation(parsed.error.issues), 400);
  const version = resolveBuildMetadata(c.env).version;
  const cmsVersionRange = /^\d+\.\d+\.\d+/.test(version) ? `>=${version.match(/^\d+\.\d+\.\d+/)![0]}` : '*';
  // Seed capture reads with the caller's own item permissions; schema-only reads no item.
  const reader: CaptureItemReader | undefined = parsed.data.seed
    ? {
        list: async (collection, limit) => {
          const items = itemServiceForRequest(c);
          const page = await items.list(collection, { limit, withTotal: false });
          return page.data as Array<Record<string, unknown>>;
        },
      }
    : undefined;
  try {
    const created = await service(c).capture({ ...parsed.data, cmsVersionRange }, reader);
    await audit(c, 'backend_template_captured', {
      templateId: created.id,
      slug: created.slug,
      collections: parsed.data.collections,
      seedCollections: parsed.data.seed?.collections ?? [],
    });
    return c.json({ data: created }, 201);
  } catch (err) {
    if (err instanceof CatalogError) return fail(c, err);
    const status = (err as { status?: unknown }).status;
    if (status === 403 || status === 404) {
      // The caller may not read those items: nothing was stored.
      return c.json({ errors: [{ code: 'FORBIDDEN', message: 'You cannot read the items of a collection selected for seed capture.' }] }, 403);
    }
    throw err;
  }
});

backendTemplatesRouter.get('/:id', async (c) => {
  try {
    return c.json({ data: await service(c).get(c.req.param('id')) });
  } catch (err) {
    return fail(c, err);
  }
});

backendTemplatesRouter.patch('/:id', async (c) => {
  const parsed = z.object({ document: documentSchema, draftRevision: z.number().int().min(1) }).strict()
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(validation(parsed.error.issues), 400);
  try {
    return c.json({ data: await service(c).updateDraft(c.req.param('id'), parsed.data.document, parsed.data.draftRevision) });
  } catch (err) {
    return fail(c, err);
  }
});

backendTemplatesRouter.post('/:id/validate', async (c) => {
  try {
    const result = await service(c).validateDraft(c.req.param('id'));
    return result.ok ? c.json({ data: { valid: true, digest: result.digest } }) : c.json({ data: { valid: false, errors: result.errors } });
  } catch (err) {
    return fail(c, err);
  }
});

backendTemplatesRouter.post('/:id/publish', async (c) => {
  const parsed = z.object({ draftRevision: z.number().int().min(1).optional() }).strict()
    .safeParse((await c.req.json().catch(() => ({}))) ?? {});
  if (!parsed.success) return c.json(validation(parsed.error.issues), 400);
  try {
    const result = await service(c).publish(c.req.param('id'), parsed.data.draftRevision);
    if (result.created) {
      await audit(c, 'backend_template_published', {
        templateId: c.req.param('id'),
        templateVersion: result.revision.templateVersion,
        digest: result.revision.digest,
      });
    }
    return c.json({ data: result.revision, meta: { created: result.created } }, result.created ? 201 : 200);
  } catch (err) {
    return fail(c, err);
  }
});

backendTemplatesRouter.get('/:id/revisions/:version', async (c) => {
  try {
    const { revision, document } = await service(c).getRevision(c.req.param('id'), c.req.param('version'));
    return c.json({ data: { ...revision, document } });
  } catch (err) {
    return fail(c, err);
  }
});

// ── Plans (#903) ───────────────────────────────────────────────────────────

/** The same request, seen as if it targeted `siteId` (for a separate source-site check). */
function asSite(c: Context<AppEnv>, siteId: string): Context<AppEnv> {
  return new Proxy(c, {
    get(target, prop) {
      if (prop === 'get') {
        return (key: string) => (key === 'siteId' ? siteId : key === 'db' ? scopedDbFor(c, siteId) : target.get(key as never));
      }
      // Hono's Context keeps private fields: read them on the real object.
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

export function plannerFor(c: Context<AppEnv>): BackendTemplatePlanner {
  return new BackendTemplatePlanner({
    db: c.get('db'),
    siteId: c.get('siteId'),
    userId: c.get('auth').userId ?? null,
    dbForSite: (siteId) => scopedDbFor(c, siteId),
    // The source catalog is authorized on its own: being admin of the target
    // grants nothing on another site's private templates.
    canReadSourceCatalog: (siteId) => isSiteAdmin(asSite(c, siteId)),
    cmsVersion: resolveBuildMetadata(c.env).version,
  });
}

function planFail(c: Context<AppEnv>, err: unknown): Response {
  if (err instanceof PlanError) {
    const errors = err.details.errors?.length
      ? err.details.errors.map((e) => ({ code: e.code, message: e.message, path: e.path }))
      : [{
          code: err.code,
          message: err.message,
          ...(err.details.conflicts ? { conflicts: err.details.conflicts } : {}),
          ...(err.details.candidates ? { candidates: err.details.candidates } : {}),
        }];
    return c.json({ errors, ...(err.details.report ? { meta: { report: err.details.report } } : {}) }, err.status);
  }
  throw err;
}

backendTemplatesRouter.post('/plans', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (body && typeof body === 'object' && !('targetSiteId' in body)) {
    return c.json({ errors: [{ code: 'MISSING_INPUT', message: 'targetSiteId is required: name the site to install into.', path: ['targetSiteId'] }] }, 400);
  }
  const parsed = TemplatePlanInputSchema.safeParse(body);
  if (!parsed.success) return c.json(validation(parsed.error.issues), 400);
  try {
    const { plan, report } = await plannerFor(c).plan(parsed.data);
    await audit(c, 'backend_template_planned', {
      planId: plan.id, slug: plan.slug, templateVersion: plan.templateVersion, digest: plan.digest,
      sourceKind: plan.sourceKind, sourceSiteId: plan.sourceSiteId, seedPack: plan.seedPack,
    });
    return c.json({
      data: { id: plan.id, status: plan.status, expiresAt: plan.expiresAt, targetFingerprint: plan.targetFingerprint, report },
    }, 201);
  } catch (err) {
    return planFail(c, err);
  }
});

backendTemplatesRouter.get('/plans/:planId', async (c) => {
  try {
    const plan = await plannerFor(c).get(c.req.param('planId'));
    return c.json({
      data: {
        id: plan.id, status: plan.status, expiresAt: plan.expiresAt, targetFingerprint: plan.targetFingerprint,
        report: plan.inventory,
      },
    });
  } catch (err) {
    return planFail(c, err);
  }
});

/** Re-checks expiry, target fingerprint and runtime; a stale plan is closed. */
backendTemplatesRouter.post('/plans/:planId/verify', async (c) => {
  try {
    const plan = await plannerFor(c).verify(c.req.param('planId'));
    return c.json({ data: { id: plan.id, status: plan.status, fresh: true } });
  } catch (err) {
    return planFail(c, err);
  }
});
