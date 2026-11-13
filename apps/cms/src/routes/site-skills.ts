import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { resolveRequestCapabilities } from '../services/governed-capabilities';
import {
  MAX_SKILL_BODY_CHARS,
  SITE_SKILL_SOURCES,
  SITE_SKILL_STATUSES,
  SITE_SKILL_SURFACES,
  SiteSkillError,
  SiteSkillService,
  siteSkillInputSchema,
  type SiteSkillStatus,
  type SiteSkillSurface,
} from '../services/site-skill-service';
import { patchSchema } from '../utils/patch-schema';

/**
 * Site Skills API — /api/v1/agent/skills (#712).
 *
 * Lives under `/api/v1/agent`, so `withControlPlaneAccessGuard` already limits
 * the whole surface to admin principals. Every write checks again here that the
 * caller's resolved grant is a control-plane admin, so the rule holds even on a
 * mount the guard does not cover: a skill is text the agents will treat as
 * instructions, so authoring one is a governance act, not a content edit.
 * There is no delegated (non-admin) author; `riskClass` is a review label only.
 */
export const siteSkillsRouter = new Hono<AppEnv>();

const writeMetaSchema = z.object({
  source: z.enum(SITE_SKILL_SOURCES).optional(),
  sourceRef: z.string().max(300).nullable().optional(),
  changeNote: z.string().max(500).nullable().optional(),
});

const importSchema = writeMetaSchema.extend({
  documents: z
    .array(
      z.object({
        path: z.string().max(300).optional(),
        // A coarse request-size bound only. Empty or over-long documents are
        // reported per document by the parser, so one bad file cannot fail a
        // whole push with an error that does not name it.
        content: z.string().max(MAX_SKILL_BODY_CHARS * 4),
      }),
    )
    .min(1)
    .max(100),
  activate: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  /** Allow content changes to skills that are already active (the `skills push` deploy path). */
  updateActive: z.boolean().optional(),
});

/** Optimistic concurrency: the version the caller loaded / is looking at. */
const patchMetaSchema = writeMetaSchema.extend({ expectedVersion: z.number().int().min(1).optional() });
const statusBodySchema = z.object({ version: z.number().int().min(1).optional() }).nullable();

const matchSchema = z.object({
  surface: z.enum(SITE_SKILL_SURFACES),
  tool: z.string().max(120).optional(),
  collection: z.string().max(120).optional(),
  text: z.string().max(8000).optional(),
});

async function context(c: Context<AppEnv>) {
  const grant = await resolveRequestCapabilities(c);
  const auth = c.get('auth');
  const service = new SiteSkillService({
    db: c.get('db'),
    siteId: c.get('siteId'),
    actor: {
      userId: auth.userId ?? null,
      label: auth.apiKeyId ? `api_key:${auth.apiKeyId}` : null,
    },
  });
  // The one write rule: a control-plane admin. No capability string can stand
  // in for it — nothing in the permission model mints a skills-specific one.
  const canWrite = grant.allowed && grant.controlPlaneAdmin;
  return { service, grant, canWrite };
}

function forbidden(c: Context<AppEnv>) {
  return c.json(
    { errors: [{ code: 'FORBIDDEN', message: 'Writing Site Skills requires a control-plane admin.' }] },
    403,
  );
}

function handleError(c: Context<AppEnv>, err: unknown) {
  if (err instanceof SiteSkillError) {
    return c.json({ errors: [{ ...err.details, code: err.code, message: err.message }] }, err.status as 400);
  }
  if (err instanceof z.ZodError) {
    return c.json(
      {
        errors: err.issues.map((issue) => ({
          code: 'VALIDATION',
          message: issue.message,
          path: issue.path.map(String),
        })),
      },
      400,
    );
  }
  throw err;
}

function statusFilter(c: Context<AppEnv>): { status?: string } | SiteSkillError {
  const status = c.req.query('status');
  if (!status) return {};
  return (SITE_SKILL_STATUSES as readonly string[]).includes(status)
    ? { status }
    : new SiteSkillError('VALIDATION', `status must be one of: ${SITE_SKILL_STATUSES.join(', ')}.`);
}

siteSkillsRouter.get('/', async (c) => {
  const filter = statusFilter(c);
  if (filter instanceof SiteSkillError) return handleError(c, filter);
  const { service } = await context(c);
  return c.json({ data: await service.list(filter) });
});

siteSkillsRouter.post('/', async (c) => {
  const { service, canWrite } = await context(c);
  if (!canWrite) return forbidden(c);
  const body: unknown = await c.req.json().catch(() => null);
  const parsed = siteSkillInputSchema.safeParse(body);
  if (!parsed.success) return handleError(c, parsed.error);
  const meta = writeMetaSchema.safeParse(body);
  if (!meta.success) return handleError(c, meta.error);
  try {
    return c.json({ data: await service.create(parsed.data, meta.data) }, 201);
  } catch (err) {
    return handleError(c, err);
  }
});

/** Upsert Markdown documents by slug — the `lumibase skills push/install` path. */
siteSkillsRouter.post('/import', async (c) => {
  const { service, canWrite } = await context(c);
  if (!canWrite) return forbidden(c);
  const parsed = importSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return handleError(c, parsed.error);
  const { documents, ...options } = parsed.data;
  try {
    const results = await service.importDocuments(documents, { ...options, source: options.source ?? 'api' });
    const count = (action: string) => results.filter((r) => r.action === action).length;
    return c.json({
      data: results,
      meta: {
        dryRun: Boolean(options.dryRun),
        created: count('created'),
        updated: count('updated'),
        unchanged: count('unchanged'),
        errors: count('error'),
      },
    });
  } catch (err) {
    return handleError(c, err);
  }
});

/** Every skill as a Markdown document — the `lumibase skills pull` path. */
siteSkillsRouter.get('/export', async (c) => {
  const filter = statusFilter(c);
  if (filter instanceof SiteSkillError) return handleError(c, filter);
  const { service } = await context(c);
  return c.json({ data: await service.exportDocuments(filter) });
});

/**
 * Preview: which active skills a run with this context would receive, and the
 * exact instruction block. Evaluated with the caller's own capabilities.
 */
siteSkillsRouter.post('/match', async (c) => {
  const parsed = matchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return handleError(c, parsed.error);
  const { service, grant } = await context(c);
  const data = await service.resolve({
    ...parsed.data,
    surface: parsed.data.surface as SiteSkillSurface,
    capabilities: grant.capabilities,
  });
  return c.json({ data });
});

siteSkillsRouter.get('/:id', async (c) => {
  const { service } = await context(c);
  try {
    const skill = await service.get(c.req.param('id'));
    return c.json({ data: { ...skill, document: service.toDocument(skill) } });
  } catch (err) {
    return handleError(c, err);
  }
});

siteSkillsRouter.patch('/:id', async (c) => {
  const { service, canWrite } = await context(c);
  if (!canWrite) return forbidden(c);
  const body: unknown = await c.req.json().catch(() => null);
  const parsed = patchSchema(siteSkillInputSchema).safeParse(body);
  if (!parsed.success) return handleError(c, parsed.error);
  const meta = patchMetaSchema.safeParse(body);
  if (!meta.success) return handleError(c, meta.error);
  try {
    const { skill, changed } = await service.update(c.req.param('id'), parsed.data, meta.data);
    return c.json({ data: skill, meta: { changed } });
  } catch (err) {
    return handleError(c, err);
  }
});

siteSkillsRouter.delete('/:id', async (c) => {
  const { service, canWrite } = await context(c);
  if (!canWrite) return forbidden(c);
  try {
    return c.json({ data: await service.remove(c.req.param('id')) });
  } catch (err) {
    return handleError(c, err);
  }
});

const STATUS_ACTIONS: Record<string, SiteSkillStatus> = {
  activate: 'active',
  archive: 'archived',
  draft: 'draft',
};

for (const [action, status] of Object.entries(STATUS_ACTIONS)) {
  siteSkillsRouter.post(`/:id/${action}`, async (c) => {
    const { service, canWrite } = await context(c);
    if (!canWrite) return forbidden(c);
    const body = statusBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return handleError(c, body.error);
    try {
      const expectedVersion = body.data?.version;
      return c.json({
        data: await service.setStatus(c.req.param('id'), status, expectedVersion === undefined ? {} : { expectedVersion }),
      });
    } catch (err) {
      return handleError(c, err);
    }
  });
}

siteSkillsRouter.get('/:id/versions', async (c) => {
  const { service } = await context(c);
  try {
    return c.json({ data: await service.listVersions(c.req.param('id')) });
  } catch (err) {
    return handleError(c, err);
  }
});

siteSkillsRouter.post('/:id/versions/:version/restore', async (c) => {
  const { service, canWrite } = await context(c);
  if (!canWrite) return forbidden(c);
  const version = Number(c.req.param('version'));
  if (!Number.isInteger(version) || version < 1) {
    return handleError(c, new SiteSkillError('VALIDATION', 'version must be a positive integer.'));
  }
  try {
    const { skill, changed } = await service.restoreVersion(c.req.param('id'), version);
    return c.json({ data: skill, meta: { changed } });
  } catch (err) {
    return handleError(c, err);
  }
});
