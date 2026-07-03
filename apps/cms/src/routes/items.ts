import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { ItemServiceError, parseDeepQueryParams, parseFilterQueryParams } from '../services/item-service';
import { itemServiceForRequest } from '../services/item-service-factory';
import { ContentVersionError, ContentVersionService } from '../services/content-version-service';
import { formatSafeError } from '@lumibase/shared/utils';

/**
 * /items/:collection — generic CRUD over the items store.
 *
 * Phase B implements the full surface (list, detail, create, patch, put,
 * delete, bulk). Permission filtering wraps these handlers in Phase C.
 */

const filterSchema: z.ZodType<unknown> = z.lazy(() =>
  z.record(z.string(), z.unknown()),
);

const listQuerySchema = z.object({
  fields: z.string().optional(),
  filter: z.string().optional(),
  sort: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  status: z.string().optional(),
});

const scheduleSchema = {
  publishAt: z.string().datetime().nullable().optional(),
  unpublishAt: z.string().datetime().nullable().optional(),
};

const createSchema = z.object({
  data: z.record(z.unknown()),
  status: z.string().optional(),
  sort: z.number().int().optional(),
  ...scheduleSchema,
});

const patchSchema = z.object({
  data: z.record(z.unknown()).optional(),
  status: z.string().optional(),
  sort: z.number().int().optional(),
  ...scheduleSchema,
});

const bulkSchema = z.object({
  op: z.enum(['create', 'update', 'delete']),
  items: z.array(z.record(z.unknown())),
});

const buildService = (c: Context<AppEnv>) => itemServiceForRequest(c);

const toError = (err: unknown) => {
  if (err instanceof ItemServiceError || err instanceof ContentVersionError) {
    return { status: err.status, body: { errors: [{ code: err.code, message: err.message }] } };
  }
  console.error('[items] unexpected error', formatSafeError(err));
  return {
    status: 500 as const,
    body: { errors: [{ code: 'INTERNAL', message: 'Unhandled item error.' }] },
  };
};

export const itemsRouter = new Hono<AppEnv>();

itemsRouter.get('/:collection', async (c) => {
  const searchParams = new URL(c.req.url).searchParams;
  const parsed = listQuerySchema.safeParse(Object.fromEntries(searchParams));
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }
  let filter: never | undefined;
  try {
    // Accepts both `?filter={json}` and `?filter[field][_op]=value` forms.
    filter = parseFilterQueryParams(searchParams, parsed.data.filter) as never | undefined;
  } catch {
    return c.json({ errors: [{ code: 'VALIDATION', message: 'Invalid filter: expected JSON or filter[field][_op]=value syntax.' }] }, 400);
  }
  try {
    const fields = parsed.data.fields ? parsed.data.fields.split(',') : undefined;
    const deep = parseDeepQueryParams(searchParams);
    const sort = parsed.data.sort ? parsed.data.sort.split(',') : undefined;
    const result = await buildService(c).list(c.req.param('collection'), {
      fields,
      deep,
      filter,
      sort,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
      status: parsed.data.status,
    });
    return c.json(result);
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

itemsRouter.post('/:collection', async (c) => {
  const parsed = createSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }
  try {
    const data = await buildService(c).create(c.req.param('collection'), parsed.data);
    return c.json({ data }, 201);
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

itemsRouter.post('/:collection/bulk', async (c) => {
  const parsed = bulkSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }
  try {
    const data = await buildService(c).bulk(c.req.param('collection'), parsed.data.op, parsed.data.items);
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

itemsRouter.get('/:collection/:id', async (c) => {
  const searchParams = new URL(c.req.url).searchParams;
  const fields = c.req.query('fields')?.split(',');
  const deep = parseDeepQueryParams(searchParams);
  try {
    const data = await buildService(c).detail(c.req.param('collection'), c.req.param('id'), fields, deep);
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

itemsRouter.patch('/:collection/:id', async (c) => {
  const parsed = patchSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }
  try {
    const data = await buildService(c).patch(c.req.param('collection'), c.req.param('id'), parsed.data);
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

itemsRouter.put('/:collection/:id', async (c) => {
  const parsed = createSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }
  try {
    const data = await buildService(c).replace(c.req.param('collection'), c.req.param('id'), parsed.data);
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

itemsRouter.delete('/:collection/:id', async (c) => {
  try {
    await buildService(c).softDelete(c.req.param('collection'), c.req.param('id'));
    return c.body(null, 204);
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

itemsRouter.get('/:collection/:id/revisions', async (c) => {
  try {
    const data = await buildService(c).listRevisions(
      c.req.param('collection'),
      c.req.param('id'),
    );
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

itemsRouter.post('/:collection/:id/revert/:revisionId', async (c) => {
  try {
    const data = await buildService(c).revertRevision(
      c.req.param('collection'),
      c.req.param('id'),
      c.req.param('revisionId'),
    );
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

// Law Zero pins — fields locked against agent writes by a human edit.
itemsRouter.get('/:collection/:id/pins', async (c) => {
  try {
    const data = await buildService(c).listPins(c.req.param('collection'), c.req.param('id'));
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

itemsRouter.delete('/:collection/:id/pins/:field', async (c) => {
  try {
    const data = await buildService(c).releasePin(
      c.req.param('collection'),
      c.req.param('id'),
      c.req.param('field'),
    );
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

// ── Content versions — named parallel draft branches of an item. ──────────────

const buildVersionService = (c: Context<AppEnv>) =>
  new ContentVersionService({
    db: c.get('db'),
    siteId: c.get('siteId'),
    userId: c.get('auth')?.userId ?? null,
    items: buildService(c),
  });

const versionCreateSchema = z.object({ key: z.string().min(1), name: z.string().min(1) });
const versionPatchSchema = z.object({
  data: z.record(z.unknown()).optional(),
  name: z.string().min(1).optional(),
});

itemsRouter.get('/:collection/:id/versions', async (c) => {
  try {
    const data = await buildVersionService(c).list(c.req.param('collection'), c.req.param('id'));
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

itemsRouter.post('/:collection/:id/versions', async (c) => {
  const parsed = versionCreateSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }
  try {
    const data = await buildVersionService(c).create(
      c.req.param('collection'),
      c.req.param('id'),
      parsed.data.key,
      parsed.data.name,
    );
    return c.json({ data }, 201);
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

itemsRouter.get('/:collection/:id/versions/:key', async (c) => {
  try {
    const data = await buildVersionService(c).get(
      c.req.param('collection'),
      c.req.param('id'),
      c.req.param('key'),
    );
    if (!data) return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Version not found' }] }, 404);
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

itemsRouter.patch('/:collection/:id/versions/:key', async (c) => {
  const parsed = versionPatchSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }
  try {
    const data = await buildVersionService(c).update(
      c.req.param('collection'),
      c.req.param('id'),
      c.req.param('key'),
      parsed.data,
    );
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

itemsRouter.delete('/:collection/:id/versions/:key', async (c) => {
  try {
    await buildVersionService(c).remove(
      c.req.param('collection'),
      c.req.param('id'),
      c.req.param('key'),
    );
    return c.json({ data: null });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

itemsRouter.get('/:collection/:id/versions/:key/compare', async (c) => {
  try {
    const data = await buildVersionService(c).compare(
      c.req.param('collection'),
      c.req.param('id'),
      c.req.param('key'),
    );
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

itemsRouter.post('/:collection/:id/versions/:key/promote', async (c) => {
  try {
    const { item, mainDiverged } = await buildVersionService(c).promote(
      c.req.param('collection'),
      c.req.param('id'),
      c.req.param('key'),
    );
    return c.json({ data: item, meta: { mainDiverged } });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});
