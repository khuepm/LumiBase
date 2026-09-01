import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { formatSafeError } from '@lumibase/contracts/utils';
import { AuditLogger } from '../modules/audit/logger';
import { itemServiceForRequest } from '../services/item-service-factory';
import {
  ReleaseService,
  ReleaseServiceError,
  releaseAuditEvent,
  releaseAuditMetadata,
  type AtomicityMode,
} from '../services/release-service';

/**
 * Content Releases API (spec: .kiro/specs/content-releases). Thin handlers —
 * all logic lives in ReleaseService. Publish delegates to a fully-configured
 * ItemService so the editorial gate, validation, permissions, hooks and search
 * indexing apply exactly as for a normal edit.
 */
export const releasesRouter = new Hono<AppEnv>();

const itemInputSchema = z.object({
  collection: z.string().min(1),
  itemId: z.string().min(1),
  targetStatus: z.enum(['draft', 'published', 'archived']).optional(),
  revisionId: z.string().nullable().optional(),
});

const createSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  atomicityMode: z.enum(['all_or_nothing', 'best_effort']).optional(),
  publishAt: z.union([z.string(), z.null()]).optional(),
  maintenanceWindow: z.unknown().optional(),
});

const patchSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  atomicityMode: z.enum(['all_or_nothing', 'best_effort']).optional(),
  publishAt: z.union([z.string(), z.null()]).optional(),
  maintenanceWindow: z.unknown().optional(),
  addItems: z.array(itemInputSchema).optional(),
  removeItems: z.array(z.object({ collection: z.string(), itemId: z.string() })).optional(),
});

/** Build a ReleaseService whose publishes run through a configured ItemService. */
function buildService(c: Context<AppEnv>): ReleaseService {
  const auth = c.get('auth');
  return new ReleaseService({
    db: c.get('db'),
    siteId: c.get('siteId'),
    userId: auth?.userId ?? null,
    // RBAC-enforcing, request-scoped ItemService (item-service-factory):
    // publish honours the caller's permission context exactly like a normal
    // item edit — never a system/fail-open service on the manual path.
    itemServiceFactory: () => itemServiceForRequest(c),
  });
}

function toError(err: unknown) {
  if (err instanceof ReleaseServiceError) {
    return { status: err.status, body: { errors: [{ code: err.code, message: err.message }] } };
  }
  console.error('[releases] unexpected error', formatSafeError(err));
  return { status: 500 as const, body: { errors: [{ code: 'INTERNAL', message: 'Unhandled release error.' }] } };
}

releasesRouter.post('/', async (c) => {
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ errors: [{ code: 'VALIDATION_FAILED', message: parsed.error.issues[0]?.message ?? 'Invalid body.' }] }, 422);
  }
  try {
    const release = await buildService(c).create(parsed.data);
    return c.json({ data: release }, 201);
  } catch (err) {
    const e = toError(err);
    return c.json(e.body, e.status as 400);
  }
});

releasesRouter.get('/', async (c) => {
  const url = new URL(c.req.url);
  const status = url.searchParams.get('status') ?? undefined;
  const page = Number(url.searchParams.get('page') ?? '1') || 1;
  const limit = Number(url.searchParams.get('limit') ?? '50') || 50;
  try {
    const result = await buildService(c).list({ status, page, limit });
    return c.json(result);
  } catch (err) {
    const e = toError(err);
    return c.json(e.body, e.status as 400);
  }
});

releasesRouter.get('/:id', async (c) => {
  try {
    const data = await buildService(c).get(c.req.param('id'));
    return c.json({ data });
  } catch (err) {
    const e = toError(err);
    return c.json(e.body, e.status as 400);
  }
});

releasesRouter.patch('/:id', async (c) => {
  const parsed = patchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ errors: [{ code: 'VALIDATION_FAILED', message: parsed.error.issues[0]?.message ?? 'Invalid body.' }] }, 422);
  }
  try {
    const updated = await buildService(c).patch(c.req.param('id'), {
      ...parsed.data,
      atomicityMode: parsed.data.atomicityMode as AtomicityMode | undefined,
    });
    return c.json({ data: updated });
  } catch (err) {
    const e = toError(err);
    return c.json(e.body, e.status as 400);
  }
});

releasesRouter.post('/:id/publish', async (c) => {
  const id = c.req.param('id');
  try {
    const result = await buildService(c).publish(id, { trigger: 'manual' });
    // Audit (Req 12). best-effort, never blocks the response.
    const auth = c.get('auth');
    await new AuditLogger({ db: c.get('db'), siteId: c.get('siteId') }).write({
      event: releaseAuditEvent(result.status),
      actorEmail: auth?.email ?? null,
      ip: c.get('ip') ?? null,
      userAgent: c.get('userAgent') ?? null,
      requestId: c.get('requestId') ?? null,
      metadata: releaseAuditMetadata(id, 'manual', result.outcomes),
    });
    // partial/failed publish still returns 200 with the per-item outcomes.
    return c.json({ data: result });
  } catch (err) {
    const e = toError(err);
    return c.json(e.body, e.status as 400);
  }
});

releasesRouter.delete('/:id', async (c) => {
  try {
    await buildService(c).delete(c.req.param('id'));
    return c.body(null, 204);
  } catch (err) {
    const e = toError(err);
    return c.json(e.body, e.status as 400);
  }
});
